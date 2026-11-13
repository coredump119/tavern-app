/**
 * World Info files for the editor (DEV_NOTES §9.20): list / read / write / delete / rename,
 * globalSelect bookkeeping and character `data.extensions.world` link updates. Orchestration only.
 */
import {
  convertForeignLorebook,
  getFreeWorldName,
  globalSelectOf,
  isWorldInfoBook,
  newWorldInfoBook,
  renameInGlobalSelect,
  replaceInCharLore,
  sanitizeFilename,
  setGlobalSelect,
  type WIBookData,
} from '@tm/core';
import { CharacterBookSchema, characterBookToWorldInfo } from '@tm/formats';
import { cardRead, cardWrite, dataDelete, dataList, dataReadText, dataWriteText } from './ipc';

export const WORLDS_DIR = 'worlds';

const fileOf = (name: string) => `${WORLDS_DIR}/${sanitizeFilename(`${name}.json`)}`;

/** the last listing, for callers that cannot wait (ST's `world_names`) */
let known: readonly string[] = [];
export const knownWorldNames = (): readonly string[] => known;

export async function listWorldNames(root: string): Promise<string[]> {
  const names = (await dataList(root, WORLDS_DIR, 'json')).map((f) => f.replace(/\.json$/i, ''));
  known = names;
  return names;
}

export async function readWorld(root: string, name: string): Promise<WIBookData> {
  const data = JSON.parse(await dataReadText(root, fileOf(name))) as unknown;
  if (!isWorldInfoBook(data)) throw new Error(`「${name}」不是世界书文件（没有 entries）`);
  if (!data.entries || typeof data.entries !== 'object') data.entries = {};
  return data;
}

/** `/api/worldinfo/edit`: 4-space JSON, sanitized file name */
export async function writeWorld(root: string, name: string, book: WIBookData): Promise<void> {
  if (!name) throw new Error('世界书必须有名字');
  if (!isWorldInfoBook(book)) throw new Error('世界书必须有 entries');
  await dataWriteText(root, fileOf(name), JSON.stringify(book, null, 4));
}

/** `createNewWorldInfo`: refuses an existing name (sanitized, case-insensitive like the file system) */
export async function createWorld(root: string, wanted?: string): Promise<string> {
  const names = await listWorldNames(root);
  const name = (wanted?.trim() || getFreeWorldName(names)) ?? 'New World';
  const clean = sanitizeFilename(name);
  if (!clean) throw new Error('名字无效');
  if (names.some((n) => n.toLowerCase() === clean.toLowerCase()))
    throw new Error(`已经有叫「${clean}」的世界书`);
  await writeWorld(root, clean, newWorldInfoBook());
  return clean;
}

/** `deleteWorldInfo`: the file, then globalSelect, characters' extra books and the persona lorebook link. Returns updated settings or null. */
export async function deleteWorld(
  root: string,
  name: string,
  settings: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  await dataDelete(root, fileOf(name));
  if (!settings) return null;
  const next = structuredClone(settings);
  let changed = false;
  const list = globalSelectOf(next);
  if (list.includes(name)) {
    setGlobalSelect(
      next,
      list.filter((n) => n !== name),
    );
    changed = true;
  }
  if (replaceInCharLore(next, name, null)) changed = true;
  // ST deleteWorldInfo: the persona lorebook link is cleared too
  const pu = (next['power_user'] as Record<string, unknown> | undefined) ?? {};
  if (pu['persona_description_lorebook'] === name) {
    next['power_user'] = { ...pu, persona_description_lorebook: '' };
    changed = true;
  }
  return changed ? next : null;
}

export interface RenameWorldResult {
  name: string;
  settings: Record<string, unknown> | null;
  /** avatars whose card points at the old name (ST asks before updating them) */
  linkedAvatars: string[];
}

/** `renameWorldInfo`: save as new → delete old → globalSelect and extra books; reports linked characters. */
export async function renameWorld(
  root: string,
  oldName: string,
  newName: string,
  book: WIBookData,
  settings: Record<string, unknown> | null,
  avatars: readonly string[],
): Promise<RenameWorldResult> {
  const clean = sanitizeFilename(newName.trim());
  if (!clean || clean === oldName) throw new Error('名字没有变化');
  const names = await listWorldNames(root);
  if (names.some((n) => n.toLowerCase() === clean.toLowerCase() && n !== oldName))
    throw new Error(`已经有叫「${clean}」的世界书`);
  await writeWorld(root, clean, book);
  await dataDelete(root, fileOf(oldName));
  let next: Record<string, unknown> | null = null;
  if (settings) {
    const copy = structuredClone(settings);
    const selected = renameInGlobalSelect(copy, oldName, clean);
    const extra = replaceInCharLore(copy, oldName, clean);
    if (selected || extra) next = copy;
  }
  const linkedAvatars: string[] = [];
  for (const avatar of avatars) {
    try {
      const card = JSON.parse(await cardRead(`${root}/characters/${avatar}`)) as {
        data?: { extensions?: { world?: string } };
      };
      if (card.data?.extensions?.world === oldName) linkedAvatars.push(avatar);
    } catch {
      /* unreadable card: skip */
    }
  }
  return { name: clean, settings: next, linkedAvatars };
}

/** `updateWorldInfoLinks` primary links (`/api/characters/merge-attributes` data.extensions.world) */
export async function relinkCharacters(
  root: string,
  avatars: readonly string[],
  newName: string,
): Promise<number> {
  let n = 0;
  for (const avatar of avatars) {
    const path = `${root}/characters/${avatar}`;
    const card = JSON.parse(await cardRead(path)) as Record<string, unknown>;
    const data = (card['data'] as Record<string, unknown> | undefined) ?? {};
    const ext = (data['extensions'] as Record<string, unknown> | undefined) ?? {};
    card['data'] = { ...data, extensions: { ...ext, world: newName } };
    await cardWrite(path, JSON.stringify(card));
    n++;
  }
  return n;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function fromCharacterBook(raw: unknown): WIBookData {
  const parsed = CharacterBookSchema.safeParse(raw);
  if (!parsed.success) throw new Error('卡内世界书的格式不对');
  return characterBookToWorldInfo(parsed.data) as unknown as WIBookData;
}

/** The JSON of a picked file → a world book; an `entries` array is read as a card's character_book. */
export function worldBookFromImport(raw: unknown): WIBookData {
  const obj = record(raw);
  if (!obj) throw new Error('不是世界书文件');
  // NovelAI / Agnai / RisuAI books are converted the way ST does (DEV_NOTES §9.36)
  const foreign = convertForeignLorebook(obj);
  if (foreign) return foreign;
  if (Array.isArray(obj['entries'])) return fromCharacterBook(obj);
  if (!record(obj['entries'])) throw new Error('不是世界书文件（没有 entries）');
  return obj as WIBookData;
}

/** ST `/api/worldinfo/import`: the book takes the file's name; a book of that name is replaced */
export async function importWorldBook(
  root: string,
  fileName: string,
  raw: unknown,
): Promise<string> {
  // ST: `path.parse(sanitize(originalname)).name` — the last extension goes, whichever it is
  const clean = sanitizeFilename(fileName);
  const dot = clean.lastIndexOf('.');
  const name = dot > 0 ? clean.slice(0, dot) : clean;
  if (!name) throw new Error('文件名无效');
  await writeWorld(root, name, worldBookFromImport(raw));
  return name;
}

/**
 * The name ST `importEmbeddedWorldInfo` gives a card's embedded book: its own name, else
 * `<character>'s Lorebook`. null when the card carries no book.
 */
export function embeddedWorldName(card: Record<string, unknown>): string | null {
  const data = record(card['data']);
  const book = record(data?.['character_book']);
  if (!book || !Array.isArray(book['entries'])) return null;
  const own = typeof book['name'] === 'string' ? book['name'].trim() : '';
  const owner = String(data?.['name'] ?? card['name'] ?? '');
  return sanitizeFilename(own || `${owner}'s Lorebook`) || null;
}

/** Writes the card's embedded book as `worlds/<name>.json` (replacing one of that name); the caller links it. */
export async function importEmbeddedWorld(
  root: string,
  card: Record<string, unknown>,
): Promise<string> {
  const name = embeddedWorldName(card);
  if (!name) throw new Error('这张卡没有内嵌世界书');
  await writeWorld(root, name, fromCharacterBook(record(card['data'])?.['character_book']));
  return name;
}
