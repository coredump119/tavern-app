// Text Completion 组装：story string 与 Handlebars 对拍、instruct 格式化、Generate() TC 分支端到端。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Handlebars from 'handlebars';
import {
  DEFAULT_WORLD_INFO_SETTINGS,
  EXTENSION_PROMPT_TYPES,
  FORCE_OUTPUT_SEQUENCE,
  MacroEngine,
  NAMES_BEHAVIOR,
  PERSONA_DESCRIPTION_POSITIONS,
  WORLD_INFO_POSITION,
  buildTextCompletionPrompt,
  createCapturingLogger,
  formatInstructModeChat,
  formatInstructModePrompt,
  formatInstructModeStoryString,
  getInstructStoppingSequences,
  getSortedEntries,
  getStoppingStrings,
  renderStoryString,
  setExtensionPrompt,
  type CoreState,
  type ExtensionPrompts,
  type InstructSettings,
  type StoryStringParams,
  type TextCompletionPipelineDeps,
  type WIEntry,
} from '../src/index.js';
import { createTestState, defaultPowerUser, type TestStateOverrides } from './helpers.js';

const presets = JSON.parse(
  readFileSync(new URL('./fixtures-context-presets.json', import.meta.url), 'utf8'),
) as { name: string; story_string: string; chat_start: string; example_separator: string }[];
const chatml: InstructSettings = {
  ...(JSON.parse(
    readFileSync(
      new URL('../../formats/tests/fixtures/presets/instruct-ChatML.json', import.meta.url),
      'utf8',
    ),
  ) as InstructSettings),
  enabled: true,
};

const engine = () => new MacroEngine({ logger: createCapturingLogger([]) });

/** ST renderStoryString 的 Handlebars 参考实现（trim helper + helperMissing → substituteParams） */
function referenceStoryString(
  eng: MacroEngine,
  state: CoreState,
  template: string,
  params: StoryStringParams,
): string {
  const hb = Handlebars.create();
  hb.registerHelper('trim', () => '{{trim}}');
  hb.registerHelper('helperMissing', function (...args: unknown[]) {
    const options = args[args.length - 1] as { name: string };
    return eng.substituteParams(`{{${options.name}}}`, state);
  });
  let output = hb.compile(template, { noEscape: true })(params);
  output = eng.substituteParams(output, state, {
    name1Override: params.user,
    name2Override: params.char,
  });
  output = output.replace(/^\n+/, '');
  if (output.length > 0 && !output.endsWith('\n')) output += '\n'; // instruct disabled
  return output;
}

const fullParams: StoryStringParams = {
  description: 'character description',
  personality: 'character personality',
  persona: 'persona details',
  scenario: 'scenario setup',
  system: 'system instructions',
  char: 'character name',
  user: 'user name',
  wiBefore: 'world info before',
  wiAfter: 'world info after',
  loreBefore: 'lore before',
  loreAfter: 'lore after',
  anchorBefore: 'before anchor text',
  anchorAfter: 'after anchor text',
  mesExamples: 'example messages',
  mesExamplesRaw: 'raw example messages',
};
const partialParams: StoryStringParams = {
  ...fullParams,
  system: '',
  wiBefore: '',
  persona: '',
  anchorBefore: '',
  anchorAfter: '',
  scenario: '',
};

describe('renderStoryString ≡ Handlebars (ST MacroStoryString e2e, 34 default context presets)', () => {
  const eng = engine();
  const state = createTestState({
    userName: 'user name',
    charName: 'character name',
    powerUser: { instruct: { ...defaultPowerUser().instruct, enabled: false } },
  });
  for (const preset of presets) {
    it(`${preset.name} (full and partial params)`, () => {
      for (const params of [fullParams, partialParams]) {
        const ours = renderStoryString(eng, state, params, {
          customStoryString: preset.story_string,
        });
        const ref = referenceStoryString(eng, state, preset.story_string, params);
        expect(ours).toBe(ref);
      }
    });
  }
  it('matches Handlebars on synthetic templates (standalone lines, else/unless, comments, ~, missing helpers, nesting)', () => {
    const eng2 = engine();
    const state2 = createTestState({
      userName: 'U',
      charName: 'C',
      powerUser: { instruct: { ...defaultPowerUser().instruct, enabled: false } },
    });
    const templates = [
      'A\n{{#if system}}\nB {{system}}\n{{/if}}\nC',
      'A {{#if system}}B{{/if}} C',
      '{{#if wiBefore}}\nyes\n{{else}}\nno {{description}}\n{{/if}}\n',
      '[{{#if wiBefore}}S{{/if}}][{{#unless wiBefore}}U{{/unless}}][{{#unless system}}X{{else}}Y{{/unless}}]',
      'a{{! c }}b{{!-- d --}}c\n{{! standalone }}\nd',
      'A\n{{~#if system~}}\nB\n{{~/if~}}\nC',
      '{{{description}}}|{{this.description}}|{{description.length}}|{{nothere}}|{{roll 1d6}}',
      '{{#if system}}{{#if description}}{{description}}{{else}}no desc{{/if}}{{else}}no sys{{/if}}',
      '  {{#if system}}\n  indented {{system}}\n  {{/if}}\n{{trim}}\nend',
      "{{char}}'s turn, {{user}}. {{#if persona}}{{persona}}{{/if}}",
    ];
    for (const tpl of templates) {
      for (const params of [fullParams, partialParams]) {
        expect(renderStoryString(eng2, state2, params, { customStoryString: tpl }), tpl).toBe(
          referenceStoryString(eng2, state2, tpl, params),
        );
      }
    }
  });
  it('adds the trailing newline only when appropriate', () => {
    const eng2 = engine();
    const s1 = createTestState({ powerUser: { instruct: { ...chatml, enabled: true } } });
    expect(renderStoryString(eng2, s1, fullParams, { customStoryString: '{{description}}' })).toBe(
      'character description',
    ); // suffix 存在 → 不加
    const s2 = createTestState({
      powerUser: { instruct: { ...chatml, enabled: true, story_string_suffix: '' } },
    });
    expect(renderStoryString(eng2, s2, fullParams, { customStoryString: '{{description}}' })).toBe(
      'character description\n',
    );
    const s3 = createTestState({
      powerUser: {
        context: {
          ...defaultPowerUser().context,
          story_string_position: EXTENSION_PROMPT_TYPES.IN_CHAT,
        },
      },
    });
    expect(
      renderStoryString(eng2, s3, fullParams, { customStoryString: '\n\n{{description}}' }),
    ).toBe('character description');
  });
});

describe('instruct formatting', () => {
  const eng = engine();
  const mk = (over: Partial<InstructSettings> = {}, state: TestStateOverrides = {}) => {
    const s = createTestState({
      userName: 'Yun',
      charName: 'Sera',
      mainApi: 'textgenerationwebui',
      powerUser: { instruct: { ...chatml, ...over } },
      ...state,
    });
    const sub = (t: string, o?: Parameters<MacroEngine['substituteParams']>[2]) =>
      eng.substituteParams(t, s, o);
    return { s, sub };
  };
  it('formatInstructModeChat: roles, first/last sequences, names behavior, wrap defaults', () => {
    const { s, sub } = mk();
    expect(formatInstructModeChat(s, sub, 'Yun', 'hi', true, false, '', 'Yun', 'Sera', false)).toBe(
      '<|im_start|>user\nhi<|im_end|>\n',
    );
    expect(
      formatInstructModeChat(s, sub, 'Sera', 'yo', false, false, '', 'Yun', 'Sera', false),
    ).toBe('<|im_start|>assistant\nyo<|im_end|>\n');
    expect(formatInstructModeChat(s, sub, '', 'note', false, true, '', 'Yun', 'Sera', false)).toBe(
      '<|im_start|>system\nnote<|im_end|>\n',
    );
    const { s: s2, sub: sub2 } = mk({
      first_output_sequence: '<first>',
      last_input_sequence: '<lastin>',
      output_suffix: '',
      input_suffix: '',
      names_behavior: NAMES_BEHAVIOR.ALWAYS,
    });
    expect(
      formatInstructModeChat(
        s2,
        sub2,
        'Sera',
        'yo',
        false,
        false,
        '',
        'Yun',
        'Sera',
        FORCE_OUTPUT_SEQUENCE.FIRST,
      ),
    ).toBe('<first>\nSera: yo\n');
    expect(
      formatInstructModeChat(
        s2,
        sub2,
        'Yun',
        'hi',
        true,
        false,
        '',
        'Yun',
        'Sera',
        FORCE_OUTPUT_SEQUENCE.LAST,
      ),
    ).toBe('<lastin>\nYun: hi\n');
    // FORCE：群聊或 force_avatar 才带名字；{{name}} 替换；wrap=false 不加换行
    const { s: s3, sub: sub3 } = mk(
      { input_sequence: '[{{name}}]', input_suffix: '', wrap: false },
      { selectedGroup: 'g', groups: [{ id: 'g', members: [] }] },
    );
    expect(
      formatInstructModeChat(s3, sub3, 'Bob', 'hi', true, false, '', 'Yun', 'Sera', false),
    ).toBe('[Bob]Bob: hi');
    const { s: s4, sub: sub4 } = mk({ system_same_as_user: true });
    expect(formatInstructModeChat(s4, sub4, '', 'n', false, true, '', 'Yun', 'Sera', false)).toBe(
      '<|im_start|>user\nn<|im_end|>\n',
    );
  });
  it('formatInstructModePrompt: default / impersonate / quiet / names with Mistral filler / bias', () => {
    const { s, sub } = mk();
    expect(formatInstructModePrompt(s, sub, 'Sera', false, '', 'Yun', 'Sera', false, false)).toBe(
      '\n<|im_start|>assistant\n',
    );
    expect(formatInstructModePrompt(s, sub, 'Yun', true, '', 'Yun', 'Sera', false, false)).toBe(
      '\n<|im_start|>user\n',
    );
    expect(formatInstructModePrompt(s, sub, 'System', false, '', 'Yun', 'Sera', true, false)).toBe(
      '<|im_start|>assistant\n',
    );
    expect(
      formatInstructModePrompt(s, sub, 'Sera', false, ' bias', 'Yun', 'Sera', false, false),
    ).toBe('\n<|im_start|>assistant\nbias\n');
    const { s: s2, sub: sub2 } = mk({
      names_behavior: NAMES_BEHAVIOR.ALWAYS,
      output_sequence: '[OUT] ',
      last_output_sequence: '[LAST]',
    });
    expect(formatInstructModePrompt(s2, sub2, 'Sera', false, '', 'Yun', 'Sera', false, false)).toBe(
      '\n[LAST]\n Sera:',
    );
    expect(
      formatInstructModePrompt(s2, sub2, 'Sera', false, ' b', 'Yun', 'Sera', false, false),
    ).toBe('\n[LAST]\n Sera: b');
  });
  it('formatInstructModeStoryString wraps with prefix/suffix unless in-chat', () => {
    const { s, sub } = mk();
    expect(formatInstructModeStoryString(s, sub, 'STORY')).toBe(
      '<|im_start|>system\nSTORY<|im_end|>\n',
    );
    expect(formatInstructModeStoryString(s, sub, '')).toBe('');
    const { s: s2, sub: sub2 } = mk(
      {},
      {
        powerUser: {
          instruct: chatml,
          context: {
            ...defaultPowerUser().context,
            story_string_position: EXTENSION_PROMPT_TYPES.IN_CHAT,
          },
        },
      },
    );
    expect(formatInstructModeStoryString(s2, sub2, 'STORY')).toBe('STORY');
  });
  it('stopping sequences: instruct sequences, names, group members, custom JSON, single_line, impersonate', () => {
    const { s, sub } = mk(
      {},
      {
        powerUser: {
          instruct: chatml,
          context: { ...defaultPowerUser().context, chat_start: '', example_separator: '' },
        },
      },
    );
    expect(getInstructStoppingSequences(s, sub)).toEqual([
      '\n<|im_end|>',
      '\n<|im_start|>user',
      '\n<|im_start|>assistant',
      '\n<|im_start|>system',
    ]);
    expect(getStoppingStrings(s, sub, false, false)).toEqual([
      '\nYun:',
      '\n<|im_end|>',
      '\n<|im_start|>user',
      '\n<|im_start|>assistant',
      '\n<|im_start|>system',
    ]);
    const { s: s2, sub: sub2 } = mk(
      { enabled: false },
      {
        groups: [{ id: 'g', members: ['sera.png', 'bob.png'] }],
        selectedGroup: 'g',
        characters: [
          { name: 'Sera', avatar: 'sera.png' },
          { name: 'Bob', avatar: 'bob.png' },
        ],
        powerUser: {
          instruct: { ...chatml, enabled: false },
          custom_stopping_strings: '["<stop {{user}}>", 5, ""]',
          single_line: true,
        },
      },
    );
    expect(getStoppingStrings(s2, sub2, true, false)).toEqual([
      '\n',
      '\nSera:',
      '\nYun:',
      '\nBob:',
      '\n***',
      '<stop Yun>',
    ]);
    expect(getStoppingStrings(s2, sub2, false, false, { api: 'openai', ephemeral: ['E'] })).toEqual(
      ['<stop Yun>', 'E'],
    );
  });
});

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
  powerUser?: Partial<CoreState['powerUser']>;
  deps?: Partial<TextCompletionPipelineDeps['powerUser']>;
  entries?: WIEntry[];
  extensionPrompts?: ExtensionPrompts;
  type?: import('../src/index.js').GenerationType;
  quietPrompt?: string;
  quietToLoud?: boolean;
  textareaText?: string;
  maxPrompt?: number;
}
async function build(o: Opts = {}) {
  const eng = engine();
  const pu = defaultPowerUser();
  const state = createTestState({
    userName: 'Yun',
    charName: 'Sera',
    mainApi: 'textgenerationwebui',
    characters: [sera],
    characterId: 0,
    chat: [
      { name: 'Sera', is_user: false, mes: 'Greetings, {{user}}.' },
      { name: 'Yun', is_user: true, mes: 'hello' },
      { name: 'Sera', is_user: false, mes: 'hi back' },
    ],
    powerUser: { ...pu, ...(o.powerUser ?? {}) },
    tokens: {
      maxContext: () => (o.maxPrompt ?? 4000) + 200,
      maxResponse: () => 200,
      maxPrompt: () => o.maxPrompt ?? 4000,
    },
    ...(o.state ?? {}),
  });
  const deps: TextCompletionPipelineDeps = {
    engine: eng,
    countText: (t) => t.length,
    worldInfo: {
      settings: { ...DEFAULT_WORLD_INFO_SETTINGS, world_info_depth: 10 },
      sortedEntries: getSortedEntries(
        { globalLore: o.entries ?? [], characterLore: [], chatLore: [], personaLore: [] },
        1,
      ),
      random: () => 0.5,
    },
    note: { allowWIScan: false },
    powerUser: {
      persona_description: '',
      persona_description_position: PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT,
      pin_examples: false,
      strip_examples: false,
      token_padding: 0,
      ...(o.deps ?? {}),
    },
    extensionPrompts: o.extensionPrompts,
  };
  const r = await buildTextCompletionPrompt(state, deps, {
    type: o.type,
    quietPrompt: o.quietPrompt,
    quietToLoud: o.quietToLoud,
    textareaText: o.textareaText,
  });
  return { ...r, state };
}

const STORY =
  "Write Sera's next reply in a fictional chat between Sera and Yun.\nSera is a guardian. She likes Yun.\nSera's personality: kind\nScenario: A glade.\n";
const EXAMPLES = '***\nYun: Hi\nSera: Hello there.\n***\nYun: Who?\nSera: Me.\n';
const CHAT = '***\nSera: Greetings, Yun.\nYun: hello\nSera: hi back';

describe('buildTextCompletionPrompt', () => {
  it('non-instruct default: story string + examples + chat with separator', async () => {
    const r = await build();
    expect(r.prompt).toBe(STORY + EXAMPLES + CHAT);
    expect(r.stoppingStrings).toEqual(['\nYun:', '\n***']);
    expect(r.inContextMessages).toBe(3);
    expect(r.storyString).toBe(STORY);
  });
  it('always_force_name2 appends the character name; impersonate appends the user name', async () => {
    expect((await build({ deps: { always_force_name2: true } })).prompt).toBe(
      STORY + EXAMPLES + CHAT + '\nSera:',
    );
    const imp = await build({ type: 'impersonate' });
    expect(imp.prompt).toBe(STORY + EXAMPLES + CHAT + '\nYun:');
    expect(imp.stoppingStrings).toEqual(['\nSera:', '\nYun:', '\n***']);
  });
  it('quiet prompt (non-instruct) is appended to the last line and bails out', async () => {
    expect(
      (
        await build({
          type: 'quiet',
          quietPrompt: 'Summarize for {{user}}.',
          deps: { always_force_name2: true },
        })
      ).prompt,
    ).toBe(STORY + EXAMPLES + CHAT + '\nSummarize for Yun.');
    expect(
      (
        await build({
          type: 'quiet',
          quietPrompt: 'Loud.',
          quietToLoud: true,
          deps: { always_force_name2: true },
        })
      ).prompt,
    ).toBe(STORY + EXAMPLES + CHAT + '\nLoud.\nSera:');
  });
  it('bias forces the name and is appended after the last line', async () => {
    const r = await build({ textareaText: 'x {{bias "be nice"}}' });
    expect(r.prompt).toBe(STORY + EXAMPLES + CHAT + '\nSera: be nice');
  });
  it('post-history instructions are appended as a user line; prefer_character_jailbreak uses {{original}}', async () => {
    const r = await build({
      powerUser: {
        sysprompt: {
          enabled: true,
          content: defaultPowerUser().sysprompt.content ?? '',
          post_history: 'PHI for {{user}}',
        },
      },
    });
    expect(r.prompt).toBe(STORY + EXAMPLES + CHAT + '\nPHI for Yun');
    const r2 = await build({
      powerUser: { sysprompt: { enabled: true, content: 'SYS', post_history: 'BASE' } },
      state: {
        characters: [
          {
            ...sera,
            data: {
              ...sera.data,
              system_prompt: 'Card ({{original}})',
              post_history_instructions: 'CardPHI ({{original}})',
            },
          },
        ],
      },
    });
    expect(r2.storyString.startsWith('Card (SYS)\n')).toBe(true);
    expect(r2.prompt.endsWith('\nCardPHI (BASE)')).toBe(true);
    const off = await build({ powerUser: { sysprompt: { enabled: false, content: 'SYS' } } });
    expect(off.storyString.startsWith('Sera is a guardian.')).toBe(true);
  });
  it('depth injections become narrator lines; story string can be injected in-chat', async () => {
    const ext: ExtensionPrompts = {};
    setExtensionPrompt(ext, 'note', 'NOTE {{user}}', EXTENSION_PROMPT_TYPES.IN_CHAT, 1, false, 0);
    const r = await build({ extensionPrompts: ext });
    expect(r.prompt).toBe(
      STORY + EXAMPLES + '***\nSera: Greetings, Yun.\nYun: hello\nNOTE Yun\nSera: hi back',
    );
    expect(r.injectedIndices).toEqual([1]);
    expect(r.inContextMessages).toBe(3);
    const inChat = await build({
      powerUser: {
        context: {
          ...defaultPowerUser().context,
          story_string_position: EXTENSION_PROMPT_TYPES.IN_CHAT,
          story_string_depth: 2,
        },
      },
    });
    expect(inChat.combinedStoryString).toBe('');
    expect(inChat.prompt).toBe(
      EXAMPLES + '***\nSera: Greetings, Yun.\n' + STORY + 'Yun: hello\nSera: hi back',
    );
  });
  it('world info before/after flows into the story string and depth entries into the chat', async () => {
    const entries: WIEntry[] = [
      {
        uid: 1,
        world: 'w',
        key: ['hello'],
        content: 'BEFORE',
        position: WORLD_INFO_POSITION.before,
        selective: true,
        keysecondary: [],
      },
      {
        uid: 2,
        world: 'w',
        key: ['hello'],
        content: 'AFTER',
        position: WORLD_INFO_POSITION.after,
        selective: true,
        keysecondary: [],
      },
      {
        uid: 3,
        world: 'w',
        key: ['hello'],
        content: 'DEEP',
        position: WORLD_INFO_POSITION.atDepth,
        depth: 1,
        role: 2,
        selective: true,
        keysecondary: [],
      },
    ];
    const r = await build({ entries });
    expect(r.storyString).toBe(
      "Write Sera's next reply in a fictional chat between Sera and Yun.\nBEFORE\nSera is a guardian. She likes Yun.\nSera's personality: kind\nScenario: A glade.\nAFTER\n",
    );
    expect(
      r.prompt.endsWith('***\nSera: Greetings, Yun.\nYun: hello\nSera: DEEP\nSera: hi back'),
    ).toBe(true);
  });
  it('continue: last message becomes the generated prompt cache without trailing newline', async () => {
    const r = await build({ type: 'continue' });
    expect(r.generatedPromptCache).toBe('Sera: hi back');
    expect(r.continueMag).toBe('hi back');
    expect(r.prompt).toBe(
      STORY + EXAMPLES + '***\nSera: Greetings, Yun.\nYun: hello\n' + 'Sera: hi back',
    );
  });
  it('token budget drops the oldest messages, then examples', async () => {
    const full = await build();
    // ST 先装历史再装示例：差 1 个 token 时掉的是第二段示例，而不是最老的消息
    const trimmed = await build({ maxPrompt: full.prompt.length - 1 });
    expect(trimmed.prompt).toBe(STORY + '***\nYun: Hi\nSera: Hello there.\n' + CHAT);
    expect(trimmed.inContextMessages).toBe(3);
    const tiny = await build({
      maxPrompt: STORY.length + '***\n'.length + 'Sera: hi back\n'.length + 1,
    });
    expect(tiny.prompt).toBe(STORY + '***\nSera: hi back');
    const pinned = await build({
      maxPrompt: STORY.length + EXAMPLES.length + 20,
      deps: { pin_examples: true },
    });
    expect(pinned.prompt.startsWith(STORY + EXAMPLES)).toBe(true);
    expect((await build({ deps: { strip_examples: true } })).prompt).toBe(STORY + CHAT);
  });
  it('instruct (ChatML): wrapped story string, formatted examples/messages and output sequence line', async () => {
    const r = await build({
      powerUser: {
        instruct: chatml,
        context: {
          ...defaultPowerUser().context,
          story_string: presets.find((p) => p.name === 'ChatML')!.story_string,
          chat_start: '',
          example_separator: '',
        },
      },
    });
    expect(r.prompt).toBe(
      "<|im_start|>system\nWrite Sera's next reply in a fictional chat between Sera and Yun.\nSera is a guardian. She likes Yun.\nkind\nA glade.<|im_end|>\n" +
        '<|im_start|>user\nYun: Hi<|im_end|>\n<|im_start|>assistant\nHello there.<|im_end|>\n<|im_start|>user\nYun: Who?<|im_end|>\n<|im_start|>assistant\nMe.<|im_end|>\n' +
        '<|im_start|>assistant\nGreetings, Yun.<|im_end|>\n<|im_start|>user\nhello<|im_end|>\n<|im_start|>assistant\nhi back<|im_end|>\n' +
        '<|im_start|>assistant\n',
    );
    expect(r.stoppingStrings).toEqual([
      '\nYun:',
      '\n<|im_end|>',
      '\n<|im_start|>user',
      '\n<|im_start|>assistant',
      '\n<|im_start|>system',
    ]);
    const imp = await build({
      type: 'impersonate',
      powerUser: {
        instruct: chatml,
        context: { ...defaultPowerUser().context, chat_start: '', example_separator: '' },
      },
    });
    expect(imp.prompt.endsWith('hi back<|im_end|>\n<|im_start|>user\n')).toBe(true);
    const quiet = await build({
      type: 'quiet',
      quietPrompt: 'Summarize.',
      powerUser: {
        instruct: chatml,
        context: { ...defaultPowerUser().context, chat_start: '', example_separator: '' },
      },
    });
    expect(
      quiet.prompt.endsWith(
        'hi back<|im_end|>\n<|im_start|>system\nSummarize.<|im_end|>\n<|im_start|>assistant\n',
      ),
    ).toBe(true);
  });
  it('instruct user alignment message is prepended when the context does not end at a user turn', async () => {
    const r = await build({
      powerUser: {
        instruct: { ...chatml, user_alignment_message: 'Go on, {{char}}.' },
        context: { ...defaultPowerUser().context, chat_start: '', example_separator: '' },
      },
    });
    expect(r.prompt).toContain(
      '<|im_start|>user\nGo on, Sera.<|im_end|>\n<|im_start|>assistant\nGreetings, Yun.<|im_end|>\n',
    );
    // chat2 以最新为 0，对齐消息 push 在最后 → 下标 3；mesSend 反转后它是第一条且标记为注入
    expect(r.injectedIndices).toEqual([3]);
    expect(r.mesSend[0]?.injected).toBe(true);
  });
  it('group chat: narrator-less names, group member stop strings, swipe pops the last message', async () => {
    const r = await build({
      state: {
        groups: [
          { id: 'g', members: ['sera.png', 'bob.png'], disabled_members: [], chat_id: 'gc' },
        ],
        selectedGroup: 'g',
        characters: [sera, { name: 'Bob', avatar: 'bob.png', description: 'Bob.' }],
        chat: [
          { name: 'Yun', is_user: true, mes: 'hello all' },
          { name: 'Bob', is_user: false, mes: 'yo' },
          { name: 'Sera', is_user: false, mes: 'hey' },
        ],
      },
      type: 'swipe',
    });
    expect(r.prompt.endsWith('***\nYun: hello all\nBob: yo')).toBe(true);
    expect(r.stoppingStrings).toEqual(['\nYun:', '\nBob:', '\n***']);
  });
});
