// core 自有测试：依赖运行时状态的宏（时间、聊天、角色卡、instruct、示例对话、group 卡片）。时间用固定 now。
import { describe, expect, it } from 'vitest';
import moment from 'moment';
import { createHarness } from './helpers.js';
import type { CharacterLike } from '../src/state.js';

const FIXED = new Date('2024-07-12T01:31:37.123Z');
const fixedNow = () => FIXED;

const seraphina: CharacterLike = {
  name: 'Seraphina',
  avatar: 'seraphina.png',
  chat: 'Seraphina - 2024',
  description: '{{char}} is a guardian of the forest. She protects {{user}}.',
  personality: 'kind, protective',
  scenario: '{{user}} wakes up in a glade.',
  mes_example:
    '<START>\n{{user}}: Hello?\n{{char}}: *smiles* Welcome, traveler.\n<START>\n{{user}}: Who are you?\n{{char}}: I am {{char}}.',
  first_mes: 'Greetings, {{user}}.',
  data: {
    system_prompt: 'Main prompt for {{char}}.',
    post_history_instructions: 'PHI for {{char}}.',
    character_version: '1.2',
    creator_notes: 'Notes about {{char}}.',
    alternate_greetings: ['Alt one for {{user}}', 'Alt two'],
    extensions: { depth_prompt: { prompt: 'Depth note {{char}}', depth: 4, role: 'system' } },
  },
};

describe('time macros', () => {
  const h = createHarness({ now: fixedNow });
  const m = () => moment(FIXED);
  it('formats time/date/weekday/isotime/isodate with moment defaults', () => {
    expect(h.evaluate('{{time}}')).toBe(m().format('LT'));
    expect(h.evaluate('{{date}}')).toBe(m().format('LL'));
    expect(h.evaluate('{{weekday}}')).toBe(m().format('dddd'));
    expect(h.evaluate('{{isotime}}')).toBe(m().format('HH:mm'));
    expect(h.evaluate('{{isodate}}')).toBe(m().format('YYYY-MM-DD'));
    expect(h.evaluate('{{datetimeformat YYYY/MM/DD HH:mm}}')).toBe(m().format('YYYY/MM/DD HH:mm'));
    expect(h.evaluate('{{datetimeformat::LLLL}}')).toBe(m().format('LLLL'));
  });
  it('handles UTC offsets including the legacy time_UTC syntax', () => {
    expect(h.evaluate('{{time::UTC+2}}')).toBe(m().utc().utcOffset(2).format('LT'));
    expect(h.evaluate('{{time_UTC-10}}')).toBe(m().utc().utcOffset(-10).format('LT'));
    expect(h.evaluate('{{time::garbage}}')).toBe(m().format('LT'));
  });
  it('timeDiff humanizes with suffix', () => {
    // moment(left).diff(right) 为负 → humanize(true) 给出 ago
    expect(h.evaluate('{{timeDiff::2023-01-01 12:00:00::2023-01-01 15:00:00}}')).toBe(
      '3 hours ago',
    );
    expect(h.evaluate('{{ timeDiff :: 2023-01-01 15:00:00 :: 2023-01-01 12:00:00 }}')).toBe(
      'in 3 hours',
    );
  });
  it('idle_duration uses the last user message that is followed by another message', () => {
    expect(createHarness({ now: fixedNow }).evaluate('{{idle_duration}}')).toBe('just now');
    const twoHoursAgo = new Date(FIXED.getTime() - 2 * 3600_000).toISOString();
    const hh = createHarness({
      now: fixedNow,
      chat: [
        { name: 'User', is_user: true, mes: 'hi', send_date: twoHoursAgo },
        { name: 'Char', is_user: false, mes: 'hello', send_date: FIXED.toISOString() },
      ],
    });
    expect(hh.evaluate('{{idleDuration}}')).toBe('2 hours');
    // ST humanized timestamp format
    const h3 = createHarness({
      now: fixedNow,
      chat: [
        { name: 'User', is_user: true, mes: 'hi', send_date: '2024-07-11@01h31m37s' },
        { name: 'Char', is_user: false, mes: 'hello' },
      ],
    });
    expect(h3.evaluate('{{idle_duration}}')).toBe('a day');
  });
});

describe('chat macros', () => {
  const chat = [
    {
      name: 'Char',
      is_user: false,
      mes: 'first (greeting)',
      swipes: ['first (greeting)', 'alt'],
      swipe_id: 0,
    },
    { name: 'User', is_user: true, mes: 'user one' },
    { name: 'Sys', is_system: true, mes: 'system note' },
    {
      name: 'Char',
      is_user: false,
      mes: 'char reply',
      swipes: ['char reply', 'char reply 2', 'char reply 3'],
      swipe_id: 1,
    },
  ];
  it('reads last/user/char messages, ids, swipes and range', () => {
    const h = createHarness({ chat, chatMetadata: { lastInContextMessageId: 1 } });
    expect(
      h.evaluate('{{lastMessage}}|{{lastMessageId}}|{{lastUserMessage}}|{{lastCharMessage}}'),
    ).toBe('char reply|3|user one|char reply');
    expect(
      h.evaluate(
        '{{lastSwipeId}}|{{currentSwipeId}}|{{allChatRange}}|{{firstIncludedMessageId}}|[{{firstDisplayedMessageId}}]',
      ),
    ).toBe('3|2|0-3|1|[]');
  });
  it('skips a message whose swipe is in progress', () => {
    const inProgress = [
      ...chat,
      { name: 'Char', is_user: false, mes: '', swipes: ['a'], swipe_id: 1 },
    ];
    const h = createHarness({ chat: inProgress, firstDisplayedMessageId: 2 });
    expect(
      h.evaluate(
        '{{lastMessageId}}|{{lastSwipeId}}|{{currentSwipeId}}|{{firstDisplayedMessageId}}',
      ),
    ).toBe('3|1|2|2');
  });
  it('returns empty values on an empty chat', () => {
    const h = createHarness();
    expect(
      h.evaluate(
        '[{{lastMessage}}][{{lastMessageId}}][{{lastSwipeId}}][{{currentSwipeId}}][{{allChatRange}}][{{firstIncludedMessageId}}]',
      ),
    ).toBe('[][][][][][]');
  });
});

describe('character card macros', () => {
  const mk = (over: Partial<Parameters<typeof createHarness>[0]> = {}) =>
    createHarness({
      characters: [seraphina],
      characterId: 0,
      charName: 'Seraphina',
      userName: 'Yun',
      powerUser: { persona_description: 'Yun is {{user}}.' },
      ...over,
    });
  it('resolves description/personality/scenario/persona with nested macros substituted', () => {
    const h = mk();
    expect(
      h.evaluate('{{description}}', { name1Override: 'Yun', name2Override: 'Seraphina' }),
    ).toBe('Seraphina is a guardian of the forest. She protects Yun.');
    expect(
      h.evaluate('{{charDescription}}|{{personality}}|{{scenario}}|{{persona}}', {
        name1Override: 'Yun',
        name2Override: 'Seraphina',
      }),
    ).toBe(
      'Seraphina is a guardian of the forest. She protects Yun.|kind, protective|Yun wakes up in a glade.|Yun is Yun.',
    );
  });
  it('resolves prompt overrides, version, notes, depth prompt, greetings', () => {
    const h = mk();
    const n = { name1Override: 'Yun', name2Override: 'Seraphina' };
    expect(
      h.evaluate(
        '{{charPrompt}}|{{charInstruction}}|{{charVersion}}|{{version}}|{{char_version}}',
        n,
      ),
    ).toBe('Main prompt for Seraphina.|PHI for Seraphina.|1.2|1.2|1.2');
    expect(h.evaluate('{{creatorNotes}}|{{charCreatorNotes}}|{{charDepthPrompt}}', n)).toBe(
      'Notes about Seraphina.|Notes about Seraphina.|Depth note Seraphina',
    );
    expect(
      h.evaluate(
        '{{greeting}}|{{charFirstMessage::0}}|{{greeting::1}}|{{greeting::2}}|[{{greeting::3}}]',
        n,
      ),
    ).toBe('Greetings, Yun.|Greetings, Yun.|Alt one for Yun|Alt two|[]');
  });
  it('respects prefer_character_prompt / jailbreak switches and chat metadata overrides', () => {
    const h = mk({
      powerUser: { prefer_character_prompt: false, prefer_character_jailbreak: false },
      chatMetadata: { scenario: 'Override scenario', mes_example: '<START>\nX: y' },
    });
    expect(h.evaluate('[{{charPrompt}}][{{charInstruction}}]{{scenario}}|{{mesExamplesRaw}}')).toBe(
      '[][]Override scenario|<START>\nX: y',
    );
  });
  it('systemPrompt prefers the character prompt when configured', () => {
    expect(mk().evaluate('{{systemPrompt}}', { name2Override: 'Seraphina' })).toBe(
      'Main prompt for Seraphina.',
    );
    // ST 直接返回 sysprompt.content 原文，宏结果不会被二次求值
    expect(
      mk({ powerUser: { prefer_character_prompt: false } }).evaluate('{{systemPrompt}}', {
        name1Override: 'Yun',
        name2Override: 'Seraphina',
      }),
    ).toBe("Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.");
    expect(
      mk({ powerUser: { sysprompt: { enabled: false, content: 'x' } } }).evaluate(
        '[{{systemPrompt}}][{{defaultSystemPrompt}}]',
      ),
    ).toBe('[][]');
    expect(
      mk().evaluate('{{instructSystemPrompt}}', {
        name1Override: 'Yun',
        name2Override: 'Seraphina',
      }),
    ).toBe("Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.");
  });
  it('mesExamples: chat completion keeps <START> blocks, instruct mode formats them', () => {
    const n = { name1Override: 'Yun', name2Override: 'Seraphina' };
    expect(mk().evaluate('{{mesExamples}}', n)).toBe(
      '<START>\nYun: Hello?\nSeraphina: *smiles* Welcome, traveler.\n<START>\nYun: Who are you?\nSeraphina: I am Seraphina.\n',
    );
    const instruct = mk({
      mainApi: 'textgenerationwebui',
      powerUser: {
        instruct: {
          enabled: true,
          input_sequence: '### Instruction:',
          output_sequence: '### Response:',
          input_suffix: '',
          output_suffix: '',
          wrap: true,
          macro: true,
          names_behavior: 'force',
          skip_examples: false,
        },
        context: { example_separator: '***', chat_start: '***' },
      },
    });
    expect(instruct.evaluate('{{mesExamples}}', n)).toBe(
      '***\n### Instruction:\nYun: Hello?\n### Response:\n*smiles* Welcome, traveler.\n***\n### Instruction:\nYun: Who are you?\n### Response:\nI am Seraphina.\n',
    );
    const textgenNoInstruct = mk({ mainApi: 'textgenerationwebui' });
    expect(textgenNoInstruct.evaluate('{{mesExamples}}', n)).toBe(
      '***\nYun: Hello?\nSeraphina: *smiles* Welcome, traveler.\n***\nYun: Who are you?\nSeraphina: I am Seraphina.\n',
    );
  });
  it('original is one-shot', () => {
    const h = mk();
    expect(h.evaluate('{{original}}|{{original}}', { original: 'ORIG' })).toBe('ORIG|');
  });
  it('merges group member cards when generation_mode is set', () => {
    const bob: CharacterLike = {
      name: 'Bob',
      avatar: 'bob.png',
      description: 'Bob desc',
      personality: 'grumpy',
      scenario: '',
      mes_example: 'Bob: hi',
    };
    const h = createHarness({
      characters: [seraphina, bob],
      characterId: 0,
      charName: 'Seraphina',
      userName: 'Yun',
      groups: [
        {
          id: 'g',
          members: ['seraphina.png', 'bob.png'],
          disabled_members: [],
          generation_mode: 1,
          generation_mode_join_prefix: '[<FIELDNAME> of {{char}}]\n',
          generation_mode_join_suffix: '',
        },
      ],
      selectedGroup: 'g',
    });
    expect(
      h.evaluate('{{description}}', { name1Override: 'Yun', name2Override: 'Seraphina' }),
    ).toBe(
      '[Description of Seraphina]\nSeraphina is a guardian of the forest. She protects Yun.\n[Description of Bob]\nBob desc',
    );
    expect(
      h.evaluate('{{personality}}', { name1Override: 'Yun', name2Override: 'Seraphina' }),
    ).toBe('[Personality of Seraphina]\nkind, protective\n[Personality of Bob]\ngrumpy');
    expect(
      h.evaluate('{{mesExamplesRaw}}', { name1Override: 'Yun', name2Override: 'Seraphina' }),
    ).toContain('[Example Messages of Bob]\n<START>\nBob: hi');
  });
});

describe('instruct / context macros', () => {
  it('returns empty when instruct is disabled and sequences when enabled', () => {
    const off = createHarness();
    expect(
      off.evaluate(
        '[{{instructInput}}][{{instructOutput}}][{{instructSystemPrefix}}]{{exampleSeparator}}|{{chatStart}}',
      ),
    ).toBe('[][][]***|***');
    const on = createHarness({
      powerUser: {
        instruct: {
          enabled: true,
          input_sequence: '<|user|>',
          output_sequence: '<|assistant|>',
          system_sequence: '<|system|>',
          input_suffix: '</s>',
          output_suffix: '</s>',
          system_suffix: '</s>',
          first_output_sequence: '',
          last_output_sequence: '<|last|>',
          stop_sequence: '<stop>',
          user_alignment_message: 'filler',
          story_string_prefix: 'SSP',
          story_string_suffix: 'SSS',
        },
      },
    });
    expect(
      on.evaluate(
        '{{instructInput}}|{{instructUserPrefix}}|{{instructUserSuffix}}|{{instructOutput}}|{{instructAssistantPrefix}}|{{instructSeparator}}',
      ),
    ).toBe('<|user|>|<|user|>|</s>|<|assistant|>|<|assistant|>|</s>');
    expect(
      on.evaluate(
        '{{instructSystemPrefix}}|{{instructSystemSuffix}}|{{instructFirstOutput}}|{{instructFirstAssistantPrefix}}|{{instructLastOutput}}|{{instructLastAssistantPrefix}}',
      ),
    ).toBe('<|system|>|</s>|{{instructFirstOutput}}|<|assistant|>|{{instructLastOutput}}|<|last|>');
    expect(
      on.evaluate(
        '{{instructStop}}|{{instructUserFiller}}|{{instructStoryStringPrefix}}|{{instructStoryStringSuffix}}|{{instructFirstUserPrefix}}|{{instructLastInput}}',
      ),
    ).toBe('<stop>|filler|SSP|SSS|<|user|>|<|user|>');
  });
});

describe('misc macros', () => {
  it('space/newline/reverse/noop/model/isMobile/lastGenerationType/hasExtension/input/max*', () => {
    const h = createHarness({
      model: 'claude',
      isMobile: true,
      lastGenerationType: 'swipe',
      hasExtension: (n) => n === 'quick-reply',
      input: 'typing…',
    });
    expect(
      h.evaluate('[{{space}}][{{space::3}}][{{newline::2}}]{{reverse::héllo🙂}}{{noop}}'),
    ).toBe('[ ][   ][\n\n]🙂olléh');
    expect(
      h.evaluate(
        '{{model}}|{{isMobile}}|{{lastGenerationType}}|{{hasExtension::quick-reply}}|{{hasExtension::nope}}|{{input}}',
      ),
    ).toBe('claude|true|swipe|true|false|typing…');
    expect(
      h.evaluate(
        '{{maxPrompt}}|{{maxPromptTokens}}|{{maxContext}}|{{maxContextTokens}}|{{maxResponse}}|{{maxResponseTokens}}',
      ),
    ).toBe('3796|3796|4096|4096|300|300');
  });
  it('roll validates formulas', () => {
    const h = createHarness();
    expect(h.evaluate('{{roll::1d1}}|{{roll 1}}|{{roll::2d1+3}}')).toBe('1|1|5');
    const n = Number(h.evaluate('{{roll::6}}'));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(6);
    expect(h.evaluate('[{{roll::abc}}]')).toBe('[]');
    expect(h.warnings().some((w) => w.includes('Invalid roll formula'))).toBe(true);
  });
  it('random supports list, legacy comma and legacy colon forms', () => {
    const h = createHarness();
    expect(h.evaluate('{{random::only}}')).toBe('only');
    expect(['a', 'b', 'c']).toContain(h.evaluate('{{random::a::b::c}}'));
    expect(['a', 'b', 'c']).toContain(h.evaluate('{{random a, b, c}}'));
    expect(['a', 'b', 'c']).toContain(h.evaluate('{{random:a::b::c}}'));
    expect(h.evaluate('{{random::x\\,y}}')).toBe('x,y');
    expect(h.evaluate('[{{random}}]')).toBe('[]');
  });
  it('pick is deterministic per chat id and position, and respects reroll seed', () => {
    const mk = (meta: Record<string, unknown>) =>
      createHarness({ characters: [seraphina], characterId: 0, chatMetadata: meta });
    const input = '{{pick::a::b::c::d::e::f::g::h}}-{{pick::a::b::c::d::e::f::g::h}}';
    const h1 = mk({});
    const r1 = h1.evaluate(input);
    expect(h1.state.chatMetadata['chat_id_hash']).toBeTypeOf('number');
    expect(mk({}).evaluate(input)).toBe(r1);
    const outputs = new Set<string>();
    for (let seed = 0; seed < 30; seed++)
      outputs.add(mk({ pick_reroll_seed: seed }).evaluate(input));
    expect(outputs.size).toBeGreaterThan(1);
    expect(mk({}).evaluate('{{pick a, b}}')).toMatch(/^(a|b)$/);
  });
  it('banned collects words only for text completion; outlet reads extension prompts', () => {
    const tc = createHarness({
      mainApi: 'textgenerationwebui',
      extensionPrompts: { custom_wi_outlet_achievements: { value: 'Achievements!' } },
    });
    expect(
      tc.evaluate(
        '{{banned "delve"}}{{banned::tapestry}}[{{outlet::achievements}}][{{outlet::missing}}]',
      ),
    ).toBe('[Achievements!][]');
    expect(tc.state.bannedWords).toEqual(['delve', 'tapestry']);
    const cc = createHarness();
    cc.evaluate('{{banned::x}}');
    expect(cc.state.bannedWords).toEqual([]);
  });
  it('substituteParams builds env from state and keeps legacy signature semantics', () => {
    const h = createHarness({ userName: 'Yun', charName: 'Sera' });
    expect(
      h.engine.substituteParams('<USER> meets {{char}} ({{original}})', h.state, { original: 'O' }),
    ).toBe('Yun meets Sera (O)');
    expect(h.engine.substituteParams('', h.state)).toBe('');
    expect(
      h.engine.substituteParams('{{description}}', h.state, { replaceCharacterCard: false }),
    ).toBe('');
  });
  it('variable scope helper matches ST numeric coercion', () => {
    const h = createHarness();
    const v = h.state.variables.local;
    v.set('n', '7');
    expect(v.get('n')).toBe(7);
    v.set('s', ' ');
    expect(v.get('s')).toBe(' ');
    v.set('arr', '[1]');
    v.add('arr', 2);
    expect(v.get('arr')).toBe('[1,2]');
    v.set('str', 'a');
    v.add('str', 'b');
    expect(v.get('str')).toBe('ab');
    expect(v.inc('n')).toBe(8);
    expect(v.dec('new')).toBe(-1);
    expect(
      h.evaluate(
        '{{incvar::n}}|{{decvar::n}}|{{addvar::n::2}}{{getvar::n}}|{{setglobalvar::g::1}}{{incglobalvar::g}}|{{getglobalvar::g}}|{{varexists::n}}|{{globalvarexists::zz}}',
      ),
    ).toBe('9|8|10|2|2|true|false');
  });
});
