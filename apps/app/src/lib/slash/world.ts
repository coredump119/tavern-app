/**
 * World Info commands: `/world`, the `/get…book` family and the entry commands (ST world-info.js
 * `onWorldInfoChange`, `registerWorldInfoSlashCommands`).
 */
import {
  charLoreOf,
  createWorldInfoEntry,
  currentAvatar,
  globalSelectOf,
  sanitizeFilename,
  setCharLore,
  setGlobalSelect,
  setPersonaFields,
  setWIOriginalDataValue,
  setWorldInfoEntryField,
  type WIBookData,
  type WIEntryData,
} from '@tm/core';
import {
  coerceEntryValue,
  entryFieldSpec,
  findEntry,
  isFalse,
  isTrue,
  parseStringArray,
  SlashError,
  type EntryFieldSpec,
} from '@tm/st-compat';
import { createWorld, listWorldNames, readWorld, writeWorld } from '../worlds';
import { findCharacter } from './characters';
import {
  fileStem,
  record,
  tagList,
  text,
  type AddCommand,
  type Obj,
  type SlashEnv,
} from './shared';

type WorldEnv = Pick<
  SlashEnv,
  | 'root'
  | 'settings'
  | 'mutateSettings'
  | 'chatName'
  | 'chatMetadata'
  | 'setChatMetadata'
  | 'userName'
  | 'characters'
  | 'currentAvatars'
  | 'inGroup'
  | 'characterWorld'
  | 'setCharacterWorld'
  | 'substitute'
  | 'warn'
>;

const MAX_NAME_TRIES = 1000;

/** How ST names the books it creates for a chat, a persona or a character */
const bookNameFor = (owner: string): string =>
  owner
    .replace(/[^a-z0-9 -]/gi, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 64);

/**
 * ST `createWorldWithName`: a new empty book under the wanted name, or under the fallback.
 * ST 1.18.0 numbers every new book (`name (1)` even when `name` is free); here the bare name is
 * used while it is free, which is what scripts that pass `name=` expect.
 */
async function createBook(env: WorldEnv, wanted: unknown, fallback: string): Promise<string> {
  const root = env.root();
  const taken = new Set((await listWorldNames(root)).map((name) => name.toLowerCase()));
  const free = (name: string) => !taken.has(sanitizeFilename(name).toLowerCase());
  let base = fallback;
  if (typeof wanted === 'string' && wanted) {
    if (!free(wanted)) throw new SlashError(`已经有叫「${wanted}」的世界书`);
    base = wanted;
  }
  for (let i = 0; i < MAX_NAME_TRIES; i++) {
    const name = i === 0 ? base : `${base} (${i})`;
    if (free(name)) return createWorld(root, name);
  }
  throw new SlashError(`没能给新世界书起名：${base}`);
}

/** The book behind `file=`; null, after a note to the user, when there is no such book */
async function loadBook(env: WorldEnv, file: string): Promise<WIBookData | null> {
  const root = env.root();
  if (!file || !(await listWorldNames(root)).includes(file)) {
    env.warn('需要有效的世界书文件名（file=）');
    return null;
  }
  try {
    return await readWorld(root, file);
  } catch {
    env.warn(`世界书「${file}」的格式不对`);
    return null;
  }
}
/** ST `getEntriesFromFile` */
async function loadEntries(env: WorldEnv, file: string): Promise<WIEntryData[] | null> {
  const book = await loadBook(env, file);
  if (!book) return null;
  const entries = Object.values(book.entries);
  if (entries.length === 0) {
    env.warn(`世界书「${file}」里没有条目`);
    return null;
  }
  return entries;
}

/** The three fields that live inside `entry.characterFilter` */
const FILTER_FIELDS = ['characterFilterNames', 'characterFilterTags', 'characterFilterExclude'];

function readField(entry: WIEntryData, name: string, spec: EntryFieldSpec, settings: Obj): unknown {
  if (!FILTER_FIELDS.includes(name)) return entry[name] ?? spec.default;
  const filter = record(entry['characterFilter']);
  if (!filter) return undefined;
  if (name === 'characterFilterNames') return filter['names'];
  if (name === 'characterFilterExclude') return filter['isExclude'];
  // stored as tag ids, read as tag names
  const ids = filter['tags'];
  if (!Array.isArray(ids)) return undefined;
  return tagList(settings)
    .filter((tag) => ids.includes(tag['id']))
    .map((tag) => tag['name']);
}

function writeField(
  env: WorldEnv,
  book: WIBookData,
  uid: number,
  name: string,
  spec: EntryFieldSpec,
  value: string,
): void {
  if (!FILTER_FIELDS.includes(name)) {
    setWorldInfoEntryField(book, uid, name, coerceEntryValue(spec, value));
    return;
  }
  const entry = book.entries[uid]!;
  const filter = record(entry['characterFilter']) ?? { isExclude: false, names: [], tags: [] };
  entry['characterFilter'] = filter;
  if (name === 'characterFilterExclude') {
    filter['isExclude'] = isTrue(value);
  } else if (name === 'characterFilterNames') {
    // stored as avatar file stems, written as names or avatars
    const stems = parseStringArray(value).flatMap((wanted) => {
      const found = findCharacter(env, { name: wanted, preferCurrent: false, quiet: true });
      return found ? [fileStem(found.avatar)] : [];
    });
    filter['names'] = [...new Set(stems)];
  } else {
    const wanted = parseStringArray(value);
    filter['tags'] = tagList(env.settings())
      .filter((tag) => wanted.includes(String(tag['name'])))
      .map((tag) => tag['id']);
  }
  setWIOriginalDataValue(book, uid, 'character_filter', filter);
}

export function worldCommands(add: AddCommand, env: WorldEnv): void {
  add(['world'], {
    run: async (named, unnamed) => {
      const note = (message: string) => {
        if (!isTrue(named['silent'])) env.warn(message);
      };
      const wanted = text(unnamed).trim();
      if (!wanted) {
        env.mutateSettings((settings) => setGlobalSelect(settings, []));
        note('已停用全部世界书');
        return '';
      }
      const names = await listWorldNames(env.root());
      const active = globalSelectOf(env.settings());
      const state = text(named['state']);
      for (const part of wanted.toLowerCase().split(',')) {
        const name = names.find((candidate) => candidate.toLowerCase() === part.trim());
        if (name === undefined) {
          note(`没有叫「${part.trim()}」的世界书`);
          continue;
        }
        const index = active.indexOf(name);
        if (state === 'off' && index < 0) {
          note(`世界书「${name}」本来就没有启用`);
        } else if (index >= 0 && (state === 'off' || state === 'toggle')) {
          active.splice(index, 1);
          note(`已停用世界书：${name}`);
        } else {
          // ST adds the name again when it is already active; once is enough
          if (index < 0) active.push(name);
          note(`已启用世界书：${name}`);
        }
      }
      env.mutateSettings((settings) => setGlobalSelect(settings, active));
      return '';
    },
  });

  add(['getglobalbooks', 'getgloballore', 'getglobalwi'], {
    run: () => JSON.stringify(globalSelectOf(env.settings())),
  });

  add(['getchatbook', 'getchatlore', 'getchatwi'], {
    run: async (named) => {
      const chat = env.chatName();
      if (chat === null) {
        env.warn('先打开一个聊天，才能取它绑定的世界书');
        return '';
      }
      const bound = env.chatMetadata()['world_info'];
      if (typeof bound === 'string' && bound) {
        if ((await listWorldNames(env.root())).includes(bound)) return bound;
      }
      if (isFalse(named['create'])) return '';
      const name = await createBook(env, named['name'], bookNameFor(`Chat Book ${chat}`));
      await env.setChatMetadata({ world_info: name });
      return name;
    },
  });

  add(['getpersonabook', 'getpersonalore', 'getpersonawi'], {
    run: async (named) => {
      const bound = record(env.settings()['power_user'])?.['persona_description_lorebook'];
      if (typeof bound === 'string' && bound) return bound;
      if (!isTrue(named['create'])) return '';
      const fallback = bookNameFor(`Persona Book ${env.userName()}`);
      const name = await createBook(env, named['name'], fallback);
      env.mutateSettings((settings) =>
        setPersonaFields(settings, currentAvatar(settings), { lorebook: name }),
      );
      return name;
    },
  });

  add(['getcharbook', 'getcharlore', 'getcharwi'], {
    run: async (named, unnamed) => {
      const identifier = text(unnamed).trim();
      if (env.inGroup() && !identifier) {
        throw new SlashError('群聊里 /getcharbook 需要给出角色名');
      }
      const type = text(named['type']).trim().toLowerCase() || 'primary';
      const wanted = identifier || env.currentAvatars()[0];
      const character = wanted ? findCharacter(env, { name: wanted }) : null;
      if (!character) {
        env.warn('找不到这个角色');
        return '';
      }
      const stem = fileStem(character.avatar);
      const books: string[] = [];
      if (type === 'all' || type === 'primary') {
        const primary = await env.characterWorld(character.avatar);
        if (primary) books.push(primary);
      }
      if (type === 'all' || type === 'additional') {
        books.push(...charLoreOf(env.settings(), stem).filter(Boolean));
      }
      if (isTrue(named['create']) && books.length === 0) {
        const fallback = bookNameFor(`Character Book ${character.name}`);
        const name = await createBook(env, named['name'], fallback);
        // bound right away: as an additional book when those were asked for, else as the primary
        if (type === 'additional') {
          env.mutateSettings((settings) =>
            setCharLore(settings, stem, [...new Set([...charLoreOf(settings, stem), name])]),
          );
        } else {
          await env.setCharacterWorld(character.avatar, name);
        }
        books.push(name);
      }
      return type === 'primary' ? (books[0] ?? '') : JSON.stringify([...new Set(books)]);
    },
  });

  add(['findentry', 'findlore', 'findwi'], {
    run: async (named, unnamed) => {
      const entries = await loadEntries(env, text(named['file']));
      if (!entries) return '';
      const name = text(named['field']) || 'key';
      let search = text(unnamed);
      if (entryFieldSpec(name)?.type === 'boolean') {
        if (isTrue(search)) search = 'true';
        else if (isFalse(search)) search = 'false';
      }
      const uid = findEntry(entries, name, search)?.['uid'];
      return uid === undefined ? '' : String(uid);
    },
  });

  add(['getentryfield', 'getlorefield', 'getwifield'], {
    run: async (named, unnamed) => {
      const entries = await loadEntries(env, text(named['file']));
      if (!entries) return '';
      const uid = text(unnamed).trim();
      const entry = entries.find((candidate) => String(candidate['uid']) === uid);
      if (!entry) {
        env.warn('需要有效的条目 UID');
        return '';
      }
      const name = text(named['field']) || 'content';
      const spec = entryFieldSpec(name);
      if (!spec) {
        env.warn(`没有这个条目字段：${name}`);
        return '';
      }
      const value = readField(entry, name, spec, env.settings());
      if (value === undefined) return '';
      if (Array.isArray(value)) {
        return JSON.stringify(value.map((item) => env.substitute(String(item))));
      }
      return env.substitute(String(value));
    },
  });

  add(['createentry', 'createlore', 'createwi'], {
    run: async (named, unnamed) => {
      const file = text(named['file']);
      const book = await loadBook(env, file);
      const entry = book && createWorldInfoEntry(book);
      if (!book || !entry) return '';
      const key = text(named['key']);
      if (key) Object.assign(entry, { key: [key], addMemo: true, comment: key });
      const content = text(unnamed);
      if (content) entry['content'] = content;
      await writeWorld(env.root(), file, book);
      return String(entry['uid']);
    },
  });

  add(['setentryfield', 'setlorefield', 'setwifield'], {
    run: async (named, unnamed) => {
      // `\{`, `\}` and `\|` are how a script writes those characters into a value
      const value = text(unnamed).replace(/\\([{}|])/g, '$1');
      const file = text(named['file']);
      const book = await loadBook(env, file);
      if (!book) return '';
      const uid = Number(text(named['uid']).trim() || NaN);
      if (!Object.hasOwn(book.entries, uid)) {
        env.warn('需要有效的条目 UID（uid=）');
        return '';
      }
      const name = text(named['field']) || 'content';
      const spec = entryFieldSpec(name);
      if (!spec) {
        env.warn(`没有这个条目字段：${name}`);
        return '';
      }
      writeField(env, book, uid, name, spec, value);
      await writeWorld(env.root(), file, book);
      return '';
    },
  });
}
