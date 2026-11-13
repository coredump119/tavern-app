import { describe, expect, it } from 'vitest';
import {
  convertAgnaiMemoryBook,
  convertForeignLorebook,
  convertNovelLorebook,
  convertRisuLorebook,
  foreignLorebookKind,
  reorderWorldEntries,
  sortWorldEntries,
  WI_SORT_CUSTOM,
  type WIBookData,
} from '../src/index.js';

describe('foreign lorebook import (ST convert*Lorebook)', () => {
  it('detects formats in ST order', () => {
    expect(foreignLorebookKind({ lorebookVersion: 5, kind: 'memory' })).toBe('novel');
    expect(foreignLorebookKind({ kind: 'memory', type: 'risu' })).toBe('agnai');
    expect(foreignLorebookKind({ type: 'risu' })).toBe('risu');
    expect(foreignLorebookKind({ entries: {} })).toBeNull();
    expect(convertForeignLorebook({ entries: {} })).toBeNull();
  });

  it('converts a NovelAI lorebook', () => {
    const book = convertNovelLorebook({
      lorebookVersion: 5,
      entries: [
        {
          keys: ['glade', 'grove'],
          text: 'A quiet glade.',
          displayName: 'Glade',
          enabled: true,
          contextConfig: { budgetPriority: 400 },
        },
        { keys: ['river'], text: 'A cold river.', displayName: ' ', enabled: false },
      ],
    });
    expect(Object.keys(book.entries)).toEqual(['0', '1']);
    expect(book.entries['0']).toMatchObject({
      uid: 0,
      displayIndex: 0,
      key: ['glade', 'grove'],
      keysecondary: [],
      comment: 'Glade',
      content: 'A quiet glade.',
      constant: false,
      selective: false,
      order: 400,
      position: 0,
      disable: false,
      addMemo: true,
      probability: 100,
      useProbability: true,
    });
    expect(book.entries['1']).toMatchObject({ uid: 1, order: 0, disable: true, addMemo: false });
  });

  it('converts an Agnai memory book', () => {
    const book = convertAgnaiMemoryBook({
      kind: 'memory',
      entries: [
        { name: 'Glade', entry: 'A quiet glade.', keywords: ['glade'], weight: 7, enabled: true },
        { name: '', entry: 'A cold river.', keywords: ['river'], weight: 3, enabled: false },
      ],
    });
    expect(book.entries['0']).toMatchObject({
      key: ['glade'],
      comment: 'Glade',
      content: 'A quiet glade.',
      order: 7,
      disable: false,
      addMemo: true,
    });
    expect(book.entries['1']).toMatchObject({ order: 3, disable: true, addMemo: false });
  });

  it('converts a RisuAI lorebook', () => {
    const book = convertRisuLorebook({
      type: 'risu',
      data: [
        {
          key: 'glade, grove',
          secondkey: 'moss',
          comment: 'Glade',
          content: 'A quiet glade.',
          alwaysActive: false,
          selective: true,
          insertorder: 12,
          activationPercent: 40,
        },
        { key: 'river', secondkey: '', comment: 'River', content: 'Cold.', alwaysActive: true },
      ],
    });
    expect(book.entries['0']).toMatchObject({
      key: ['glade', 'grove'],
      keysecondary: ['moss'],
      constant: false,
      selective: true,
      order: 12,
      disable: false,
      addMemo: true,
      probability: 40,
      useProbability: 40,
    });
    expect(book.entries['1']).toMatchObject({
      keysecondary: [],
      constant: true,
      selective: false,
      probability: 100,
      useProbability: true,
    });
  });
});

describe('entry list sort (ST sortWorldInfoEntries)', () => {
  const entries = [
    { uid: 0, comment: 'b', content: 'xx', order: 10, displayIndex: 2, disable: true },
    { uid: 1, comment: 'a', content: 'xxxx', order: 30, displayIndex: 0, constant: true },
    { uid: 2, comment: 'c', content: 'x', order: 20, displayIndex: 1 },
    { uid: 3, comment: 'c', content: 'x', order: 20, displayIndex: 3 },
  ];
  const uids = (value: number) => sortWorldEntries(entries, value).map((e) => e['uid']);

  it('priority: constant, normal, disabled; ties by order desc then uid', () => {
    expect(uids(0)).toEqual([1, 2, 3, 0]);
  });
  it('custom: displayIndex', () => {
    expect(uids(WI_SORT_CUSTOM)).toEqual([1, 2, 0, 3]);
  });
  it('title, length and number fields in both directions', () => {
    expect(uids(1)).toEqual([1, 0, 2, 3]);
    expect(uids(2)).toEqual([2, 3, 0, 1]);
    expect(uids(3)).toEqual([2, 3, 0, 1]);
    expect(uids(4)).toEqual([1, 0, 2, 3]);
    expect(uids(7)).toEqual([0, 2, 3, 1]);
    expect(uids(10)).toEqual([3, 2, 1, 0]);
  });
  it('does not mutate the input and falls back to priority for unknown values', () => {
    expect(entries.map((e) => e.uid)).toEqual([0, 1, 2, 3]);
    expect(uids(99)).toEqual(uids(0));
  });

  it('reorderWorldEntries renumbers from the first entry and mirrors originalData', () => {
    const book: WIBookData = {
      entries: {
        '0': { uid: 0, displayIndex: 5 },
        '1': { uid: 1, displayIndex: 6 },
        '2': { uid: 2, displayIndex: 7 },
      },
      originalData: {
        entries: [
          { uid: 0, extensions: {} },
          { uid: 1, extensions: {} },
          { uid: 2, extensions: {} },
        ],
      },
    };
    reorderWorldEntries(book, [1, 0, 2]);
    expect(Object.values(book.entries).map((e) => e['displayIndex'])).toEqual([7, 6, 8]);
    const original = (
      book['originalData'] as { entries: { extensions: { display_index: number } }[] }
    ).entries;
    expect(original.map((e) => e.extensions.display_index)).toEqual([7, 6, 8]);
    reorderWorldEntries(book, []);
  });
});
