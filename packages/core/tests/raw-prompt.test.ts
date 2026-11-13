// ST createRawPrompt 的 Text Completion 分支（generateRaw 在文本补全 API 上的提示词）。
import { describe, expect, it } from 'vitest';
import {
  MacroEngine,
  buildClaudeRequest,
  createCapturingLogger,
  createRawTextPrompt,
  type InstructSettings,
  type RawPromptMessage,
} from '../src/index.js';
import { createTestState, defaultPowerUser } from './helpers.js';

const chatml: InstructSettings = {
  ...defaultPowerUser().instruct,
  enabled: true,
  input_sequence: '<|im_start|>user',
  output_sequence: '<|im_start|>assistant',
  system_sequence: '<|im_start|>system',
  stop_sequence: '<|im_end|>',
  output_suffix: '<|im_end|>\n',
  input_suffix: '<|im_end|>\n',
  system_suffix: '<|im_end|>\n',
};

const setup = (instruct: Partial<InstructSettings>) => {
  const engine = new MacroEngine({ logger: createCapturingLogger([]) });
  const state = createTestState({
    userName: 'Yun',
    charName: 'Sera',
    mainApi: 'textgenerationwebui',
    powerUser: { instruct: { ...chatml, ...instruct } },
  });
  const substitute = (t: string, o?: Parameters<MacroEngine['substituteParams']>[2]) =>
    engine.substituteParams(t, state, o);
  return { state, substitute };
};

const messages: RawPromptMessage[] = [
  { role: 'system', content: 'Rules.' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'yo' },
  { role: 'user', content: 'what now' },
];

describe('createRawTextPrompt', () => {
  it('instruct on: every message wrapped in its sequence, then the output line', () => {
    const { state, substitute } = setup({});
    expect(createRawTextPrompt(state, substitute, messages)).toBe(
      '<|im_start|>system\nRules.<|im_end|>\n' +
        '<|im_start|>user\nhi<|im_end|>\n' +
        '<|im_start|>assistant\nyo<|im_end|>\n' +
        '<|im_start|>user\nwhat now<|im_end|>\n' +
        '<|im_start|>assistant\n',
    );
  });

  it('instruct on: a prefill follows the output line', () => {
    const { state, substitute } = setup({});
    const prompt = createRawTextPrompt(state, substitute, messages.slice(1, 2), {
      prefill: 'Sure,',
    });
    expect(prompt).toBe('<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\nSure,\n');
  });

  it('instruct on: the last line uses the system sequence when one is set for quiet prompts', () => {
    const { state, substitute } = setup({ last_system_sequence: '<|im_start|>narrator' });
    const quiet = createRawTextPrompt(state, substitute, messages.slice(1, 2));
    expect(quiet.endsWith('<|im_start|>narrator\n')).toBe(true);
    const loud = createRawTextPrompt(state, substitute, messages.slice(1, 2), {
      quietToLoud: true,
    });
    expect(loud.endsWith('<|im_start|>assistant\n')).toBe(true);
  });

  it('instruct off: one "Name: text" line per message, system lines unnamed', () => {
    const { state, substitute } = setup({ enabled: false });
    expect(createRawTextPrompt(state, substitute, messages)).toBe(
      'Rules.\nYun: hi\nSera: yo\nYun: what now\n',
    );
    expect(
      createRawTextPrompt(state, substitute, [{ role: 'user', content: 'hi', name: 'Bo' }], {
        prefill: 'Sera:',
      }),
    ).toBe('Bo: hi\nSera:');
  });
});

describe('Claude tool_choice from OpenAI forms', () => {
  const tools = [{ type: 'function', function: { name: 'roll', parameters: { type: 'object' } } }];
  const choice = (toolChoice: unknown) =>
    buildClaudeRequest({
      type: 'normal',
      chat_completion_source: 'claude',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      tool_choice: toolChoice,
    }).body['tool_choice'];

  it('keeps plain modes, renames required, names a forced function', () => {
    expect(choice('auto')).toEqual({ type: 'auto' });
    expect(choice('none')).toEqual({ type: 'none' });
    expect(choice('required')).toEqual({ type: 'any' });
    expect(choice({ type: 'function', function: { name: 'roll' } })).toEqual({
      type: 'tool',
      name: 'roll',
    });
  });
});
