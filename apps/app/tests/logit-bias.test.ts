import { beforeEach, describe, expect, it, vi } from 'vitest';

const tokenizerEncode = vi.fn(async (name: string, text: string, model?: string) => ({
  ids: name === 'openai' ? [...text].map((c) => c.charCodeAt(0)) : [],
  count: text.length,
  model,
}));
vi.mock('../src/lib/ipc', () => ({ tokenizerEncode }));

const { chatCompletionLogitBias } = await import('../src/lib/chat/logit-bias');

const oai = (over: Record<string, unknown> = {}) => ({
  chat_completion_source: 'openai',
  bias_preset_selected: 'Mine',
  bias_presets: { Mine: [{ id: '1', text: 'ab', value: 12 }], Empty: [] },
  ...over,
});

describe('chatCompletionLogitBias', () => {
  beforeEach(() => {
    tokenizerEncode.mockClear();
  });

  it('tokenizes the selected preset with the tiktoken model and caches the result', async () => {
    expect(await chatCompletionLogitBias(oai(), 'gpt-4o')).toEqual({ '97': 12, '98': 12 });
    expect(tokenizerEncode).toHaveBeenCalledWith('openai', 'ab', 'gpt-4o');
    await chatCompletionLogitBias(oai(), 'gpt-4o');
    expect(tokenizerEncode).toHaveBeenCalledTimes(1);
    // an edit or another tokenizer model recomputes
    const edited = oai({ bias_presets: { Mine: [{ id: '1', text: 'ab', value: -3 }] } });
    expect(await chatCompletionLogitBias(edited, 'gpt-4o')).toEqual({ '97': -3, '98': -3 });
    expect(tokenizerEncode).toHaveBeenCalledTimes(2);
  });

  it('skips when nothing is selected, the preset is empty or the source has no logit bias', async () => {
    expect(await chatCompletionLogitBias(oai({ bias_preset_selected: '' }), 'gpt-4o')).toBe(
      undefined,
    );
    expect(await chatCompletionLogitBias(oai({ bias_preset_selected: 'Empty' }), 'gpt-4o')).toBe(
      undefined,
    );
    expect(await chatCompletionLogitBias(oai({ chat_completion_source: 'claude' }), 'claude')).toBe(
      undefined,
    );
    expect(tokenizerEncode).not.toHaveBeenCalled();
  });

  it('gives no bias for Claude tokenizers and for local tokenizers without a vocabulary', async () => {
    const custom = oai({ chat_completion_source: 'custom' });
    expect(await chatCompletionLogitBias(custom, 'claude')).toEqual({});
    expect(tokenizerEncode).not.toHaveBeenCalled();
    expect(await chatCompletionLogitBias(custom, 'gemma')).toEqual({});
    expect(tokenizerEncode).toHaveBeenCalledWith('gemma', 'ab');
  });
});
