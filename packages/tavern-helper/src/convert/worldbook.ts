/**
 * World info ("lorebook") shape converters between SillyTavern's on-disk format (a world file's
 * `{ entries: { [uid]: entry } }` and settings.json `world_info_settings`) and the data shapes of
 * the TavernHelper script API: `WorldbookEntry`, the legacy flat `LorebookEntry`, `LorebookSettings`.
 * Pure: no DOM, no dependencies, inputs are never mutated and outputs never alias them.
 */

export interface WorldbookEntry {
  /** only meaningful inside its own worldbook */
  uid: number;
  name: string;
  enabled: boolean;
  strategy: {
    type: 'constant' | 'selective' | 'vectorized';
    keys: (string | RegExp)[];
    keys_secondary: {
      logic: 'and_any' | 'and_all' | 'not_all' | 'not_any';
      keys: (string | RegExp)[];
    };
    scan_depth: 'same_as_global' | number;
  };
  position: {
    type:
      | 'before_character_definition'
      | 'after_character_definition'
      | 'before_example_messages'
      | 'after_example_messages'
      | 'before_author_note'
      | 'after_author_note'
      | 'at_depth'
      | 'outlet';
    /** used by `at_depth` only */
    role: 'system' | 'assistant' | 'user';
    /** used by `at_depth` only */
    depth: number;
    order: number;
  };
  content: string;
  probability: number;
  recursion: {
    prevent_incoming: boolean;
    prevent_outgoing: boolean;
    delay_until: null | number;
  };
  effect: {
    sticky: null | number;
    cooldown: null | number;
    delay: null | number;
  };
  extra?: Record<string, unknown>;
}

/** @deprecated legacy flat shape (`getLorebookEntries` and friends) */
export interface LorebookEntry {
  uid: number;
  display_index: number;
  comment: string;
  enabled: boolean;
  type: 'constant' | 'selective' | 'vectorized';
  position:
    | 'before_character_definition'
    | 'after_character_definition'
    | 'before_example_messages'
    | 'after_example_messages'
    | 'before_author_note'
    | 'after_author_note'
    | 'at_depth_as_system'
    | 'at_depth_as_assistant'
    | 'at_depth_as_user';
  depth: number | null;
  order: number;
  probability: number;
  keys: string[];
  logic: 'and_any' | 'and_all' | 'not_all' | 'not_any';
  filters: string[];
  scan_depth: 'same_as_global' | number;
  case_sensitive: 'same_as_global' | boolean;
  match_whole_words: 'same_as_global' | boolean;
  use_group_scoring: 'same_as_global' | boolean;
  automation_id: string | null;
  exclude_recursion: boolean;
  prevent_recursion: boolean;
  delay_until_recursion: boolean | number;
  content: string;
  group: string;
  group_prioritized: boolean;
  group_weight: number;
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  /** @deprecated alias of `keys`; not in the public declaration but still emitted. Read-only. */
  key?: string[];
  /** @deprecated alias of `filters`; not in the public declaration but still emitted. Read-only. */
  filter?: string[];
}

/** @deprecated `getLorebookSettings` / `setLorebookSettings` */
export interface LorebookSettings {
  selected_global_lorebooks: string[];
  scan_depth: number;
  context_percentage: number;
  /** 0 = disabled */
  budget_cap: number;
  min_activations: number;
  /** 0 = unlimited */
  max_depth: number;
  max_recursion_steps: number;
  insertion_strategy: 'evenly' | 'character_first' | 'global_first';
  include_names: boolean;
  recursive: boolean;
  case_sensitive: boolean;
  match_whole_words: boolean;
  use_group_scoring: boolean;
  overflow_alert: boolean;
}

export type StWorldFile = {
  entries: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

type StEntry = Record<string, unknown>;
type StrategyType = WorldbookEntry['strategy']['type'];

// Name tables indexed by the number ST stores.
/** world_info_position */
const POSITIONS: readonly WorldbookEntry['position']['type'][] = [
  'before_character_definition',
  'after_character_definition',
  'before_author_note',
  'after_author_note',
  'at_depth',
  'before_example_messages',
  'after_example_messages',
  'outlet',
];
const AT_DEPTH = 4;
/** world_info_logic */
const LOGICS: readonly LorebookEntry['logic'][] = ['and_any', 'not_all', 'not_any', 'and_all'];
/** extension_prompt_roles */
const ROLES: readonly WorldbookEntry['position']['role'][] = ['system', 'user', 'assistant'];
const FLAT_DEPTH_POSITIONS: readonly LorebookEntry['position'][] = [
  'at_depth_as_system',
  'at_depth_as_user',
  'at_depth_as_assistant',
];
/** world_info_insertion_strategy */
const STRATEGIES: readonly LorebookSettings['insertion_strategy'][] = [
  'evenly',
  'character_first',
  'global_first',
];
const STRATEGY_TYPES: readonly StrategyType[] = ['constant', 'selective', 'vectorized'];

const DEFAULT_DEPTH = 4;
const DEFAULT_ORDER = 100;
const SAME_AS_GLOBAL = 'same_as_global';

/**
 * ST entry fields the nested shape has no place for but upstream hands through under their ST
 * names: a read copies them onto the entry, a write takes them back when the entry carries them.
 */
const PASSTHROUGH_KEYS = [
  'addMemo',
  'matchPersonaDescription',
  'matchCharacterDescription',
  'matchCharacterPersonality',
  'matchCharacterDepthPrompt',
  'matchScenario',
  'matchCreatorNotes',
  'group',
  'groupOverride',
  'groupWeight',
  'caseSensitive',
  'matchWholeWords',
  'useGroupScoring',
  'automationId',
  'ignoreBudget',
  'outletName',
  'triggers',
  'characterFilter',
] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const NOTHING: Record<string, unknown> = Object.freeze({});
const record = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : NOTHING);
const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const finite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
/** Like `finite`, but also reads the numeric strings old world files and settings hold. */
const numeric = (v: unknown): number | undefined =>
  finite(typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
/** ST stores "off" timers as null or 0; the script API always says null. */
const positive = (v: unknown): number | null => {
  const n = numeric(v);
  return n !== undefined && n > 0 ? n : null;
};
const isUid = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isPrimitive = (v: unknown): boolean => typeof v !== 'object' || v === null;
const isStrategyType = (v: unknown): v is StrategyType =>
  STRATEGY_TYPES.includes(v as StrategyType);

const nameAt = <T extends string>(names: readonly T[], index: unknown): T | undefined =>
  typeof index === 'number' ? names[index] : undefined;
const indexOf = (names: readonly string[], name: unknown, fallback: number): number => {
  const index = typeof name === 'string' ? names.indexOf(name) : -1;
  return index < 0 ? fallback : index;
};

/** A value safe to put into the output: objects are copied, flat arrays the cheap way. */
function carry<T>(v: T): T {
  if (isPrimitive(v)) return v;
  if (Array.isArray(v) && v.every(isPrimitive)) return v.slice() as T;
  return structuredClone(v);
}

function carryEntry(entry: StEntry): StEntry {
  const out: StEntry = {};
  for (const key of Object.keys(entry)) out[key] = carry(entry[key]);
  return out;
}

/** ST's `newWorldInfoEntryTemplate`, except `addMemo` (upstream shows the title of what it creates). */
function newStEntry(uid: number): StEntry {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: DEFAULT_ORDER,
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
    groupWeight: 100,
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
    characterFilter: { isExclude: false, names: [], tags: [] },
    // ST sorts an entry without one by its uid
    displayIndex: uid,
  };
}

// ---------------------------------------------------------------------------------------------
// keys

const REGEX_KEY = /^\/([\w\W]+?)\/([gimsuy]*)$/;
const BARE_SLASH = /(^|[^\\])\//;

/**
 * ST's `parseRegexFromString`: a `/pattern/flags` key whose inner slashes are all escaped. The
 * pattern is compiled as written (`\/` already matches a slash), so it prints back to the same key.
 */
function parseRegexKey(key: string): RegExp | null {
  if (!key.startsWith('/')) return null;
  const match = REGEX_KEY.exec(key);
  const pattern = match?.[1];
  if (pattern === undefined || BARE_SLASH.test(pattern)) return null;
  try {
    return new RegExp(pattern, match?.[2] ?? '');
  } catch {
    return null;
  }
}

function toKeys(stored: unknown): (string | RegExp)[] {
  return strings(stored).map((key) => parseRegexKey(key) ?? key);
}

/** Script keys → ST strings; a RegExp (from any realm) prints as `/source/flags`. */
function fromKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  const out: string[] = [];
  for (const key of keys) {
    if (typeof key === 'string') out.push(key);
    else if (typeof key === 'number') out.push(String(key));
    else if (Object.prototype.toString.call(key) === '[object RegExp]') out.push(String(key));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ST entry → script shapes

/** `[uid, entry]` for everything in the file that can be an entry, in stored order. */
function storedEntries(file: unknown): [number, StEntry][] {
  const entries = isRecord(file) ? file['entries'] : undefined;
  if (typeof entries !== 'object' || entries === null) return [];
  const out: [number, StEntry][] = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) continue;
    const uid = isUid(entry['uid']) ? entry['uid'] : Number(key);
    if (isUid(uid)) out.push([uid, entry]);
  }
  return out;
}

const strategyType = (st: StEntry): StrategyType =>
  st['constant'] === true ? 'constant' : st['vectorized'] === true ? 'vectorized' : 'selective';

function toWorldbookEntry(st: StEntry, uid: number): WorldbookEntry {
  const delayUntil = st['delayUntilRecursion'];
  const entry: WorldbookEntry = {
    uid,
    name: text(st['comment']),
    enabled: st['disable'] !== true,
    strategy: {
      type: strategyType(st),
      keys: toKeys(st['key']),
      keys_secondary: {
        logic: nameAt(LOGICS, st['selectiveLogic']) ?? 'and_any',
        keys: toKeys(st['keysecondary']),
      },
      scan_depth: numeric(st['scanDepth']) ?? SAME_AS_GLOBAL,
    },
    position: {
      type: nameAt(POSITIONS, st['position']) ?? 'before_character_definition',
      role: nameAt(ROLES, st['role']) ?? 'system',
      depth: numeric(st['depth']) ?? DEFAULT_DEPTH,
      order: numeric(st['order']) ?? DEFAULT_ORDER,
    },
    content: text(st['content']),
    // with the switch off ST never rolls, whatever number is stored
    probability: st['useProbability'] === true ? (numeric(st['probability']) ?? 100) : 100,
    recursion: {
      prevent_incoming: st['excludeRecursion'] === true,
      prevent_outgoing: st['preventRecursion'] === true,
      // files from before recursion levels hold `true`, which ST runs as level 1
      delay_until: delayUntil === true ? 1 : positive(delayUntil),
    },
    effect: {
      sticky: positive(st['sticky']),
      cooldown: positive(st['cooldown']),
      delay: positive(st['delay']),
    },
  };
  if (isRecord(st['extra'])) entry.extra = carry(st['extra']);
  const bag = entry as unknown as Record<string, unknown>;
  for (const key of PASSTHROUGH_KEYS) if (key in st) bag[key] = carry(st[key]);
  return entry;
}

/** The positions the flat shape names directly. */
function fixedSlot(position: unknown): LorebookEntry['position'] | undefined {
  const type = nameAt(POSITIONS, position);
  return type === 'at_depth' || type === 'outlet' ? undefined : type;
}

/** The flat position an ST entry reads as; anything that is not a fixed slot counts as at-depth. */
function flatPosition(st: StEntry): LorebookEntry['position'] {
  return (
    fixedSlot(st['position']) ?? nameAt(FLAT_DEPTH_POSITIONS, st['role']) ?? 'at_depth_as_system'
  );
}

function toLorebookEntry(st: StEntry, uid: number): LorebookEntry {
  const keys = strings(st['key']);
  const filters = strings(st['keysecondary']);
  const delayUntil = st['delayUntilRecursion'];
  return {
    uid,
    display_index: numeric(st['displayIndex']) ?? uid,
    comment: text(st['comment']),
    enabled: st['disable'] !== true,
    type: strategyType(st),
    position: flatPosition(st),
    depth: st['position'] === AT_DEPTH ? (numeric(st['depth']) ?? DEFAULT_DEPTH) : null,
    order: numeric(st['order']) ?? DEFAULT_ORDER,
    // the flat shape reports the stored number even while `useProbability` is off
    probability: numeric(st['probability']) ?? 100,
    key: keys.slice(),
    keys,
    logic: nameAt(LOGICS, st['selectiveLogic']) ?? 'and_any',
    filter: filters.slice(),
    filters,
    scan_depth: numeric(st['scanDepth']) ?? SAME_AS_GLOBAL,
    case_sensitive: flag(st['caseSensitive']) ?? SAME_AS_GLOBAL,
    match_whole_words: flag(st['matchWholeWords']) ?? SAME_AS_GLOBAL,
    use_group_scoring: flag(st['useGroupScoring']) ?? SAME_AS_GLOBAL,
    automation_id: text(st['automationId']) || null,
    exclude_recursion: st['excludeRecursion'] === true,
    prevent_recursion: st['preventRecursion'] === true,
    delay_until_recursion: flag(delayUntil) ?? numeric(delayUntil) ?? 0,
    content: text(st['content']),
    group: text(st['group']),
    group_prioritized: st['groupOverride'] === true,
    group_weight: numeric(st['groupWeight']) ?? 100,
    sticky: numeric(st['sticky']) || null,
    cooldown: numeric(st['cooldown']) || null,
    delay: numeric(st['delay']) || null,
  };
}

/**
 * ST world file → script entries, ordered by `displayIndex` like upstream `getWorldbook` (entries
 * without one go last, ties keep the stored order). `/…/flags` keys come back as RegExp. A missing
 * or malformed file gives `[]`.
 */
export function toWorldbookEntries(file: unknown): WorldbookEntry[] {
  const rows = storedEntries(file).map(([uid, st]) => ({
    rank: finite(st['displayIndex']) ?? Infinity,
    entry: toWorldbookEntry(st, uid),
  }));
  rows.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  return rows.map((row) => row.entry);
}

/** ST world file → legacy flat entries, in stored order (upstream does not sort these). */
export function toLorebookEntries(file: unknown): LorebookEntry[] {
  return storedEntries(file).map(([uid, st]) => toLorebookEntry(st, uid));
}

// ---------------------------------------------------------------------------------------------
// script shapes → ST entry

/** Writes every field the nested shape covers onto `st`; a missing one gets upstream's default. */
function applyWorldbookEntry(st: StEntry, th: Record<string, unknown>, displayIndex: number): void {
  const strategy = record(th['strategy']);
  const secondary = record(strategy['keys_secondary']);
  const position = record(th['position']);
  const recursion = record(th['recursion']);
  const effect = record(th['effect']);
  const type = strategy['type'];

  st['displayIndex'] = displayIndex;
  st['comment'] = text(th['name']);
  st['disable'] = th['enabled'] === false;

  // an entry that names no strategy is constant, at depth 4 as system: upstream's new entry
  st['constant'] = isStrategyType(type) ? type === 'constant' : true;
  st['selective'] = type === 'selective';
  st['vectorized'] = type === 'vectorized';
  st['key'] = fromKeys(strategy['keys']);
  st['selectiveLogic'] = indexOf(LOGICS, secondary['logic'], 0);
  st['keysecondary'] = fromKeys(secondary['keys']);
  st['scanDepth'] = finite(strategy['scan_depth']) ?? null;

  st['position'] = indexOf(POSITIONS, position['type'], AT_DEPTH);
  st['role'] = indexOf(ROLES, position['role'], 0);
  st['depth'] = finite(position['depth']) ?? DEFAULT_DEPTH;
  st['order'] = finite(position['order']) ?? DEFAULT_ORDER;

  st['content'] = text(th['content']);

  st['useProbability'] = true;
  st['probability'] = finite(th['probability']) ?? 100;
  st['excludeRecursion'] = recursion['prevent_incoming'] === true;
  st['preventRecursion'] = recursion['prevent_outgoing'] === true;
  st['delayUntilRecursion'] = finite(recursion['delay_until']) ?? 0;
  st['sticky'] = finite(effect['sticky']) ?? null;
  st['cooldown'] = finite(effect['cooldown']) ?? null;
  st['delay'] = finite(effect['delay']) ?? null;

  if (isRecord(th['extra'])) st['extra'] = carry(th['extra']);
  else delete st['extra'];

  for (const key of PASSTHROUGH_KEYS) {
    const value = th[key];
    if (value === undefined) continue;
    // a partial filter fills in around what is there, as upstream's deep merge does
    st[key] =
      key === 'characterFilter' && isRecord(value)
        ? { ...record(st[key]), ...carry(value) }
        : carry(value);
  }
}

/**
 * Script entries (possibly partial) → ST world file.
 * - a missing field gets the default upstream gives a new entry (constant, at depth 4 as system,
 *   order 100, probability 100, enabled); `displayIndex` is the position in `entries`;
 * - a uid that is a non-negative integer and not used earlier in the list is kept, every other
 *   entry gets the lowest free number; items that are not objects are skipped;
 * - an entry that keeps a uid found in `previous` starts from that ST entry, so ST fields outside
 *   the script shape survive (the ones it covers are rewritten); the other top-level keys of
 *   `previous` are carried over as well.
 */
export function fromWorldbookEntries(entries: readonly unknown[], previous?: unknown): StWorldFile {
  const list = Array.isArray(entries) ? entries.filter(isRecord) : [];
  const before = record(previous);
  const beforeEntries = record(before['entries']);

  const taken = new Set<number>();
  const kept = list.map((th) => {
    const uid = th['uid'];
    if (!isUid(uid) || taken.has(uid)) return undefined;
    taken.add(uid);
    return uid;
  });

  const written: StWorldFile['entries'] = {};
  let free = 0;
  list.forEach((th, index) => {
    let uid = kept[index];
    const base = uid === undefined ? undefined : beforeEntries[String(uid)];
    if (uid === undefined) {
      while (taken.has(free)) free++;
      uid = free++;
    }
    const st = isRecord(base) ? carryEntry(base) : newStEntry(uid);
    st['uid'] = uid;
    applyWorldbookEntry(st, th, index);
    written[String(uid)] = st;
  });

  const file: StWorldFile = { entries: written };
  for (const key of Object.keys(before)) if (key !== 'entries') file[key] = carry(before[key]);
  return file;
}

type FieldType = 'string' | 'number' | 'boolean';
type FieldMap = readonly (readonly [flat: string, st: string, type: FieldType])[];

const hasType = (v: unknown, type: FieldType): boolean =>
  type === 'number' ? finite(v) !== undefined : typeof v === type;

/** flat field → ST field, copied as is */
const FLAT_COPIES: FieldMap = [
  ['display_index', 'displayIndex', 'number'],
  ['comment', 'comment', 'string'],
  ['order', 'order', 'number'],
  ['probability', 'probability', 'number'],
  ['content', 'content', 'string'],
  ['exclude_recursion', 'excludeRecursion', 'boolean'],
  ['prevent_recursion', 'preventRecursion', 'boolean'],
  ['group', 'group', 'string'],
  ['group_prioritized', 'groupOverride', 'boolean'],
  ['group_weight', 'groupWeight', 'number'],
];
/** per-entry overrides of a global setting: `'same_as_global'` is ST's null */
const FLAT_OVERRIDES: FieldMap = [
  ['scan_depth', 'scanDepth', 'number'],
  ['case_sensitive', 'caseSensitive', 'boolean'],
  ['match_whole_words', 'matchWholeWords', 'boolean'],
  ['use_group_scoring', 'useGroupScoring', 'boolean'],
];
/** timed effects: null is stored as 0 */
const FLAT_TIMERS = ['sticky', 'cooldown', 'delay'] as const;

/**
 * One partial legacy flat entry applied onto an ST entry: onto a copy of `base`, or onto a fresh
 * default ST entry when there is none. Only fields present with a usable value are written; `uid`
 * is always the argument, never `entry.uid`. The read-only aliases `key` / `filter` are ignored.
 */
export function fromLorebookEntry(
  entry: Record<string, unknown>,
  uid: number,
  base?: Record<string, unknown>,
): Record<string, unknown> {
  const st = isRecord(base) ? carryEntry(base) : newStEntry(uid);
  st['uid'] = uid;
  if (!isRecord(entry)) return st;

  for (const [flat, key, type] of FLAT_COPIES) {
    if (hasType(entry[flat], type)) st[key] = entry[flat];
  }
  for (const [flat, key, type] of FLAT_OVERRIDES) {
    const value = entry[flat];
    if (value === SAME_AS_GLOBAL) st[key] = null;
    else if (hasType(value, type)) st[key] = value;
  }
  for (const key of FLAT_TIMERS) {
    const value = entry[key];
    if (value === null) st[key] = 0;
    else if (finite(value) !== undefined) st[key] = value;
  }

  if (typeof entry['enabled'] === 'boolean') st['disable'] = !entry['enabled'];
  const type = entry['type'];
  if (isStrategyType(type)) {
    st['constant'] = type === 'constant';
    st['vectorized'] = type === 'vectorized';
  }

  // A position the entry already reads as is left alone: the flat shape cannot name `outlet`
  // (it reads as at-depth), and writing that reading back would move the entry.
  const position = entry['position'];
  if (typeof position === 'string' && position !== flatPosition(st)) {
    const role = FLAT_DEPTH_POSITIONS.indexOf(position as LorebookEntry['position']);
    const slot = indexOf(POSITIONS, position, -1);
    if (role >= 0) {
      st['position'] = AT_DEPTH;
      st['role'] = role;
    } else if (fixedSlot(slot) !== undefined) {
      st['position'] = slot;
      st['role'] = null;
    }
  }
  // `depth: null` is what a read reports for "not at depth"; the stored depth stays
  const depth = finite(entry['depth']);
  if (depth !== undefined) st['depth'] = depth;

  if (Array.isArray(entry['keys'])) st['key'] = strings(entry['keys']);
  if (Array.isArray(entry['filters'])) st['keysecondary'] = strings(entry['filters']);
  const logic = indexOf(LOGICS, entry['logic'], -1);
  if (logic >= 0) st['selectiveLogic'] = logic;

  const automationId = entry['automation_id'];
  if (automationId === null || typeof automationId === 'string') {
    st['automationId'] = automationId ?? '';
  }
  const delayUntil = entry['delay_until_recursion'];
  if (typeof delayUntil === 'boolean' || finite(delayUntil) !== undefined) {
    st['delayUntilRecursion'] = delayUntil;
  }
  return st;
}

// ---------------------------------------------------------------------------------------------
// settings

type ScalarSetting = Exclude<
  keyof LorebookSettings,
  'selected_global_lorebooks' | 'insertion_strategy'
>;

/** LorebookSettings field → `world_info_settings` key */
const SETTING_KEYS: Readonly<Record<ScalarSetting, string>> = {
  scan_depth: 'world_info_depth',
  context_percentage: 'world_info_budget',
  budget_cap: 'world_info_budget_cap',
  min_activations: 'world_info_min_activations',
  max_depth: 'world_info_min_activations_depth_max',
  max_recursion_steps: 'world_info_max_recursion_steps',
  include_names: 'world_info_include_names',
  recursive: 'world_info_recursive',
  case_sensitive: 'world_info_case_sensitive',
  match_whole_words: 'world_info_match_whole_words',
  use_group_scoring: 'world_info_use_group_scoring',
  overflow_alert: 'world_info_overflow_alert',
};
const STRATEGY_KEY = 'world_info_character_strategy';
/** What ST runs with while settings.json has no value yet. */
const SETTING_DEFAULTS: Readonly<Pick<LorebookSettings, ScalarSetting>> = {
  scan_depth: 2,
  context_percentage: 25,
  budget_cap: 0,
  min_activations: 0,
  max_depth: 0,
  max_recursion_steps: 0,
  include_names: true,
  recursive: false,
  case_sensitive: false,
  match_whole_words: false,
  use_group_scoring: false,
  overflow_alert: false,
};
const SCALAR_SETTINGS = Object.keys(SETTING_KEYS) as ScalarSetting[];

/**
 * settings.json `world_info_settings` → LorebookSettings, with ST's load-time coercion and its
 * defaults for whatever is missing. `selected_global_lorebooks` is `world_info.globalSelect`.
 */
export function toLorebookSettings(worldInfoSettings: unknown): LorebookSettings {
  const stored = record(worldInfoSettings);
  // `world_info` used to be the selected book's name, then a list of names
  const worldInfo = stored['world_info'];
  const selected =
    typeof worldInfo === 'string' ? [worldInfo] : (record(worldInfo)['globalSelect'] ?? worldInfo);

  const settings: LorebookSettings = {
    selected_global_lorebooks: strings(selected),
    insertion_strategy: nameAt(STRATEGIES, numeric(stored[STRATEGY_KEY])) ?? 'character_first',
    ...SETTING_DEFAULTS,
  };
  const bag = settings as unknown as Record<string, unknown>;
  for (const field of SCALAR_SETTINGS) {
    const value = stored[SETTING_KEYS[field]];
    if (value === undefined) continue;
    if (typeof SETTING_DEFAULTS[field] === 'boolean') bag[field] = Boolean(value);
    else bag[field] = numeric(value) ?? SETTING_DEFAULTS[field];
  }
  // ST resets a budget saved by versions that stored it in tokens
  if (settings.context_percentage > 100) settings.context_percentage = 25;
  return settings;
}

/**
 * Partial LorebookSettings → the `world_info_settings` keys to assign; only fields present with a
 * usable value produce a key. `selected_global_lorebooks` becomes `world_info.globalSelect`: the
 * `world_info` object also holds other data (character lore links), so pass the current
 * `world_info_settings` as `current` to get it back whole, or merge that one key yourself.
 */
export function fromLorebookSettings(
  patch: Record<string, unknown>,
  current?: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(patch)) return out;

  if (Array.isArray(patch['selected_global_lorebooks'])) {
    out['world_info'] = {
      ...carryEntry(record(record(current)['world_info'])),
      globalSelect: strings(patch['selected_global_lorebooks']),
    };
  }
  for (const field of SCALAR_SETTINGS) {
    const value = patch[field];
    const usable =
      typeof SETTING_DEFAULTS[field] === 'boolean'
        ? typeof value === 'boolean'
        : finite(value) !== undefined;
    if (usable) out[SETTING_KEYS[field]] = value;
  }
  const strategy = indexOf(STRATEGIES, patch['insertion_strategy'], -1);
  if (strategy >= 0) out[STRATEGY_KEY] = strategy;
  return out;
}
