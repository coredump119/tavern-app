/**
 * World Info entry fields as the `/findentry`, `/getentryfield` and `/setentryfield` commands see
 * them. The table follows ST 1.18.0 `newWorldInfoEntryDefinition` (world-info.js); the commands
 * themselves live in the app, which owns the files.
 */
import { isTrue } from './executor.js';

export type EntryFieldType =
  'array' | 'string' | 'boolean' | 'number' | 'enum' | 'number?' | 'boolean?';
export interface EntryFieldSpec {
  type: EntryFieldType;
  default: unknown;
  /** values an array field may hold */
  allowed?: readonly string[];
}

/** ST `GENERATION_TYPE_TRIGGERS` */
const TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];

const field = (type: EntryFieldType, value: unknown): EntryFieldSpec => ({ type, default: value });

export const ENTRY_FIELDS: Readonly<Record<string, EntryFieldSpec>> = {
  key: field('array', []),
  keysecondary: field('array', []),
  comment: field('string', ''),
  content: field('string', ''),
  constant: field('boolean', false),
  vectorized: field('boolean', false),
  selective: field('boolean', true),
  selectiveLogic: field('enum', 0),
  addMemo: field('boolean', false),
  order: field('number', 100),
  position: field('number', 0),
  disable: field('boolean', false),
  ignoreBudget: field('boolean', false),
  excludeRecursion: field('boolean', false),
  preventRecursion: field('boolean', false),
  matchPersonaDescription: field('boolean', false),
  matchCharacterDescription: field('boolean', false),
  matchCharacterPersonality: field('boolean', false),
  matchCharacterDepthPrompt: field('boolean', false),
  matchScenario: field('boolean', false),
  matchCreatorNotes: field('boolean', false),
  delayUntilRecursion: field('number', 0),
  probability: field('number', 100),
  useProbability: field('boolean', true),
  depth: field('number', 4),
  outletName: field('string', ''),
  group: field('string', ''),
  groupOverride: field('boolean', false),
  groupWeight: field('number', 100),
  scanDepth: field('number?', null),
  caseSensitive: field('boolean?', null),
  matchWholeWords: field('boolean?', null),
  useGroupScoring: field('boolean?', null),
  automationId: field('string', ''),
  role: field('enum', 0),
  sticky: field('number?', null),
  cooldown: field('number?', null),
  delay: field('number?', null),
  // these three are stored inside `entry.characterFilter`; the app reads and writes them there
  characterFilterNames: field('array', []),
  characterFilterTags: field('array', []),
  characterFilterExclude: field('boolean', false),
  triggers: { type: 'array', default: [], allowed: TRIGGERS },
};

export const entryFieldSpec = (name: string): EntryFieldSpec | undefined =>
  Object.hasOwn(ENTRY_FIELDS, name) ? ENTRY_FIELDS[name] : undefined;

/** ST `parseStringArray`: a JSON list, or comma-separated words */
export function parseStringArray(value: unknown): string[] {
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // not JSON: a comma-separated list
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The stored value for `/setentryfield` text. ST converts by the type of the value the entry
 * holds at that moment, which leaves text in the nullable fields (`sticky`, `scanDepth`…) while
 * they are null; here the type comes from the table, so those get a number / boolean, and null
 * for empty text.
 */
export function coerceEntryValue(spec: EntryFieldSpec, value: string): unknown {
  const blank = ['', 'null'].includes(value.trim().toLowerCase());
  switch (spec.type) {
    case 'array': {
      const items = parseStringArray(value);
      return spec.allowed ? items.filter((item) => spec.allowed!.includes(item)) : items;
    }
    case 'boolean':
      return isTrue(value);
    case 'boolean?':
      return blank ? null : isTrue(value);
    case 'number':
    case 'enum':
      return Number(value);
    case 'number?':
      return blank ? null : Number(value);
    case 'string':
      return value;
  }
}

const fold = (value: unknown): string => String(value).trim().toLowerCase();
/** The texts of one field: the items of a list, or the value itself */
const fieldTexts = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(fold);
  return value === undefined || value === null || typeof value === 'object' ? [] : [fold(value)];
};

/**
 * `/findentry`: the first entry whose field matches the text. ST ranks with Fuse (fuzzy,
 * threshold 0.3); this is a plain case-insensitive match instead: an entry with an equal value
 * wins, then one whose value contains the text.
 */
export function findEntry<T extends Record<string, unknown>>(
  entries: readonly T[],
  name: string,
  search: string,
): T | undefined {
  const needle = fold(search);
  if (!needle) return undefined;
  const texts = entries.map((entry) => fieldTexts(entry[name]));
  let index = texts.findIndex((values) => values.includes(needle));
  if (index < 0) index = texts.findIndex((values) => values.some((v) => v.includes(needle)));
  return entries[index];
}
