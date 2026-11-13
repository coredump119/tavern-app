/** The request shapes script-driven generation asks for: `generateRaw` plans, quiet prompts, injects. */
import { describe, expect, it, vi } from 'vitest';
import {
  EXTENSION_PROMPT_TYPES,
  defaultChatCompletionSettings,
  setExtensionPrompt,
  type ExtensionPrompts,
} from '@tm/core';
import type { ChatMessage } from '@tm/formats';
import { createMockFs, ipcModule } from './ipc-mock';

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
vi.mock('../src/lib/ipc', () => ({
  ...ipcModule(createMockFs()),
  tokenizerCount: vi.fn(async (_name: string, text: string) => words(text)),
  tokenizerCountOpenAI: vi.fn(async (_model: string, messages: { content?: unknown }[]) =>
    messages.reduce((sum, m) => sum + words(String(m.content ?? '')), 0),
  ),
}));

const { prepareGeneration } = await import('../src/lib/chat/pipeline');
type PipelineInput = Parameters<typeof prepareGeneration>[0];

const character = {
  name: 'Mira',
  avatar: 'Mira.png',
  description: 'Mira keeps the lighthouse.',
  personality: 'patient',
  scenario: 'a storm night',
  mes_example: '',
  data: {},
};

const settings = (oai: Record<string, unknown> = {}) => ({
  main_api: 'openai',
  power_user: { persona_description: 'A sailor.' },
  extension_settings: {},
  oai_settings: {
    ...defaultChatCompletionSettings(),
    openai_model: 'gpt-4-turbo',
    stream_openai: true,
    temp_openai: 1,
    ...oai,
  },
});

const message = (mes: string, isUser: boolean): ChatMessage =>
  ({
    name: isUser ? 'Ann' : 'Mira',
    is_user: isUser,
    is_system: false,
    send_date: '2026-01-01T00:00:00.000Z',
    mes,
    extra: {},
  }) as ChatMessage;

const history = [message('first question', true), message('first answer', false)];

const input = (over: Partial<PipelineInput>): PipelineInput => ({
  root: '/data',
  settings: settings(),
  subject: { character, group: null, members: [], memberIndex: null },
  userName: 'Ann',
  chat: history,
  chatMetadata: {},
  type: 'normal',
  textareaText: '',
  ...over,
});

interface Body {
  stream: boolean;
  messages: { role: string; content: string }[];
}
const bodyOf = async (over: Partial<PipelineInput>) => {
  const prep = await prepareGeneration(input(over));
  return { prep, body: prep.request.body as unknown as Body };
};

describe('generateRaw plan (DEV_NOTES §9.5)', () => {
  it('sends the named parts in the script order, one message each', async () => {
    const { body } = await bodyOf({
      chat: [...history, message('what now', true)],
      raw: {
        order: [
          { role: 'system', content: 'Rules for {{char}}.' },
          'char_description',
          'chat_history',
          'user_input',
          'scenario',
        ],
        hasUserInput: true,
      },
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'Rules for Mira.' },
      { role: 'system', content: 'Mira keeps the lighthouse.' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'what now' },
      { role: 'system', content: 'a storm night' },
    ]);
  });

  it('leaves out empty parts, and the user input when the order does not name it', async () => {
    const { body } = await bodyOf({
      chat: [...history, message('ignored', true)],
      raw: {
        order: ['dialogue_examples', 'persona_description', 'chat_history'],
        hasUserInput: true,
      },
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'A sailor.' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ]);
  });

  it('drops the oldest history first when the prompt would not fit the context', async () => {
    const long = Array.from({ length: 40 }, (_, i) =>
      message(`turn ${i} ` + 'word '.repeat(9), i % 2 === 0),
    );
    const { body } = await bodyOf({
      settings: settings({ openai_max_context: 400, openai_max_tokens: 300 }),
      chat: long,
      raw: {
        order: [{ role: 'system', content: 'Keep it short.' }, 'chat_history'],
        hasUserInput: false,
      },
    });
    const kept = body.messages.slice(1);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'Keep it short.' });
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(long.length);
    expect(kept.at(-1)?.content).toBe(long.at(-1)?.mes);
    expect(kept.map((m) => m.content)).toEqual(long.slice(-kept.length).map((m) => m.mes));
  });

  it('carries the images of user_input as image parts', async () => {
    const picture = 'data:image/png;base64,AAAA';
    const last = {
      ...message('what is this', true),
      extra: { media: [{ url: picture, type: 'image' }] },
    };
    const { body } = await bodyOf({
      chat: [...history, last as ChatMessage],
      raw: { order: [{ role: 'system', content: 'Look.' }, 'user_input'], hasUserInput: true },
      inlineMedia: {
        quality: 'low',
        image: true,
        video: false,
        audio: false,
        resolve: async (url) => ({ dataUrl: url, width: 8, height: 8 }),
      },
    });
    expect(body.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: picture, detail: 'low' } },
      ],
    });
  });

  it('refuses an image the model cannot take instead of dropping it', async () => {
    const last = {
      ...message('what is this', true),
      extra: { media: [{ url: 'data:image/png;base64,AAAA', type: 'image' }] },
    };
    await expect(
      prepareGeneration(
        input({
          chat: [...history, last as ChatMessage],
          raw: { order: ['user_input'], hasUserInput: true },
        }),
      ),
    ).rejects.toThrow('不支持图片');
  });
});

const textSettings = (instruct: Record<string, unknown> = {}) => ({
  main_api: 'textgenerationwebui',
  amount_gen: 100,
  max_context: 2048,
  power_user: {
    persona_description: 'A sailor.',
    instruct: { enabled: false, ...instruct },
    sysprompt: { enabled: false, content: '' },
    context: { story_string: '', example_separator: '', chat_start: '' },
  },
  extension_settings: {},
  textgenerationwebui_settings: {
    type: 'ooba',
    server_urls: { ooba: 'http://127.0.0.1:5000' },
    streaming: false,
  },
});
const promptOf = async (over: Partial<PipelineInput>) => {
  const prep = await prepareGeneration(input(over));
  return (prep.request.body as { prompt: string }).prompt;
};

describe('generateRaw on Text Completion', () => {
  const raw = {
    order: [
      { role: 'system' as const, content: 'Rules for {{char}}.' },
      'chat_history',
      'user_input',
    ],
    hasUserInput: true,
  } satisfies PipelineInput['raw'];
  const chat = [...history, message('what now', true)];

  it('writes the parts as one named transcript without an instruct template', async () => {
    const prompt = await promptOf({ settings: textSettings(), chat, raw });
    expect(prompt).toBe(
      ['Rules for Mira.', 'Ann: first question', 'Mira: first answer', 'Ann: what now', ''].join(
        '\n',
      ),
    );
  });

  it('wraps each part in the active instruct template', async () => {
    const prompt = await promptOf({
      settings: textSettings({
        enabled: true,
        input_sequence: '<|user|>',
        output_sequence: '<|bot|>',
        system_sequence: '<|sys|>',
        wrap: true,
        names_behavior: 'none',
      }),
      chat,
      raw,
    });
    expect(prompt.indexOf('<|sys|>\nRules for Mira.')).toBe(0);
    expect(prompt).toContain('<|user|>\nfirst question');
    expect(prompt).toContain('<|bot|>\nfirst answer');
    expect(prompt.trimEnd().endsWith('<|bot|>')).toBe(true);
  });

  it('has no place for images or tools', async () => {
    const last = {
      ...message('what is this', true),
      extra: { media: [{ url: 'data:image/png;base64,AAAA', type: 'image' }] },
    };
    await expect(
      promptOf({ settings: textSettings(), chat: [...history, last as ChatMessage], raw }),
    ).rejects.toThrow('不支持图片');
    await expect(
      promptOf({
        settings: textSettings(),
        tools: [{ type: 'function', function: { name: 'f' } }],
      }),
    ).rejects.toThrow('只支持 Chat Completion');
  });
});

describe('script generate', () => {
  it('a quiet generation carries its instruction and never streams', async () => {
    const { body } = await bodyOf({ type: 'quiet', quietPrompt: 'Summarise the scene.' });
    expect(body.stream).toBe(false);
    expect(body.messages.at(-1)).toMatchObject({ content: 'Summarise the scene.' });
  });

  it('request.stream follows the stream flag of the body', async () => {
    const on = await bodyOf({});
    expect(on.body.stream).toBe(true);
    expect(on.prep.request.stream).toBe(true);
    const off = await bodyOf({ settings: settings({ stream_openai: false }) });
    expect(off.body.stream).toBe(false);
    expect(off.prep.request.stream).toBe(false);
  });

  it('script injects reach the prompt at their depth', async () => {
    const prompts: ExtensionPrompts = {};
    setExtensionPrompt(prompts, 'TH-inject-0', 'INJECTED NOTE', EXTENSION_PROMPT_TYPES.IN_CHAT, 1);
    const { body } = await bodyOf({ extensionPrompts: prompts });
    const contents = body.messages.map((m) => m.content);
    const at = contents.findIndex((c) => c.includes('INJECTED NOTE'));
    expect(at).toBeGreaterThan(-1);
    expect(at).toBe(contents.indexOf('first answer') - 1);
  });
});

describe('tools and structured output', () => {
  const tools = [
    { type: 'function', function: { name: 'roll', description: 'roll a die', parameters: {} } },
  ];
  const schema = { name: 'scene', value: { type: 'object', properties: {} } };
  const requestBody = async (over: Partial<PipelineInput>) =>
    (await prepareGeneration(input(over))).request.body as Record<string, unknown>;

  it('passes tools and tool_choice through untouched', async () => {
    const body = await requestBody({ tools, toolChoice: 'required' });
    expect(body['tools']).toEqual(tools);
    expect(body['tool_choice']).toBe('required');
  });

  it('sends nothing about tools when a script asked for none', async () => {
    const body = await requestBody({});
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('turns json_schema into the response format of the source', async () => {
    const body = await requestBody({ jsonSchema: schema });
    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'scene', strict: true, schema: schema.value },
    });
  });

  it('gives Claude the schema as a forced tool', async () => {
    const body = await requestBody({
      settings: settings({ chat_completion_source: 'claude', claude_model: 'claude-sonnet-4-5' }),
      jsonSchema: schema,
    });
    expect(body['tool_choice']).toEqual({ type: 'tool', name: 'scene' });
    expect(body['tools']).toEqual([
      { name: 'scene', description: 'Well-formed JSON object', input_schema: schema.value },
    ]);
  });
});
