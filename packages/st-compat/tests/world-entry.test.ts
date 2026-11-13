import { describe, expect, it } from 'vitest';
import {
  coerceEntryValue,
  ENTRY_FIELDS,
  entryFieldSpec,
  findEntry,
  parseStringArray,
} from '../src/index.js';

const spec = (name: string) => entryFieldSpec(name)!;

describe('entry field table', () => {
  it('knows ST fields only, and not what objects inherit', () => {
    expect(spec('key')).toEqual({ type: 'array', default: [] });
    expect(spec('depth').default).toBe(4);
    expect(entryFieldSpec('uid')).toBeUndefined();
    expect(entryFieldSpec('toString')).toBeUndefined();
    expect(Object.keys(ENTRY_FIELDS)).toHaveLength(42);
  });
});

describe('parseStringArray', () => {
  it('reads a JSON list or comma-separated words', () => {
    expect(parseStringArray('["a", 2, "c d"]')).toEqual(['a', '2', 'c d']);
    expect(parseStringArray(' sword , shield,, ')).toEqual(['sword', 'shield']);
    expect(parseStringArray('{"a":1}')).toEqual(['{"a":1}']);
    expect(parseStringArray('')).toEqual([]);
    expect(parseStringArray(3)).toEqual([]);
  });
});

describe('coerceEntryValue', () => {
  it('converts text by the type of the field', () => {
    expect(coerceEntryValue(spec('key'), 'a, b')).toEqual(['a', 'b']);
    expect(coerceEntryValue(spec('constant'), 'on')).toBe(true);
    expect(coerceEntryValue(spec('constant'), 'nope')).toBe(false);
    expect(coerceEntryValue(spec('order'), '250')).toBe(250);
    expect(coerceEntryValue(spec('selectiveLogic'), '3')).toBe(3);
    expect(coerceEntryValue(spec('content'), ' 12 ')).toBe(' 12 ');
  });

  it('keeps null for an emptied nullable field', () => {
    expect(coerceEntryValue(spec('sticky'), '3')).toBe(3);
    expect(coerceEntryValue(spec('sticky'), '')).toBeNull();
    expect(coerceEntryValue(spec('caseSensitive'), 'true')).toBe(true);
    expect(coerceEntryValue(spec('caseSensitive'), 'null')).toBeNull();
  });

  it('drops trigger names ST does not know', () => {
    expect(coerceEntryValue(spec('triggers'), 'normal, dance, quiet')).toEqual(['normal', 'quiet']);
  });
});

describe('findEntry', () => {
  const entries = [
    { uid: 0, key: ['Dragonfly', 'pond'], comment: 'Pond life', constant: false },
    { uid: 1, key: ['dragon'], comment: 'The dragon', constant: true },
    { uid: 2, key: [], comment: 'Empty', constant: false },
  ];

  it('prefers an equal value over one that only contains the text', () => {
    expect(findEntry(entries, 'key', 'Dragon')?.uid).toBe(1);
    expect(findEntry(entries, 'key', 'fly')?.uid).toBe(0);
    expect(findEntry(entries, 'comment', 'the DRAGON')?.uid).toBe(1);
  });

  it('matches booleans and numbers as text', () => {
    expect(findEntry(entries, 'constant', 'true')?.uid).toBe(1);
    expect(findEntry(entries, 'uid', '2')?.uid).toBe(2);
  });

  it('finds nothing for empty text, an unknown field or no match', () => {
    expect(findEntry(entries, 'key', ' ')).toBeUndefined();
    expect(findEntry(entries, 'nothing', 'x')).toBeUndefined();
    expect(findEntry(entries, 'key', 'wyvern')).toBeUndefined();
  });
});
