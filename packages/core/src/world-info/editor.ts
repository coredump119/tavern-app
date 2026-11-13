/**
 * World Info editor data operations (ST world-info.js editor half — DEV_NOTES §9.20):
 * entry template / uid / create / duplicate / delete, keyword splitting, strategy and position
 * pickers, `originalData` mirroring for books imported from character cards, book names.
 * Pure: books are plain objects `{ entries: { [uid]: entry }, originalData? }` mutated in place.
 */
import { parseRegexFromString } from '../util/regex.js';
import {
  DEFAULT_DEPTH,
  DEFAULT_WEIGHT,
  GENERATION_TYPE_TRIGGERS,
  WORLD_INFO_LOGIC,
  WORLD_INFO_POSITION,
} from './types.js';

export type WIBookData = Record<string, unknown> & {
  entries: Record<string, Record<string, unknown>>;
};
export type WIEntryData = Record<string, unknown>;

/** `newWorldInfoEntryTemplate` (excludeFromTemplate fields dropped) */
export function newWorldInfoEntryTemplate(): WIEntryData {
  return {
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: WORLD_INFO_LOGIC.AND_ANY,
    addMemo: false,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: DEFAULT_DEPTH,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: DEFAULT_WEIGHT,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
  };
}

/** `{ entries: {} }` — what `createNewWorldInfo` saves */
export function newWorldInfoBook(): WIBookData {
  return { entries: {} };
}

/** `getFreeWorldEntryUid`: lowest non-negative integer not used as an entries key */
export function getFreeWorldEntryUid(book: WIBookData): number | null {
  for (let uid = 0; uid < 1_000_000; uid++) if (!(uid in book.entries)) return uid;
  return null;
}

/** `createWorldInfoEntry`: `{ uid, ...template }` added to the book */
export function createWorldInfoEntry(book: WIBookData): WIEntryData | undefined {
  const uid = getFreeWorldEntryUid(book);
  if (uid === null) return undefined;
  const entry: WIEntryData = { uid, ...newWorldInfoEntryTemplate() };
  book.entries[uid] = entry;
  return entry;
}

/** `duplicateWorldInfoEntry`: a new entry carrying every field of `uid` except the uid */
export function duplicateWorldInfoEntry(book: WIBookData, uid: number): WIEntryData | undefined {
  const source = book.entries[uid];
  if (!source) return undefined;
  const copy = structuredClone(source);
  delete copy['uid'];
  const entry = createWorldInfoEntry(book);
  if (!entry) return undefined;
  Object.assign(entry, copy);
  return entry;
}

/** `deleteWorldInfoEntry` + `deleteWIOriginalDataValue` */
export function deleteWorldInfoEntry(book: WIBookData, uid: number): boolean {
  if (!book.entries[uid]) return false;
  delete book.entries[uid];
  const original = book['originalData'] as { entries?: unknown } | undefined;
  if (original && Array.isArray(original.entries)) {
    // eslint-disable-next-line eqeqeq
    const i = (original.entries as Array<{ uid?: unknown }>).findIndex((x) => x.uid == uid);
    if (i >= 0) original.entries.splice(i, 1);
  }
  return true;
}

/** `originalWIDataKeyMap` + the paths ST mirrors directly (group / outlet / character filter). */
export const ORIGINAL_WI_DATA_KEY_MAP: Readonly<Record<string, string>> = {
  displayIndex: 'extensions.display_index',
  excludeRecursion: 'extensions.exclude_recursion',
  preventRecursion: 'extensions.prevent_recursion',
  delayUntilRecursion: 'extensions.delay_until_recursion',
  selectiveLogic: 'selectiveLogic',
  comment: 'comment',
  constant: 'constant',
  order: 'insertion_order',
  depth: 'extensions.depth',
  probability: 'extensions.probability',
  position: 'extensions.position',
  role: 'extensions.role',
  content: 'content',
  enabled: 'enabled',
  key: 'keys',
  keysecondary: 'secondary_keys',
  selective: 'selective',
  matchWholeWords: 'extensions.match_whole_words',
  useGroupScoring: 'extensions.use_group_scoring',
  caseSensitive: 'extensions.case_sensitive',
  matchPersonaDescription: 'extensions.match_persona_description',
  matchCharacterDescription: 'extensions.match_character_description',
  matchCharacterPersonality: 'extensions.match_character_personality',
  matchCharacterDepthPrompt: 'extensions.match_character_depth_prompt',
  matchScenario: 'extensions.match_scenario',
  matchCreatorNotes: 'extensions.match_creator_notes',
  scanDepth: 'extensions.scan_depth',
  automationId: 'extensions.automation_id',
  vectorized: 'extensions.vectorized',
  groupOverride: 'extensions.group_override',
  groupWeight: 'extensions.group_weight',
  sticky: 'extensions.sticky',
  cooldown: 'extensions.cooldown',
  delay: 'extensions.delay',
  triggers: 'extensions.triggers',
  ignoreBudget: 'extensions.ignore_budget',
  group: 'extensions.group',
  outletName: 'extensions.outlet_name',
  characterFilter: 'character_filter',
};

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = target;
  for (const p of parts.slice(0, -1)) {
    const next = cur[p];
    if (!next || typeof next !== 'object') cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** `setWIOriginalDataValue`: mirror into the imported card book entry with the same uid */
export function setWIOriginalDataValue(
  book: WIBookData,
  uid: number,
  path: string,
  value: unknown,
): void {
  const original = book['originalData'] as { entries?: unknown } | undefined;
  if (!original || !Array.isArray(original.entries)) return;
  const entry = (original.entries as Array<Record<string, unknown>>).find((x) => x['uid'] === uid);
  if (entry) setByPath(entry, path, structuredClone(value));
}

/**
 * Set one entry field the way the ST editor does: the entry value plus its `originalData` mirror.
 * `disable` mirrors as `enabled = !disable`; `position` also writes `before_char` / `after_char`.
 */
export function setWorldInfoEntryField(
  book: WIBookData,
  uid: number,
  field: string,
  value: unknown,
): void {
  const entry = book.entries[uid];
  if (!entry) return;
  entry[field] = value;
  if (field === 'disable') {
    setWIOriginalDataValue(book, uid, 'enabled', !value);
    return;
  }
  if (field === 'position') {
    setWIOriginalDataValue(book, uid, 'position', value == 0 ? 'before_char' : 'after_char');
  }
  const path = ORIGINAL_WI_DATA_KEY_MAP[field];
  if (path) setWIOriginalDataValue(book, uid, path, value);
}

// ---- keywords ----

const isValidRegex = (s: string) => parseRegexFromString(s) !== null;

/**
 * `splitKeywordsAndRegexes` (select2 customTokenizer): commas split keywords, except inside a
 * `/regex/` that is still open; a token that starts with `/` but is not a valid regex is split again.
 */
export function splitKeywordsAndRegexes(input: string): string[] {
  const out: string[] = [];
  let current = input;
  let insideRegex = false;
  let regexClosed = false;
  for (let i = 0; i < current.length; i++) {
    const ch = current[i];
    if (ch === '/' && (i === 0 || current[i - 1] !== '\\')) {
      if (!insideRegex) insideRegex = true;
      else if (!regexClosed) regexClosed = true;
    }
    if (ch === ',') {
      const token = current.slice(0, i).trim();
      if (insideRegex && !regexClosed) continue;
      if (token) {
        if (token.startsWith('/') && !isValidRegex(token)) {
          out.push(...token.split(',').map((x) => x.trim()));
        } else {
          out.push(token);
        }
      }
      current = current.slice(i + 1);
      insideRegex = false;
      regexClosed = false;
      // ST resets to 0 and then i++ skips the first remaining char (`a,,c` → `,c`). select2 feeds it
      // one keystroke at a time so it never shows; we split whole strings, so restart at index 0.
      i = -1;
    }
  }
  const rest = current.trim();
  if (rest) out.push(rest);
  return out;
}

/** Keys as an editable string (ST plaintext keys mode joins with ", ") */
export const joinKeywords = (keys: unknown): string =>
  Array.isArray(keys) ? keys.map(String).join(', ') : '';

// ---- strategy / position pickers ----

export type WIEntryStrategy = 'constant' | 'normal' | 'vectorized';

export function entryStrategy(entry: WIEntryData): WIEntryStrategy {
  if (entry['constant']) return 'constant';
  if (entry['vectorized']) return 'vectorized';
  return 'normal';
}

/** `entryStateSelector` input handler */
export function setEntryStrategy(book: WIBookData, uid: number, strategy: WIEntryStrategy): void {
  setWorldInfoEntryField(book, uid, 'constant', strategy === 'constant');
  setWorldInfoEntryField(book, uid, 'vectorized', strategy === 'vectorized');
}

/** The entry `position` select: value + data-role (atDepth carries a role, others null) */
export const WI_POSITION_OPTIONS: ReadonlyArray<{
  id: string;
  position: number;
  role: number | null;
  label: string;
}> = [
  { id: '0', position: WORLD_INFO_POSITION.before, role: null, label: '角色定义之前' },
  { id: '1', position: WORLD_INFO_POSITION.after, role: null, label: '角色定义之后' },
  { id: '5', position: WORLD_INFO_POSITION.EMTop, role: null, label: '示例消息之前' },
  { id: '6', position: WORLD_INFO_POSITION.EMBottom, role: null, label: '示例消息之后' },
  { id: '2', position: WORLD_INFO_POSITION.ANTop, role: null, label: '作者注释之前' },
  { id: '3', position: WORLD_INFO_POSITION.ANBottom, role: null, label: '作者注释之后' },
  { id: '4:0', position: WORLD_INFO_POSITION.atDepth, role: 0, label: '@深度 · system' },
  { id: '4:1', position: WORLD_INFO_POSITION.atDepth, role: 1, label: '@深度 · user' },
  { id: '4:2', position: WORLD_INFO_POSITION.atDepth, role: 2, label: '@深度 · assistant' },
  { id: '7', position: WORLD_INFO_POSITION.outlet, role: null, label: 'Outlet（宏取用）' },
];

export function positionOptionId(entry: WIEntryData): string {
  const pos = Number(entry['position'] ?? 0);
  if (pos === WORLD_INFO_POSITION.atDepth) return `4:${Number(entry['role'] ?? 0) || 0}`;
  return String(pos);
}

/** `position` input handler: atDepth takes the option's role, others clear it */
export function setEntryPosition(book: WIBookData, uid: number, optionId: string): void {
  const opt = WI_POSITION_OPTIONS.find((o) => o.id === optionId);
  if (!opt) return;
  setWorldInfoEntryField(book, uid, 'position', opt.position);
  setWorldInfoEntryField(book, uid, 'role', opt.role);
}

export const WI_LOGIC_OPTIONS = [
  { value: WORLD_INFO_LOGIC.AND_ANY, label: 'AND ANY（含任一）' },
  { value: WORLD_INFO_LOGIC.AND_ALL, label: 'AND ALL（含全部）' },
  { value: WORLD_INFO_LOGIC.NOT_ALL, label: 'NOT ALL（不全含）' },
  { value: WORLD_INFO_LOGIC.NOT_ANY, label: 'NOT ANY（都不含）' },
] as const;

export const WI_TRIGGER_OPTIONS: readonly string[] = GENERATION_TYPE_TRIGGERS;

/** Entry title in the list: comment, else the keys, else `#uid` */
export function entryTitle(entry: WIEntryData): string {
  const c = String(entry['comment'] ?? '').trim();
  if (c) return c;
  const keys = joinKeywords(entry['key']);
  return keys || `#${String(entry['uid'] ?? '')}`;
}

/** Display order: displayIndex, then uid (ST's default "Order" list sort) */
export function sortedEntries(book: WIBookData): WIEntryData[] {
  return Object.values(book.entries).sort(
    (a, b) =>
      Number(a['displayIndex'] ?? 0) - Number(b['displayIndex'] ?? 0) ||
      Number(a['uid'] ?? 0) - Number(b['uid'] ?? 0),
  );
}

/** `#world_info_sort_order` options (value = ST's option value; DEV_NOTES §9.36) */
export const WI_SORT_OPTIONS: ReadonlyArray<{
  value: number;
  label: string;
  rule?: 'priority' | 'custom' | 'length';
  field?: string;
  order?: 'asc' | 'desc';
}> = [
  { value: 0, label: '优先级', rule: 'priority' },
  { value: 13, label: '自定义', rule: 'custom' },
  { value: 1, label: '标题 A-Z', field: 'comment', order: 'asc' },
  { value: 2, label: '标题 Z-A', field: 'comment', order: 'desc' },
  { value: 3, label: '字数 ↗', rule: 'length', field: 'content', order: 'asc' },
  { value: 4, label: '字数 ↘', rule: 'length', field: 'content', order: 'desc' },
  { value: 5, label: '深度 ↗', field: 'depth', order: 'asc' },
  { value: 6, label: '深度 ↘', field: 'depth', order: 'desc' },
  { value: 7, label: '顺序 ↗', field: 'order', order: 'asc' },
  { value: 8, label: '顺序 ↘', field: 'order', order: 'desc' },
  { value: 9, label: 'UID ↗', field: 'uid', order: 'asc' },
  { value: 10, label: 'UID ↘', field: 'uid', order: 'desc' },
  { value: 11, label: '触发率 ↗', field: 'probability', order: 'asc' },
  { value: 12, label: '触发率 ↘', field: 'probability', order: 'desc' },
];
export const WI_SORT_CUSTOM = 13;

/** `sortWorldInfoEntries`: primary rule, then `order` descending, then `uid` ascending. Returns a new array. */
export function sortWorldEntries(entries: readonly WIEntryData[], value: number): WIEntryData[] {
  const option = WI_SORT_OPTIONS.find((o) => o.value === value) ?? WI_SORT_OPTIONS[0]!;
  const sign = option.order === 'desc' ? -1 : 1;
  const state = (e: WIEntryData) => (e['disable'] ? 2 : e['constant'] ? 0 : 1);
  let primary: (a: WIEntryData, b: WIEntryData) => number;
  if (option.rule === 'custom') {
    primary = (a, b) => Number(a['displayIndex'] ?? 0) - Number(b['displayIndex'] ?? 0);
  } else if (option.rule === 'priority') {
    primary = (a, b) => state(a) - state(b);
  } else {
    const field = option.field ?? 'uid';
    primary = (a, b) => {
      const av = a[field];
      const bv = b[field];
      if (typeof av === 'string' && typeof bv === 'string') {
        return option.rule === 'length'
          ? sign * (av.length - bv.length)
          : sign * av.localeCompare(bv);
      }
      return sign * (Number(av) - Number(bv)) || 0;
    };
  }
  return [...entries].sort(
    (a, b) =>
      primary(a, b) ||
      Number(b['order'] ?? 0) - Number(a['order'] ?? 0) ||
      Number(a['uid'] ?? 0) - Number(b['uid'] ?? 0),
  );
}

/**
 * ST sortable `stop`: renumber the whole book in the given uid order, starting from the first
 * entry's current displayIndex; mirrors into `originalData`.
 */
export function reorderWorldEntries(book: WIBookData, uidsInOrder: readonly number[]): void {
  const first = uidsInOrder[0];
  if (first === undefined) return;
  const min = Number(book.entries[String(first)]?.['displayIndex'] ?? 0) || 0;
  uidsInOrder.forEach((uid, index) => {
    const entry = book.entries[String(uid)];
    if (!entry) return;
    entry['displayIndex'] = min + index;
    setWIOriginalDataValue(book, uid, 'extensions.display_index', min + index);
  });
}

// ---- books ----

/** `getFreeWorldName`: `<base> (n)` with the first unused n, stripping an existing ` (n)` */
export function getFreeWorldName(
  names: readonly string[],
  worldName = 'New World',
  { stripIndex = true }: { stripIndex?: boolean } = {},
): string | undefined {
  const base = stripIndex ? worldName.replace(/\s*\(\d+\)$/, '') : worldName;
  for (let i = 1; i < 100_000; i++) {
    const name = `${base} (${i})`;
    if (!names.includes(name)) return name;
  }
  return undefined;
}

/** `/api/worldinfo/edit` body check */
export function isWorldInfoBook(data: unknown): data is WIBookData {
  return !!data && typeof data === 'object' && 'entries' in data;
}

/** settings.json `world_info_settings.world_info.globalSelect` (selected_world_info) */
export function globalSelectOf(settings: Record<string, unknown>): string[] {
  const wi = settings['world_info_settings'] as Record<string, unknown> | undefined;
  const inner = wi?.['world_info'] as { globalSelect?: unknown } | undefined;
  return Array.isArray(inner?.globalSelect) ? inner.globalSelect.map(String) : [];
}

export function setGlobalSelect(settings: Record<string, unknown>, names: readonly string[]): void {
  const wi = (settings['world_info_settings'] as Record<string, unknown> | undefined) ?? {};
  const inner = (wi['world_info'] as Record<string, unknown> | undefined) ?? {};
  settings['world_info_settings'] = { ...wi, world_info: { ...inner, globalSelect: [...names] } };
}

/** `world_info.charLore`: a character's extra books, keyed by the card's file stem */
export function charLoreOf(settings: Record<string, unknown>, fileStem: string): string[] {
  const wi = settings['world_info_settings'] as Record<string, unknown> | undefined;
  const inner = wi?.['world_info'] as { charLore?: unknown } | undefined;
  if (!Array.isArray(inner?.charLore)) return [];
  const entry = (inner.charLore as Array<{ name?: unknown; extraBooks?: unknown } | null>).find(
    (e) => e?.name === fileStem,
  );
  return Array.isArray(entry?.extraBooks)
    ? entry.extraBooks.filter((n): n is string => typeof n === 'string')
    : [];
}

/** ST `openCharacterWorldPopup`: replace the character's extra books; an empty list drops its entry */
export function setCharLore(
  settings: Record<string, unknown>,
  fileStem: string,
  books: readonly string[],
): void {
  const wi = (settings['world_info_settings'] as Record<string, unknown> | undefined) ?? {};
  const inner = (wi['world_info'] as Record<string, unknown> | undefined) ?? {};
  const list = Array.isArray(inner['charLore'])
    ? (inner['charLore'] as Array<Record<string, unknown>>).slice()
    : [];
  const i = list.findIndex((e) => e?.['name'] === fileStem);
  if (books.length === 0) {
    if (i >= 0) list.splice(i, 1);
  } else if (i >= 0) list[i] = { ...list[i], extraBooks: [...books] };
  else list.push({ name: fileStem, extraBooks: [...books] });
  settings['world_info_settings'] = { ...wi, world_info: { ...inner, charLore: list } };
}

/**
 * A book was renamed (`newName`) or deleted (null): every character's extra books follow, and an
 * entry left without books is dropped. Returns whether anything changed.
 */
export function replaceInCharLore(
  settings: Record<string, unknown>,
  oldName: string,
  newName: string | null,
): boolean {
  const wi = (settings['world_info_settings'] as Record<string, unknown> | undefined) ?? {};
  const inner = (wi['world_info'] as Record<string, unknown> | undefined) ?? {};
  if (!Array.isArray(inner['charLore'])) return false;
  let changed = false;
  const charLore: Array<Record<string, unknown>> = [];
  for (const entry of inner['charLore'] as Array<Record<string, unknown>>) {
    const books = Array.isArray(entry?.['extraBooks']) ? (entry['extraBooks'] as unknown[]) : [];
    if (!books.includes(oldName)) {
      charLore.push(entry);
      continue;
    }
    changed = true;
    const rest = books.filter((b) => b !== oldName);
    if (newName !== null && !rest.includes(newName)) rest.push(newName);
    if (rest.length > 0) charLore.push({ ...entry, extraBooks: rest });
  }
  if (changed) settings['world_info_settings'] = { ...wi, world_info: { ...inner, charLore } };
  return changed;
}

/** rename: the old name in globalSelect is replaced in place */
export function renameInGlobalSelect(
  settings: Record<string, unknown>,
  oldName: string,
  newName: string,
): boolean {
  const list = globalSelectOf(settings);
  const i = list.indexOf(oldName);
  if (i < 0) return false;
  list[i] = newName;
  setGlobalSelect(settings, list);
  return true;
}
