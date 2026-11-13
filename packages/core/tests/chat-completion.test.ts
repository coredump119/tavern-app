// Chat Completion 组装：对照 ST openai.js prepareOpenAIMessages / script.js Generate() CC 路径的确定性测试。
import { describe, expect, it } from 'vitest';
import {
  CHARACTER_NAMES_BEHAVIOR,
  EXTENSION_PROMPT_TYPES,
  INJECTION_POSITION,
  MacroEngine,
  NOTE_METADATA_KEYS,
  PERSONA_DESCRIPTION_POSITIONS,
  DEFAULT_WORLD_INFO_SETTINGS,
  WORLD_INFO_POSITION,
  buildChatCompletionPrompt,
  createCapturingLogger,
  createOpenAITokenCounter,
  defaultChatCompletionSettings,
  getSortedEntries,
  setExtensionPrompt,
  type ChatCompletionPipelineDeps,
  type ChatCompletionSettings,
  type ExtensionPrompts,
  type WIEntry,
} from '../src/index.js';
import { createTestState, type TestStateOverrides } from './helpers.js';

const sera = {
  name: 'Sera',
  avatar: 'sera.png',
  description: 'Sera is a guardian. She likes {{user}}.',
  personality: 'kind',
  scenario: 'A glade.',
  mes_example:
    '<START>\n{{user}}: Hi\n{{char}}: Hello there.\n<START>\n{{user}}: Who?\n{{char}}: Me.',
  first_mes: 'Greetings, {{user}}.',
  data: {
    system_prompt: '',
    post_history_instructions: '',
    character_version: '1',
    creator_notes: '',
    alternate_greetings: [],
    extensions: {},
  },
};

interface Opts {
  state?: TestStateOverrides;
  settings?: Partial<ChatCompletionSettings>;
  entries?: WIEntry[];
  wi?: Partial<typeof DEFAULT_WORLD_INFO_SETTINGS>;
  note?: ChatCompletionPipelineDeps['note'];
  powerUser?: Partial<ChatCompletionPipelineDeps['powerUser']>;
  extensionPrompts?: ExtensionPrompts;
  type?: ChatCompletionPipelineDeps extends never
    ? never
    : import('../src/index.js').GenerationType;
  quietPrompt?: string;
  textareaText?: string;
  activeCharacter?: ChatCompletionPipelineDeps['activeCharacter'];
  inlineMedia?: ChatCompletionPipelineDeps['inlineMedia'];
  canUseTools?: boolean;
}

async function build(o: Opts = {}) {
  const engine = new MacroEngine({ logger: createCapturingLogger([]) });
  const state = createTestState({
    userName: 'Yun',
    charName: 'Sera',
    characters: [sera],
    characterId: 0,
    chat: [
      { name: 'Sera', is_user: false, mes: 'Greetings, {{user}}.' },
      { name: 'Yun', is_user: true, mes: 'hello' },
      { name: 'Sera', is_user: false, mes: 'hi back' },
    ],
    ...(o.state ?? {}),
  });
  const settings = { ...defaultChatCompletionSettings(), ...(o.settings ?? {}) };
  const deps: ChatCompletionPipelineDeps = {
    engine,
    settings,
    countText: (t) => t.length,
    worldInfo: {
      settings: { ...DEFAULT_WORLD_INFO_SETTINGS, ...(o.wi ?? {}) },
      sortedEntries: getSortedEntries(
        { globalLore: o.entries ?? [], characterLore: [], chatLore: [], personaLore: [] },
        1,
      ),
      random: () => 0.5,
    },
    note: o.note ?? { allowWIScan: false },
    powerUser: {
      persona_description: '',
      persona_description_position: PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT,
      pin_examples: false,
      strip_examples: false,
      ...(o.powerUser ?? {}),
    },
    extensionPrompts: o.extensionPrompts,
    activeCharacter: o.activeCharacter,
    inlineMedia: o.inlineMedia,
    canUseTools: o.canUseTools,
  };
  const r = await buildChatCompletionPrompt(state, deps, {
    type: o.type,
    quietPrompt: o.quietPrompt,
    textareaText: o.textareaText,
  });
  return {
    ...r,
    state,
    settings,
    brief: r.chat.map((m) => `${m.role}${m.name ? `(${m.name})` : ''}: ${String(m.content)}`),
  };
}

describe('buildChatCompletionPrompt (default preset)', () => {
  it('produces the ST default order with substituted markers', async () => {
    const r = await build();
    expect(r.error).toBeNull();
    expect(r.brief).toEqual([
      "system: Write Sera's next reply in a fictional chat between Sera and Yun.",
      'system: Sera is a guardian. She likes Yun.',
      'system: kind',
      'system: A glade.',
      'system: [Example Chat]',
      'system(example_user): Hi',
      'system(example_assistant): Hello there.',
      'system: [Example Chat]',
      'system(example_user): Who?',
      'system(example_assistant): Me.',
      'system: [Start a new Chat]',
      'assistant: Greetings, Yun.',
      'user: hello',
      'assistant: hi back',
    ]);
    expect(r.messagesCount).toBe(3);
    expect(r.chat[0]).toEqual({
      role: 'system',
      content: "Write Sera's next reply in a fictional chat between Sera and Yun.",
    });
  });

  it('uses the token counter scheme of ST (tiktoken message overhead)', async () => {
    const count = createOpenAITokenCounter((t) => t.length);
    // 客户端从 -1 起累加；每条 3 + Σlen (+1 name) + 3 padding；非 full 再 -2
    expect(await count({ role: 'user', content: 'abc' })).toBe(-1 + (3 + 4 + 3 + 3) - 2);
    expect(await count({ role: 'user', content: 'abc', name: 'x' })).toBe(
      -1 + (3 + 4 + 3 + 1 + 1 + 3) - 2,
    );
    expect(await count({ role: 'user', content: 'abc' }, true)).toBe(-1 + (3 + 4 + 3 + 3));
    expect(
      await count([
        { role: 'a', content: 'b' },
        { role: 'c', content: 'd' },
      ]),
    ).toBe(-1 + 2 * (3 + 1 + 1 + 3) - 2);
  });

  it('applies world info before/after with wi_format, character prompt override with {{original}}, and personality/scenario formats', async () => {
    const r = await build({
      entries: [
        {
          uid: 1,
          world: 'w',
          key: ['hello'],
          content: 'LORE-BEFORE',
          position: WORLD_INFO_POSITION.before,
          selective: true,
          keysecondary: [],
        },
        {
          uid: 2,
          world: 'w',
          key: ['hello'],
          content: 'LORE-AFTER',
          position: WORLD_INFO_POSITION.after,
          selective: true,
          keysecondary: [],
        },
      ],
      wi: { world_info_depth: 10 },
      settings: {
        wi_format: '[Info: {0}]',
        personality_format: "{{char}}'s personality: {{personality}}",
        scenario_format: 'Scenario: {{scenario}}',
      },
      state: {
        characters: [{ ...sera, data: { ...sera.data, system_prompt: 'OVERRIDE ({{original}})' } }],
      },
    });
    expect(r.brief.slice(0, 5)).toEqual([
      "system: OVERRIDE (Write Sera's next reply in a fictional chat between Sera and Yun.)",
      'system: [Info: LORE-BEFORE]',
      'system: Sera is a guardian. She likes Yun.',
      "system: Sera's personality: kind",
      'system: Scenario: A glade.',
    ]);
    expect(r.brief).toContain('system: [Info: LORE-AFTER]');
    expect(r.chatCompletion.getOverriddenPrompts()).toEqual(['main']);
  });

  it('respects prompt_order (disabled / custom relative prompt / forbid_overrides)', async () => {
    const settings = defaultChatCompletionSettings();
    settings.prompts.push({
      identifier: 'myprompt',
      name: 'Mine',
      role: 'user',
      content: 'Remember {{user}}.',
      system_prompt: false,
      injection_position: INJECTION_POSITION.RELATIVE,
    });
    settings.prompts.find((p) => p.identifier === 'main')!.forbid_overrides = true;
    const order = settings.prompt_order[0]!.order;
    order.find((o) => o.identifier === 'charPersonality')!.enabled = false;
    order.splice(
      order.findIndex((o) => o.identifier === 'chatHistory'),
      0,
      { identifier: 'myprompt', enabled: true },
    );
    const r = await build({
      settings,
      state: { characters: [{ ...sera, data: { ...sera.data, system_prompt: 'IGNORED' } }] },
    });
    expect(r.brief[0]).toBe(
      "system: Write Sera's next reply in a fictional chat between Sera and Yun.",
    );
    expect(r.brief).not.toContain('system: kind');
    expect(r.brief.indexOf('user: Remember Yun.')).toBe(
      r.brief.indexOf('system: [Start a new Chat]') - 1,
    );
  });

  it('names_behavior: content / completion / default in group', async () => {
    const content = await build({ settings: { names_behavior: CHARACTER_NAMES_BEHAVIOR.CONTENT } });
    expect(content.brief.slice(-3)).toEqual([
      'assistant: Sera: Greetings, Yun.',
      'user: Yun: hello',
      'assistant: Sera: hi back',
    ]);
    const completion = await build({
      settings: { names_behavior: CHARACTER_NAMES_BEHAVIOR.COMPLETION },
      state: { userName: 'Jo Park' },
    });
    expect(completion.brief.slice(-3)).toEqual([
      'assistant(Sera): Greetings, Jo Park.',
      'user(Yun): hello',
      'assistant(Sera): hi back',
    ]);
    const group = await build({
      state: {
        groups: [
          { id: 'g', members: ['sera.png', 'bob.png'], disabled_members: [], chat_id: 'gc' },
        ],
        selectedGroup: 'g',
        characters: [sera, { name: 'Bob', avatar: 'bob.png' }],
        chat: [
          { name: 'Yun', is_user: true, mes: 'hello all' },
          { name: 'Bob', is_user: false, mes: 'yo' },
        ],
      },
    });
    // 群聊：新群聊提示 + 成员名前缀 + 历史末尾的 group nudge
    expect(group.brief.slice(-4)).toEqual([
      'system: [Start a new group chat. Group members: Sera, Bob]',
      'user: hello all',
      'assistant: Bob: yo',
      'system: [Write the next reply only as Sera.]',
    ]);
  });

  it('injects IN_CHAT extension prompts and absolute prompts by depth, order and role', async () => {
    const ext: ExtensionPrompts = {};
    setExtensionPrompt(
      ext,
      'zz_ext',
      'EXT-D1',
      EXTENSION_PROMPT_TYPES.IN_CHAT,
      1,
      false,
      1 /* user */,
    );
    const settings = defaultChatCompletionSettings();
    settings.prompts.push(
      {
        identifier: 'abs0',
        name: 'a',
        role: 'system',
        content: 'ABS-D0',
        system_prompt: false,
        injection_position: INJECTION_POSITION.ABSOLUTE,
        injection_depth: 0,
      },
      {
        identifier: 'abs1hi',
        name: 'b',
        role: 'system',
        content: 'ABS-D1-ORDER200',
        system_prompt: false,
        injection_position: INJECTION_POSITION.ABSOLUTE,
        injection_depth: 1,
        injection_order: 200,
      },
      {
        identifier: 'abs1',
        name: 'c',
        role: 'user',
        content: 'ABS-D1-USER',
        system_prompt: false,
        injection_position: INJECTION_POSITION.ABSOLUTE,
        injection_depth: 1,
      },
    );
    settings.prompt_order[0]!.order.push(
      { identifier: 'abs0', enabled: true },
      { identifier: 'abs1hi', enabled: true },
      { identifier: 'abs1', enabled: true },
    );
    const r = await build({ settings, extensionPrompts: ext });
    expect(r.brief.slice(r.brief.indexOf('system: [Start a new Chat]'))).toEqual([
      'system: [Start a new Chat]',
      'assistant: Greetings, Yun.',
      'user: hello',
      // 同深度：order 高的组先 splice，因此反转后更靠近最新消息；同组内 system → user → assistant
      'user: ABS-D1-USER\nEXT-D1',
      'system: ABS-D1-ORDER200',
      'assistant: hi back',
      'system: ABS-D0',
    ]);
  });

  it("author's note: in-chat depth, in-prompt relative to main, before-prompt, interval gating", async () => {
    const meta = (pos: number, extra: Record<string, unknown> = {}) => ({
      [NOTE_METADATA_KEYS.prompt]: 'AN for {{user}}',
      [NOTE_METADATA_KEYS.interval]: 1,
      [NOTE_METADATA_KEYS.position]: pos,
      [NOTE_METADATA_KEYS.depth]: 1,
      [NOTE_METADATA_KEYS.role]: 0,
      ...extra,
    });
    const inChat = await build({ state: { chatMetadata: meta(EXTENSION_PROMPT_TYPES.IN_CHAT) } });
    expect(inChat.brief.slice(-3)).toEqual([
      'user: hello',
      'system: AN for Yun',
      'assistant: hi back',
    ]);
    const inPrompt = await build({
      state: { chatMetadata: meta(EXTENSION_PROMPT_TYPES.IN_PROMPT) },
    });
    expect(inPrompt.brief.slice(0, 2)).toEqual([
      "system: Write Sera's next reply in a fictional chat between Sera and Yun.",
      'system: AN for Yun',
    ]);
    const before = await build({
      state: { chatMetadata: meta(EXTENSION_PROMPT_TYPES.BEFORE_PROMPT) },
    });
    expect(before.brief.slice(0, 2)).toEqual([
      'system: AN for Yun',
      "system: Write Sera's next reply in a fictional chat between Sera and Yun.",
    ]);
    // interval 2 且只有 1 条用户消息 → 本轮不插入
    const gated = await build({
      state: {
        chatMetadata: meta(EXTENSION_PROMPT_TYPES.IN_CHAT, { [NOTE_METADATA_KEYS.interval]: 2 }),
      },
    });
    expect(gated.brief).not.toContain('system: AN for Yun');
  });

  it('world info at depth / outlet / AN top are routed into injections', async () => {
    const entries: WIEntry[] = [
      {
        uid: 1,
        world: 'w',
        key: ['hello'],
        content: 'DEPTH2',
        position: WORLD_INFO_POSITION.atDepth,
        depth: 2,
        role: 0,
        selective: true,
        keysecondary: [],
      },
      {
        uid: 2,
        world: 'w',
        key: ['hello'],
        content: 'ANTOP',
        position: WORLD_INFO_POSITION.ANTop,
        selective: true,
        keysecondary: [],
      },
    ];
    const r = await build({
      entries,
      wi: { world_info_depth: 10 },
      state: {
        chatMetadata: {
          note_prompt: 'NOTE',
          note_interval: 1,
          note_position: EXTENSION_PROMPT_TYPES.IN_CHAT,
          note_depth: 0,
          note_role: 0,
        },
      },
    });
    // depth 2 的世界书在倒数第二条前；depth 0 的作者注释（已并入 ANTOP）在最后
    expect(r.brief.slice(-5)).toEqual([
      'assistant: Greetings, Yun.',
      'system: DEPTH2',
      'user: hello',
      'assistant: hi back',
      'system: ANTOP\nNOTE',
    ]);
    expect(r.extensionPrompts['2_floating_prompt']?.value).toBe('ANTOP\nNOTE');
  });

  it('persona description: in prompt / at depth / top of AN', async () => {
    const inPrompt = await build({ powerUser: { persona_description: 'I am {{user}}.' } });
    expect(inPrompt.brief[1]).toBe('system: I am Yun.'); // personaDescription 标记经 preparePrompt 替换宏
    const atDepth = await build({
      powerUser: {
        persona_description: 'PD',
        persona_description_position: PERSONA_DESCRIPTION_POSITIONS.AT_DEPTH,
        persona_description_depth: 1,
        persona_description_role: 2,
      },
    });
    expect(atDepth.brief.slice(-3)).toEqual(['user: hello', 'assistant: PD', 'assistant: hi back']);
    expect(atDepth.brief).not.toContain('system: PD');
  });

  it('continue: nudge collection with displaced last message; continue_prefill moves it to control prompts', async () => {
    const nudge = await build({ type: 'continue' });
    expect(nudge.brief.slice(-3)).toEqual([
      'user: hello',
      'assistant: hi back',
      'system: [Continue your last message without repeating its original content.]',
    ]);
    expect(nudge.cyclePrompt).toBe('hi back ');
    const prefill = await build({ type: 'continue', settings: { continue_prefill: true } });
    expect(prefill.brief.slice(-3)).toEqual([
      'assistant: Greetings, Yun.',
      'user: hello',
      'assistant: hi back',
    ]);
  });

  it('impersonate and quiet prompts go to control prompts last; impersonate has no bias', async () => {
    const imp = await build({ type: 'impersonate', textareaText: '{{bias "ignored"}}' });
    expect(imp.brief.at(-1)).toBe(
      "system: [Write your next reply from the point of view of Yun, using the chat history so far as a guideline for the writing style of Yun. Don't write as Sera or system. Don't describe actions of Sera.]",
    );
    expect(imp.bias.promptBias).toBe('');
    const quiet = await build({ type: 'quiet', quietPrompt: 'Summarize for {{user}}.' });
    expect(quiet.brief.at(-1)).toBe('system: Summarize for Yun.');
  });

  it('bias from textarea or user_prompt_bias becomes a trailing assistant prompt', async () => {
    const r = await build({ textareaText: 'hello {{bias "be nice"}}' });
    expect(r.bias).toEqual({
      messageBias: ' be nice',
      promptBias: ' be nice',
      isUserPromptBias: false,
    });
    expect(r.brief).toContain('assistant:  be nice');
    const u = await build({ powerUser: { user_prompt_bias: 'always {{user}}' } });
    expect(u.bias.isUserPromptBias).toBe(true);
    expect(u.brief).toContain('assistant: always Yun');
  });

  it('send_if_empty adds a user message when history ends with assistant', async () => {
    const r = await build({ settings: { send_if_empty: '(continue)' } });
    expect(r.brief.slice(-2)).toEqual(['assistant: hi back', 'user: (continue)']);
    const r2 = await build({
      settings: { send_if_empty: '(continue)' },
      state: { chat: [{ name: 'Yun', is_user: true, mes: 'q' }] },
    });
    expect(r2.brief.at(-1)).toBe('user: q');
  });

  it('pin_examples puts examples before history budgeting; strip_examples removes them; squash merges system messages', async () => {
    const stripped = await build({ powerUser: { strip_examples: true } });
    expect(stripped.brief.some((l) => l.includes('[Example Chat]'))).toBe(false);
    const squashed = await build({ settings: { squash_system_messages: true } });
    expect(squashed.brief[0]).toBe(
      "system: Write Sera's next reply in a fictional chat between Sera and Yun.\nSera is a guardian. She likes Yun.\nkind\nA glade.",
    );
    expect(squashed.brief[1]).toBe('system: [Example Chat]');
    expect(squashed.brief).toContain('system: [Start a new Chat]');
    const pinned = await build({
      powerUser: { pin_examples: true },
      settings: { openai_max_context: 330, openai_max_tokens: 0 },
    });
    expect(pinned.brief.some((l) => l.includes('[Example Chat]'))).toBe(true);
    expect(
      pinned.brief.filter((l) => l.startsWith('user:') || l.startsWith('assistant:')).length,
    ).toBeLessThan(3);
  });

  it('token budget drops oldest history first and reports mandatory overflow', async () => {
    const r = await build({ settings: { openai_max_context: 230, openai_max_tokens: 0 } });
    expect(r.error).toBeNull();
    const history = r.brief.slice(r.brief.indexOf('system: [Start a new Chat]') + 1);
    expect(history).toEqual(['user: hello', 'assistant: hi back']);
    const tiny = await build({ settings: { openai_max_context: 20, openai_max_tokens: 0 } });
    expect(tiny.error?.name).toBe('TokenBudgetExceeded');
  });

  it('swipe drops the last message; narrator messages become system; ignored flag skips', async () => {
    const swipe = await build({ type: 'swipe' });
    expect(swipe.brief.at(-1)).toBe('user: hello');
    const narrator = await build({
      state: {
        chat: [
          { name: 'Yun', is_user: true, mes: 'a' },
          { name: 'Narrator', is_user: false, mes: 'scene', extra: { type: 'narrator' } },
          { name: 'Sera', is_user: false, mes: 'b', extra: { [Symbol.for('ignore')]: true } },
        ],
      },
    });
    expect(narrator.brief.slice(-2)).toEqual(['user: a', 'system: scene']);
  });

  it('reasoning blocks are prepended when add_to_prompts is enabled', async () => {
    const r = await build({
      powerUser: {
        reasoning: {
          add_to_prompts: true,
          prefix: '<think>',
          suffix: '</think>',
          separator: '\n',
          max_additions: 1,
        },
      },
      state: {
        chat: [
          { name: 'Yun', is_user: true, mes: 'q' },
          { name: 'Sera', is_user: false, mes: 'a1', extra: { reasoning: 'r1' } },
          { name: 'Yun', is_user: true, mes: 'q2' },
          { name: 'Sera', is_user: false, mes: 'a2', extra: { reasoning: 'r2' } },
        ],
      },
    });
    expect(r.brief.slice(-3)).toEqual([
      'assistant: a1',
      'user: q2',
      'assistant: <think>r2</think>\na2',
    ]);
  });
});

describe('media inlining (DEV_NOTES §9.30)', () => {
  const chatWithImage = [
    { name: 'Sera', is_user: false, mes: 'Greetings, {{user}}.' },
    {
      name: 'Yun',
      is_user: true,
      mes: 'look at this',
      extra: {
        media: [
          { url: 'user/images/Sera/1.png', type: 'image', source: 'upload' },
          { url: 'user/images/Sera/2.mp4', type: 'video' },
        ],
        media_index: 0,
        inline_image: true,
      },
    },
    { name: 'Sera', is_user: false, mes: 'nice' },
  ];
  it('without host support the history stays plain strings', async () => {
    const r = await build({ state: { chat: chatWithImage } });
    const user = r.chat.find((m) => m.role === 'user' && String(m.content).includes('look'));
    expect(typeof user?.content).toBe('string');
  });
  it('with host support the user message becomes text + image_url and costs 85 tokens (low)', async () => {
    const seen: string[] = [];
    const r = await build({
      state: { chat: chatWithImage },
      inlineMedia: {
        quality: 'low',
        image: true,
        video: false,
        audio: false,
        resolve: async (url) => {
          seen.push(url);
          return { dataUrl: 'data:image/png;base64,AAAA', width: 1024, height: 1024 };
        },
      },
    });
    expect(seen).toEqual(['user/images/Sera/1.png']); // the video is not inlined
    const user = r.chat.find((m) => Array.isArray(m.content))!;
    expect(user.role).toBe('user');
    expect(user.content).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } },
    ]);
    const plain = await build({ state: { chat: chatWithImage } });
    expect(r.chatCompletion.messages.getTokens() - plain.chatCompletion.messages.getTokens()).toBe(
      85,
    );
  });
  it('gallery display inlines only the selected image; legacy extra.image migrates', async () => {
    const seen: string[] = [];
    await build({
      state: {
        chat: [
          { name: 'Sera', is_user: false, mes: 'hi' },
          {
            name: 'Yun',
            is_user: true,
            mes: 'pick',
            extra: { image_swipes: ['a.png', 'b.png'], image: 'b.png' },
          },
        ],
      },
      inlineMedia: {
        quality: 'auto',
        image: true,
        video: false,
        audio: false,
        resolve: async (url) => {
          seen.push(url);
          return { dataUrl: 'data:image/png;base64,BB', width: 2000, height: 1000 };
        },
      },
    });
    expect(seen).toEqual(['b.png']);
  });
});

describe('video / audio inlining (DEV_NOTES §9.30)', () => {
  const chat = [
    { name: 'Sera', is_user: false, mes: 'hi' },
    {
      name: 'Yun',
      is_user: true,
      mes: 'listen',
      extra: {
        media: [
          { url: '/user/images/S/a.png', type: 'image' },
          { url: '/user/images/S/b.mp4', type: 'video' },
          { url: '/user/images/S/c.mp3', type: 'audio' },
        ],
      },
    },
  ];
  it('each kind only when its flag is on; tokens follow the Gemini rates', async () => {
    const seen: string[] = [];
    const resolve = async (url: string, kind: string) => {
      seen.push(kind);
      return {
        dataUrl: `data:${kind}/x;base64,AA`,
        width: 100,
        height: 100,
        duration: kind === 'video' ? 10 : kind === 'audio' ? 5 : undefined,
      };
    };
    const r = await build({
      state: { chat },
      inlineMedia: { quality: 'auto', image: false, video: true, audio: true, resolve },
    });
    expect(seen).toEqual(['video', 'audio']);
    const user = r.chat.find((m) => Array.isArray(m.content))!;
    expect((user.content as { type: string }[]).map((p) => p.type)).toEqual([
      'text',
      'video_url',
      'audio_url',
    ]);
    const plain = await build({ state: { chat } });
    expect(r.chatCompletion.messages.getTokens() - plain.chatCompletion.messages.getTokens()).toBe(
      263 * 10 + 32 * 5,
    );
  });
});

describe('tool-call turns in the history (DEV_NOTES §9.34 第 8 轮)', () => {
  const chat = [
    { name: 'Yun', is_user: true, mes: 'what time is it' },
    {
      name: 'SillyTavern System',
      is_user: false,
      is_system: true,
      mes: '<details></details>',
      extra: {
        isSmallSys: true,
        tool_invocations: [
          { id: 'call_a', name: 'clock', parameters: '{"zone":"utc"}', result: '12:00' },
          { id: 'call_b', name: 'date', parameters: '{}', result: '' },
        ],
      },
    },
    { name: 'Sera', is_user: false, mes: 'It is noon.' },
  ];

  it('replays them as assistant tool_calls plus tool results when tools are on', async () => {
    const r = await build({ state: { chat }, canUseTools: true });
    const at = r.chat.findIndex((m) => Array.isArray(m.tool_calls));
    expect(r.chat[at]).toEqual({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_a',
          type: 'function',
          function: { arguments: '{"zone":"utc"}', name: 'clock' },
        },
        { id: 'call_b', type: 'function', function: { arguments: '{}', name: 'date' } },
      ],
    });
    expect(r.chat.slice(at + 1, at + 3)).toEqual([
      { role: 'tool', content: '12:00', tool_call_id: 'call_a' },
      { role: 'tool', content: '[No content]', tool_call_id: 'call_b' },
    ]);
    expect(r.chat[at - 1]).toMatchObject({ role: 'user', content: 'what time is it' });
  });

  it('leaves them out when tools are off', async () => {
    const r = await build({ state: { chat } });
    expect(r.chat.some((m) => m.tool_calls || m.role === 'tool')).toBe(false);
    expect(r.brief.join('|')).not.toContain('details');
  });
});
