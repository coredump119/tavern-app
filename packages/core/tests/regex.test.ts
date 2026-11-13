// 正则脚本引擎：对照 ST extensions/regex/engine.js 的确定性测试 + 接入 CC/TC 管线。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORLD_INFO_SETTINGS,
  MacroEngine,
  PERSONA_DESCRIPTION_POSITIONS,
  REGEX_PLACEMENT,
  REGEX_SCRIPT_TYPES,
  RegexEngine,
  RegexProvider,
  SUBSTITUTE_FIND_REGEX,
  WORLD_INFO_POSITION,
  buildChatCompletionPrompt,
  buildTextCompletionPrompt,
  createApplyRegex,
  createCapturingLogger,
  defaultChatCompletionSettings,
  getRegexScripts,
  getSortedEntries,
  regexFromString,
  sanitizeRegexMacro,
  type RegexScript,
  type RegexScriptSources,
} from '../src/index.js';
import { createTestState, defaultPowerUser } from './helpers.js';

const script = (over: Partial<RegexScript> = {}): RegexScript => ({
  id: 's',
  scriptName: 'test',
  findRegex: '/foo/g',
  replaceString: 'bar',
  trimStrings: [],
  placement: [REGEX_PLACEMENT.AI_OUTPUT],
  disabled: false,
  markdownOnly: false,
  promptOnly: false,
  runOnEdit: true,
  substituteRegex: SUBSTITUTE_FIND_REGEX.NONE,
  minDepth: null,
  maxDepth: null,
  ...over,
});

function mkEngine(
  sources: RegexScriptSources,
  stateOver: Parameters<typeof createTestState>[0] = {},
) {
  const macro = new MacroEngine({ logger: createCapturingLogger([]) });
  const state = createTestState({ userName: 'Yun', charName: 'Sera', ...stateOver });
  const engine = new RegexEngine({
    substitute: (t, o) => macro.substituteParams(t, state, o),
    sources: () => sources,
  });
  return { engine, state, macro };
}

describe('regexFromString / RegexProvider', () => {
  it('parses delimited, bare and invalid-flag inputs like ST', () => {
    expect(regexFromString('/ab+c/gi')).toEqual(/ab+c/gi);
    expect(regexFromString('ab+c')).toEqual(/ab+c/);
    expect(regexFromString('/a/b/g')).toEqual(/a\/b/g);
    // 非法 flags → 整串作为 pattern
    expect(regexFromString('/abc/zz')?.source).toBe('\\/abc\\/zz');
    expect(regexFromString('/abc/gg')?.source).toBe('\\/abc\\/gg');
    expect(regexFromString('/(/')).toBeUndefined();
    expect(regexFromString('')).toBeUndefined();
  });
  it('caches with LRU eviction and resets lastIndex for global regexes', () => {
    const p = new RegexProvider(2);
    const a = p.get('/a/g')!;
    a.lastIndex = 5;
    expect(p.get('/a/g')).toBe(a);
    expect(a.lastIndex).toBe(0);
    p.get('/b/');
    p.get('/c/');
    expect(p.size).toBe(2);
    expect(p.get('/a/g')).not.toBe(a); // 被淘汰后重新编译
    expect(p.get('/(/')).toBeNull();
  });
  it('sanitizeRegexMacro escapes specials and control chars', () => {
    expect(sanitizeRegexMacro('a.b*c\n(d)|e/f\\g')).toBe('a\\.b\\*c\\n\\(d\\)\\|e\\/f\\\\g');
    expect(sanitizeRegexMacro('plain')).toBe('plain');
  });
});

describe('getRegexScripts', () => {
  it('orders GLOBAL → PRESET → SCOPED and honors allow lists', () => {
    const g = script({ id: 'g' });
    const p = script({ id: 'p' });
    const s = script({ id: 's' });
    const src: RegexScriptSources = { global: [g], preset: [p], scoped: [s] };
    expect(getRegexScripts(src).map((x) => x.id)).toEqual(['g', 'p', 's']);
    expect(getRegexScripts(src, { allowedOnly: true }).map((x) => x.id)).toEqual(['g']);
    expect(
      getRegexScripts(
        { ...src, scopedAllowed: true, presetAllowed: true },
        { allowedOnly: true },
      ).map((x) => x.id),
    ).toEqual(['g', 'p', 's']);
    expect(Object.values(REGEX_SCRIPT_TYPES)).toEqual([0, 2, 1]);
  });
});

describe('RegexEngine.getRegexedString', () => {
  it('applies by placement, respects disabled / extension disabled / non-string input', () => {
    const { engine } = mkEngine({
      global: [script(), script({ id: 'x', disabled: true, replaceString: 'NO' })],
    });
    expect(engine.getRegexedString('foo foo', REGEX_PLACEMENT.AI_OUTPUT)).toBe('bar bar');
    expect(engine.getRegexedString('foo', REGEX_PLACEMENT.USER_INPUT)).toBe('foo');
    expect(engine.getRegexedString('foo', undefined)).toBe('foo');
    expect(engine.getRegexedString(42, REGEX_PLACEMENT.AI_OUTPUT)).toBe('');
    expect(
      mkEngine({ global: [script()], extensionDisabled: true }).engine.getRegexedString(
        'foo',
        REGEX_PLACEMENT.AI_OUTPUT,
      ),
    ).toBe('foo');
  });
  it('markdownOnly / promptOnly / neither gating and runOnEdit', () => {
    const { engine } = mkEngine({
      global: [
        script({ id: 'md', markdownOnly: true, replaceString: 'MD' }),
        script({ id: 'pr', promptOnly: true, replaceString: 'PR' }),
        script({ id: 'both', replaceString: 'BOTH', runOnEdit: false }),
      ],
    });
    expect(engine.getRegexedString('foo', REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true })).toBe(
      'MD',
    );
    expect(engine.getRegexedString('foo', REGEX_PLACEMENT.AI_OUTPUT, { isPrompt: true })).toBe(
      'PR',
    );
    expect(engine.getRegexedString('foo', REGEX_PLACEMENT.AI_OUTPUT)).toBe('BOTH');
    expect(engine.getRegexedString('foo', REGEX_PLACEMENT.AI_OUTPUT, { isEdit: true })).toBe('foo');
    const { engine: e2 } = mkEngine({ global: [script({ runOnEdit: true, replaceString: 'E' })] });
    expect(e2.getRegexedString('foo', REGEX_PLACEMENT.AI_OUTPUT, { isEdit: true })).toBe('E');
  });
  it('depth window: minDepth / maxDepth, -1 and null semantics', () => {
    const { engine } = mkEngine({
      global: [script({ minDepth: 1, maxDepth: 2, promptOnly: true })],
    });
    const run = (depth: number | undefined) =>
      engine.getRegexedString('foo', REGEX_PLACEMENT.AI_OUTPUT, { isPrompt: true, depth });
    expect(run(0)).toBe('foo');
    expect(run(1)).toBe('bar');
    expect(run(2)).toBe('bar');
    expect(run(3)).toBe('foo');
    expect(run(undefined)).toBe('bar');
    const { engine: e2 } = mkEngine({
      global: [script({ minDepth: -1, maxDepth: -1, promptOnly: true })],
    });
    expect(
      e2.getRegexedString('foo', REGEX_PLACEMENT.AI_OUTPUT, { isPrompt: true, depth: 7 }),
    ).toBe('bar');
    const { engine: e3 } = mkEngine({
      global: [script({ minDepth: -5, maxDepth: null, promptOnly: true })],
    });
    expect(
      e3.getRegexedString('foo', REGEX_PLACEMENT.AI_OUTPUT, { isPrompt: true, depth: 0 }),
    ).toBe('bar');
  });
  it('scripts run in order and chain their output', () => {
    const { engine } = mkEngine({
      global: [
        script({ id: 'a', findRegex: '/foo/', replaceString: 'bar' }),
        script({ id: 'b', findRegex: '/bar/', replaceString: 'baz' }),
      ],
    });
    expect(engine.getRegexedString('foo', REGEX_PLACEMENT.AI_OUTPUT)).toBe('baz');
  });
});

describe('RegexEngine.runRegexScript', () => {
  it('supports {{match}}, numbered and named groups, missing groups → empty', () => {
    const { engine } = mkEngine({});
    expect(
      engine.runRegexScript(
        script({ findRegex: '/(\\w+)@(\\w+)/', replaceString: '[$2:$1] <{{match}}>' }),
        'me@host',
      ),
    ).toBe('[host:me] <me@host>');
    expect(
      engine.runRegexScript(
        script({ findRegex: '/(?<a>x)(?<b>y)?/', replaceString: '$<b>|$<a>|$3' }),
        'x',
      ),
    ).toBe('|x|');
    expect(engine.runRegexScript(script({ findRegex: '/o/g', replaceString: '0' }), 'foo')).toBe(
      'f00',
    );
    expect(engine.runRegexScript(script({ findRegex: '', replaceString: 'x' }), 'foo')).toBe('foo');
    expect(engine.runRegexScript(script({ findRegex: '/(/', replaceString: 'x' }), 'foo')).toBe(
      'foo',
    );
    expect(engine.runRegexScript(null, 'foo')).toBe('foo');
  });
  it('trims strings from captures (with character override macro) and substitutes macros in the result', () => {
    const { engine } = mkEngine({});
    const s = script({
      findRegex: '/^(.*)$/',
      replaceString: '$1 — said {{char}}',
      trimStrings: ['{{char}}: ', '*'],
    });
    expect(engine.runRegexScript(s, 'Sera: *waves* hi')).toBe('waves hi — said Sera');
    expect(engine.runRegexScript(s, 'Bob: *waves* hi', { characterOverride: 'Bob' })).toBe(
      'waves hi — said Sera',
    );
  });
  it('substituteRegex: NONE keeps macros literal, RAW substitutes, ESCAPED escapes regex specials', () => {
    const { engine, state } = mkEngine({});
    state.variables.local.set('needle', 'a.b (c)');
    const none = script({
      findRegex: '/{{getvar::needle}}/',
      replaceString: 'X',
      substituteRegex: SUBSTITUTE_FIND_REGEX.NONE,
    });
    // 字面 /{{getvar::needle}}/ 在 JS 里是合法正则（{ 不作量词），按字面匹配
    expect(engine.runRegexScript(none, 'a.b (c) {{getvar::needle}}')).toBe('a.b (c) X');
    const raw = script({
      findRegex: '/{{getvar::needle}}/',
      replaceString: 'X',
      substituteRegex: SUBSTITUTE_FIND_REGEX.RAW,
    });
    expect(engine.runRegexScript(raw, 'a.b (c) axb c')).toBe(
      'a.b (c) axb c'.replace(/a.b (c)/, 'X'),
    );
    const escaped = script({
      findRegex: '/{{getvar::needle}}/',
      replaceString: 'X',
      substituteRegex: SUBSTITUTE_FIND_REGEX.ESCAPED,
    });
    expect(engine.runRegexScript(escaped, 'a.b (c) axb c')).toBe('X axb c');
    expect(
      engine.runRegexScript(
        script({ findRegex: '/{{user}}/g', replaceString: '{{char}}', substituteRegex: true }),
        'Yun and Yun',
      ),
    ).toBe('Sera and Sera');
  });
});

describe('pipeline integration via createApplyRegex', () => {
  const sera = {
    name: 'Sera',
    avatar: 'sera.png',
    description: 'desc',
    personality: 'kind',
    scenario: 'glade',
    mes_example: '',
    first_mes: 'Greetings.',
    data: {
      system_prompt: '',
      post_history_instructions: '',
      character_version: '1',
      creator_notes: '',
      alternate_greetings: [],
      extensions: {
        regex_scripts: [
          script({
            id: 'scoped',
            findRegex: '/hello/',
            replaceString: 'HELLO',
            placement: [REGEX_PLACEMENT.USER_INPUT],
            promptOnly: true,
          }),
        ],
      },
    },
  };
  const mk = (scopedAllowed: boolean) => {
    const macro = new MacroEngine({ logger: createCapturingLogger([]) });
    const state = createTestState({
      userName: 'Yun',
      charName: 'Sera',
      mainApi: 'textgenerationwebui',
      characters: [sera],
      characterId: 0,
      chat: [
        {
          name: 'Sera',
          is_user: false,
          mes: 'Greetings, {{user}}.',
          extra: { reasoning: 'secret thoughts' },
        },
        { name: 'Yun', is_user: true, mes: 'hello' },
        { name: 'Sera', is_user: false, mes: 'hi *back*' },
      ],
    });
    const sources: RegexScriptSources = {
      global: [
        script({
          id: 'strip-stars',
          findRegex: '/\\*/g',
          replaceString: '',
          placement: [REGEX_PLACEMENT.AI_OUTPUT],
          promptOnly: true,
        }),
        script({
          id: 'wi',
          findRegex: '/LORE/',
          replaceString: 'lore@{{char}}',
          placement: [REGEX_PLACEMENT.WORLD_INFO],
          promptOnly: true,
        }),
        script({
          id: 'think',
          findRegex: '/secret/',
          replaceString: 'hidden',
          placement: [REGEX_PLACEMENT.REASONING],
          promptOnly: true,
        }),
        script({
          id: 'deep',
          findRegex: '/Greetings/',
          replaceString: 'OLD',
          placement: [REGEX_PLACEMENT.AI_OUTPUT],
          promptOnly: true,
          minDepth: 2,
        }),
      ],
      scoped: sera.data.extensions.regex_scripts,
      scopedAllowed,
    };
    const regex = new RegexEngine({
      substitute: (t, o) => macro.substituteParams(t, state, o),
      sources: () => sources,
    });
    const applyRegex = createApplyRegex(regex);
    const entries = getSortedEntries(
      {
        globalLore: [
          {
            uid: 1,
            world: 'w',
            key: ['hello'],
            content: 'LORE',
            position: WORLD_INFO_POSITION.before,
            selective: true,
            keysecondary: [],
          },
        ],
        characterLore: [],
        chatLore: [],
        personaLore: [],
      },
      1,
    );
    return { macro, state, applyRegex, entries };
  };

  it('Text Completion: user/ai/world_info/reasoning placements with depth, scoped scripts gated by allow list', async () => {
    const { macro, state, applyRegex, entries } = mk(true);
    const r = await buildTextCompletionPrompt(state, {
      engine: macro,
      countText: (t) => t.length,
      worldInfo: {
        settings: { ...DEFAULT_WORLD_INFO_SETTINGS, world_info_depth: 10 },
        sortedEntries: entries,
        random: () => 0.5,
      },
      note: {},
      powerUser: {
        persona_description: '',
        persona_description_position: PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT,
        pin_examples: false,
        strip_examples: false,
        token_padding: 0,
        reasoning: {
          add_to_prompts: true,
          prefix: '<think>',
          suffix: '</think>',
          separator: '\n',
          max_additions: 2,
        },
      },
      applyRegex,
    });
    expect(r.prompt).toContain('lore@Sera\n');
    // reasoning 走 REASONING placement（secret → hidden），minDepth 2 只命中最老的 greeting，scoped 脚本改写用户输入，AI 输出去掉 *
    expect(r.prompt).toContain(
      '***\nSera: <think>hidden thoughts</think>\nOLD, Yun.\nYun: HELLO\nSera: hi back',
    );
    expect(r.prompt).not.toContain('secret');
    const denied = mk(false);
    const r2 = await buildTextCompletionPrompt(denied.state, {
      engine: denied.macro,
      countText: (t) => t.length,
      worldInfo: { settings: DEFAULT_WORLD_INFO_SETTINGS, sortedEntries: [], random: () => 0.5 },
      note: {},
      powerUser: {
        persona_description: '',
        persona_description_position: PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT,
        pin_examples: false,
        strip_examples: false,
        token_padding: 0,
      },
      applyRegex: denied.applyRegex,
    });
    expect(r2.prompt).toContain('Yun: hello\n');
  });

  it('Chat Completion: the same hooks shape the messages', async () => {
    const { macro, state, applyRegex, entries } = mk(true);
    state.mainApi = 'openai';
    const r = await buildChatCompletionPrompt(state, {
      engine: macro,
      settings: defaultChatCompletionSettings(),
      countText: (t) => t.length,
      worldInfo: {
        settings: { ...DEFAULT_WORLD_INFO_SETTINGS, world_info_depth: 10 },
        sortedEntries: entries,
        random: () => 0.5,
      },
      note: {},
      powerUser: {
        persona_description: '',
        persona_description_position: PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT,
        pin_examples: false,
        strip_examples: false,
      },
      applyRegex,
    });
    const brief = r.chat.map((m) => `${m.role}: ${String(m.content)}`);
    expect(brief).toContain('system: lore@Sera');
    expect(brief.slice(-3)).toEqual(['assistant: OLD, Yun.', 'user: HELLO', 'assistant: hi back']);
  });

  it('depth passed to scripts matches ST (newest message = 0; continue shifts by one)', async () => {
    const seen: number[] = [];
    const macro = new MacroEngine({ logger: createCapturingLogger([]) });
    const state = createTestState({
      userName: 'Yun',
      charName: 'Sera',
      mainApi: 'textgenerationwebui',
      characters: [sera],
      characterId: 0,
      chat: [
        { name: 'Sera', is_user: false, mes: 'a' },
        { name: 'Yun', is_user: true, mes: 'b' },
        { name: 'Sera', is_user: false, mes: 'c' },
      ],
    });
    const applyRegex = (text: string, placement: string, o: { depth: number | null }) => {
      if (placement !== 'reasoning' && o.depth !== null) seen.push(o.depth);
      return text;
    };
    const deps = {
      engine: macro,
      countText: (t: string) => t.length,
      worldInfo: { settings: DEFAULT_WORLD_INFO_SETTINGS, sortedEntries: [], random: () => 0.5 },
      note: {},
      powerUser: {
        ...defaultPowerUser(),
        persona_description: '',
        persona_description_position: PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT,
        pin_examples: false,
        strip_examples: false,
        token_padding: 0,
      },
    };
    await buildTextCompletionPrompt(state, { ...deps, applyRegex: applyRegex as never });
    expect(seen).toEqual([2, 1, 0]);
    seen.length = 0;
    await buildTextCompletionPrompt(
      state,
      { ...deps, applyRegex: applyRegex as never },
      { type: 'continue' },
    );
    expect(seen).toEqual([1, 0, -1]);
  });
});
