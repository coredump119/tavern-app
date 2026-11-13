import { describe, expect, it } from 'vitest';
import {
  buildCohereRequest,
  buildDeepSeekRequest,
  buildGoogleRequest,
  buildMistralRequest,
  buildUpstreamRequest,
  buildXaiRequest,
  calculateGoogleBudgetTokens,
  convertGooglePrompt,
  convertMistralMessages,
  convertXAIMessages,
  getChatCompletionModel,
  mergeMessages,
  resolveChatCompletionEndpoint,
  toUpstreamRequest,
  type GenerateData,
  type LooseMessage,
} from '../src/index.js';

const names = { charName: 'Sera', userName: 'Yun', groupNames: [] };
const base = (over: Record<string, unknown> = {}): GenerateData => ({
  type: 'normal',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'system', content: 'ex u', name: 'example_user' },
    { role: 'system', content: 'ex a', name: 'example_assistant' },
    { role: 'user', content: 'hi', name: 'Yun' },
    { role: 'assistant', content: 'yo' },
    { role: 'user', content: 'again' },
  ],
  model: 'm',
  chat_completion_source: 'openai',
  temperature: 1,
  top_p: 1,
  max_tokens: 300,
  stream: false,
  stop: ['x'],
  user_name: 'Yun',
  char_name: 'Sera',
  group_names: [],
  include_reasoning: true,
  reasoning_effort: 'auto',
  seed: -1,
  ...over,
});

describe('mergeMessages / post-processing', () => {
  it('merges consecutive roles, names in content, strict + placeholders', () => {
    const msgs: LooseMessage[] = [
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b', name: 'example_user' },
      { role: 'assistant', content: 'c', name: 'Bot' },
      { role: 'assistant', content: 'd' },
    ];
    const m = mergeMessages(structuredClone(msgs), names, { strict: true, placeholders: true });
    expect(m).toEqual([
      { role: 'system', content: 'a\n\nYun: b' },
      { role: 'user', content: '[Start a new chat]' },
      { role: 'assistant', content: 'Bot: c\n\nd' },
    ]);
    const single = mergeMessages(structuredClone(msgs), names, { single: true });
    expect(single).toEqual([{ role: 'user', content: 'a\n\nYun: b\n\nSera: Bot: c\n\nSera: d' }]);
    expect(mergeMessages([], names)).toEqual([{ role: 'user', content: '[Start a new chat]' }]);
  });
});

describe('Google', () => {
  it('convertGooglePrompt: system instruction, model role, merge same role, names', () => {
    const p = convertGooglePrompt(
      structuredClone(base().messages) as unknown as LooseMessage[],
      'gemini-2.5-pro',
      true,
      names,
    );
    expect(p.system_instruction.parts.map((x) => x.text)).toEqual([
      'sys',
      'Yun: ex u',
      'Sera: ex a',
    ]);
    expect(p.contents).toEqual([
      { role: 'user', parts: [{ text: 'Yun: hi' }] },
      { role: 'model', parts: [{ text: 'yo' }] },
      { role: 'user', parts: [{ text: 'again' }] },
    ]);
    const noSys = convertGooglePrompt(
      structuredClone(base().messages) as unknown as LooseMessage[],
      'gemma-3-27b',
      false,
      names,
    );
    expect(noSys.system_instruction.parts).toEqual([]);
    expect(noSys.contents[0]).toEqual({
      role: 'user',
      parts: [{ text: 'sys\n\nYun: ex u\n\nSera: ex a\n\nYun: hi' }],
    });
  });
  it('budget tokens by family', () => {
    expect(calculateGoogleBudgetTokens(1000, 'auto', 'gemini-2.5-flash')).toBe(-1);
    expect(calculateGoogleBudgetTokens(1000, 'min', 'gemini-2.5-flash')).toBe(0);
    expect(calculateGoogleBudgetTokens(1000, 'medium', 'gemini-2.5-flash')).toBe(250);
    expect(calculateGoogleBudgetTokens(100, 'low', 'gemini-2.5-flash-lite')).toBe(512);
    expect(calculateGoogleBudgetTokens(1000, 'min', 'gemini-2.5-pro')).toBe(128);
    expect(calculateGoogleBudgetTokens(100000, 'max', 'gemini-2.5-pro')).toBe(32768);
    expect(calculateGoogleBudgetTokens(1000, 'medium', 'gemini-3-pro-preview')).toBe('low');
    expect(calculateGoogleBudgetTokens(1000, 'min', 'gemini-3-flash')).toBe('minimal');
    expect(calculateGoogleBudgetTokens(1000, 'high', 'gemma-3')).toBeNull();
  });
  it('buildGoogleRequest body, url, thinking config, stop sequences', () => {
    const r = buildGoogleRequest(
      base({
        chat_completion_source: 'makersuite',
        model: 'gemini-2.5-pro',
        use_sysprompt: true,
        top_k: 0,
        reasoning_effort: 'medium',
        stop: ['a'],
      }),
    );
    expect(r.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key={{key}}',
    );
    expect(r.keyInUrl).toBe(true);
    expect(Object.keys(r.body)).toEqual([
      'contents',
      'safetySettings',
      'generationConfig',
      'systemInstruction',
    ]);
    expect(r.body['generationConfig']).toEqual({
      stopSequences: ['a'],
      candidateCount: 1,
      maxOutputTokens: 300,
      temperature: 1,
      topP: 1,
      topK: undefined,
      responseMimeType: undefined,
      responseSchema: undefined,
      seed: -1,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 128 },
    });
    expect((r.body['safetySettings'] as unknown[]).length).toBe(5);
    const s = buildGoogleRequest(
      base({
        chat_completion_source: 'makersuite',
        model: 'gemini-2.0-flash',
        use_sysprompt: true,
        stop: [],
        stream: true,
        reverse_proxy: 'http://127.0.0.1:9/',
      }),
    );
    expect(s.url).toBe(
      'http://127.0.0.1:9/v1beta/models/gemini-2.0-flash:streamGenerateContent?key={{key}}&alt=sse',
    );
    expect('stopSequences' in (s.body['generationConfig'] as object)).toBe(false);
    expect(
      (s.body['generationConfig'] as Record<string, unknown>)['thinkingConfig'],
    ).toBeUndefined();
    const g = buildGoogleRequest(
      base({
        chat_completion_source: 'makersuite',
        model: 'gemma-3-27b-it',
        use_sysprompt: true,
        enable_web_search: true,
      }),
    );
    expect(g.body['systemInstruction']).toBeUndefined();
    expect(g.body['tools']).toBeUndefined();
    const w = buildGoogleRequest(
      base({
        chat_completion_source: 'makersuite',
        model: 'gemini-2.5-flash',
        use_sysprompt: true,
        enable_web_search: true,
        tool_choice: 'auto',
      }),
    );
    expect(w.body['tools']).toEqual([{ google_search: {} }]);
    expect(w.body['toolConfig']).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
  });
});

describe('Mistral', () => {
  it('converts names and fixes system after assistant; request body', () => {
    const msgs = convertMistralMessages(
      structuredClone(base().messages) as unknown as LooseMessage[],
      names,
    );
    expect(msgs).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'system', content: 'Yun: ex u' },
      { role: 'system', content: 'Sera: ex a' },
      { role: 'user', content: 'Yun: hi' },
      { role: 'assistant', content: 'yo' },
      { role: 'user', content: 'again' },
    ]);
    const fix = convertMistralMessages(
      [
        { role: 'assistant', content: 'a' },
        { role: 'system', content: 's' },
      ],
      names,
    );
    expect(fix[1]?.role).toBe('user');
    const r = buildMistralRequest(
      base({ chat_completion_source: 'mistralai', safe_prompt: false, seed: 7, stop: [] }),
    );
    expect(r.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(Object.keys(r.body)).toEqual([
      'model',
      'messages',
      'temperature',
      'top_p',
      'frequency_penalty',
      'presence_penalty',
      'max_tokens',
      'stream',
      'safe_prompt',
      'random_seed',
      'stop',
    ]);
    expect(r.body['random_seed']).toBe(7);
    expect(r.body['stop']).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain('"stop"');
    const pre = buildMistralRequest(
      base({
        chat_completion_source: 'mistralai',
        messages: [
          { role: 'user', content: 'u' },
          { role: 'assistant', content: 'a' },
        ],
      }),
      { enablePrefix: true },
    );
    expect((pre.body['messages'] as LooseMessage[])[1]).toEqual({
      role: 'assistant',
      content: 'a',
      prefix: true,
    });
  });
});

describe('Cohere / DeepSeek / xAI', () => {
  it('cohere body shape and names', () => {
    const r = buildCohereRequest(
      base({ chat_completion_source: 'cohere', model: 'command-r-08-2024', top_k: 0, seed: -1 }),
    );
    expect(r.url).toBe('https://api.cohere.ai/v2/chat');
    expect(Object.keys(r.body)).toEqual([
      'stream',
      'model',
      'messages',
      'temperature',
      'max_tokens',
      'k',
      'p',
      'seed',
      'stop_sequences',
      'frequency_penalty',
      'presence_penalty',
      'documents',
      'tools',
      'safety_mode',
    ]);
    expect((r.body['messages'] as LooseMessage[])[1]).toEqual({
      role: 'system',
      content: 'Yun: ex u',
    });
    expect((r.body['messages'] as LooseMessage[])[3]).toEqual({ role: 'user', content: 'Yun: hi' });
  });
  it('deepseek merges with SEMI_TOOLS, prefixes trailing assistant, thinking flag', () => {
    const r = buildDeepSeekRequest(
      base({
        chat_completion_source: 'deepseek',
        include_reasoning: false,
        messages: [...base().messages, { role: 'assistant', content: 'pre' }],
      }),
    );
    expect(r.body['messages']).toEqual([
      { role: 'system', content: 'sys\n\nYun: ex u\n\nSera: ex a' },
      { role: 'user', content: 'Yun: hi' },
      { role: 'assistant', content: 'yo' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'pre', prefix: true },
    ]);
    expect(r.body['thinking']).toEqual({ type: 'disabled' });
    expect(Object.keys(r.body)).toEqual([
      'messages',
      'model',
      'temperature',
      'max_tokens',
      'stream',
      'presence_penalty',
      'frequency_penalty',
      'top_p',
      'stop',
      'seed',
      'thinking',
    ]);
    const think = buildDeepSeekRequest(
      base({
        chat_completion_source: 'deepseek',
        include_reasoning: true,
        reasoning_effort: 'high',
      }),
    );
    expect(think.body['thinking']).toEqual({ type: 'enabled' });
    expect(think.body['reasoning_effort']).toBe('high');
    expect(think.url).toBe('https://api.deepseek.com/beta/chat/completions');
  });
  it('xai names and body', () => {
    const msgs = convertXAIMessages(
      structuredClone(base().messages) as unknown as LooseMessage[],
      names,
    );
    expect(msgs[1]).toEqual({ role: 'system', content: 'Yun: ex u' });
    expect(msgs[2]).toEqual({ role: 'system', content: 'Sera: ex a' });
    expect(msgs[3]).toEqual({ role: 'user', content: 'hi', name: 'Yun' }); // user 保留 name
    const r = buildXaiRequest(
      base({
        chat_completion_source: 'xai',
        model: 'grok-3-mini',
        reasoning_effort: 'medium',
        logprobs: 5,
      }),
    );
    expect(Object.keys(r.body)).toEqual([
      'messages',
      'model',
      'temperature',
      'max_tokens',
      'max_completion_tokens',
      'stream',
      'presence_penalty',
      'frequency_penalty',
      'top_p',
      'seed',
      'n',
      'top_logprobs',
      'logprobs',
      'stop',
      'reasoning_effort',
    ]);
    expect(r.body['reasoning_effort']).toBe('low');
    expect(r.body['logprobs']).toBe(true);
  });
});

describe('generic upstream for other sources', () => {
  it('openrouter transforms/plugins/reasoning/provider; perplexity strict merge; zai headers', () => {
    const or = toUpstreamRequest(
      base({
        chat_completion_source: 'openrouter',
        model: 'google/gemini-2.5-pro',
        middleout: 'on',
        enable_web_search: true,
        include_reasoning: false,
        provider: ['A'],
        allow_fallbacks: false,
        quantizations: ['q8'],
        use_fallback: true,
        reasoning_effort: 'high',
        min_p: 0,
        top_a: 0,
        repetition_penalty: 1,
      }),
    );
    expect(or.body['transforms']).toEqual(['middle-out']);
    expect(or.body['plugins']).toEqual([{ id: 'web' }]);
    expect(or.body['reasoning']).toEqual({ exclude: true, effort: 'high' });
    expect(or.body['provider']).toEqual({
      allow_fallbacks: false,
      order: ['A'],
      quantizations: ['q8'],
    });
    expect(or.body['route']).toBe('fallback');
    expect((or.body['safety_settings'] as unknown[]).length).toBe(5);
    const px = toUpstreamRequest(
      base({ chat_completion_source: 'perplexity', reasoning_effort: 'low' }),
    );
    expect(px.body['messages']).toEqual([
      { role: 'system', content: 'sys\n\nYun: ex u\n\nSera: ex a' },
      { role: 'user', content: 'Yun: hi' },
      { role: 'assistant', content: 'yo' },
      { role: 'user', content: 'again' },
    ]);
    const zai = toUpstreamRequest(base({ chat_completion_source: 'zai' }));
    expect(zai.headers).toEqual({ 'Accept-Language': 'en-US,en' });
    expect(zai.body['thinking']).toEqual({ type: 'enabled' });
    const moon = toUpstreamRequest(
      base({
        chat_completion_source: 'moonshot',
        messages: [
          { role: 'user', content: 'u' },
          { role: 'assistant', content: 'a' },
        ],
      }),
    );
    expect((moon.body['messages'] as LooseMessage[])[1]).toEqual({
      role: 'assistant',
      content: 'a',
      partial: true,
    });
    expect(() => toUpstreamRequest(base({ chat_completion_source: 'cohere' }))).toThrow(
      /unsupported/,
    );
  });
  it('buildUpstreamRequest converts audio to input_audio (OpenAI / Custom) and keeps video only for OpenRouter', () => {
    const media = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'listen' },
          { type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,QUJD' } },
          { type: 'video_url', video_url: { url: 'data:video/mp4;base64,REVG' } },
        ],
      },
    ];
    const parts = (src: string) =>
      (
        (
          buildUpstreamRequest(
            base({ chat_completion_source: src, messages: structuredClone(media) }),
          ).body['messages'] as LooseMessage[]
        )[0]!.content as { type: string }[]
      ).map((p) => p.type);
    expect(parts('custom')).toEqual(['text', 'input_audio', 'video_url']);
    expect(parts('openai')).toEqual(['text', 'input_audio', 'video_url']);
    expect(parts('openrouter')).toEqual(['text', 'input_audio', 'video_url']);
    // the caller's messages are not mutated
    expect(media[0]!.content[1]!.type).toBe('audio_url');
  });
  it('buildUpstreamRequest dispatches and applies custom post-processing', () => {
    const d = buildUpstreamRequest(
      base({ chat_completion_source: 'openai', custom_prompt_post_processing: 'merge' }),
    );
    expect(d.url).toBe('https://api.openai.com/v1/chat/completions');
    expect((d.body['messages'] as LooseMessage[])[0]).toEqual({
      role: 'system',
      content: 'sys\n\nYun: ex u\n\nSera: ex a',
    });
    expect(
      buildUpstreamRequest(base({ chat_completion_source: 'claude', use_sysprompt: true }))
        .authHeader,
    ).toBe('x-api-key');
    expect(
      buildUpstreamRequest(
        base({
          chat_completion_source: 'makersuite',
          model: 'gemini-2.0-flash',
          use_sysprompt: true,
        }),
      ).keyInUrl,
    ).toBe(true);
    expect(buildUpstreamRequest(base({ chat_completion_source: 'xai', model: 'grok-4' })).url).toBe(
      'https://api.x.ai/v1/chat/completions',
    );
  });
  it('endpoints and model picking', () => {
    expect(
      resolveChatCompletionEndpoint({
        ...baseSettings,
        chat_completion_source: 'deepseek',
        reverse_proxy: 'http://127.0.0.1:1/x',
      }),
    ).toMatchObject({
      url: 'http://127.0.0.1:1/x/chat/completions',
      secret: { kind: 'proxy_password' },
    });
    expect(
      resolveChatCompletionEndpoint({
        ...baseSettings,
        chat_completion_source: 'groq',
        reverse_proxy: 'http://ignored',
      }),
    ).toMatchObject({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      secret: { kind: 'keyring', name: 'api_key_groq' },
    });
    expect(
      resolveChatCompletionEndpoint({
        ...baseSettings,
        chat_completion_source: 'zai',
        zai_endpoint: 'coding',
      }).url,
    ).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
    expect(
      getChatCompletionModel({
        ...baseSettings,
        chat_completion_source: 'makersuite',
        google_model: 'gemini-2.5-pro',
      }),
    ).toBe('gemini-2.5-pro');
    expect(
      getChatCompletionModel({
        ...baseSettings,
        chat_completion_source: 'deepseek',
        deepseek_model: 'deepseek-chat',
      }),
    ).toBe('deepseek-chat');
  });
});

const baseSettings = {
  chat_completion_source: 'openai',
  temp_openai: 1,
  freq_pen_openai: 0,
  pres_pen_openai: 0,
  top_p_openai: 1,
  openai_max_tokens: 300,
  stream_openai: false,
};
