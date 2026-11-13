import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  fromLorebookEntry,
  fromLorebookSettings,
  fromWorldbookEntries,
  toLorebookEntries,
  toLorebookSettings,
  toWorldbookEntries,
  type WorldbookEntry,
} from '../src/convert/worldbook.js';

type St = Record<string, unknown>;

/** An ST entry as ST 1.18 writes a new one, with overrides. */
const stEntry = (uid: number, over: St = {}): St => ({
  uid,
  key: [],
  keysecondary: [],
  comment: '',
  content: '',
  constant: false,
  vectorized: false,
  selective: true,
  selectiveLogic: 0,
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
  depth: 4,
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
  displayIndex: uid,
  ...over,
});

const stFile = (...entries: St[]) => ({
  entries: Object.fromEntries(entries.map((e) => [String(e['uid']), e])),
});

const readOne = (over: St = {}): WorldbookEntry => {
  const [entry] = toWorldbookEntries(stFile(stEntry(0, over)));
  if (!entry) throw new Error('no entry');
  return entry;
};
const writeOne = (entry: unknown, previous?: unknown): St => {
  const [written] = Object.values(fromWorldbookEntries([entry], previous).entries);
  if (!written) throw new Error('no entry');
  return written;
};

const POSITIONS = [
  [0, 'before_character_definition'],
  [1, 'after_character_definition'],
  [2, 'before_author_note'],
  [3, 'after_author_note'],
  [4, 'at_depth'],
  [5, 'before_example_messages'],
  [6, 'after_example_messages'],
  [7, 'outlet'],
] as const;
const LOGICS = [
  [0, 'and_any'],
  [1, 'not_all'],
  [2, 'not_any'],
  [3, 'and_all'],
] as const;
const ROLES = [
  [0, 'system'],
  [1, 'user'],
  [2, 'assistant'],
] as const;

describe('toWorldbookEntries', () => {
  it('maps the plain fields', () => {
    const entry = readOne({
      comment: 'Glade',
      content: 'A quiet glade.',
      disable: true,
      key: ['glade', 'forest'],
      order: 37,
      depth: 2,
    });
    expect(entry).toMatchObject({
      uid: 0,
      name: 'Glade',
      enabled: false,
      content: 'A quiet glade.',
      strategy: { type: 'selective', keys: ['glade', 'forest'], scan_depth: 'same_as_global' },
      position: { type: 'before_character_definition', role: 'system', depth: 2, order: 37 },
      probability: 100,
    });
  });

  it.each(POSITIONS)('reads position %i as %s', (position, type) => {
    expect(readOne({ position }).position.type).toBe(type);
  });

  it.each(ROLES)('reads role %i as %s, null as system', (role, name) => {
    expect(readOne({ position: 4, role }).position.role).toBe(name);
    expect(readOne({ position: 4, role: null }).position.role).toBe('system');
  });

  it('derives the strategy type, constant winning over vectorized', () => {
    expect(readOne({ constant: true, vectorized: true }).strategy.type).toBe('constant');
    expect(readOne({ vectorized: true }).strategy.type).toBe('vectorized');
    expect(readOne({ selective: false }).strategy.type).toBe('selective');
  });

  it.each(LOGICS)('reads selectiveLogic %i as %s', (selectiveLogic, logic) => {
    const entry = readOne({ selectiveLogic, keysecondary: ['x'] });
    expect(entry.strategy.keys_secondary).toEqual({ logic, keys: ['x'] });
  });

  it('reads scan depth, null meaning the global one', () => {
    expect(readOne({ scanDepth: null }).strategy.scan_depth).toBe('same_as_global');
    expect(readOne({ scanDepth: 6 }).strategy.scan_depth).toBe(6);
  });

  it('reports 100 while the probability switch is off', () => {
    expect(readOne({ useProbability: true, probability: 40 }).probability).toBe(40);
    expect(readOne({ useProbability: false, probability: 40 }).probability).toBe(100);
    expect(readOne({ useProbability: true, probability: '15' }).probability).toBe(15);
  });

  it('reads recursion and effects, anything not positive as null', () => {
    const on = readOne({
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 3,
      sticky: 2,
      cooldown: 5,
      delay: 9,
    });
    expect(on.recursion).toEqual({
      prevent_incoming: true,
      prevent_outgoing: true,
      delay_until: 3,
    });
    expect(on.effect).toEqual({ sticky: 2, cooldown: 5, delay: 9 });

    const off = readOne({ delayUntilRecursion: false, sticky: 0, cooldown: null });
    expect(off.recursion.delay_until).toBeNull();
    expect(off.effect).toEqual({ sticky: null, cooldown: null, delay: null });
    expect(readOne({ delayUntilRecursion: 0 }).recursion.delay_until).toBeNull();
    // the legacy boolean is recursion level 1 to ST
    expect(readOne({ delayUntilRecursion: true }).recursion.delay_until).toBe(1);
  });

  it('turns /…/flags keys into RegExp and leaves the rest as text', () => {
    const { keys, keys_secondary } = readOne({
      key: ['/drag(on|ons)/i', 'plain', '/a\\/b/', '/a/b/', '/(/', '/x/z', '/'],
      keysecondary: ['/^end$/gm'],
    }).strategy;
    expect(keys).toEqual([/drag(on|ons)/i, 'plain', /a\/b/, '/a/b/', '/(/', '/x/z', '/']);
    expect(keys[0]).toBeInstanceOf(RegExp);
    expect(keys_secondary.keys).toEqual([/^end$/gm]);
  });

  it('copies `extra` and hands the uncovered ST fields through', () => {
    const extra = { tags: ['a'], nested: { n: 1 } };
    const characterFilter = { isExclude: true, names: ['Ann'], tags: [] };
    const file = stFile(
      stEntry(0, { extra, characterFilter, group: 'g', outletName: 'side', triggers: ['normal'] }),
    );
    const [entry] = toWorldbookEntries(file);
    expect(entry).toMatchObject({
      extra,
      characterFilter,
      group: 'g',
      outletName: 'side',
      triggers: ['normal'],
      addMemo: false,
      caseSensitive: null,
    });
    expect(entry?.extra).not.toBe(extra);
    expect((entry as unknown as St)['characterFilter']).not.toBe(characterFilter);
    expect(readOne()).not.toHaveProperty('extra');
    expect(readOne()).not.toHaveProperty('characterFilter');
  });

  it('orders by displayIndex, entries without one last', () => {
    const file = stFile(
      stEntry(0, { displayIndex: 2 }),
      stEntry(1, { displayIndex: undefined }),
      stEntry(2, { displayIndex: 0 }),
      stEntry(3, { displayIndex: 2 }),
      stEntry(4, { displayIndex: 1 }),
    );
    expect(toWorldbookEntries(file).map((e) => e.uid)).toEqual([2, 4, 0, 3, 1]);
  });

  it('fills in for an entry from an old file', () => {
    const file = { entries: { '7': { key: ['k'], content: 'c' }, x: { content: 'lost' } } };
    expect(toWorldbookEntries(file)).toEqual([
      {
        uid: 7,
        name: '',
        enabled: true,
        strategy: {
          type: 'selective',
          keys: ['k'],
          keys_secondary: { logic: 'and_any', keys: [] },
          scan_depth: 'same_as_global',
        },
        position: { type: 'before_character_definition', role: 'system', depth: 4, order: 100 },
        content: 'c',
        probability: 100,
        recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
        effect: { sticky: null, cooldown: null, delay: null },
      },
    ]);
  });

  it('returns nothing for a missing or malformed file', () => {
    for (const junk of [undefined, null, 3, 'x', [], {}, { entries: null }, { entries: 'x' }]) {
      expect(toWorldbookEntries(junk)).toEqual([]);
      expect(toLorebookEntries(junk)).toEqual([]);
    }
    expect(toWorldbookEntries({ entries: { '0': null, '1': 'x', '2': [] } })).toEqual([]);
  });
});

describe('fromWorldbookEntries', () => {
  it('gives a nearly empty entry the defaults of a new one', () => {
    const file = fromWorldbookEntries([{ name: 'only a name' }]);
    expect(file).toEqual({
      entries: {
        '0': {
          ...stEntry(0),
          comment: 'only a name',
          // upstream's new entry: constant, at depth 4 as system, title shown
          constant: true,
          selective: false,
          position: 4,
          addMemo: true,
          characterFilter: { isExclude: false, names: [], tags: [] },
        },
      },
    });
    expect(toWorldbookEntries(file)[0]).toMatchObject({
      uid: 0,
      name: 'only a name',
      enabled: true,
      strategy: { type: 'constant', keys: [], scan_depth: 'same_as_global' },
      position: { type: 'at_depth', role: 'system', depth: 4, order: 100 },
      content: '',
      probability: 100,
      recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
      effect: { sticky: null, cooldown: null, delay: null },
    });
  });

  it.each(POSITIONS)('writes position %i for %s', (position, type) => {
    expect(writeOne({ position: { type } })['position']).toBe(position);
  });

  it.each(ROLES)('writes role %i for %s', (role, name) => {
    const written = writeOne({ position: { type: 'at_depth', role: name, depth: 1, order: 5 } });
    expect(written).toMatchObject({ position: 4, role, depth: 1, order: 5 });
  });

  it('writes the three strategy flags', () => {
    const flags = (type: string) => {
      const { constant, selective, vectorized } = writeOne({ strategy: { type } });
      return { constant, selective, vectorized };
    };
    expect(flags('constant')).toEqual({ constant: true, selective: false, vectorized: false });
    expect(flags('selective')).toEqual({ constant: false, selective: true, vectorized: false });
    expect(flags('vectorized')).toEqual({ constant: false, selective: false, vectorized: true });
  });

  it.each(LOGICS)('writes selectiveLogic %i for %s', (selectiveLogic, logic) => {
    const written = writeOne({ strategy: { keys_secondary: { logic, keys: ['a', 'b'] } } });
    expect(written).toMatchObject({ selectiveLogic, keysecondary: ['a', 'b'] });
  });

  it('writes scan depth, the global one as null', () => {
    expect(writeOne({ strategy: { scan_depth: 'same_as_global' } })['scanDepth']).toBeNull();
    expect(writeOne({ strategy: { scan_depth: 8 } })['scanDepth']).toBe(8);
    expect(writeOne({ strategy: {} })['scanDepth']).toBeNull();
  });

  it('writes probability, recursion and effects', () => {
    expect(
      writeOne({
        enabled: false,
        probability: 30,
        recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: 2 },
        effect: { sticky: 4, cooldown: null, delay: 6 },
      }),
    ).toMatchObject({
      disable: true,
      useProbability: true,
      probability: 30,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 2,
      sticky: 4,
      cooldown: null,
      delay: 6,
    });
    expect(writeOne({ recursion: { delay_until: null } })['delayUntilRecursion']).toBe(0);
  });

  it('serialises regex keys, also ones from another realm', () => {
    const foreign: unknown = runInNewContext('/caf[eé]/iu');
    expect(foreign).not.toBeInstanceOf(RegExp);
    const written = writeOne({
      strategy: {
        keys: [/drag(on|ons)/i, 'plain', new RegExp('a/b'), foreign, 12, null, {}],
        keys_secondary: { keys: [/^end$/gm] },
      },
    });
    expect(written['key']).toEqual(['/drag(on|ons)/i', 'plain', '/a\\/b/', '/caf[eé]/iu', '12']);
    expect(written['keysecondary']).toEqual(['/^end$/gm']);
    expect(toWorldbookEntries({ entries: { '0': written } })[0]?.strategy.keys).toEqual([
      /drag(on|ons)/i,
      'plain',
      /a\/b/,
      /caf[eé]/iu,
      '12',
    ]);
  });

  it('keeps unique uids and renumbers missing, invalid and repeated ones', () => {
    const file = fromWorldbookEntries([
      { name: 'none' },
      { uid: 5, name: 'five' },
      { uid: 5, name: 'five again' },
      { uid: 0, name: 'zero' },
      { uid: -1, name: 'negative' },
      { uid: 1.5, name: 'fraction' },
      { uid: '2', name: 'text' },
      'not an entry',
      { uid: 2, name: 'two' },
    ]);
    const names = Object.fromEntries(
      Object.values(file.entries).map((e) => [e['comment'], [e['uid'], e['displayIndex']]]),
    );
    expect(names).toEqual({
      none: [1, 0],
      five: [5, 1],
      'five again': [3, 2],
      zero: [0, 3],
      negative: [4, 4],
      fraction: [6, 5],
      text: [7, 6],
      two: [2, 7],
    });
    for (const [key, entry] of Object.entries(file.entries)) expect(String(entry['uid'])).toBe(key);
  });

  it('starts from the previous entry so unknown ST fields survive', () => {
    const previous = {
      entries: {
        '3': stEntry(3, {
          comment: 'old',
          group: 'pack',
          outletName: 'side',
          extensions: { my_ext: { deep: [1, 2] } },
          futureField: 'kept',
          extra: { stale: true },
        }),
        '9': stEntry(9, { comment: 'dropped' }),
      },
      name: 'Book',
      originalData: { entries: [{ id: 3 }] },
    };
    const snapshot = structuredClone(previous);
    const file = fromWorldbookEntries(
      [
        { uid: 3, name: 'new', strategy: { type: 'selective', keys: ['k'] } },
        { uid: 3, name: 'duplicate' },
      ],
      previous,
    );

    expect(Object.keys(file.entries)).toEqual(['0', '3']);
    expect(file.entries['3']).toMatchObject({
      uid: 3,
      comment: 'new',
      key: ['k'],
      constant: false,
      selective: true,
      group: 'pack',
      outletName: 'side',
      extensions: { my_ext: { deep: [1, 2] } },
      futureField: 'kept',
    });
    // `extra` belongs to the script shape: leaving it out removes it
    expect(file.entries['3']).not.toHaveProperty('extra');
    // a renumbered duplicate is a new entry, it inherits nothing
    expect(file.entries['0']).toMatchObject({ comment: 'duplicate', group: '', outletName: '' });
    expect(file.entries['0']).not.toHaveProperty('futureField');

    expect(file['name']).toBe('Book');
    expect(file['originalData']).toEqual(previous.originalData);
    expect(file['originalData']).not.toBe(previous.originalData);
    expect(file.entries['3']?.['extensions']).not.toBe(previous.entries['3']['extensions']);
    expect(previous).toEqual(snapshot);
  });

  it('takes handed-through ST fields from the entry over the previous ones', () => {
    const previous = stFile(
      stEntry(0, { group: 'old', characterFilter: { isExclude: true, names: ['Ann'], tags: [] } }),
    );
    const written = writeOne(
      {
        uid: 0,
        group: 'new',
        outletName: 'side',
        caseSensitive: true,
        characterFilter: { names: ['Bo'] },
        extra: { note: 1 },
      },
      previous,
    );
    expect(written).toMatchObject({
      group: 'new',
      outletName: 'side',
      caseSensitive: true,
      characterFilter: { isExclude: true, names: ['Bo'], tags: [] },
      extra: { note: 1 },
    });
  });

  it('round-trips a mixed book and does not alias the script entries', () => {
    const file = {
      entries: {
        '0': stEntry(0, { comment: 'a', key: ['/re+x/i', 'word'], displayIndex: 3 }),
        '1': stEntry(1, { constant: true, position: 4, role: 2, depth: 0, displayIndex: 1 }),
        '2': stEntry(2, { vectorized: true, position: 7, outletName: 'side', displayIndex: 2 }),
        '4': stEntry(4, {
          selectiveLogic: 3,
          keysecondary: ['x', '/y/'],
          scanDepth: 5,
          useProbability: false,
          probability: 20,
          delayUntilRecursion: true,
          sticky: 0,
          cooldown: 3,
          role: null,
          extra: { any: ['thing'] },
          extensions: { ext: 1 },
          displayIndex: 0,
        }),
        '8': { key: ['bare'], content: 'old file entry' },
      },
      originalData: { name: 'kept' },
    };
    const once = toWorldbookEntries(file);
    const written = fromWorldbookEntries(once, file);
    expect(toWorldbookEntries(written)).toEqual(once);
    expect(once.map((e) => e.uid)).toEqual([4, 1, 2, 0, 8]);
    expect(Object.values(written.entries).map((e) => e['displayIndex'])).toEqual([3, 1, 2, 0, 4]);
    expect(written['originalData']).toEqual({ name: 'kept' });
    expect(written.entries['4']?.['extensions']).toEqual({ ext: 1 });
    expect(written.entries['4']?.['extra']).not.toBe(once[0]?.extra);
    expect(written.entries['0']?.['key']).toEqual(['/re+x/i', 'word']);
  });

  it('tolerates garbage', () => {
    expect(fromWorldbookEntries([])).toEqual({ entries: {} });
    expect(fromWorldbookEntries('nope' as unknown as unknown[], 'junk')).toEqual({ entries: {} });
    expect(fromWorldbookEntries([null, 1, []], { entries: [] })).toEqual({ entries: {} });
    const written = writeOne({
      uid: 'x',
      name: 4,
      enabled: 'yes',
      strategy: { type: 'blue', keys: 'k', keys_secondary: 3, scan_depth: NaN },
      position: { type: 'nowhere', role: 'narrator', depth: '2', order: null },
      probability: '50',
      recursion: 1,
      effect: { sticky: 'long' },
      extra: 'no',
    });
    expect(written).toEqual({
      ...stEntry(0),
      constant: true,
      selective: false,
      position: 4,
      addMemo: true,
      characterFilter: { isExclude: false, names: [], tags: [] },
    });
  });
});

describe('legacy flat entries', () => {
  it('reads an ST entry', () => {
    const file = stFile(
      stEntry(2, {
        comment: 'Glade',
        content: 'text',
        key: ['a', '/b/i'],
        keysecondary: ['c'],
        selectiveLogic: 1,
        position: 4,
        role: 2,
        depth: 3,
        order: 12,
        probability: 60,
        useProbability: false,
        scanDepth: 7,
        caseSensitive: true,
        matchWholeWords: false,
        automationId: 'auto',
        excludeRecursion: true,
        delayUntilRecursion: 2,
        group: 'g',
        groupOverride: true,
        groupWeight: 30,
        sticky: 4,
        cooldown: 0,
        displayIndex: 11,
      }),
    );
    expect(toLorebookEntries(file)).toEqual([
      {
        uid: 2,
        display_index: 11,
        comment: 'Glade',
        enabled: true,
        type: 'selective',
        position: 'at_depth_as_assistant',
        depth: 3,
        order: 12,
        probability: 60,
        key: ['a', '/b/i'],
        keys: ['a', '/b/i'],
        logic: 'not_all',
        filter: ['c'],
        filters: ['c'],
        scan_depth: 7,
        case_sensitive: true,
        match_whole_words: false,
        use_group_scoring: 'same_as_global',
        automation_id: 'auto',
        exclude_recursion: true,
        prevent_recursion: false,
        delay_until_recursion: 2,
        content: 'text',
        group: 'g',
        group_prioritized: true,
        group_weight: 30,
        sticky: 4,
        cooldown: null,
        delay: null,
      },
    ]);
  });

  it('reads every position, at-depth by role and with a depth only there', () => {
    const read = (over: St) => {
      const [entry] = toLorebookEntries(stFile(stEntry(0, over)));
      return [entry?.position, entry?.depth];
    };
    expect(read({ position: 0 })).toEqual(['before_character_definition', null]);
    expect(read({ position: 1 })).toEqual(['after_character_definition', null]);
    expect(read({ position: 2 })).toEqual(['before_author_note', null]);
    expect(read({ position: 3 })).toEqual(['after_author_note', null]);
    expect(read({ position: 5 })).toEqual(['before_example_messages', null]);
    expect(read({ position: 6 })).toEqual(['after_example_messages', null]);
    expect(read({ position: 4, role: 0, depth: 2 })).toEqual(['at_depth_as_system', 2]);
    expect(read({ position: 4, role: 1, depth: 2 })).toEqual(['at_depth_as_user', 2]);
    expect(read({ position: 4, role: 2, depth: 2 })).toEqual(['at_depth_as_assistant', 2]);
    expect(read({ position: 4, role: null, depth: 2 })).toEqual(['at_depth_as_system', 2]);
    // the flat shape has no outlet
    expect(read({ position: 7, role: 0 })).toEqual(['at_depth_as_system', null]);
  });

  it('keeps stored order, empty automation id as null, legacy delay flag as is', () => {
    const file = stFile(
      stEntry(1, { displayIndex: 5, delayUntilRecursion: true, vectorized: true }),
      stEntry(0, { displayIndex: 9, constant: true }),
    );
    const entries = toLorebookEntries(file);
    expect(entries.map((e) => [e.uid, e.display_index, e.type])).toEqual([
      [0, 9, 'constant'],
      [1, 5, 'vectorized'],
    ]);
    expect(entries[1]).toMatchObject({ automation_id: null, delay_until_recursion: true });
  });

  it('builds a default ST entry from an empty partial', () => {
    expect(fromLorebookEntry({}, 6)).toEqual({
      ...stEntry(6),
      addMemo: true,
      characterFilter: { isExclude: false, names: [], tags: [] },
    });
    expect(fromLorebookEntry({ uid: 99 }, 6)['uid']).toBe(6);
  });

  it('applies every field of a full flat entry', () => {
    const written = fromLorebookEntry(
      {
        display_index: 8,
        comment: 'c',
        enabled: false,
        type: 'vectorized',
        position: 'at_depth_as_user',
        depth: 1,
        order: 9,
        probability: 70,
        keys: ['a'],
        logic: 'and_all',
        filters: ['b'],
        key: ['ignored'],
        filter: ['ignored'],
        scan_depth: 3,
        case_sensitive: false,
        match_whole_words: 'same_as_global',
        use_group_scoring: true,
        automation_id: 'id',
        exclude_recursion: true,
        prevent_recursion: true,
        delay_until_recursion: 2,
        content: 'body',
        group: 'g',
        group_prioritized: true,
        group_weight: 40,
        sticky: 5,
        cooldown: null,
        delay: 1,
      },
      0,
    );
    expect(written).toMatchObject({
      uid: 0,
      displayIndex: 8,
      comment: 'c',
      disable: true,
      constant: false,
      vectorized: true,
      position: 4,
      role: 1,
      depth: 1,
      order: 9,
      probability: 70,
      key: ['a'],
      selectiveLogic: 3,
      keysecondary: ['b'],
      scanDepth: 3,
      caseSensitive: false,
      matchWholeWords: null,
      useGroupScoring: true,
      automationId: 'id',
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 2,
      content: 'body',
      group: 'g',
      groupOverride: true,
      groupWeight: 40,
      sticky: 5,
      cooldown: 0,
      delay: 1,
    });
  });

  it('writes each flat position and logic', () => {
    const base = stEntry(0, { position: 4, role: 1, selectiveLogic: 2 });
    const at = (position: string) => {
      const st = fromLorebookEntry({ position }, 0, base);
      return [st['position'], st['role']];
    };
    expect(at('before_character_definition')).toEqual([0, null]);
    expect(at('after_character_definition')).toEqual([1, null]);
    expect(at('before_author_note')).toEqual([2, null]);
    expect(at('after_author_note')).toEqual([3, null]);
    expect(at('before_example_messages')).toEqual([5, null]);
    expect(at('after_example_messages')).toEqual([6, null]);
    expect(at('at_depth_as_system')).toEqual([4, 0]);
    expect(at('at_depth_as_user')).toEqual([4, 1]);
    expect(at('at_depth_as_assistant')).toEqual([4, 2]);
    // not flat positions
    expect(at('at_depth')).toEqual([4, 1]);
    expect(at('outlet')).toEqual([4, 1]);
    for (const [selectiveLogic, logic] of LOGICS) {
      expect(fromLorebookEntry({ logic }, 0, base)['selectiveLogic']).toBe(selectiveLogic);
    }
    expect(fromLorebookEntry({ logic: 'xor' }, 0, base)['selectiveLogic']).toBe(2);
  });

  it('touches only the given fields of a base entry', () => {
    const base = stEntry(4, {
      comment: 'old',
      key: ['k'],
      depth: 2,
      extensions: { ext: { n: 1 } },
      automationId: 'id',
      sticky: 3,
    });
    const snapshot = structuredClone(base);
    const written = fromLorebookEntry(
      { comment: 'new', depth: null, automation_id: null, sticky: null, order: 'bad' },
      4,
      base,
    );
    expect(written).toEqual({ ...base, comment: 'new', automationId: '', sticky: 0 });
    expect(written['extensions']).not.toBe(base['extensions']);
    expect(written['key']).not.toBe(base['key']);
    expect(base).toEqual(snapshot);
  });

  it('writes a whole read back without moving anything, an outlet entry included', () => {
    const file = stFile(
      stEntry(0, { position: 7, outletName: 'side', depth: 2 }),
      stEntry(1, { position: 4, role: 2, depth: 0, key: ['a'], cooldown: 2 }),
      stEntry(2, { position: 5, role: null, caseSensitive: true, automationId: 'x' }),
    );
    for (const flat of toLorebookEntries(file)) {
      const base = file.entries[String(flat.uid)];
      expect(fromLorebookEntry({ ...flat }, flat.uid, base)).toEqual({
        ...base,
        sticky: 0,
        delay: 0,
        ...(flat.cooldown === null ? { cooldown: 0 } : {}),
      });
    }
  });
});

describe('lorebook settings', () => {
  const stored = {
    world_info: { globalSelect: ['Atlas', 'Bestiary'], charLore: [{ name: 'c', extraBooks: [] }] },
    world_info_depth: 4,
    world_info_min_activations: 1,
    world_info_min_activations_depth_max: 20,
    world_info_budget: 40,
    world_info_include_names: false,
    world_info_recursive: true,
    world_info_overflow_alert: true,
    world_info_case_sensitive: true,
    world_info_match_whole_words: true,
    world_info_character_strategy: 2,
    world_info_budget_cap: 2048,
    world_info_use_group_scoring: true,
    world_info_max_recursion_steps: 3,
  };

  it('reads world_info_settings', () => {
    const settings = toLorebookSettings(stored);
    expect(settings).toEqual({
      selected_global_lorebooks: ['Atlas', 'Bestiary'],
      scan_depth: 4,
      context_percentage: 40,
      budget_cap: 2048,
      min_activations: 1,
      max_depth: 20,
      max_recursion_steps: 3,
      insertion_strategy: 'global_first',
      include_names: false,
      recursive: true,
      case_sensitive: true,
      match_whole_words: true,
      use_group_scoring: true,
      overflow_alert: true,
    });
    expect(settings.selected_global_lorebooks).not.toBe(stored.world_info.globalSelect);
  });

  it("falls back to ST's defaults", () => {
    const defaults = {
      selected_global_lorebooks: [],
      scan_depth: 2,
      context_percentage: 25,
      budget_cap: 0,
      min_activations: 0,
      max_depth: 0,
      max_recursion_steps: 0,
      insertion_strategy: 'character_first',
      include_names: true,
      recursive: false,
      case_sensitive: false,
      match_whole_words: false,
      use_group_scoring: false,
      overflow_alert: false,
    };
    for (const junk of [undefined, null, 'x', [], {}]) {
      expect(toLorebookSettings(junk)).toEqual(defaults);
    }
  });

  it('coerces like ST does on load', () => {
    const settings = toLorebookSettings({
      world_info: 'Solo',
      world_info_depth: '6',
      world_info_budget: 2048,
      world_info_recursive: 1,
      world_info_character_strategy: '0',
      world_info_budget_cap: 'many',
    });
    expect(settings).toMatchObject({
      selected_global_lorebooks: ['Solo'],
      scan_depth: 6,
      context_percentage: 25,
      recursive: true,
      insertion_strategy: 'evenly',
      budget_cap: 0,
    });
    expect(toLorebookSettings({ world_info: ['A', 'B'] }).selected_global_lorebooks).toEqual([
      'A',
      'B',
    ]);
    expect(toLorebookSettings({ world_info_character_strategy: 1 }).insertion_strategy).toBe(
      'character_first',
    );
  });

  it('writes only the keys of the fields given', () => {
    expect(fromLorebookSettings({})).toEqual({});
    expect(fromLorebookSettings({ scan_depth: 5, recursive: false })).toEqual({
      world_info_depth: 5,
      world_info_recursive: false,
    });
    expect(fromLorebookSettings({ insertion_strategy: 'evenly' })).toEqual({
      world_info_character_strategy: 0,
    });
    expect(fromLorebookSettings({ insertion_strategy: 'character_first' })).toEqual({
      world_info_character_strategy: 1,
    });
    expect(fromLorebookSettings({ insertion_strategy: 'global_first' })).toEqual({
      world_info_character_strategy: 2,
    });
  });

  it('skips unusable values and unknown fields', () => {
    expect(
      fromLorebookSettings({
        scan_depth: '5',
        recursive: 1,
        insertion_strategy: 'random',
        selected_global_lorebooks: 'Atlas',
        budget_cap: undefined,
        unknown: true,
      }),
    ).toEqual({});
    expect(fromLorebookSettings(null as unknown as St)).toEqual({});
  });

  it('puts the selected books in world_info.globalSelect, keeping its other data', () => {
    const selected = ['Atlas', 7, 'Codex'];
    expect(fromLorebookSettings({ selected_global_lorebooks: selected })).toEqual({
      world_info: { globalSelect: ['Atlas', 'Codex'] },
    });
    const patch = fromLorebookSettings({ selected_global_lorebooks: ['Codex'] }, stored);
    expect(patch).toEqual({
      world_info: { globalSelect: ['Codex'], charLore: stored.world_info.charLore },
    });
    expect((patch['world_info'] as St)['charLore']).not.toBe(stored.world_info.charLore);
  });

  it('round-trips through a patch', () => {
    const settings = toLorebookSettings(stored);
    const patch = fromLorebookSettings({ ...settings }, stored);
    expect(patch).toEqual(stored);
    expect(toLorebookSettings(patch)).toEqual(settings);
  });
});
