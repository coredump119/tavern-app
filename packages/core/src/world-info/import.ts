/**
 * Lorebook formats ST converts on import (world-info.js `convertNovelLorebook` /
 * `convertAgnaiMemoryBook` / `convertRisuLorebook` — DEV_NOTES §9.36). Pure.
 */
import { newWorldInfoEntryTemplate, type WIBookData, type WIEntryData } from './editor.js';
import { WORLD_INFO_LOGIC } from './types.js';

export type ForeignLorebookKind = 'novel' | 'agnai' | 'risu';

/** ST `importWorldInfo` detection order */
export function foreignLorebookKind(raw: Record<string, unknown>): ForeignLorebookKind | null {
  if (raw['lorebookVersion'] !== undefined) return 'novel';
  if (raw['kind'] === 'memory') return 'agnai';
  if (raw['type'] === 'risu') return 'risu';
  return null;
}

type Raw = Record<string, unknown>;

const list = (v: unknown): Raw[] =>
  Array.isArray(v) ? v.filter((e): e is Raw => !!e && typeof e === 'object') : [];
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => String(s)) : []);
const csv = (v: unknown): string[] =>
  typeof v === 'string' && v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/** the fields every converter writes the same way */
function converted(index: number, fields: WIEntryData): WIEntryData {
  return {
    ...newWorldInfoEntryTemplate(),
    uid: index,
    displayIndex: index,
    keysecondary: [],
    position: 0,
    selectiveLogic: WORLD_INFO_LOGIC.AND_ANY,
    excludeRecursion: false,
    delayUntilRecursion: false,
    ...fields,
  };
}

function toBook(entries: WIEntryData[]): WIBookData {
  const book: WIBookData = { entries: {} };
  entries.forEach((e, i) => (book.entries[String(i)] = e));
  return book;
}

/** NovelAI `.lorebook`: `{ lorebookVersion, entries: [{ keys, text, displayName, enabled, contextConfig }] }` */
export function convertNovelLorebook(raw: Raw): WIBookData {
  return toBook(
    list(raw['entries']).map((entry, index) => {
      const displayName = entry['displayName'];
      const config = entry['contextConfig'] as Raw | undefined;
      return converted(index, {
        key: strings(entry['keys']),
        comment: typeof displayName === 'string' ? displayName : '',
        content: String(entry['text'] ?? ''),
        constant: false,
        selective: false,
        order: Number(config?.['budgetPriority'] ?? 0),
        disable: !entry['enabled'],
        addMemo: typeof displayName === 'string' && displayName.trim() !== '',
        probability: 100,
        useProbability: true,
      });
    }),
  );
}

/** Agnai memory book: `{ kind: 'memory', entries: [{ name, entry, keywords, weight, enabled }] }` */
export function convertAgnaiMemoryBook(raw: Raw): WIBookData {
  return toBook(
    list(raw['entries']).map((entry, index) =>
      converted(index, {
        key: strings(entry['keywords']),
        comment: String(entry['name'] ?? ''),
        content: String(entry['entry'] ?? ''),
        constant: false,
        selective: false,
        order: Number(entry['weight'] ?? 0),
        disable: !entry['enabled'],
        addMemo: !!entry['name'],
        probability: 100,
        useProbability: true,
      }),
    ),
  );
}

/** RisuAI lorebook: `{ type: 'risu', data: [{ key, secondkey, comment, content, alwaysActive, … }] }` */
export function convertRisuLorebook(raw: Raw): WIBookData {
  return toBook(
    list(raw['data']).map((entry, index) =>
      converted(index, {
        key: csv(entry['key']),
        keysecondary: csv(entry['secondkey']),
        comment: String(entry['comment'] ?? ''),
        content: String(entry['content'] ?? ''),
        constant: !!entry['alwaysActive'],
        selective: !!entry['selective'],
        order: Number(entry['insertorder'] ?? 0),
        disable: false,
        addMemo: true,
        probability: entry['activationPercent'] ?? 100,
        useProbability: entry['activationPercent'] ?? true,
      }),
    ),
  );
}

/** Convert a recognized foreign lorebook; `null` when `raw` is none of them. */
export function convertForeignLorebook(raw: Raw): WIBookData | null {
  switch (foreignLorebookKind(raw)) {
    case 'novel':
      return convertNovelLorebook(raw);
    case 'agnai':
      return convertAgnaiMemoryBook(raw);
    case 'risu':
      return convertRisuLorebook(raw);
    default:
      return null;
  }
}
