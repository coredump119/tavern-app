// 世界书扫描：对照 ST world-info.js 的 checkWorldInfo 行为编写的确定性测试（random / countTokens 注入）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  WorldInfoBuffer,
  WorldInfoTimedEffects,
  buildChatForWorldInfo,
  checkWorldInfo,
  collectLore,
  getSortedEntries,
  getWorldInfoPrompt,
  parseDecorators,
  DEFAULT_WORLD_INFO_SETTINGS,
  SCAN_STATE,
  WORLD_INFO_INSERTION_STRATEGY,
  WORLD_INFO_LOGIC,
  WORLD_INFO_POSITION,
  type WIBook,
  type WIEntry,
  type WorldInfoSettings,
  type WorldInfoScanDeps,
} from '../src/index.js';

let uidCounter = 0;
const entry = (over: Partial<WIEntry> = {}): WIEntry => ({
  uid: over.uid ?? uidCounter++,
  world: 'test',
  key: [],
  keysecondary: [],
  content: '',
  constant: false,
  selective: true,
  selectiveLogic: WORLD_INFO_LOGIC.AND_ANY,
  order: 100,
  position: WORLD_INFO_POSITION.before,
  disable: false,
  probability: 100,
  useProbability: true,
  depth: 4,
  group: '',
  ...over,
});
const sorted = (entries: WIEntry[], strategy = WORLD_INFO_INSERTION_STRATEGY.character_first) =>
  getSortedEntries(
    { globalLore: entries, characterLore: [], chatLore: [], personaLore: [] },
    strategy,
  );

interface RunOptions {
  settings?: Partial<WorldInfoSettings>;
  chatMetadata?: Record<string, unknown>;
  random?: () => number;
  deps?: Partial<WorldInfoScanDeps>;
  maxContext?: number;
  isDryRun?: boolean;
  globalScanData?: Partial<import('../src/index.js').WIGlobalScanData>;
}
async function run(entries: WIEntry[], chat: string[], o: RunOptions = {}) {
  const chatMetadata = o.chatMetadata ?? {};
  const deps: WorldInfoScanDeps = {
    settings: { ...DEFAULT_WORLD_INFO_SETTINGS, ...(o.settings ?? {}) },
    chatMetadata,
    substitute: (t) => t.replace(/{{user}}/g, 'Yun').replace(/{{char}}/g, 'Sera'),
    countTokens: (t) => t.length,
    random: o.random ?? (() => 0.5),
    ...(o.deps ?? {}),
  };
  const result = await checkWorldInfo(
    {
      chat,
      maxContext: o.maxContext ?? 4000,
      isDryRun: o.isDryRun ?? false,
      sortedEntries: sorted(entries),
      globalScanData: o.globalScanData,
    },
    deps,
  );
  return {
    ...result,
    uids: [...result.allActivatedEntries].map((e) => e.uid).sort((a, b) => a - b),
    chatMetadata,
  };
}

describe('parseDecorators', () => {
  it('extracts known decorators and strips them from content', () => {
    expect(parseDecorators('plain')).toEqual([[], 'plain']);
    expect(parseDecorators('@@activate\nbody')).toEqual([['@@activate'], 'body']);
    expect(parseDecorators('@@dont_activate\n@@activate\nbody\nmore')).toEqual([
      ['@@dont_activate', '@@activate'],
      'body\nmore',
    ]);
    // 未知 @@ 行触发 fallback，后续 @@@ 行作为备选被接受
    expect(parseDecorators('@@unknown\n@@@activate\nbody')).toEqual([['@@activate'], 'body']);
    // 无 fallback 时 @@@ 行被忽略
    expect(parseDecorators('@@@activate\nbody')).toEqual([[], 'body']);
    expect(parseDecorators('@@activate')).toEqual([['@@activate'], '@@activate']);
  });
});

describe('collectLore / getSortedEntries', () => {
  const books: Record<string, WIBook> = {
    G: { entries: { '0': { uid: 0, key: ['g'], order: 50 } } },
    C: {
      entries: { '0': { uid: 0, key: ['c'], order: 10 }, '1': { uid: 1, key: ['c2'], order: 200 } },
    },
    X: { entries: { '7': { uid: 7, key: ['x'], order: 100 } } },
    Chat: { entries: { '3': { uid: 3, key: ['chat'], order: 1 } } },
    P: { entries: { '4': { uid: 4, key: ['p'], order: 1 } } },
  };
  const load = (n: string) => books[n];
  it('dedupes books across sources like ST', () => {
    const lore = collectLore(
      {
        globalBooks: ['G', 'C'],
        characterBook: 'C',
        characterExtraBooks: ['X'],
        chatBook: 'Chat',
        personaBook: 'P',
      },
      load,
    );
    expect(lore.globalLore.map((e) => `${e.world}.${e.uid}`)).toEqual(['G.0', 'C.0', 'C.1']);
    expect(lore.characterLore.map((e) => e.world)).toEqual(['X']);
    expect(lore.chatLore.map((e) => e.uid)).toEqual([3]);
    expect(lore.personaLore.map((e) => e.uid)).toEqual([4]);
    const dup = collectLore(
      { globalBooks: ['Chat'], chatBook: 'Chat', personaBook: 'Chat', characterBook: 'Chat' },
      load,
    );
    expect(dup.chatLore).toEqual([]);
    expect(dup.personaLore).toEqual([]);
    expect(dup.characterLore).toEqual([]);
    expect(collectLore({ globalBooks: ['Missing'] }, load).globalLore).toEqual([]);
  });
  it('orders by strategy with chat and persona lore first, and adds hash + decorators', () => {
    const lore = collectLore(
      { globalBooks: ['G'], characterBook: 'C', chatBook: 'Chat', personaBook: 'P' },
      load,
    );
    const ids = (s: number) => getSortedEntries(lore, s).map((e) => `${e.world}.${e.uid}`);
    expect(ids(WORLD_INFO_INSERTION_STRATEGY.character_first)).toEqual([
      'Chat.3',
      'P.4',
      'C.1',
      'C.0',
      'G.0',
    ]);
    expect(ids(WORLD_INFO_INSERTION_STRATEGY.global_first)).toEqual([
      'Chat.3',
      'P.4',
      'G.0',
      'C.1',
      'C.0',
    ]);
    expect(ids(WORLD_INFO_INSERTION_STRATEGY.evenly)).toEqual([
      'Chat.3',
      'P.4',
      'C.1',
      'G.0',
      'C.0',
    ]);
    const e = getSortedEntries(lore, 1)[0]!;
    expect(typeof e.hash).toBe('number');
    expect(e.decorators).toEqual([]);
  });
});

describe('WorldInfoBuffer', () => {
  const s = { ...DEFAULT_WORLD_INFO_SETTINGS, world_info_depth: 2 };
  const g = {
    trigger: 'normal',
    personaDescription: 'PERSONA',
    characterDescription: '',
    characterPersonality: '',
    characterDepthPrompt: '',
    scenario: '',
    creatorNotes: '',
  };
  it('slices by depth, includes injects/recursion/global scan data', () => {
    const b = new WorldInfoBuffer(['m0', 'm1', 'm2'], g, s);
    expect(b.get(entry(), SCAN_STATE.INITIAL)).toBe('\x01m0\n\x01m1');
    expect(b.get(entry({ scanDepth: 3 }), SCAN_STATE.INITIAL)).toBe('\x01m0\n\x01m1\n\x01m2');
    expect(b.get(entry({ scanDepth: 0 }), SCAN_STATE.INITIAL)).toBe('');
    b.advanceScan();
    expect(b.getDepth()).toBe(3);
    b.addInject('INJ');
    b.addRecurse('REC');
    expect(b.get(entry({ matchPersonaDescription: true }), SCAN_STATE.INITIAL)).toBe(
      '\x01m0\n\x01m1\n\x01m2\n\x01PERSONA\n\x01INJ\n\x01REC',
    );
    expect(b.get(entry(), SCAN_STATE.MIN_ACTIVATIONS)).toBe('\x01m0\n\x01m1\n\x01m2\n\x01INJ');
  });
  it('matches keys: case, whole words, regex', () => {
    const b = new WorldInfoBuffer(['The Dragon roars'], g, s);
    const e = entry();
    expect(b.matchKeys('The Dragon roars', 'dragon', e)).toBe(true);
    expect(b.matchKeys('The Dragon roars', 'dragon', entry({ caseSensitive: true }))).toBe(false);
    expect(b.matchKeys('The Dragons roar', 'dragon', entry({ matchWholeWords: true }))).toBe(false);
    expect(b.matchKeys('The Dragon, roars', 'dragon', entry({ matchWholeWords: true }))).toBe(true);
    expect(b.matchKeys('a big dragon', 'big dragon', entry({ matchWholeWords: true }))).toBe(true);
    expect(b.matchKeys('The Dragon roars', '/drag(on|ons)\\b/i', e)).toBe(true);
    expect(b.matchKeys('The Dragon roars', '/DRAGON/', e)).toBe(false);
    expect(b.matchKeys('a/b', '/a/b/', e)).toBe(false); // 未转义的 / → 不是正则 → 按字面不匹配 "/a/b/"
    expect(b.matchKeys('x a/b y', '/a\\/b/', e)).toBe(true);
  });
  it('scores keys per selective logic', () => {
    const b = new WorldInfoBuffer(['alpha beta gamma'], g, s);
    expect(
      b.getScore(
        entry({
          key: ['alpha', 'zeta'],
          keysecondary: ['beta', 'nope'],
          selectiveLogic: WORLD_INFO_LOGIC.AND_ANY,
        }),
        SCAN_STATE.INITIAL,
      ),
    ).toBe(2);
    expect(
      b.getScore(
        entry({
          key: ['alpha', 'zeta'],
          keysecondary: ['beta', 'nope'],
          selectiveLogic: WORLD_INFO_LOGIC.AND_ALL,
        }),
        SCAN_STATE.INITIAL,
      ),
    ).toBe(1);
    expect(
      b.getScore(
        entry({
          key: ['alpha'],
          keysecondary: ['beta', 'gamma'],
          selectiveLogic: WORLD_INFO_LOGIC.AND_ALL,
        }),
        SCAN_STATE.INITIAL,
      ),
    ).toBe(3);
    expect(
      b.getScore(
        entry({ key: ['alpha'], keysecondary: ['beta'], selectiveLogic: WORLD_INFO_LOGIC.NOT_ANY }),
        SCAN_STATE.INITIAL,
      ),
    ).toBe(1);
    expect(b.getScore(entry({ key: [], keysecondary: ['beta'] }), SCAN_STATE.INITIAL)).toBe(0);
  });
});

describe('checkWorldInfo', () => {
  it('activates by primary key within depth; respects scanDepth and disable', async () => {
    const es = [
      entry({ uid: 1, key: ['dragon'], content: 'D' }),
      entry({ uid: 2, key: ['castle'], content: 'C' }),
      entry({ uid: 3, key: ['castle'], content: 'C3', scanDepth: 5 }),
      entry({ uid: 4, key: ['dragon'], content: 'X', disable: true }),
    ];
    const r = await run(es, ['A dragon appears', 'old msg', 'the castle', 'older']);
    expect(r.uids).toEqual([1, 3]);
    // 同 order 的条目按激活顺序 unshift → 输出倒序（与 ST 一致）
    expect(r.worldInfoBefore).toBe('C3\nD');
  });
  it('substitutes macros in keys and content', async () => {
    const r = await run(
      [entry({ uid: 1, key: ['{{user}}'], content: 'Hello {{char}}' })],
      ['Yun says hi'],
    );
    expect(r.uids).toEqual([1]);
    expect(r.worldInfoBefore).toBe('Hello Sera');
  });
  it('applies secondary key logic', async () => {
    const chat = ['alpha and beta here'];
    const mk = (logic: number, keysecondary: string[]) =>
      entry({
        uid: logic * 10 + keysecondary.length,
        key: ['alpha'],
        keysecondary,
        selectiveLogic: logic,
      });
    expect((await run([mk(WORLD_INFO_LOGIC.AND_ANY, ['beta', 'zzz'])], chat)).uids.length).toBe(1);
    expect((await run([mk(WORLD_INFO_LOGIC.AND_ANY, ['yyy', 'zzz'])], chat)).uids.length).toBe(0);
    expect((await run([mk(WORLD_INFO_LOGIC.AND_ALL, ['beta', 'here'])], chat)).uids.length).toBe(1);
    expect((await run([mk(WORLD_INFO_LOGIC.AND_ALL, ['beta', 'zzz'])], chat)).uids.length).toBe(0);
    expect((await run([mk(WORLD_INFO_LOGIC.NOT_ANY, ['yyy', 'zzz'])], chat)).uids.length).toBe(1);
    expect((await run([mk(WORLD_INFO_LOGIC.NOT_ANY, ['beta'])], chat)).uids.length).toBe(0);
    expect((await run([mk(WORLD_INFO_LOGIC.NOT_ALL, ['beta', 'zzz'])], chat)).uids.length).toBe(1);
    expect((await run([mk(WORLD_INFO_LOGIC.NOT_ALL, ['beta', 'here'])], chat)).uids.length).toBe(0);
    // selective=false 忽略次关键词
    expect(
      (
        await run(
          [entry({ uid: 9, key: ['alpha'], keysecondary: ['zzz'], selective: false })],
          chat,
        )
      ).uids,
    ).toEqual([9]);
  });
  it('constant, triggers, character filters, decorators, external activation', async () => {
    const es = [
      entry({ uid: 1, constant: true, content: 'const' }),
      entry({ uid: 2, constant: true, triggers: ['continue'], content: 'cont-only' }),
      entry({ uid: 3, constant: true, characterFilter: { names: ['sera'], isExclude: false } }),
      entry({ uid: 4, constant: true, characterFilter: { names: ['sera'], isExclude: true } }),
      entry({ uid: 5, constant: true, characterFilter: { tags: ['fantasy'], isExclude: false } }),
      entry({ uid: 6, constant: true, characterFilter: { tags: ['scifi'], isExclude: false } }),
      entry({ uid: 7, content: '@@activate\nforced' }),
      entry({ uid: 8, constant: true, content: '@@dont_activate\nnever' }),
      entry({ uid: 9, key: ['nomatch'] }),
    ];
    const deps = { characterFilename: 'sera', characterTags: ['fantasy'] };
    const r = await run(es, ['hello'], { deps });
    expect(r.uids).toEqual([1, 3, 5, 7]);
    const rc = await run(es, ['hello'], { deps, globalScanData: { trigger: 'continue' } });
    expect(rc.uids).toEqual([1, 2, 3, 5, 7]);
    const ext = new Map([['test.9', { ...es[8]!, content: 'EXT' }]]);
    const re = await run(es, ['hello'], { deps: { ...deps, externalActivations: ext } });
    expect(re.uids).toContain(9);
    expect(re.worldInfoBefore).toContain('EXT');
    expect(ext.size).toBe(0); // resetExternalEffects
  });
  it('recursion: activates by other entries content, excludeRecursion, preventRecursion, max steps', async () => {
    const es = [
      entry({ uid: 1, key: ['start'], content: 'mentions chain' }),
      entry({ uid: 2, key: ['chain'], content: 'mentions link' }),
      entry({ uid: 3, key: ['link'], content: 'end' }),
      entry({ uid: 4, key: ['chain'], content: 'no-rec', excludeRecursion: true }),
      entry({ uid: 5, key: ['start'], content: 'mentions solo', preventRecursion: true }),
      entry({ uid: 6, key: ['solo'], content: 'from-solo' }),
    ];
    expect((await run(es, ['start'])).uids).toEqual([1, 5]);
    expect((await run(es, ['start'], { settings: { world_info_recursive: true } })).uids).toEqual([
      1, 2, 3, 5,
    ]);
    expect(
      (
        await run(es, ['start'], {
          settings: { world_info_recursive: true, world_info_max_recursion_steps: 2 },
        })
      ).uids,
    ).toEqual([1, 2, 5]);
    expect(
      (await run(es, ['start chain'], { settings: { world_info_recursive: true } })).uids,
    ).toEqual([1, 2, 3, 4, 5]);
  });
  it('delayUntilRecursion levels', async () => {
    const es = [
      entry({ uid: 1, key: ['go'], content: 'A' }),
      entry({ uid: 2, key: ['go'], content: 'B', delayUntilRecursion: true }),
      entry({ uid: 3, key: ['go'], content: 'C', delayUntilRecursion: 2 }),
      entry({ uid: 4, key: ['C'], content: 'D', delayUntilRecursion: 2, caseSensitive: true }),
    ];
    const r = await run(es, ['go'], { settings: { world_info_recursive: true } });
    expect(r.uids).toEqual([1, 2, 3, 4]);
    // 非递归模式：扫描收尾时仍会按剩余延迟层级补跑递归轮（ST 行为），但没有递归缓冲所以 4 不激活
    expect((await run(es, ['go'])).uids).toEqual([1, 2, 3]);
  });
  it('min activations widens depth until satisfied or capped', async () => {
    const es = [
      entry({ uid: 1, key: ['deep'], content: 'deep' }),
      entry({ uid: 2, key: ['deeper'], content: 'deeper' }),
    ];
    const chat = ['m0', 'm1', 'deep', 'deeper', 'm4'];
    expect((await run(es, chat, { settings: { world_info_depth: 1 } })).uids).toEqual([]);
    expect(
      (await run(es, chat, { settings: { world_info_depth: 1, world_info_min_activations: 1 } }))
        .uids,
    ).toEqual([1]);
    expect(
      (await run(es, chat, { settings: { world_info_depth: 1, world_info_min_activations: 2 } }))
        .uids,
    ).toEqual([1, 2]);
    // depth_max 用 > 判定：getDepth()=3 时不算超限，还会再推进到 4
    expect(
      (
        await run(es, chat, {
          settings: {
            world_info_depth: 1,
            world_info_min_activations: 2,
            world_info_min_activations_depth_max: 3,
          },
        })
      ).uids,
    ).toEqual([1, 2]);
    expect(
      (
        await run(es, chat, {
          settings: {
            world_info_depth: 1,
            world_info_min_activations: 2,
            world_info_min_activations_depth_max: 2,
          },
        })
      ).uids,
    ).toEqual([1]);
  });
  it('probability rolls once per entry and failed entries stay out', async () => {
    const es = [
      entry({ uid: 1, key: ['x'], probability: 30, content: 'A' }),
      entry({ uid: 2, key: ['x'], probability: 30, useProbability: false, content: 'B' }),
    ];
    expect((await run(es, ['x'], { random: () => 0.5 })).uids).toEqual([2]);
    expect((await run(es, ['x'], { random: () => 0.2 })).uids).toEqual([1, 2]);
  });
  it('token budget: stops at budget, ignoreBudget bypasses, cap applies', async () => {
    const es = [
      entry({ uid: 1, key: ['x'], content: '12345', order: 300 }),
      entry({ uid: 2, key: ['x'], content: '12345', order: 200 }),
      entry({ uid: 3, key: ['x'], content: 'free', order: 100, ignoreBudget: true }),
    ];
    // budget = 25% * 40 = 10 chars → 第一条 5 字符 + 换行通过（6 < 10），第二条累计 12 ≥ 10 溢出
    const r = await run(es, ['x'], { maxContext: 40 });
    expect(r.uids).toEqual([1, 3]);
    // the result says what was left out, whether or not the alert option is on
    expect(r.budgetOverflow).toEqual({ budget: 10, activated: 1, firstSkipped: 'x' });
    expect((await run(es, ['x'], { maxContext: 4000 })).budgetOverflow).toBeUndefined();
    const r2 = await run(es, ['x'], { maxContext: 4000, settings: { world_info_budget_cap: 10 } });
    expect(r2.uids).toEqual([1, 3]);
    const alerts: number[] = [];
    await run(es, ['x'], {
      maxContext: 40,
      settings: { world_info_overflow_alert: true },
      deps: { onOverflow: (b) => void alerts.push(b) },
    });
    expect(alerts).toEqual([10]);
  });
  it('inclusion groups: prio override, weighted roll, scoring, already-activated group', async () => {
    const grp = (uid: number, over: Partial<WIEntry> = {}) =>
      entry({ uid, key: ['x'], group: 'g', content: `E${uid}`, ...over });
    expect(
      (
        await run(
          [
            grp(1),
            grp(2, { groupOverride: true, order: 50 }),
            grp(3, { groupOverride: true, order: 90 }),
          ],
          ['x'],
        )
      ).uids,
    ).toEqual([3]);
    // 权重 100/100/100，roll 0.5*300=150 → 第二个
    expect((await run([grp(1), grp(2), grp(3)], ['x'], { random: () => 0.5 })).uids).toEqual([2]);
    expect((await run([grp(1), grp(2), grp(3)], ['x'], { random: () => 0.1 })).uids).toEqual([1]);
    expect(
      (
        await run([grp(1, { groupWeight: 1 }), grp(2, { groupWeight: 1000 })], ['x'], {
          random: () => 0.5,
        })
      ).uids,
    ).toEqual([2]);
    // 组评分：匹配更多关键词者胜
    const scored = [grp(1, { key: ['x'] }), grp(2, { key: ['x', 'y'] })];
    expect(
      (await run(scored, ['x y'], { settings: { world_info_use_group_scoring: true } })).uids,
    ).toEqual([2]);
    // 组已激活（递归轮）：同组新条目全部剔除
    const rec = [grp(1, { key: ['x'], content: 'says y' }), grp(2, { key: ['y'] })];
    expect((await run(rec, ['x'], { settings: { world_info_recursive: true } })).uids).toEqual([1]);
    // 多组名用逗号分隔
    expect(
      (await run([grp(1, { group: 'a, b' }), grp(2, { group: 'b' })], ['x'], { random: () => 0.9 }))
        .uids,
    ).toEqual([2]);
  });
  it('timed effects: sticky persists, cooldown blocks, sticky end starts cooldown, delay, dry run', async () => {
    const es = [
      entry({ uid: 1, key: ['x'], sticky: 2, cooldown: 2, content: 'S' }),
      entry({ uid: 2, key: ['y'], delay: 3, content: 'D' }),
    ];
    const meta: Record<string, unknown> = {};
    const deep = { world_info_depth: 10 };
    const r1 = await run(es, ['x', 'y'], { chatMetadata: meta, settings: deep });
    expect(r1.uids).toEqual([1]); // y 被 delay 压住（chat.length 2 < 3）
    const timed = meta['timedWorldInfo'] as {
      sticky: Record<string, { start: number; end: number }>;
      cooldown: Record<string, unknown>;
    };
    expect(timed.sticky['test.1']).toMatchObject({ start: 2, end: 4 });
    // 下一条消息没有关键词：sticky 仍激活；delay 到期 y 激活
    const r2 = await run(es, ['nothing', 'x', 'y'], { chatMetadata: meta, settings: deep });
    expect(r2.uids).toEqual([1, 2]);
    // chat 到 4：sticky 过期 → 进入 cooldown（protected），x 出现也不激活
    const r3 = await run(es, ['x', 'nothing', 'x', 'y'], { chatMetadata: meta, settings: deep });
    expect(r3.uids).toEqual([2]);
    expect(timed.sticky['test.1']).toBeUndefined();
    expect(timed.cooldown['test.1']).toMatchObject({ start: 4, end: 6, protected: true });
    // cooldown 过期后恢复
    const r4 = await run(es, ['x', 'a', 'b', 'c', 'd', 'y'], {
      chatMetadata: meta,
      settings: deep,
    });
    expect(r4.uids).toEqual([1, 2]);
    // dry run 不写 metadata
    const dry: Record<string, unknown> = {};
    await run(es, ['x'], { chatMetadata: dry, isDryRun: true, settings: deep });
    expect((dry['timedWorldInfo'] as { sticky: object }).sticky).toEqual({});
    // chat 未推进（长度 ≤ start 且非 protected）→ 清除
    const stale: Record<string, unknown> = {
      timedWorldInfo: {
        sticky: { 'test.1': { hash: 0, start: 5, end: 7, protected: false } },
        cooldown: {},
      },
    };
    await run(es, ['x'], { chatMetadata: stale, settings: deep });
    // 陈旧记录被清除；同轮 x 又激活了条目 1，于是写入新的 sticky（start=1）
    expect(
      (stale['timedWorldInfo'] as { sticky: Record<string, object> }).sticky['test.1'],
    ).toMatchObject({ start: 1, end: 3, protected: false });
  });
  it('builds prompt sections by position, order and depth/role grouping', async () => {
    const P = WORLD_INFO_POSITION;
    const es = [
      entry({ uid: 1, constant: true, position: P.before, order: 10, content: 'b10' }),
      entry({ uid: 2, constant: true, position: P.before, order: 200, content: 'b200' }),
      entry({ uid: 3, constant: true, position: P.after, content: 'after' }),
      entry({ uid: 4, constant: true, position: P.EMTop, content: 'emtop' }),
      entry({ uid: 5, constant: true, position: P.EMBottom, content: 'embottom' }),
      entry({ uid: 6, constant: true, position: P.ANTop, content: 'antop' }),
      entry({ uid: 7, constant: true, position: P.ANBottom, content: 'anbottom' }),
      entry({
        uid: 8,
        constant: true,
        position: P.atDepth,
        depth: 2,
        role: 1,
        order: 5,
        content: 'd2u-5',
      }),
      entry({
        uid: 9,
        constant: true,
        position: P.atDepth,
        depth: 2,
        role: 1,
        order: 50,
        content: 'd2u-50',
      }),
      entry({ uid: 10, constant: true, position: P.atDepth, depth: 2, role: 0, content: 'd2s' }),
      entry({ uid: 11, constant: true, position: P.outlet, outletName: 'o1', content: 'out1' }),
      entry({ uid: 12, constant: true, position: P.outlet, content: 'no-name' }),
      entry({ uid: 13, constant: true, position: P.before, content: '' }),
    ];
    const r = await run(es, ['hi'], {
      deps: { applyRegex: (c, depth) => (depth === 2 ? c.toUpperCase() : c) },
    });
    expect(r.worldInfoBefore).toBe('b10\nb200');
    expect(r.worldInfoAfter).toBe('after');
    expect(r.EMEntries).toEqual([
      { position: 1, content: 'embottom' },
      { position: 0, content: 'emtop' },
    ]);
    expect(r.ANBeforeEntries).toEqual(['antop']);
    expect(r.ANAfterEntries).toEqual(['anbottom']);
    expect(r.WIDepthEntries).toEqual([
      { depth: 2, entries: ['D2S'], role: 0 },
      { depth: 2, entries: ['D2U-5', 'D2U-50'], role: 1 },
    ]);
    expect(r.outletEntries).toEqual({ o1: ['out1'] });
    expect(r.uids).toContain(13);
  });
  it('scan injects and global scan data are searched', async () => {
    const es = [
      entry({ uid: 1, key: ['note'] }),
      entry({ uid: 2, key: ['elf'], matchCharacterDescription: true }),
      entry({ uid: 3, key: ['elf'] }),
    ];
    const r = await run(es, ['hello'], {
      deps: { scanInjects: ['authors note'] },
      globalScanData: { characterDescription: 'an elf' },
    });
    expect(r.uids).toEqual([1, 2]);
  });
  it('onScanDone hook can alter state; getWorldInfoPrompt and buildChatForWorldInfo shapes', async () => {
    const states: number[] = [];
    const es = [
      entry({ uid: 1, key: ['x'], content: 'says y' }),
      entry({ uid: 2, key: ['y'], content: 'Y' }),
    ];
    const r = await run(es, ['x'], {
      settings: { world_info_recursive: true },
      deps: {
        onScanDone: (args) => {
          states.push(args.state.current);
          if (args.state.loopCount === 1) args.state.next = SCAN_STATE.NONE;
        },
      },
    });
    expect(r.uids).toEqual([1]);
    expect(states).toEqual([1]);
    const p = await getWorldInfoPrompt(
      { chat: ['x'], maxContext: 4000, sortedEntries: sorted(es) },
      {
        settings: DEFAULT_WORLD_INFO_SETTINGS,
        chatMetadata: {},
        substitute: (t) => t,
        countTokens: () => 0,
      },
    );
    expect(p.worldInfoString).toBe('says y');
    expect(p.allActivatedEntries.map((e) => e.uid)).toEqual([1]);
    expect(
      buildChatForWorldInfo(
        [
          { name: 'A', mes: '1' },
          { name: 'B', mes: '2' },
        ],
        true,
      ),
    ).toEqual(['B: 2', 'A: 1']);
    expect(buildChatForWorldInfo([{ name: 'A', mes: '1' }], false)).toEqual(['1']);
    expect((await run([], ['x'])).uids).toEqual([]);
  });
  it('works on the Eldoria fixture shipped with ST', async () => {
    const book = JSON.parse(
      readFileSync(
        new URL('../../formats/tests/fixtures/world-eldoria.json', import.meta.url),
        'utf8',
      ),
    ) as WIBook;
    const lore = collectLore({ globalBooks: ['Eldoria'] }, () => book);
    const entries = getSortedEntries(lore, WORLD_INFO_INSERTION_STRATEGY.character_first);
    const r = await checkWorldInfo(
      {
        chat: ['Yun: Tell me about the magical forest and the glade'],
        maxContext: 8000,
        sortedEntries: entries,
      },
      {
        settings: DEFAULT_WORLD_INFO_SETTINGS,
        chatMetadata: {},
        substitute: (t) => t.replace(/{{user}}/g, 'Yun').replace(/{{char}}/g, 'Seraphina'),
        countTokens: (t) => Math.ceil(t.length / 4),
      },
    );
    // 'magical' 子串命中条目 3 的 'magic'
    expect([...r.allActivatedEntries].map((e) => e.uid).sort()).toEqual([0, 2, 3]);
    // 同 order → 激活顺序倒置：powers、glade、Eldoria
    const before = r.worldInfoBefore;
    expect(before.indexOf('What are your powers?')).toBeLessThan(
      before.indexOf('What is the glade?'),
    );
    expect(before.indexOf('What is the glade?')).toBeLessThan(before.indexOf('What is Eldoria?'));
    expect(before).toContain('Seraphina');
  });
});

describe('WorldInfoTimedEffects', () => {
  it('normalizes metadata and reports effect metadata', () => {
    const meta: Record<string, unknown> = {
      timedWorldInfo: { sticky: { bad: null }, cooldown: 'x' },
    };
    const e = entry({ uid: 1, sticky: 2, hash: 7 });
    const t = new WorldInfoTimedEffects(['a'], [e], meta);
    expect(meta['timedWorldInfo']).toEqual({ sticky: {}, cooldown: {} });
    t.setTimedEffects([e]);
    expect(t.getEffectMetadata('sticky', e)).toEqual({
      hash: 7,
      start: 1,
      end: 3,
      protected: false,
    });
    t.setTimedEffect('sticky', e, false);
    expect(t.getEffectMetadata('sticky', e)).toBeNull();
    expect(t.isValidEffectType('nope')).toBe(false);
  });
});
