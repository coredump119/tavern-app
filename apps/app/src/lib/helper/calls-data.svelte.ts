/**
 * Data calls scripts may make (DEV_NOTES §9.5 第 3 轮 → 数据接口): characters, chats, world
 * books, presets, regex, personas, script-owned extension settings and prompt injections.
 *
 * Every argument comes from a script. File names are checked against what is on disk (or
 * sanitized when a file is created), and connection addresses, proxy passwords and keys neither
 * leave through these handlers nor can be set through them.
 */
import {
  applyChatCompletionPreset,
  CC_PRESET_FIELDS,
  deletePersona,
  getOrCreateDescriptor,
  initPersona,
  newPersonaAvatarId,
  renamePersona,
  sanitizeFilename,
  setGlobalSelect,
  setPersonaFields,
  type RegexScript,
  type WIBookData,
} from '@tm/core';
import { PRESET_ST_KEYS } from '@tm/tavern-helper';
import { deleteCharacter } from '../characters';
import { countTokens } from '../chat/pipeline';
import { chatStore } from '../chat/store.svelte';
import { cardImport, cardRead, cardWrite, dataDelete, dataWriteText, indexChats } from '../ipc';
import { deleteCcPreset, listCcPresets, oaiOf, readCcPreset, writeCcPreset } from '../oai.svelte';
import { copyUserAvatarFile, deleteUserAvatarFile, listUserAvatars } from '../personas';
import { askPopup } from '../popup.svelte';
import { setGlobalRegexScripts, setPresetRegexScripts, setScopedRegexScripts } from '../regex';
import { deleteWorld, readWorld, writeWorld } from '../worlds';
import type { CallTable } from './calls';
import { catalogNames, SCRIPT_EXTENSIONS_KEY, scriptExtensionIds } from './catalog.svelte';
import { askerLabel } from './custom-api';
import { macroDisplay } from './display.svelte';
import { listModels } from './generate.svelte';
import { injectPosition, injectRole, scriptInjects, type ScriptInject } from './injects.svelte';
import { scriptMacros } from './macro-like';

type Obj = Record<string, unknown>;

/** `extension_settings` entries of the app itself: never a script-owned id */
const RESERVED_EXTENSIONS: ReadonlySet<string> = new Set([
  'tavern_helper',
  'variables',
  'regex',
  'character_allowed_regex',
  'preset_allowed_regex',
  SCRIPT_EXTENSIONS_KEY,
]);
/** Preset keys that say where and how to connect: scripts neither read nor write them */
const CONNECTION_KEYS: ReadonlySet<string> = new Set(
  CC_PRESET_FIELDS.filter((field) => field[3]).map((field) => field[0]),
);
const DEFAULT_USER_AVATAR = 'user-default.png';
const TEMP_DIR = 'temp';

// ---- argument checks ----

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function str(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${what}必须是非空字符串`);
  return value;
}
function obj(value: unknown, what: string): Obj {
  if (!isObj(value)) throw new Error(`${what}必须是对象`);
  return value;
}
function index(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new Error(`${what}必须是非负整数`);
  return value;
}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function root(): string {
  const path = chatStore.root;
  if (!path) throw new Error('数据目录还没有准备好');
  return path;
}

/** An avatar file name the app knows: anything else (a path, a missing card) is refused */
function knownAvatar(value: unknown): string {
  const avatar = str(value, '角色');
  if (!chatStore.characters.some((row) => row.avatar === avatar))
    throw new Error(`角色「${avatar}」不存在`);
  return avatar;
}

/** A name from one of the file lists, read again from disk when the cached list lacks it */
async function knownName(value: unknown, kind: 'worlds' | 'presets'): Promise<string> {
  const what = kind === 'worlds' ? '世界书' : '预设';
  const name = str(value, `${what}名`);
  if (!catalogNames[kind].includes(name)) {
    await catalogNames.refresh();
    if (!catalogNames[kind].includes(name)) throw new Error(`${what}「${name}」不存在`);
  }
  return name;
}

const cardPath = (avatar: string): string => `${root()}/characters/${avatar}`;
const readCard = async (avatar: string): Promise<Obj> =>
  obj(JSON.parse(await cardRead(cardPath(avatar))) as unknown, '角色卡');

// ---- writes ----

/** Settings and card edits run one after another: each starts from what the last one saved */
let turn: Promise<unknown> = Promise.resolve();
function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const run = turn.then(job, job);
  turn = run.catch(() => undefined);
  return run;
}

/** Change a plain copy of the settings (file writes may happen meanwhile) and save it */
function editSettings<T>(change: (settings: Obj) => T | Promise<T>): Promise<T> {
  return inTurn(async () => {
    await chatStore.flushDeferred();
    const current = chatStore.settings;
    if (!current) throw new Error('设置还没有载入');
    const next = $state.snapshot(current) as Obj;
    const result = await change(next);
    await chatStore.saveSettings(next);
    return result;
  });
}

/** The app's copies of a card that was rewritten on disk */
async function cardChanged(avatar: string): Promise<void> {
  if (chatStore.character?.avatar === avatar) await chatStore.reloadCharacter();
  else if (chatStore.group?.members.includes(avatar)) await chatStore.reloadGroup();
  await chatStore.refreshCharacters();
}

/** Rewrite a card on disk through `change`; pending script writes to it land first */
function editCard(avatar: string, change: (card: Obj) => void): Promise<void> {
  return inTurn(async () => {
    await chatStore.flushDeferred();
    const card = await readCard(avatar);
    change(card);
    await cardWrite(cardPath(avatar), JSON.stringify(card));
    await cardChanged(avatar);
  });
}

function setCardExtension(card: Obj, key: string, value: unknown): void {
  const data = isObj(card['data']) ? card['data'] : {};
  const extensions = isObj(data['extensions']) ? data['extensions'] : {};
  card['data'] = { ...data, extensions: { ...extensions, [key]: value } };
}

const worldInfoOf = (settings: Obj): Obj => {
  const all = isObj(settings['world_info_settings']) ? settings['world_info_settings'] : {};
  settings['world_info_settings'] = all;
  return all;
};

/** The raw `oai_settings` bucket, made when missing */
const oaiBucket = (settings: Obj): Obj => {
  const bucket = isObj(settings['oai_settings']) ? settings['oai_settings'] : {};
  settings['oai_settings'] = bucket;
  return bucket;
};
const loadedPreset = (): string => {
  const bucket = chatStore.settings?.['oai_settings'];
  return isObj(bucket) ? String(bucket['preset_settings_openai'] ?? '') : '';
};

/** A preset body without the connection fields */
export function withoutConnection(body: Obj): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(body)) {
    if (!CONNECTION_KEYS.has(key)) out[key] = value;
  }
  return out;
}

const regexScripts = (value: unknown): RegexScript[] => {
  if (!Array.isArray(value) || !value.every(isObj)) throw new Error('正则脚本必须是对象数组');
  return value as unknown as RegexScript[];
};

/** ST `getPastCharacterChats` row */
const chatRow = (row: Awaited<ReturnType<typeof indexChats>>[number]): Obj => ({
  file_name: row.file,
  chat_items: row.mes_count,
  mes: row.last_mes ?? '',
  last_mes: row.mtime,
});

export const dataCalls: CallTable = {
  // ---- characters ----
  'character.read': ([avatar]) => readCard(knownAvatar(avatar)),

  'character.write': ([avatar, card]) => {
    const next = obj(card, '角色卡');
    obj(next['data'], '角色卡的 data');
    const target = knownAvatar(avatar);
    return editCard(target, (current) => {
      for (const key of Object.keys(current)) delete current[key];
      Object.assign(current, next);
    });
  },

  'character.create': ([card]) => {
    const text = JSON.stringify(obj(card, '角色卡'));
    return inTurn(async () => {
      // the Rust importer names the file and writes the PNG: hand it the card as a JSON file
      const rel = `${TEMP_DIR}/th-card-${crypto.randomUUID()}.json`;
      await dataWriteText(root(), rel, text);
      try {
        const avatar = await cardImport(root(), `${root()}/${rel}`);
        await chatStore.refreshCharacters();
        return avatar;
      } finally {
        await dataDelete(root(), rel).catch(() => undefined);
      }
    });
  },

  'character.delete': async ([avatar, deleteChats], from) => {
    const target = knownAvatar(avatar);
    const name = chatStore.characters.find((row) => row.avatar === target)?.name ?? target;
    const agreed = await askPopup({
      kind: 'confirm',
      title: '脚本想删除角色',
      text: `${askerLabel(from)}想删除角色「${name}」${
        deleteChats === true ? '以及它的全部聊天记录' : ''
      }。删除后无法恢复。`,
      okButton: '删除',
      cancelButton: '不删除',
    });
    if (agreed !== true) throw new Error('用户没有同意删除角色');
    await inTurn(async () => {
      await chatStore.flushDeferred();
      const settings = chatStore.settings ? ($state.snapshot(chatStore.settings) as Obj) : null;
      const next = await deleteCharacter(root(), target, deleteChats === true, settings);
      if (next) await chatStore.saveSettings(next);
      if (chatStore.character?.avatar === target) await chatStore.closeCharacter();
      else if (chatStore.group?.members.includes(target)) await chatStore.reloadGroup();
      await chatStore.refreshCharacters();
    });
  },

  'character.extension': ([avatar, key, value]) => {
    const target = knownAvatar(avatar);
    const field = str(key, '扩展字段名');
    if (chatStore.character?.avatar === target) {
      chatStore.setCardExtension(field, value);
      return undefined;
    }
    return editCard(target, (card) => setCardExtension(card, field, value));
  },

  // ---- chats ----
  'chat.list': async ([avatar]) => (await indexChats(root(), knownAvatar(avatar))).map(chatRow),

  'chat.save': () => chatStore.flushDeferred(),
  'settings.save': () => chatStore.flushDeferred(),

  'chat.reload': async () => {
    const file = chatStore.chatFile;
    if (!file) throw new Error('没有打开的聊天');
    await chatStore.openChat(file);
  },

  /** `[begin, middle)` and `[middle, end)` change places */
  'chat.rotate': ([begin, middle, end]) => {
    const from = index(begin, 'begin');
    const mid = index(middle, 'middle');
    const to = index(end, 'end');
    const messages = chatStore.messages;
    if (from > mid || mid > to || to > messages.length) throw new Error('楼层范围无效');
    if (from === mid || mid === to) return;
    const moved = [...messages.slice(mid, to), ...messages.slice(from, mid)];
    chatStore.spliceMessages(from, to - from, moved);
  },

  'tokens.count': ([text]) => {
    const settings = chatStore.settings;
    if (!settings) throw new Error('设置还没有载入');
    return countTokens($state.snapshot(settings) as Obj, typeof text === 'string' ? text : '');
  },

  // ---- world books ----
  'world.read': async ([name]) => readWorld(root(), await knownName(name, 'worlds')),

  'world.write': async ([name, file]) => {
    const stored = sanitizeFilename(`${str(name, '世界书名')}.json`).replace(/\.json$/i, '');
    if (!stored) throw new Error('世界书名无效');
    await writeWorld(root(), stored, obj(file, '世界书') as unknown as WIBookData);
    if (!catalogNames.worlds.includes(stored)) await catalogNames.refresh();
    return stored;
  },

  'world.delete': async ([name]) => {
    const target = await knownName(name, 'worlds');
    await inTurn(async () => {
      await chatStore.flushDeferred();
      const settings = chatStore.settings ? ($state.snapshot(chatStore.settings) as Obj) : null;
      const next = await deleteWorld(root(), target, settings);
      if (next) await chatStore.saveSettings(next);
    });
    await catalogNames.refresh();
  },

  /** `world_info_settings`: the global selection and the scalar `world_info_*` values only */
  'world.settings': ([assign]) => {
    const patch = obj(assign, '世界书设置');
    chatStore.mutateSettings((settings) => {
      const selection = isObj(patch['world_info']) ? patch['world_info']['globalSelect'] : null;
      if (Array.isArray(selection)) setGlobalSelect(settings, strings(selection));
      const all = worldInfoOf(settings);
      for (const [key, value] of Object.entries(patch)) {
        if (!key.startsWith('world_info_')) continue;
        if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
          all[key] = value;
      }
    });
  },

  /** Primary: the card's `data.extensions.world`; additional: the `charLore` row of the avatar */
  'world.bindCharacter': async ([avatar, books]) => {
    const target = knownAvatar(avatar);
    const wanted = obj(books, '世界书绑定');
    const primary = typeof wanted['primary'] === 'string' ? wanted['primary'] : '';
    const additional = strings(wanted['additional']);
    if (chatStore.character?.avatar === target) chatStore.setCardExtension('world', primary);
    else await editCard(target, (card) => setCardExtension(card, 'world', primary));
    chatStore.mutateSettings((settings) => {
      const all = worldInfoOf(settings);
      const inner = isObj(all['world_info']) ? all['world_info'] : {};
      const key = target.replace(/\.[^/.]+$/, '');
      const rows = (Array.isArray(inner['charLore']) ? inner['charLore'] : []).filter(
        (row): row is Obj => isObj(row) && row['name'] !== key,
      );
      if (additional.length) rows.push({ name: key, extraBooks: additional });
      all['world_info'] = { ...inner, charLore: rows };
    });
  },

  'world.bindChat': async ([name]) => {
    if (name !== null && typeof name !== 'string') throw new Error('世界书名必须是字符串或 null');
    await chatStore.flushDeferred();
    // ST keeps no key when the chat has no book
    await chatStore.setChatMetadata({ world_info: name || undefined });
  },

  // ---- presets (Chat Completion) ----
  'preset.read': async ([name]) =>
    withoutConnection(await readCcPreset(root(), await knownName(name, 'presets'))),

  /** The file keeps its own connection fields; what the script sent for them is dropped */
  'preset.write': async ([name, body]) => {
    const wanted = sanitizeFilename(str(name, '预设名'));
    if (!wanted) throw new Error('预设名无效');
    const next = withoutConnection(obj(body, '预设'));
    const existing = (await listCcPresets(root())).includes(wanted)
      ? await readCcPreset(root(), wanted)
      : {};
    const stored = await writeCcPreset(root(), wanted, { ...existing, ...next });
    if (!catalogNames.presets.includes(stored)) await catalogNames.refresh();
    return stored;
  },

  /** The preset in use: only the keys a preset owns reach `oai_settings` */
  'preset.apply': ([body]) => {
    const next = obj(body, '预设');
    chatStore.mutateSettings((settings) => {
      const bucket = oaiBucket(settings);
      for (const key of PRESET_ST_KEYS) {
        if (Object.hasOwn(next, key)) bucket[key] = next[key];
      }
    });
  },

  'preset.load': async ([name]) => {
    const target = await knownName(name, 'presets');
    const body = await readCcPreset(root(), target);
    await editSettings((settings) => {
      settings['oai_settings'] = applyChatCompletionPreset(oaiOf(settings), body, target);
    });
  },

  'preset.delete': async ([name]) => {
    const target = await knownName(name, 'presets');
    await deleteCcPreset(root(), target);
    await catalogNames.refresh();
    if (loadedPreset() !== target) return;
    chatStore.mutateSettings((settings) => {
      oaiBucket(settings)['preset_settings_openai'] = '';
    });
  },

  'preset.rename': async ([name, newName]) => {
    const target = await knownName(name, 'presets');
    const wanted = sanitizeFilename(str(newName, '新预设名'));
    if (!wanted) throw new Error('预设名无效');
    if (catalogNames.presets.some((other) => other.toLowerCase() === wanted.toLowerCase()))
      throw new Error(`已经有叫「${wanted}」的预设`);
    const stored = await writeCcPreset(root(), wanted, await readCcPreset(root(), target));
    await deleteCcPreset(root(), target);
    await catalogNames.refresh();
    if (loadedPreset() === target) {
      chatStore.mutateSettings((settings) => {
        oaiBucket(settings)['preset_settings_openai'] = stored;
      });
    }
    return stored;
  },

  // ---- regex ----
  'regex.set': async ([scope, scripts]) => {
    const list = regexScripts(scripts);
    if (scope === 'global') {
      chatStore.mutateSettings((settings) => setGlobalRegexScripts(settings, list));
      return;
    }
    if (scope === 'preset') {
      await editSettings((settings) => setPresetRegexScripts(root(), settings, list));
      return;
    }
    if (scope !== 'character') throw new Error(`未知的正则范围：${String(scope)}`);
    const avatar = chatStore.character?.avatar;
    if (!avatar) throw new Error('没有打开的角色');
    await editSettings((settings) => setScopedRegexScripts(root(), settings, avatar, list));
    await chatStore.reloadCharacter();
  },

  // ---- personas ----
  'persona.write': async ([avatar, persona]) => {
    const wanted = obj(persona, 'persona');
    const name = str(wanted['name'], 'persona 名字');
    const description = isObj(wanted['description']) ? wanted['description'] : {};
    const files = await listUserAvatars(root());
    let target = typeof avatar === 'string' ? avatar : '';
    if (target && !files.includes(target)) throw new Error(`persona「${target}」不存在`);
    if (!target) {
      target = newPersonaAvatarId(name);
      await copyUserAvatarFile(root(), files[0] ?? DEFAULT_USER_AVATAR, target);
    }
    const number = (key: string): number | undefined => {
      const value = description[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    };
    const text = (key: string): string | undefined => {
      const value = description[key];
      return typeof value === 'string' ? value : undefined;
    };
    const fields = {
      description: text('description'),
      title: text('title'),
      lorebook: text('lorebook'),
      position: number('position'),
      depth: number('depth'),
      role: number('role'),
    };
    const patch = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
    await editSettings((settings) => {
      const power = isObj(settings['power_user']) ? settings['power_user'] : {};
      settings['power_user'] = power;
      if (!isObj(power['personas']) || !(target in power['personas']))
        initPersona(settings, target, name);
      renamePersona(settings, target, name);
      setPersonaFields(settings, target, patch);
      if (Array.isArray(description['connections'])) {
        const descriptor = getOrCreateDescriptor(settings, target) as unknown as Obj;
        descriptor['connections'] = description['connections'].filter(isObj);
      }
      if (wanted['is_default'] === true) power['default_persona'] = target;
      else if (power['default_persona'] === target) delete power['default_persona'];
    });
    return target;
  },

  'persona.delete': async ([avatar]) => {
    const target = str(avatar, 'persona');
    if (!(await listUserAvatars(root())).includes(target))
      throw new Error(`persona「${target}」不存在`);
    await deleteUserAvatarFile(root(), target);
    const metadata = chatStore.open ? { ...chatStore.chatMetadata } : null;
    const result = await editSettings((settings) => deletePersona(settings, metadata, target));
    if (result.chatLockCleared) await chatStore.setChatMetadata({ persona: undefined });
  },

  // ---- script-owned extension settings ----
  'ext.set': ([id, value]) => {
    const key = str(id, '扩展 id');
    if (RESERVED_EXTENSIONS.has(key)) throw new Error(`扩展 id「${key}」是应用自己的`);
    chatStore.mutateSettings((settings) => {
      const extensions = isObj(settings['extension_settings'])
        ? settings['extension_settings']
        : {};
      settings['extension_settings'] = extensions;
      const owned = scriptExtensionIds(extensions);
      if (!owned.includes(key) && key in extensions)
        throw new Error(`扩展 id「${key}」不是脚本创建的`);
      if (value === undefined || value === null) {
        delete extensions[key];
        extensions[SCRIPT_EXTENSIONS_KEY] = owned.filter((other) => other !== key);
        return;
      }
      extensions[key] = obj(value, '扩展变量');
      if (!owned.includes(key)) extensions[SCRIPT_EXTENSIONS_KEY] = [...owned, key];
    });
  },

  // ---- prompt injections ----
  'inject.add': ([prompts, once]) => {
    if (!Array.isArray(prompts)) throw new Error('注入必须是数组');
    const injects: ScriptInject[] = prompts.filter(isObj).map((prompt) => ({
      id: str(prompt['id'], '注入 id'),
      position: injectPosition(prompt['position']) ?? injectPosition('in_chat')!,
      depth: Number(prompt['depth']) || 0,
      role: injectRole(prompt['role']),
      content: typeof prompt['content'] === 'string' ? prompt['content'] : '',
      scan: prompt['scan'] === true,
      once: once === true,
      filtered: prompt['filtered'] === true,
    }));
    scriptInjects.set(injects);
  },

  'inject.remove': ([ids]) => scriptInjects.remove(strings(ids)),

  'macro.changed': ([custom]) => {
    scriptMacros.custom = custom === true;
    macroDisplay.refresh();
  },

  // ---- models of an address the script names ----
  'models.list': ([config], from) => {
    const wanted = obj(config, '接口配置');
    const key = typeof wanted['key'] === 'string' ? wanted['key'] : undefined;
    return listModels({ apiurl: str(wanted['apiurl'], 'apiurl'), ...(key ? { key } : {}) }, from);
  },
};
