// 请求体组装：CC createGenerationParameters / toUpstreamRequestBody，TC createTextGenGenerationData / toTextCompletionUpstream
import { describe, expect, it } from 'vitest';
import {
  TEXTGEN_TYPES,
  createGenerationParameters,
  createTextGenGenerationData,
  defaultTextgenSettings,
  getCustomTokenBans,
  resolveChatCompletionEndpoint,
  serializeRequestBody,
  textCompletionHeaders,
  toTextCompletionUpstream,
  toUpstreamRequestBody,
  type GenerationSettings,
} from '../src/index.js';

const baseOai: GenerationSettings = {
  chat_completion_source: 'openai',
  temp_openai: 1,
  freq_pen_openai: 0,
  pres_pen_openai: 0,
  top_p_openai: 1,
  top_k_openai: 0,
  openai_max_tokens: 300,
  stream_openai: false,
  n: 1,
  seed: -1,
  reverse_proxy: '',
  proxy_password: '',
  show_thoughts: true,
  reasoning_effort: 'auto',
  verbosity: 'auto',
  custom_prompt_post_processing: '',
  bias_preset_selected: 'Default (none)',
  bias_presets: { 'Default (none)': [] },
};
const msgs = () => [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' },
];
const gen = (over: Partial<GenerationSettings> = {}, model = 'gpt-4-turbo', type = 'normal') =>
  createGenerationParameters({
    settings: { ...baseOai, ...over },
    model,
    type,
    messages: msgs(),
    userName: 'User',
    charName: 'Sera',
    groupNames: [],
    customStoppingStrings: [],
  });

describe('createGenerationParameters (CC)', () => {
  it('default openai: numeric params, no stop/logit_bias/n, stream off', () => {
    const { generate_data, stream, canMultiSwipe } = gen();
    expect(stream).toBe(false);
    expect(canMultiSwipe).toBe(false);
    expect(generate_data).toMatchObject({
      temperature: 1,
      max_tokens: 300,
      chat_completion_source: 'openai',
      include_reasoning: true,
    });
    expect('stop' in generate_data).toBe(false);
    expect(generate_data['logit_bias']).toBeUndefined();
    expect(generate_data['n']).toBeUndefined();
    expect(generate_data['reasoning_effort']).toBeUndefined();
  });
  it('stream is suppressed for quiet and o1; n only with multi-swipe sources and normal type', () => {
    expect(gen({ stream_openai: true }).stream).toBe(true);
    expect(gen({ stream_openai: true }, 'gpt-4', 'quiet').stream).toBe(false);
    expect(gen({ stream_openai: true }, 'o1').stream).toBe(false);
    expect(gen({ n: 3 }).generate_data['n']).toBe(3);
    expect(gen({ n: 3 }, 'gpt-4', 'continue').generate_data['n']).toBeUndefined();
  });
  it('proxy, seed, logprobs, custom stop strings', () => {
    const r = createGenerationParameters({
      settings: {
        ...baseOai,
        reverse_proxy: 'http://127.0.0.1:1/v1',
        proxy_password: 'p',
        seed: 7,
      },
      model: 'gpt-4o',
      type: 'normal',
      messages: msgs(),
      userName: 'U',
      charName: 'C',
      groupNames: ['A', 'B'],
      customStoppingStrings: ['\nU:'],
      requestTokenProbabilities: true,
    }).generate_data;
    expect(r).toMatchObject({
      reverse_proxy: 'http://127.0.0.1:1/v1',
      proxy_password: 'p',
      seed: 7,
      logprobs: 5,
      stop: ['\nU:'],
      group_names: ['A', 'B'],
    });
  });
  it('o1: max_completion_tokens, sampling stripped, system → user', () => {
    const r = gen({ n: 2, reasoning_effort: 'low' }, 'o1').generate_data;
    expect(r['max_completion_tokens']).toBe(300);
    for (const k of [
      'max_tokens',
      'temperature',
      'top_p',
      'frequency_penalty',
      'presence_penalty',
      'logit_bias',
      'stop',
      'n',
    ]) {
      expect(r[k]).toBeUndefined();
    }
    expect(r.messages[0]?.role).toBe('user');
    expect(r['reasoning_effort']).toBe('low');
  });
  it('gpt-5 family: min effort → minimal mapping happens server-side; chat-latest keeps sampling off', () => {
    const r = gen({ reasoning_effort: 'min', verbosity: 'low' }, 'gpt-5').generate_data;
    expect(r['reasoning_effort']).toBe('min');
    expect(r['verbosity']).toBe('low');
    expect(r['temperature']).toBeUndefined();
    expect(r['max_completion_tokens']).toBe(300);
    const latest = gen({}, 'gpt-5.1').generate_data;
    expect(latest['temperature']).toBe(1); // gpt-5.1 without effort keeps temperature, drops penalties
    expect(latest['frequency_penalty']).toBeUndefined();
  });
  it('vision models drop logit_bias/stop/logprobs; gpt-4.5 drops logprobs', () => {
    const r = createGenerationParameters({
      settings: baseOai,
      model: 'gpt-4-vision-preview',
      type: 'normal',
      messages: msgs(),
      userName: 'U',
      charName: 'C',
      groupNames: [],
      customStoppingStrings: ['x'],
      requestTokenProbabilities: true,
    }).generate_data;
    expect(r['stop']).toBeUndefined();
    expect(r['logprobs']).toBeUndefined();
  });
  it('upstream body keeps ST key order and maps logprobs/reasoning_effort/verbosity', () => {
    const { generate_data } = gen({ seed: 1, reasoning_effort: 'min', verbosity: 'low' }, 'gpt-5');
    const body = toUpstreamRequestBody(generate_data);
    expect(Object.keys(body)).toEqual([
      'messages',
      'prompt',
      'model',
      'temperature',
      'max_tokens',
      'max_completion_tokens',
      'stream',
      'presence_penalty',
      'frequency_penalty',
      'top_p',
      'top_k',
      'stop',
      'logit_bias',
      'seed',
      'n',
      'logprobs',
      'top_logprobs',
      'reasoning_effort',
      'verbosity',
    ]);
    expect(body['reasoning_effort']).toBe('minimal');
    expect(body['verbosity']).toBe('low');
    expect(serializeRequestBody(body)).toBe(
      '{"messages":[{"role":"system","content":"sys"},{"role":"user","content":"hi"}],"model":"gpt-5","max_completion_tokens":300,"stream":false,"seed":1,"reasoning_effort":"minimal","verbosity":"low"}',
    );
    const lp = toUpstreamRequestBody({ ...gen().generate_data, logprobs: 5, stop: ['a'] });
    expect(lp).toMatchObject({ logprobs: true, top_logprobs: 5, stop: ['a'] });
    expect(() =>
      toUpstreamRequestBody({ ...gen().generate_data, chat_completion_source: 'claude' }),
    ).toThrow(/unsupported/);
    expect(() =>
      toUpstreamRequestBody({ ...gen().generate_data, model: 'text-davinci-003' }),
    ).toThrow(/text completion/);
  });
  it('resolves endpoints', () => {
    expect(resolveChatCompletionEndpoint(baseOai)).toEqual({
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {},
      secret: { kind: 'keyring', name: 'api_key_openai' },
    });
    expect(
      resolveChatCompletionEndpoint({ ...baseOai, reverse_proxy: 'http://127.0.0.1:9/v1/' }),
    ).toMatchObject({
      url: 'http://127.0.0.1:9/v1/chat/completions',
      secret: { kind: 'proxy_password' },
    });
    expect(
      resolveChatCompletionEndpoint({
        ...baseOai,
        chat_completion_source: 'custom',
        custom_url: 'http://localhost:1234/v1',
      }).url,
    ).toBe('http://localhost:1234/v1/chat/completions');
    expect(
      resolveChatCompletionEndpoint({ ...baseOai, chat_completion_source: 'openrouter' }).headers[
        'X-Title'
      ],
    ).toBe('SillyTavern');
  });
});

describe('createTextGenGenerationData (TC)', () => {
  const sub = (t: string) => t.replace('{{user}}', 'User');
  const make = (
    over: Partial<ReturnType<typeof defaultTextgenSettings>> = {},
    extra: Record<string, unknown> = {},
  ) =>
    createTextGenGenerationData({
      settings: { ...defaultTextgenSettings(), ...over },
      prompt: 'P',
      maxTokens: 250,
      maxContext: 4096,
      stoppingStrings: ['\nUser:'],
      substitute: sub,
      type: 'normal',
      ...extra,
    });
  it('ooba: full non-aphrodite params with sampler priority and dynatemp off', () => {
    const p = make({ server_urls: { ooba: 'http://127.0.0.1:5000' } });
    expect(p).toMatchObject({
      prompt: 'P',
      max_new_tokens: 250,
      max_tokens: 250,
      truncation_length: 4096,
      api_type: 'ooba',
      api_server: 'http://127.0.0.1:5000',
      rep_pen: 1.2,
      do_sample: true,
      temperature: 0.7,
      n_predict: 250,
    });
    expect(p['sampler_priority']).toBeDefined();
    expect(p['dynamic_temperature']).toBeUndefined();
    expect(p['model']).toBeUndefined();
    expect(p['stop']).toEqual(['\nUser:']);
    expect(p['negative_prompt']).toBe('');
  });
  it('dynatemp only where supported; mancer rescales cutoffs', () => {
    const o = make({
      dynatemp: true,
      min_temp: 0.5,
      max_temp: 1.5,
      epsilon_cutoff: 3,
      eta_cutoff: 2,
    });
    expect(o).toMatchObject({
      temperature: 1,
      dynamic_temperature: true,
      dynatemp_low: 0.5,
      dynatemp_high: 1.5,
      dynatemp_range: 0.5,
    });
    const m = make({
      type: TEXTGEN_TYPES.MANCER,
      dynatemp: true,
      min_temp: 0.5,
      max_temp: 1.5,
      epsilon_cutoff: 3,
      eta_cutoff: 2,
      n: 2,
    });
    expect(m).toMatchObject({
      epsilon_cutoff: 0.003,
      eta_cutoff: 0.002,
      dynatemp_mode: 1,
      dynatemp_min: 0.5,
      dynatemp_max: 1.5,
      n: 2,
      model: 'mytholite',
      api_server: 'https://neuro.mancer.tech',
    });
    expect(m['dynatemp_low']).toBeUndefined();
    const v = make({
      type: TEXTGEN_TYPES.VLLM,
      dynatemp: true,
      vllm_model: 'x',
      server_urls: { vllm: 'http://h:8000' },
    });
    expect(v['dynamic_temperature']).toBeUndefined();
    expect(v['n']).toBe(1);
    expect(v['ignore_eos']).toBe(false);
  });
  it('aphrodite replaces the param set; custom token bans as int array', () => {
    const a = make(
      {
        type: TEXTGEN_TYPES.APHRODITE,
        banned_tokens: '[1, 2]\n"stopword"\nraw text',
        aphrodite_model: 'm',
      },
      { tokenBans: { substitute: sub, encode: () => [9] } },
    );
    expect(a).toMatchObject({
      n: 1,
      early_stopping: false,
      include_stop_str_in_output: false,
      custom_token_bans: [1, 2, 9],
      banned_strings: ['stopword'],
    });
    expect(a['rep_pen']).toBeUndefined();
    expect(a['sampler_priority']).toBeUndefined();
  });
  it('koboldcpp / llama.cpp / ollama specifics', () => {
    const k = make(
      {
        type: TEXTGEN_TYPES.KOBOLDCPP,
        grammar_string: 'root ::= "a"',
        server_urls: { koboldcpp: 'http://127.0.0.1:5001' },
      },
      { isContinue: true },
    );
    expect(k).toMatchObject({
      grammar: 'root ::= "a"',
      grammar_retain_state: true,
      trim_stop: true,
      dry_sequence_breakers: ['\n', ':', '"', '*'],
      sampler_order: [6, 0, 1, 3, 4, 2, 5],
    });
    const l = make(
      {
        type: TEXTGEN_TYPES.LLAMACPP,
        banned_tokens: '[5]',
        server_urls: { llamacpp: 'http://127.0.0.1:8080' },
      },
      { logitBias: { '1': 2 } },
    );
    expect(l['logit_bias']).toEqual([[5, false]]); // settings.logit_bias 为空 → 只有 token 禁用
    expect(l).toMatchObject({ cache_prompt: true, grammar: '', n: 1, samplers: expect.any(Array) });
    expect(l['json_schema']).toBeUndefined();
    const o = make({
      type: TEXTGEN_TYPES.OLLAMA,
      ollama_model: 'llama3',
      server_urls: { ollama: 'http://localhost:11434' },
    });
    expect(o['model']).toBe('llama3');
    expect(o['cache_prompt']).toBe(true);
  });
  it('huggingface clamps top_p, slices stop, random seed', () => {
    const h = make(
      { type: TEXTGEN_TYPES.HUGGINGFACE, top_p: 1 },
      { stoppingStrings: ['a', 'b', 'c', 'd', 'e'], random: () => 0.5 },
    );
    expect(h['top_p']).toBe(0.999);
    expect(h['stop']).toEqual(['a', 'b', 'c', 'd']);
    expect(h['seed']).toBe(Math.floor(0.5 * 2 ** 32));
    expect(h['model']).toBe('tgi');
  });
  it('token bans honour send_banned_tokens and macros', () => {
    expect(
      getCustomTokenBans(
        { ...defaultTextgenSettings(), send_banned_tokens: false, banned_tokens: '[1]' },
        { substitute: sub },
      ),
    ).toEqual({ banned_tokens: '', banned_strings: [] });
    expect(
      getCustomTokenBans(
        { ...defaultTextgenSettings(), banned_tokens: '"{{user}}"\n[3,3]' },
        { substitute: sub, bannedInMacros: ['[4]'] },
      ),
    ).toEqual({ banned_tokens: '3,4', banned_strings: ['User'] });
  });
});

describe('toTextCompletionUpstream (server side)', () => {
  const base = {
    api_server: 'http://localhost:5000/v1/',
    prompt: 'P',
    model: 'm',
    stream: true,
    max_tokens: 10,
    temperature: 1,
    stop: ['a', 'b', 'c', 'd', 'e'],
    rep_pen: 1.1,
    foo: 'bar',
  };
  it('url: localhost → 127.0.0.1, trimV1, per-type path', () => {
    expect(toTextCompletionUpstream({ ...base, api_type: 'ooba' }).url).toBe(
      'http://127.0.0.1:5000/v1/completions',
    );
    expect(toTextCompletionUpstream({ ...base, api_type: 'llamacpp' }).url).toBe(
      'http://127.0.0.1:5000/completion',
    );
    expect(
      toTextCompletionUpstream({
        ...base,
        api_type: 'dreamgen',
        api_server: 'https://dreamgen.com',
      }).url,
    ).toBe('https://dreamgen.com/api/openai/v1/completions');
    expect(
      toTextCompletionUpstream({
        ...base,
        api_type: 'mancer',
        api_server: 'https://neuro.mancer.tech',
      }).url,
    ).toBe('https://neuro.mancer.tech/oai/v1/completions');
    expect(
      toTextCompletionUpstream({
        ...base,
        api_type: 'openrouter',
        api_server: 'https://openrouter.ai/api',
      }).url,
    ).toBe('https://openrouter.ai/api/v1/chat/completions');
  });
  it('ooba passes everything through; generic filters to OPENAI_KEYS and 4 stops', () => {
    const o = toTextCompletionUpstream({ ...base, api_type: 'ooba' });
    expect(o.body['foo']).toBe('bar');
    expect(o.streamFormat).toBe('sse');
    const g = toTextCompletionUpstream({ ...base, api_type: 'generic' });
    expect(Object.keys(g.body).sort()).toEqual([
      'max_tokens',
      'model',
      'prompt',
      'stop',
      'stream',
      'temperature',
    ]);
    expect(g.body['stop']).toEqual(['a', 'b', 'c', 'd']);
  });
  it('openrouter provider object; ollama body shape', () => {
    const or = toTextCompletionUpstream({
      ...base,
      api_type: 'openrouter',
      provider: ['A'],
      quantizations: ['q4'],
      allow_fallbacks: false,
      include_reasoning: true,
    });
    expect(or.body['provider']).toEqual({
      allow_fallbacks: false,
      order: ['A'],
      quantizations: ['q4'],
    });
    expect(or.body['foo']).toBeUndefined();
    const none = toTextCompletionUpstream({ ...base, api_type: 'openrouter', provider: [] });
    expect(none.body['provider']).toBeUndefined();
    const ol = toTextCompletionUpstream(
      { ...base, api_type: 'ollama', num_predict: 10, num_ctx: 4096, top_k: 40 },
      { ollamaKeepAlive: 300, ollamaBatchSize: 512 },
    );
    expect(ol.url).toBe('http://127.0.0.1:5000/api/generate');
    expect(ol.streamFormat).toBe('json_lines');
    expect(ol.body).toEqual({
      model: 'm',
      prompt: 'P',
      stream: true,
      keep_alive: 300,
      raw: true,
      options: {
        stop: ['a', 'b', 'c', 'd', 'e'],
        temperature: 1,
        num_predict: 10,
        num_ctx: 4096,
        top_k: 40,
        num_batch: 512,
      },
    });
  });
  it('headers per api_type', () => {
    expect(textCompletionHeaders('tabby', 'k')).toEqual({
      'x-api-key': 'k',
      Authorization: 'Bearer k',
    });
    expect(textCompletionHeaders('mancer', 'k')).toEqual({
      'X-API-KEY': 'k',
      Authorization: 'Bearer k',
    });
    expect(textCompletionHeaders('openrouter', null)).toEqual({
      'HTTP-Referer': 'https://sillytavern.app',
      'X-Title': 'SillyTavern',
    });
    expect(textCompletionHeaders('featherless', 'k')).toMatchObject({
      'X-Title': 'SillyTavern',
      Authorization: 'Bearer k',
    });
    expect(textCompletionHeaders('ollama', 'k')).toEqual({});
    expect(textCompletionHeaders('ooba', '')).toEqual({});
  });
});
