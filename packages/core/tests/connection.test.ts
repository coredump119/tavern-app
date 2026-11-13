import { describe, expect, it } from 'vitest';
import {
  STATUS_BYPASSED,
  STATUS_KEY_SAVED,
  STATUS_NO_CONNECTION,
  STATUS_VALID,
  chatConnectionStatus,
  koboldStatus,
  koboldStatusUrls,
  normalizeChatModels,
  normalizeTextModels,
  pickChatModel,
  pickTextModel,
  resolveModelsEndpoint,
  textConnectionStatus,
  textModelsEndpoint,
  textStatusResult,
  type GenerationSettings,
} from '../src/index.js';

const base: GenerationSettings = {
  chat_completion_source: 'openai',
  temp_openai: 1,
  freq_pen_openai: 0,
  pres_pen_openai: 0,
  top_p_openai: 1,
  openai_max_tokens: 300,
  stream_openai: false,
};

describe('chat completion status endpoints', () => {
  it('per-source urls, proxies and keys', () => {
    expect(resolveModelsEndpoint(base)).toMatchObject({
      kind: 'fetch',
      url: 'https://api.openai.com/v1/models',
      secret: { kind: 'keyring', name: 'api_key_openai' },
    });
    expect(
      resolveModelsEndpoint({ ...base, reverse_proxy: 'http://127.0.0.1:9/v1' }),
    ).toMatchObject({ url: 'http://127.0.0.1:9/v1/models', secret: { kind: 'proxy_password' } });
    expect(resolveModelsEndpoint({ ...base, chat_completion_source: 'deepseek' })).toMatchObject({
      url: 'https://api.deepseek.com/models',
    });
    expect(resolveModelsEndpoint({ ...base, chat_completion_source: 'makersuite' })).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/models?key={{key}}',
      keyInUrl: true,
    });
    expect(resolveModelsEndpoint({ ...base, chat_completion_source: 'nanogpt' })).toMatchObject({
      url: 'https://nano-gpt.com/api/v1/models?detailed=true',
    });
    expect(
      resolveModelsEndpoint({
        ...base,
        chat_completion_source: 'siliconflow',
        siliconflow_endpoint: 'cn',
      }),
    ).toMatchObject({ url: 'https://api.siliconflow.cn/v1/models?type=text&sub_type=chat' });
    expect(resolveModelsEndpoint({ ...base, chat_completion_source: 'openrouter' })).toMatchObject({
      headers: { 'X-Title': 'SillyTavern' },
    });
    expect(resolveModelsEndpoint({ ...base, chat_completion_source: 'cohere' })).toMatchObject({
      url: 'https://api.cohere.ai/v1/models',
    });
    expect(
      resolveModelsEndpoint({
        ...base,
        chat_completion_source: 'workers_ai',
        workers_ai_account_id: 'acc 1',
      }),
    ).toMatchObject({
      url: 'https://api.cloudflare.com/client/v4/accounts/acc%201/ai/models/search?task=Text+Generation&per_page=1000',
    });
    expect(resolveModelsEndpoint({ ...base, chat_completion_source: 'claude' })).toEqual({
      kind: 'no_validate',
      status: STATUS_KEY_SAVED,
    });
    expect(
      resolveModelsEndpoint({ ...base, chat_completion_source: 'custom', custom_url: 'nope' }),
    ).toMatchObject({ kind: 'invalid' });
    expect(
      resolveModelsEndpoint({
        ...base,
        chat_completion_source: 'custom',
        custom_url: 'http://localhost:1234/v1',
      }),
    ).toMatchObject({ url: 'http://localhost:1234/v1/models' });
  });
  it('normalizes model lists per source and applies frontend filters', () => {
    expect(
      normalizeChatModels('openai', { data: [{ id: 'b' }, { id: 'a' }] }).map((m) => m.id),
    ).toEqual(['a', 'b']);
    expect(
      normalizeChatModels('makersuite', {
        models: [
          { name: 'models/gemini-x', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
        ],
      }).map((m) => m.id),
    ).toEqual(['gemini-x']);
    expect(
      normalizeChatModels('pollinations', [{ name: 'openai' }, { name: 'mistral' }]).map(
        (m) => m.id,
      ),
    ).toEqual(['mistral', 'openai']);
    expect(normalizeChatModels('cohere', { models: [{ name: 'command-r' }] })[0]?.id).toBe(
      'command-r',
    );
    expect(normalizeChatModels('workers_ai', { result: [{ name: '@cf/meta/llama' }] })[0]?.id).toBe(
      '@cf/meta/llama',
    );
    expect(
      normalizeChatModels('mistralai', {
        data: [
          { id: 'embed', capabilities: { completion_chat: false } },
          { id: 'large', capabilities: { completion_chat: true } },
        ],
      }).map((m) => m.id),
    ).toEqual(['large']);
    expect(
      normalizeChatModels('aimlapi', {
        data: [
          { id: 'img', type: 'image' },
          { id: 'chat', type: 'chat-completion' },
        ],
      }).map((m) => m.id),
    ).toEqual(['chat']);
    expect(
      normalizeChatModels('electronhub', {
        data: [
          { id: 'x', endpoints: ['/v1/chat/completions'] },
          { id: 'y', endpoints: ['/v1/images'] },
        ],
      }).map((m) => m.id),
    ).toEqual(['x']);
    expect(
      normalizeChatModels('chutes', { data: [{ id: 'Affine-1' }, { id: 'deepseek' }] }).map(
        (m) => m.id,
      ),
    ).toEqual(['deepseek']);
    expect(normalizeChatModels('openai', null)).toEqual([]);
  });
  it('model pick rules and status text', () => {
    const models = [
      { id: 'a', raw: {} },
      { id: 'b', raw: {} },
    ];
    expect(pickChatModel('mistralai', models, 'zzz')).toBe('a');
    expect(pickChatModel('mistralai', models, 'b')).toBeUndefined();
    expect(pickChatModel('custom', models, '')).toBe('a');
    expect(pickChatModel('custom', models, 'c')).toBeUndefined();
    expect(pickChatModel('electronhub', models, 'c')).toBe('a');
    expect(pickChatModel('openai', models, 'gpt-x', { showExternalModels: true })).toBe(
      'gpt-4-turbo',
    );
    expect(pickChatModel('openai', models, 'gpt-x')).toBeUndefined();
    expect(
      chatConnectionStatus('openai', base, {
        ok: true,
        status: 200,
        json: { data: [{ id: 'm' }] },
      }),
    ).toEqual({ status: STATUS_VALID, models: [{ id: 'm', name: undefined, raw: { id: 'm' } }] });
    expect(
      chatConnectionStatus('openai', base, { ok: false, status: 401, json: null }).status,
    ).toBe(STATUS_NO_CONNECTION);
    expect(
      chatConnectionStatus('openai', { ...base, bypass_status_check: true }, null).status,
    ).toBe(STATUS_BYPASSED);
    expect(
      chatConnectionStatus('custom', base, { ok: true, status: 200, json: { error: true } }).status,
    ).toBe(STATUS_BYPASSED);
    expect(
      chatConnectionStatus('makersuite', base, {
        ok: true,
        status: 200,
        json: { error: true, bypass: true, data: { data: [] } },
      }).status,
    ).toBe(STATUS_NO_CONNECTION);
  });
});

describe('text completion status', () => {
  it('urls, probes, bypass', () => {
    expect(textModelsEndpoint('ooba', 'http://localhost:5000/v1/')).toMatchObject({
      url: 'http://127.0.0.1:5000/v1/models',
      probe: { url: 'http://127.0.0.1:5000/v1/internal/model/info', field: 'model_name' },
    });
    expect(textModelsEndpoint('tabby', 'http://h:5000')).toMatchObject({
      url: 'http://h:5000/v1/model/list',
      probe: { url: 'http://h:5000/v1/model', field: 'id' },
      headers: {},
    });
    expect(textModelsEndpoint('ollama', 'http://h:11434')).toMatchObject({
      url: 'http://h:11434/api/tags',
      probe: undefined,
    });
    expect(textModelsEndpoint('togetherai', 'https://api.together.xyz')).toMatchObject({
      url: 'https://api.together.xyz/api/models?&info',
    });
    expect(textModelsEndpoint('openrouter', 'https://openrouter.ai/api')).toMatchObject({
      url: 'https://openrouter.ai/api/v1/models',
      headers: { 'X-Title': 'SillyTavern' },
    });
    expect(textModelsEndpoint('generic', 'http://h', { bypassStatusCheck: true })).toEqual({
      kind: 'no_validate',
      status: STATUS_BYPASSED,
    });
    expect(textModelsEndpoint('ooba', '')).toMatchObject({ kind: 'invalid' });
  });
  it('normalization, result and status text', () => {
    expect(
      normalizeTextModels('togetherai', [{ name: 'a', display_name: 'A' }])?.map((m) => m.id),
    ).toEqual(['a']);
    expect(
      normalizeTextModels('ollama', { models: [{ name: 'llama3:8b' }] })?.map((m) => m.id),
    ).toEqual(['llama3:8b']);
    expect(normalizeTextModels('huggingface', { anything: 1 })).toEqual([]);
    expect(normalizeTextModels('ooba', { data: [{ id: 'm' }] })?.length).toBe(1);
    expect(normalizeTextModels('ooba', { nope: true })).toBeNull();
    const models = [{ id: 'm1', raw: {} }];
    expect(textStatusResult('vllm', models, null)).toBe('m1');
    expect(textStatusResult('vllm', [], null)).toBe(STATUS_VALID);
    expect(
      textStatusResult('ooba', models, { ok: true, json: { model_name: 'loaded.gguf' } }),
    ).toBe('loaded.gguf');
    expect(textStatusResult('tabby', models, { ok: false, json: null })).toBe('None');
    expect(textStatusResult('tabby', models, { ok: true, json: { id: 'tab' } })).toBe('tab');
    expect(pickTextModel('ollama', models, 'gone')).toBe('m1');
    expect(pickTextModel('ollama', models, 'm1')).toBe('m1');
    expect(pickTextModel('tabby', models, 'gone')).toBe('');
    expect(textConnectionStatus('ollama', '', 'x')).toBe('Connected');
    expect(textConnectionStatus('tabby', '', 'None')).toBe('None');
    expect(textConnectionStatus('llamacpp', '', undefined)).toBe('Connected');
    expect(textConnectionStatus('vllm', '', 'm')).toBe(STATUS_NO_CONNECTION);
    expect(textConnectionStatus('koboldcpp', '', 'koboldcpp/model')).toBe('koboldcpp/model');
  });
});

describe('kobold status', () => {
  it('urls and synthesis', () => {
    expect(koboldStatusUrls('http://localhost:5001/api')).toEqual({
      version: 'http://127.0.0.1:5001/api/v1/info/version',
      cppVersion: 'http://127.0.0.1:5001/api/extra/version',
      model: 'http://127.0.0.1:5001/api/v1/model',
    });
    expect(
      koboldStatus({
        version: { result: '1.2.5' },
        cppVersion: { version: '1.80' },
        model: { result: 'koboldcpp/Model' },
      }),
    ).toEqual({ koboldUnitedVersion: '1.2.5', koboldCppVersion: '0.0', model: 'koboldcpp/Model' });
    expect(
      koboldStatus({ version: null, cppVersion: null, model: { result: 'ReadOnly' } }).model,
    ).toBe(STATUS_NO_CONNECTION);
  });
});
