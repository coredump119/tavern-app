import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_COMPLETION_SOURCES,
  TEXTGEN_TYPES,
  TOKENIZERS,
  createTokenCounter,
  estimateBackend,
  getTokenizerBestMatch,
  getTokenizerModel,
  guesstimate,
  isLocalServerTokenizer,
  resolveServerTokenizerModel,
  type BestMatchInput,
  type TokenizerBackend,
  type TokenizerModelInput,
} from '../src/index.js';

describe('guesstimate', () => {
  it('ceil(utf8 bytes / 3.35)', () => {
    expect(guesstimate('')).toBe(0);
    expect(guesstimate('hello world')).toBe(Math.ceil(11 / 3.35));
    expect(guesstimate('你好')).toBe(Math.ceil(6 / 3.35));
    expect(guesstimate('a')).toBe(1);
  });
});

describe('getTokenizerBestMatch', () => {
  const base: BestMatchInput = { api: 'textgenerationwebui', onlineStatus: 'model-x' };
  it('novel models', () => {
    expect(getTokenizerBestMatch({ api: 'novel', novelModel: 'clio-v1' })).toBe(TOKENIZERS.NERD);
    expect(getTokenizerBestMatch({ api: 'novel', novelModel: 'kayra-v1' })).toBe(TOKENIZERS.NERD2);
    expect(getTokenizerBestMatch({ api: 'novel', novelModel: 'erato-v1' })).toBe(TOKENIZERS.LLAMA3);
    expect(getTokenizerBestMatch({ api: 'novel', novelModel: 'other' })).toBe(TOKENIZERS.NONE);
  });
  it('kobold uses the API tokenizer only when connected and capable', () => {
    expect(
      getTokenizerBestMatch({ api: 'kobold', onlineStatus: 'ok', koboldCanTokenize: true }),
    ).toBe(TOKENIZERS.API_KOBOLD);
    expect(
      getTokenizerBestMatch({
        api: 'kobold',
        onlineStatus: 'no_connection',
        koboldCanTokenize: true,
      }),
    ).toBe(TOKENIZERS.LLAMA);
    expect(
      getTokenizerBestMatch({ api: 'kobold', onlineStatus: 'ok', koboldCanTokenize: false }),
    ).toBe(TOKENIZERS.LLAMA);
    expect(getTokenizerBestMatch({ api: 'koboldhorde' })).toBe(TOKENIZERS.LLAMA);
  });
  it('textgen remote tokenizers', () => {
    expect(getTokenizerBestMatch({ ...base, textgenType: TEXTGEN_TYPES.TABBY })).toBe(
      TOKENIZERS.API_TEXTGENERATIONWEBUI,
    );
    // OOBA needs a validated endpoint
    expect(getTokenizerBestMatch({ ...base, textgenType: TEXTGEN_TYPES.OOBA })).toBe(
      TOKENIZERS.LLAMA,
    );
    expect(
      getTokenizerBestMatch({ ...base, textgenType: TEXTGEN_TYPES.OOBA, hasValidEndpoint: true }),
    ).toBe(TOKENIZERS.API_TEXTGENERATIONWEBUI);
    // a previous tokenizer error disables the remote path
    expect(
      getTokenizerBestMatch({ ...base, textgenType: TEXTGEN_TYPES.TABBY, hasTokenizerError: true }),
    ).toBe(TOKENIZERS.LLAMA);
    expect(
      getTokenizerBestMatch({
        ...base,
        textgenType: TEXTGEN_TYPES.OPENROUTER,
        openRouterTokenizer: TOKENIZERS.MISTRAL,
      }),
    ).toBe(TOKENIZERS.MISTRAL);
    expect(
      getTokenizerBestMatch({
        ...base,
        textgenType: TEXTGEN_TYPES.DREAMGEN,
        dreamGenTokenizer: TOKENIZERS.LLAMA3,
      }),
    ).toBe(TOKENIZERS.LLAMA3);
  });
  it('textgen model-name heuristics (falls back to LLAMA)', () => {
    const tg = (model: string) =>
      getTokenizerBestMatch({
        api: 'textgenerationwebui',
        textgenType: TEXTGEN_TYPES.GENERIC,
        textgenModel: model,
      });
    expect(tg('Meta-Llama-3-8B')).toBe(TOKENIZERS.LLAMA3);
    expect(tg('Mixtral-8x7B')).toBe(TOKENIZERS.MISTRAL);
    expect(tg('gemma-2-9b')).toBe(TOKENIZERS.GEMMA);
    expect(tg('Pixtral-12B')).toBe(TOKENIZERS.NEMO);
    expect(tg('DeepSeek-V3')).toBe(TOKENIZERS.DEEPSEEK);
    expect(tg('Yi-34B')).toBe(TOKENIZERS.YI);
    expect(tg('Jamba-1.5')).toBe(TOKENIZERS.JAMBA);
    expect(tg('c4ai-command-r-plus')).toBe(TOKENIZERS.COMMAND_R);
    expect(tg('command-a-03-2025')).toBe(TOKENIZERS.COMMAND_A);
    expect(tg('Qwen2.5-72B')).toBe(TOKENIZERS.QWEN2);
    expect(tg('some-model')).toBe(TOKENIZERS.LLAMA);
    // model missing → online_status is used as the name
    expect(getTokenizerBestMatch({ api: 'textgenerationwebui', onlineStatus: 'llama-3-70b' })).toBe(
      TOKENIZERS.LLAMA3,
    );
  });
  it('other apis → NONE', () => {
    expect(getTokenizerBestMatch({ api: 'openai' })).toBe(TOKENIZERS.NONE);
  });
});

describe('getTokenizerModel (client)', () => {
  const S = CHAT_COMPLETION_SOURCES;
  const oai = (over: Partial<TokenizerModelInput>): string =>
    getTokenizerModel({ mainApi: 'openai', source: S.OPENAI, ...over });
  it('direct sources', () => {
    expect(oai({ openaiModel: 'gpt-4o-mini' })).toBe('gpt-4o-mini');
    expect(oai({ source: S.AZURE_OPENAI, azureOpenaiModel: '' })).toBe('gpt-3.5-turbo');
    expect(oai({ source: S.AZURE_OPENAI, azureOpenaiModel: 'my-gpt4' })).toBe('my-gpt4');
    expect(oai({ source: S.DEEPSEEK })).toBe('deepseek');
    expect(oai({ source: S.CLAUDE })).toBe('claude');
    expect(oai({ source: S.MAKERSUITE })).toBe('gemma');
    expect(oai({ source: S.VERTEXAI })).toBe('gemma');
    expect(oai({ source: S.AI21 })).toBe('jamba');
    expect(oai({ source: S.MINIMAX })).toBe('gpt-3.5-turbo');
    expect(oai({ source: S.COHERE, cohereModel: 'command-r-plus' })).toBe('command-r');
    expect(oai({ source: S.COHERE, cohereModel: 'command-a-03-2025' })).toBe('command-a');
    expect(oai({ source: S.MISTRALAI, mistralaiModel: 'open-mistral-nemo' })).toBe('nemo');
    expect(oai({ source: S.MISTRALAI, mistralaiModel: 'mistral-large' })).toBe('mistral');
    expect(oai({ source: S.CUSTOM, customModel: 'anything' })).toBe('anything');
    expect(oai({ source: S.XAI })).toBe('gpt-3.5-turbo');
  });
  it('openrouter prefers architecture.tokenizer, then model-name', () => {
    const or = (model: string, tok?: string) =>
      oai({
        source: S.OPENROUTER,
        openrouterModel: model,
        openrouterModelMeta: tok ? { id: model, architecture: { tokenizer: tok } } : undefined,
      });
    expect(or('x', 'Llama2')).toBe('llama');
    expect(or('x', 'Llama3')).toBe('llama3');
    expect(or('x', 'Mistral')).toBe('mistral');
    expect(or('x', 'Yi')).toBe('yi');
    expect(or('x', 'Gemini')).toBe('gemma');
    expect(or('x', 'Qwen')).toBe('qwen2');
    expect(or('cohere/command-r', 'Cohere')).toBe('command-r');
    expect(or('cohere/command-a', 'Cohere')).toBe('command-a');
    expect(or('openai/gpt-4o')).toBe('gpt-4o');
    expect(or('openai/gpt-4-turbo')).toBe('gpt-4');
    expect(or('openai/gpt-3.5-turbo')).toBe('gpt-3.5-turbo');
    expect(or('anthropic/claude-3')).toBe('claude');
    expect(or('togethercomputer/GPT-NeoXT-Chat')).toBe('gpt2');
    expect(or('ai21/jamba')).toBe('jamba');
    expect(or('deepseek/deepseek-r1')).toBe('deepseek');
    expect(or('unknown/model')).toBe('gpt-3.5-turbo');
    // textgen openrouter uses the textgen model list
    expect(
      getTokenizerModel({
        mainApi: 'textgenerationwebui',
        source: S.XAI,
        textgenType: TEXTGEN_TYPES.OPENROUTER,
        textgenOpenrouterModel: 'x',
        textgenOpenrouterModelMeta: { id: 'x', architecture: { tokenizer: 'Mistral' } },
      }),
    ).toBe('mistral');
  });
  it('aggregators by model name', () => {
    expect(oai({ source: S.ELECTRONHUB, electronhubModel: 'gpt-5-mini' })).toBe('gpt-4o');
    expect(oai({ source: S.ELECTRONHUB, electronhubModel: 'gpt-4.1' })).toBe('gpt-4o');
    expect(oai({ source: S.ELECTRONHUB, electronhubModel: 'sonar-reasoning' })).toBe('deepseek');
    expect(oai({ source: S.ELECTRONHUB, electronhubModel: 'l3-70b-euryale' })).toBe('llama3');
    expect(oai({ source: S.ELECTRONHUB, electronhubModel: 'command-r-plus' })).toBe('command-r');
    expect(oai({ source: S.ELECTRONHUB, electronhubModel: 'other' })).toBe('gpt-3.5-turbo');
    expect(oai({ source: S.CHUTES, chutesModel: 'Qwen/QwQ-32B' })).toBe('qwen2');
    expect(oai({ source: S.CHUTES, chutesModel: 'NousResearch/Hermes-3' })).toBe('llama3');
    expect(oai({ source: S.CHUTES, chutesModel: 'openai/gpt-oss-120b' })).toBe('gpt-4o');
    expect(oai({ source: S.WORKERS_AI, workersAiModel: '@cf/meta/llama-4-scout' })).toBe('llama3');
    expect(oai({ source: S.WORKERS_AI, workersAiModel: '@cf/meta/llama-2-7b' })).toBe('llama');
    expect(oai({ source: S.WORKERS_AI, workersAiModel: '@cf/microsoft/phi-2' })).toBe(
      'gpt-3.5-turbo',
    );
    expect(oai({ source: S.PERPLEXITY, perplexityModel: 'r1-1776' })).toBe('deepseek');
    expect(oai({ source: S.PERPLEXITY, perplexityModel: 'sonar' })).toBe('gpt-3.5-turbo');
    expect(oai({ source: S.GROQ, groqModel: 'llama-3.3-70b' })).toBe('llama3');
    expect(oai({ source: S.GROQ, groqModel: 'gemma2-9b-it' })).toBe('gemma');
  });
});

describe('resolveServerTokenizerModel (server getTokenizerModel)', () => {
  it('normalizes OpenAI families', () => {
    expect(resolveServerTokenizerModel('gpt-4o-mini-2024-07-18')).toBe('gpt-4o');
    expect(resolveServerTokenizerModel('gpt-4.1-nano')).toBe('gpt-4o');
    expect(resolveServerTokenizerModel('gpt-5')).toBe('o1');
    expect(resolveServerTokenizerModel('o3-mini')).toBe('o1');
    expect(resolveServerTokenizerModel('gpt-4-32k-0613')).toBe('gpt-4-32k');
    expect(resolveServerTokenizerModel('gpt-4-turbo')).toBe('gpt-4');
    expect(resolveServerTokenizerModel('gpt-3.5-turbo-0301')).toBe('gpt-3.5-turbo-0301');
    expect(resolveServerTokenizerModel('text-davinci-003')).toBe('text-davinci-003');
  });
  it('routes to local tokenizers', () => {
    expect(resolveServerTokenizerModel('claude-sonnet-4-5')).toBe('claude');
    expect(resolveServerTokenizerModel('meta-llama/llama-3-70b')).toBe('llama3');
    expect(resolveServerTokenizerModel('gemini-2.5-pro')).toBe('gemma');
    expect(resolveServerTokenizerModel('learnlm-1.5')).toBe('gemma');
    expect(resolveServerTokenizerModel('nope')).toBe('gpt-3.5-turbo');
    expect(isLocalServerTokenizer('claude')).toBe(true);
    expect(isLocalServerTokenizer('gpt-4o')).toBe(false);
  });
});

function fakeBackend() {
  const count = vi.fn((_name: string, text: string) => text.length);
  const countOpenAI = vi.fn((_model: string, messages: Record<string, unknown>[]) =>
    messages.reduce((n, m) => n + 3 + String(m.content ?? '').length, 3),
  );
  const countTextgen = vi.fn((text: string) => text.length * 2);
  const backend: TokenizerBackend = { count, countOpenAI, countTextgen };
  return { backend, count, countOpenAI, countTextgen };
}

describe('createTokenCounter', () => {
  const bestMatch: BestMatchInput = {
    api: 'textgenerationwebui',
    textgenType: TEXTGEN_TYPES.GENERIC,
    textgenModel: 'llama-3',
  };
  it('openai api: padding === token_padding → guesstimate; otherwise OpenAI system-message count', async () => {
    const { backend, countOpenAI } = fakeBackend();
    const counter = createTokenCounter(backend, {
      tokenizer: TOKENIZERS.BEST_MATCH,
      tokenPadding: 64,
      mainApi: 'openai',
      openaiModel: 'gpt-4o',
      bestMatch: { api: 'openai' },
    });
    expect(await counter.countText('hello world', 64)).toBe(guesstimate('hello world') + 64);
    expect(countOpenAI).not.toHaveBeenCalled();
    // -1 start + (3 + 11 + 3) with full=true → 16
    expect(await counter.countText('hello world')).toBe(-1 + 3 + 3 + 11);
    expect(countOpenAI).toHaveBeenCalledWith('gpt-4o', [
      { role: 'system', content: 'hello world' },
    ]);
    expect(await counter.countText('')).toBe(0);
  });
  it('countOpenAIMessages: -1 start, -2 unless full, claude forces full, per-message cache', async () => {
    const { backend, countOpenAI } = fakeBackend();
    const cfg = {
      tokenizer: TOKENIZERS.NONE,
      tokenPadding: 64,
      mainApi: 'openai',
      bestMatch: { api: 'openai' },
    } as const;
    const counter = createTokenCounter(backend, { ...cfg, openaiModel: 'gpt-4' });
    const msgs = [
      { role: 'user', content: 'ab' },
      { role: 'assistant', content: 'cde' },
    ];
    // per message server count: 3 + 3 + len → 8 and 9; total -1 + 17 - 2 = 14
    expect(await counter.countOpenAIMessages(msgs)).toBe(14);
    expect(await counter.countOpenAIMessages(msgs, true)).toBe(16);
    expect(countOpenAI).toHaveBeenCalledTimes(2);
    const claude = createTokenCounter(backend, { ...cfg, openaiModel: 'claude' });
    expect(await claude.countOpenAIMessages(msgs)).toBe(16);
  });
  it('text completion: BEST_MATCH resolves to a local tokenizer name and caches by type+hash+padding', async () => {
    const { backend, count } = fakeBackend();
    const counter = createTokenCounter(backend, {
      tokenizer: TOKENIZERS.BEST_MATCH,
      tokenPadding: 64,
      mainApi: 'textgenerationwebui',
      openaiModel: 'gpt-3.5-turbo',
      bestMatch,
    });
    expect(counter.resolveTokenizer()).toBe(TOKENIZERS.LLAMA3);
    expect(await counter.countText('abcd', 5)).toBe(9);
    expect(count).toHaveBeenCalledWith('llama3', 'abcd', undefined);
    expect(await counter.countText('abcd', 5)).toBe(9);
    expect(count).toHaveBeenCalledTimes(1);
    expect(await counter.countText('abcd')).toBe(4);
    expect(count).toHaveBeenCalledTimes(2);
    counter.resetCache();
    expect(counter.cache.size).toBe(0);
  });
  it('explicit OPENAI tokenizer passes the model; remote textgen uses countTextgen', async () => {
    const { backend, count, countTextgen } = fakeBackend();
    const counter = createTokenCounter(backend, {
      tokenizer: TOKENIZERS.OPENAI,
      tokenPadding: 64,
      mainApi: 'textgenerationwebui',
      openaiModel: 'gpt-4o',
      bestMatch,
    });
    await counter.countText('xyz');
    expect(count).toHaveBeenCalledWith('openai', 'xyz', 'gpt-4o');
    const remote = createTokenCounter(backend, {
      tokenizer: TOKENIZERS.API_TEXTGENERATIONWEBUI,
      tokenPadding: 64,
      mainApi: 'textgenerationwebui',
      openaiModel: 'gpt-4o',
      bestMatch,
      textgenModelKey: 'm',
    });
    expect(await remote.countText('xyz')).toBe(6);
    expect(countTextgen).toHaveBeenCalledWith('xyz');
    const current = createTokenCounter(backend, {
      ...(remote.cache && {}),
      tokenizer: TOKENIZERS.API_CURRENT,
      tokenPadding: 64,
      mainApi: 'textgenerationwebui',
      openaiModel: 'gpt-4o',
      bestMatch,
    });
    expect(await current.countText('xyz')).toBe(6);
  });
  it('backend failures fall back to guesstimate (apiFailureTokenCount)', async () => {
    const backend: TokenizerBackend = {
      count: () => {
        throw new Error('boom');
      },
      countOpenAI: () => 0,
    };
    const counter = createTokenCounter(backend, {
      tokenizer: TOKENIZERS.LLAMA,
      tokenPadding: 64,
      mainApi: 'textgenerationwebui',
      openaiModel: 'gpt-4o',
      bestMatch,
    });
    expect(await counter.countText('hello world')).toBe(guesstimate('hello world'));
    const kobold = createTokenCounter(backend, {
      tokenizer: TOKENIZERS.API_KOBOLD,
      tokenPadding: 64,
      mainApi: 'kobold',
      openaiModel: 'gpt-4o',
      bestMatch,
    });
    expect(await kobold.countText('hello world')).toBe(guesstimate('hello world'));
  });
  it('estimateBackend approximates the server tiktoken scheme', () => {
    expect(estimateBackend.count('llama', 'hello world')).toBe(guesstimate('hello world'));
    expect(
      estimateBackend.countOpenAI('gpt-4', [{ role: 'user', content: 'hello world', name: 'x' }]),
    ).toBe(3 + 3 + guesstimate('user') + guesstimate('hello world') + guesstimate('x') + 1);
  });
});
