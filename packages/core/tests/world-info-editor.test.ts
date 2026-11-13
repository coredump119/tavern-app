import { describe, expect, it } from 'vitest';
import {
  createWorldInfoEntry,
  deleteWorldInfoEntry,
  duplicateWorldInfoEntry,
  entryStrategy,
  entryTitle,
  getFreeWorldEntryUid,
  getFreeWorldName,
  charLoreOf,
  globalSelectOf,
  replaceInCharLore,
  setCharLore,
  newWorldInfoBook,
  positionOptionId,
  renameInGlobalSelect,
  setEntryPosition,
  setEntryStrategy,
  setGlobalSelect,
  setWorldInfoEntryField,
  sortedEntries,
  splitKeywordsAndRegexes,
  type WIBookData,
} from '../src/index.js';

describe('world info editor (ST world-info.js)', () => {
  it('creates entries with the lowest free uid and the ST template', () => {
    const book = newWorldInfoBook();
    const a = createWorldInfoEntry(book)!;
    const b = createWorldInfoEntry(book)!;
    expect([a['uid'], b['uid']]).toEqual([0, 1]);
    expect(a['selective']).toBe(true);
    expect(a['probability']).toBe(100);
    expect(a['depth']).toBe(4);
    expect(a['scanDepth']).toBeNull();
    expect('characterFilterNames' in a).toBe(false);
    delete book.entries[0];
    expect(getFreeWorldEntryUid(book)).toBe(0);
  });

  it('duplicates everything but the uid; deletes and mirrors into originalData', () => {
    const book: WIBookData = {
      entries: {},
      originalData: { entries: [{ uid: 0, keys: [], extensions: {} }, { uid: 1 }] },
    };
    const a = createWorldInfoEntry(book)!;
    a['content'] = 'hello';
    a['key'] = ['x'];
    const copy = duplicateWorldInfoEntry(book, 0)!;
    expect(copy['uid']).toBe(1);
    expect(copy['content']).toBe('hello');
    expect(copy['key']).toEqual(['x']);
    expect(copy['key']).not.toBe(a['key']);
    expect(deleteWorldInfoEntry(book, 1)).toBe(true);
    expect((book['originalData'] as { entries: unknown[] }).entries).toHaveLength(1);
    expect(deleteWorldInfoEntry(book, 9)).toBe(false);
  });

  it('mirrors edits into originalData with ST key paths', () => {
    const book: WIBookData = {
      entries: { 0: { uid: 0, key: [] } },
      originalData: { entries: [{ uid: 0, keys: [] }] },
    };
    setWorldInfoEntryField(book, 0, 'key', ['a', 'b']);
    setWorldInfoEntryField(book, 0, 'order', 50);
    setWorldInfoEntryField(book, 0, 'disable', true);
    setEntryPosition(book, 0, '4:1');
    setEntryStrategy(book, 0, 'constant');
    const orig = (book['originalData'] as { entries: Record<string, unknown>[] }).entries[0]!;
    expect(orig['keys']).toEqual(['a', 'b']);
    expect(orig['insertion_order']).toBe(50);
    expect(orig['enabled']).toBe(false);
    expect(orig['position']).toBe('after_char');
    expect((orig['extensions'] as Record<string, unknown>)['position']).toBe(4);
    expect((orig['extensions'] as Record<string, unknown>)['role']).toBe(1);
    expect(orig['constant']).toBe(true);
    expect(book.entries[0]!['role']).toBe(1);
  });

  it('position / strategy pickers', () => {
    const book: WIBookData = { entries: { 0: { uid: 0, position: 4, role: 2 } } };
    expect(positionOptionId(book.entries[0]!)).toBe('4:2');
    setEntryPosition(book, 0, '1');
    expect(book.entries[0]).toMatchObject({ position: 1, role: null });
    expect(positionOptionId(book.entries[0]!)).toBe('1');
    setEntryStrategy(book, 0, 'vectorized');
    expect(entryStrategy(book.entries[0]!)).toBe('vectorized');
    setEntryStrategy(book, 0, 'normal');
    expect(book.entries[0]).toMatchObject({ constant: false, vectorized: false });
  });

  it('splits keywords like the select2 tokenizer, keeping commas inside regexes', () => {
    expect(splitKeywordsAndRegexes('a, b ,,c')).toEqual(['a', 'b', 'c']);
    expect(splitKeywordsAndRegexes('/a,b/i, c')).toEqual(['/a,b/i', 'c']);
    expect(splitKeywordsAndRegexes('/bad/z, d')).toEqual(['/bad/z', 'd']);
    expect(splitKeywordsAndRegexes('/open, x')).toEqual(['/open, x']);
    expect(splitKeywordsAndRegexes('  ')).toEqual([]);
  });

  it('titles, ordering, free names, globalSelect', () => {
    expect(entryTitle({ uid: 3, comment: ' C ', key: ['k'] })).toBe('C');
    expect(entryTitle({ uid: 3, comment: '', key: ['k', 'j'] })).toBe('k, j');
    expect(entryTitle({ uid: 3 })).toBe('#3');
    const book: WIBookData = {
      entries: { 0: { uid: 0, displayIndex: 2 }, 1: { uid: 1, displayIndex: 0 }, 2: { uid: 2 } },
    };
    expect(sortedEntries(book).map((e) => e['uid'])).toEqual([1, 2, 0]);
    expect(getFreeWorldName(['New World (1)'])).toBe('New World (2)');
    expect(getFreeWorldName([], 'Lore (3)')).toBe('Lore (1)');
    const s: Record<string, unknown> = { world_info_settings: { world_info_depth: 2 } };
    expect(globalSelectOf(s)).toEqual([]);
    setGlobalSelect(s, ['A', 'B']);
    expect(globalSelectOf(s)).toEqual(['A', 'B']);
    expect((s['world_info_settings'] as Record<string, unknown>)['world_info_depth']).toBe(2);
    expect(renameInGlobalSelect(s, 'A', 'Z')).toBe(true);
    expect(globalSelectOf(s)).toEqual(['Z', 'B']);
    expect(renameInGlobalSelect(s, 'nope', 'Q')).toBe(false);
  });
});

describe('character extra books (world_info.charLore, DEV_NOTES §9.35)', () => {
  it('adds, replaces and drops the entry of one character, leaving the others', () => {
    const s: Record<string, unknown> = {
      world_info_settings: {
        world_info_depth: 4,
        world_info: { globalSelect: ['G'], charLore: [{ name: 'Other', extraBooks: ['X'] }] },
      },
    };
    expect(charLoreOf(s, 'Seraphina')).toEqual([]);
    setCharLore(s, 'Seraphina', []);
    expect(charLoreOf(s, 'Other')).toEqual(['X']);
    setCharLore(s, 'Seraphina', ['A', 'B']);
    expect(charLoreOf(s, 'Seraphina')).toEqual(['A', 'B']);
    setCharLore(s, 'Seraphina', ['B']);
    expect(charLoreOf(s, 'Seraphina')).toEqual(['B']);
    setCharLore(s, 'Seraphina', []);
    const wi = s['world_info_settings'] as Record<string, unknown>;
    expect(wi['world_info']).toEqual({
      globalSelect: ['G'],
      charLore: [{ name: 'Other', extraBooks: ['X'] }],
    });
    expect(wi['world_info_depth']).toBe(4);
    expect(charLoreOf({}, 'Seraphina')).toEqual([]);
  });

  it('replaceInCharLore follows a renamed book and drops a deleted one', () => {
    const s: Record<string, unknown> = {
      world_info_settings: {
        world_info: {
          charLore: [
            { name: 'A', extraBooks: ['X', 'Y'] },
            { name: 'B', extraBooks: ['X'] },
            { name: 'C', extraBooks: ['Z'] },
          ],
        },
      },
    };
    expect(replaceInCharLore(s, 'Nope', 'Q')).toBe(false);
    expect(replaceInCharLore(s, 'X', 'W')).toBe(true);
    expect(charLoreOf(s, 'A')).toEqual(['Y', 'W']);
    expect(charLoreOf(s, 'B')).toEqual(['W']);
    expect(replaceInCharLore(s, 'W', null)).toBe(true);
    expect(charLoreOf(s, 'A')).toEqual(['Y']);
    const inner = (s['world_info_settings'] as { world_info: { charLore: unknown[] } }).world_info;
    expect(inner.charLore).toEqual([
      { name: 'A', extraBooks: ['Y'] },
      { name: 'C', extraBooks: ['Z'] },
    ]);
    expect(replaceInCharLore({}, 'X', null)).toBe(false);
  });
});
