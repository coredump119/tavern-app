/**
 * TavernHelper `custom_api`: where a script may send a prompt, and with whose key. Every address and
 * key here is made up.
 */
import { describe, expect, it, vi } from 'vitest';
import { defaultChatCompletionSettings } from '@tm/core';
import type { ChatMessage } from '@tm/formats';
import type { GenerateRequest, SecretRef } from '../src/lib/ipc';
import {
  applyCustomApi,
  EXTENSION_ASKER,
  askerLabel,
  confirmRequest,
  editRequest,
  isUnder,
  parseCustomApi,
  routeRequest,
  scriptAddress,
  withScriptKey,
  type CustomApi,
  type CustomTarget,
} from '../src/lib/helper/custom-api';
import { createMockFs, ipcModule } from './ipc-mock';

vi.mock('../src/lib/ipc', () => ({
  ...ipcModule(createMockFs()),
  tokenizerCount: vi.fn(async () => 1),
  tokenizerCountOpenAI: vi.fn(async () => 1),
}));
const { prepareGeneration } = await import('../src/lib/chat/pipeline');

const SCRIPT_KEY = 'script-key';
const api = (value: Record<string, unknown>): CustomApi => parseCustomApi(value)!;
const address = (url: string, key = SCRIPT_KEY): CustomTarget => ({
  kind: 'address',
  url,
  key,
  insecure: false,
});

describe('parseCustomApi', () => {
  it('is absent when the script gave none', () => {
    expect(parseCustomApi(undefined)).toBeNull();
    expect(() => parseCustomApi('https://alt.test')).toThrow('custom_api');
  });

  it('defaults the source and sorts samplers into set / unset / preset', () => {
    const parsed = api({
      apiurl: ' https://alt.test/v1 ',
      temperature: 0.4,
      top_p: 'unset',
      top_k: 'same_as_preset',
    });
    expect(parsed.apiurl).toBe('https://alt.test/v1');
    expect(parsed.source).toBe('openai');
    expect(parsed.set).toEqual({ temperature: 0.4 });
    expect(parsed.unset).toEqual(['top_p']);
  });

  it('refuses a sampler value it does not know', () => {
    expect(() => api({ max_tokens: 'lots' })).toThrow('custom_api.max_tokens');
  });
});

describe('scriptAddress', () => {
  it('is the origin and path, without a trailing slash', () => {
    expect(scriptAddress('https://alt.test/v1/')).toBe('https://alt.test/v1');
    expect(scriptAddress('https://ALT.test')).toBe('https://alt.test');
    expect(scriptAddress('http://127.0.0.1:4010/v1')).toBe('http://127.0.0.1:4010/v1');
  });

  it('refuses anything that could hide where the prompt goes', () => {
    expect(() => scriptAddress('alt.test/v1')).toThrow('有效的地址');
    expect(() => scriptAddress('ftp://alt.test')).toThrow('http(s)');
    expect(() => scriptAddress('https://good.test@alt.test/v1')).toThrow('用户名');
    expect(() => scriptAddress('https://alt.test/v1?to=elsewhere')).toThrow('?');
    expect(() => scriptAddress('https://alt.test/v1#x')).toThrow('#');
  });
});

describe('the question put to the user', () => {
  it('names who asks', () => {
    expect(askerLabel('TH-message--12--0')).toBe('第 12 楼的卡片');
    expect(askerLabel('TH-script--dice--roller--a1b2')).toBe('脚本「dice--roller」');
    expect(askerLabel('')).toBe('一个脚本');
    expect(askerLabel(EXTENSION_ASKER)).toBe('一个扩展');
  });

  it('shows the whole address and says what is sent', () => {
    const request = confirmRequest('TH-message--3--1', 'https://alt.test/v1', false);
    expect(request.text).toContain('第 3 楼的卡片');
    expect(request.text).toContain('\n\nhttps://alt.test/v1\n\n');
    expect(request.text).toContain('角色卡');
    expect(request.text).toContain('聊天记录');
    expect(request.text).not.toContain('明文');
  });

  it('warns about plain http', () => {
    expect(confirmRequest('', 'http://alt.test', true).text).toContain('明文');
    const extension = confirmRequest(EXTENSION_ASKER, 'https://alt.test/v1', false);
    expect(extension.title).toContain('扩展');
    expect(extension.text).toContain('https://alt.test/v1');
    expect(extension.text).toContain('扩展自己提供的密钥');
    expect(() => scriptAddress('nope', '扩展给的地址')).toThrow('扩展给的地址 不是有效的地址');
  });
});

const settings = (oai: Record<string, unknown> = {}) => ({
  main_api: 'openai',
  power_user: {},
  extension_settings: {},
  proxies: [{ name: 'Mine', url: 'https://mine.test/v1', password: '' }],
  selected_proxy: { name: 'Mine' },
  oai_settings: {
    ...defaultChatCompletionSettings(),
    openai_model: 'gpt-4-turbo',
    reverse_proxy: 'https://mine.test/v1',
    custom_include_headers: 'X-Mine: 1',
    ...oai,
  },
});
const oaiOf = (s: { oai_settings: unknown }) => s.oai_settings as Record<string, unknown>;

describe('applyCustomApi', () => {
  it('points the copy at the address and applies the overrides', () => {
    const s = settings();
    applyCustomApi(
      s,
      api({ source: 'custom', model: 'alt-1', temperature: 0.2, max_tokens: 64 }),
      address('https://alt.test/v1'),
    );
    const oai = oaiOf(s);
    expect(oai['chat_completion_source']).toBe('custom');
    expect(oai['custom_url']).toBe('https://alt.test/v1');
    expect(oai['custom_model']).toBe('alt-1');
    expect(oai['temp_openai']).toBe(0.2);
    expect(oai['openai_max_tokens']).toBe(64);
    // set up by the user for their own endpoint: not for this one
    expect(oai['custom_include_headers']).toBe('');
  });

  it('forces Chat Completion for an address, and needs it for the own connection', () => {
    const s = { ...settings(), main_api: 'textgenerationwebui' };
    expect(() => applyCustomApi(s, api({ model: 'm' }), { kind: 'own' })).toThrow(
      'Chat Completion',
    );
    applyCustomApi(s, api({}), address('https://alt.test'));
    expect(s.main_api).toBe('openai');
  });

  it('only changes model and samplers of the own connection', () => {
    const s = settings();
    applyCustomApi(s, api({ source: 'claude', model: 'gpt-x', top_p: 0.5 }), { kind: 'own' });
    const oai = oaiOf(s);
    expect(oai['chat_completion_source']).toBe('openai');
    expect(oai['reverse_proxy']).toBe('https://mine.test/v1');
    expect(oai['openai_model']).toBe('gpt-x');
    expect(oai['top_p_openai']).toBe(0.5);
  });

  it('refuses a source that has no replaceable address', () => {
    expect(() =>
      applyCustomApi(settings(), api({ source: 'vertexai' }), address('https://alt.test')),
    ).toThrow('vertexai');
  });
});

const request = (over: Partial<GenerateRequest> = {}): GenerateRequest =>
  ({
    url: 'https://alt.test/v1/chat/completions',
    headers: {},
    auth_header: null,
    body: { model: 'm', temperature: 1, top_p: 1, max_tokens: 300, messages: [] },
    stream: false,
    format: { kind: 'chat_completion', source: 'openai' },
    ...over,
  }) as GenerateRequest;

describe('editRequest', () => {
  it('leaves unset samplers out of the body', () => {
    const r = request();
    editRequest(r, api({ temperature: 'unset', max_tokens: 'unset' }), 'openai');
    expect(r.body).toEqual({ model: 'm', top_p: 1, messages: [] });
  });

  it('reaches into the Google generation config, and keeps what Claude requires', () => {
    const google = request({ body: { generationConfig: { temperature: 1, topK: 40 } } });
    editRequest(google, api({ temperature: 'unset', top_k: 'unset' }), 'makersuite');
    expect(google.body).toEqual({ generationConfig: {} });
    const claude = request();
    editRequest(claude, api({ max_tokens: 'unset' }), 'claude');
    expect(claude.body).toHaveProperty('max_tokens', 300);
  });

  it('applies body and header edits for the custom source only', () => {
    const edits = {
      custom_include_body: { seed: 7 },
      custom_exclude_body: ['top_p'],
      custom_include_headers: { 'X-Script': 'yes' },
    };
    const custom = request();
    editRequest(custom, api(edits), 'custom');
    expect(custom.body).toEqual({
      model: 'm',
      temperature: 1,
      max_tokens: 300,
      messages: [],
      seed: 7,
    });
    expect(custom.headers).toEqual({ 'X-Script': 'yes' });
    const openai = request();
    editRequest(openai, api(edits), 'openai');
    expect(openai.body).toHaveProperty('top_p', 1);
    expect(openai.headers).toEqual({});
  });
});

describe('isUnder', () => {
  it('accepts the address and paths below it, nothing beside it', () => {
    expect(isUnder('https://alt.test/v1/chat/completions', 'https://alt.test/v1')).toBe(true);
    expect(isUnder('https://alt.test/v1', 'https://alt.test/v1')).toBe(true);
    expect(isUnder('https://alt.test/v10/chat', 'https://alt.test/v1')).toBe(false);
    expect(isUnder('https://alt.test.evil.test/v1/chat', 'https://alt.test/v1')).toBe(false);
    expect(isUnder('http://alt.test/v1/chat', 'https://alt.test/v1')).toBe(false);
  });
});

describe('withScriptKey', () => {
  it('sends the script key as a bearer token and asks the keychain for nothing', () => {
    const out = withScriptKey(request(), SCRIPT_KEY, false);
    expect(out.secret).toEqual({ kind: 'none' });
    expect(out.request.headers).toEqual({ Authorization: `Bearer ${SCRIPT_KEY}` });
    expect(out.request.allow_insecure_http).toBe(false);
  });

  it('uses the header the source names', () => {
    const out = withScriptKey(request({ auth_header: 'x-api-key' }), SCRIPT_KEY, false);
    expect(out.request.headers).toEqual({ 'x-api-key': SCRIPT_KEY });
  });

  it('fills a key placeholder in the address itself', () => {
    const url = 'https://alt.test/v1beta/models/m:generateContent?key={{key}}';
    expect(withScriptKey(request({ url }), 'a b', false).request.url).toBe(
      'https://alt.test/v1beta/models/m:generateContent?key=a%20b',
    );
    expect(withScriptKey(request({ url }), '', false).request.url.endsWith('?key=')).toBe(true);
  });

  it('adds no header without a key', () => {
    expect(withScriptKey(request(), '', true).request).toMatchObject({
      headers: {},
      allow_insecure_http: true,
    });
  });
});

describe('routeRequest', () => {
  const keychain: SecretRef = { kind: 'keyring', key: 'api_key_openai' };
  const built = (secret: SecretRef = keychain) => ({
    request: request(),
    secret,
    source: 'openai',
  });

  it('never lets a keychain secret travel to an address a script chose', () => {
    for (const secret of [keychain, { kind: 'proxy_password', preset: 'Mine' } as SecretRef]) {
      const out = routeRequest(built(secret), api({}), address('https://alt.test/v1'));
      expect(out.secret).toEqual({ kind: 'none' });
    }
  });

  it('refuses a request that would leave the confirmed address', () => {
    expect(() => routeRequest(built(), api({}), address('https://other.test/v1'))).toThrow(
      '不一致',
    );
  });

  it('uses the stored password of a saved proxy preset, at that preset only', () => {
    const preset: CustomTarget = { kind: 'preset', name: 'Mine', url: 'https://alt.test/v1' };
    expect(routeRequest(built(), api({}), preset).secret).toEqual({
      kind: 'proxy_password',
      preset: 'Mine',
    });
    expect(() => routeRequest(built(), api({}), { ...preset, url: 'https://mine.test' })).toThrow(
      '不一致',
    );
  });

  it('keeps the own connection as the pipeline built it', () => {
    const out = routeRequest(built(), api({ temperature: 'unset' }), { kind: 'own' });
    expect(out.secret).toBe(keychain);
    expect(out.request.body).not.toHaveProperty('temperature');
  });
});

describe('a generation sent to a script address', () => {
  const message = (mes: string, isUser: boolean): ChatMessage =>
    ({
      name: isUser ? 'Ann' : 'Mira',
      is_user: isUser,
      is_system: false,
      send_date: '2026-01-01T00:00:00.000Z',
      mes,
      extra: {},
    }) as ChatMessage;
  const character = {
    name: 'Mira',
    avatar: 'Mira.png',
    description: 'Keeps a lighthouse.',
    data: {},
  };

  const send = async (custom: Record<string, unknown>, target: CustomTarget) => {
    const s = settings();
    const parsed = api(custom);
    applyCustomApi(s, parsed, target);
    const prep = await prepareGeneration({
      root: '/data',
      settings: s,
      subject: { character, group: null, members: [], memberIndex: null },
      userName: 'Ann',
      chat: [message('hello', true)],
      chatMetadata: {},
      type: 'normal',
      textareaText: '',
    } as Parameters<typeof prepareGeneration>[0]);
    return { prep, out: routeRequest(prep, parsed, target) };
  };

  it('openai-compatible: the address, the script key, no secret reference', async () => {
    const { prep, out } = await send({ model: 'alt-1' }, address('https://alt.test/v1'));
    // the user's own proxy is selected, so the pipeline itself would have sent its password
    expect(prep.secret.kind).toBe('proxy_password');
    expect(out.secret).toEqual({ kind: 'none' });
    expect(out.request.url).toBe('https://alt.test/v1/chat/completions');
    expect(out.request.headers?.['Authorization']).toBe(`Bearer ${SCRIPT_KEY}`);
    expect((out.request.body as { model: string }).model).toBe('alt-1');
  });

  it('custom source: the address, with the script body and header edits', async () => {
    const { out } = await send(
      { source: 'custom', model: 'alt-1', custom_include_body: { seed: 7 } },
      address('https://alt.test/v1'),
    );
    expect(out.secret).toEqual({ kind: 'none' });
    expect(out.request.url).toBe('https://alt.test/v1/chat/completions');
    expect(out.request.body).toHaveProperty('seed', 7);
    expect(JSON.stringify(out.request)).not.toContain('X-Mine');
  });

  it('claude: the key goes in its own header', async () => {
    const { out } = await send(
      { source: 'claude', model: 'claude-sonnet-4-5' },
      address('https://alt.test'),
    );
    expect(out.secret).toEqual({ kind: 'none' });
    expect(isUnder(out.request.url, 'https://alt.test')).toBe(true);
    expect(out.request.headers?.['x-api-key']).toBe(SCRIPT_KEY);
    expect(out.request.headers).not.toHaveProperty('Authorization');
  });

  it('google: no key placeholder is left for the backend to fill', async () => {
    const { out } = await send(
      { source: 'makersuite', model: 'gemini-2.5-flash' },
      address('https://alt.test'),
    );
    expect(out.secret).toEqual({ kind: 'none' });
    expect(isUnder(out.request.url, 'https://alt.test')).toBe(true);
    expect(out.request.url).toBe(
      `https://alt.test/v1beta/models/gemini-2.5-flash:generateContent?key=${SCRIPT_KEY}`,
    );
  });

  it('a saved proxy preset keeps its own password and address', async () => {
    const { out } = await send(
      { proxy_preset: 'Mine' },
      { kind: 'preset', name: 'Mine', url: 'https://mine.test/v1' },
    );
    expect(out.secret).toEqual({ kind: 'proxy_password', preset: 'Mine' });
    expect(out.request.url).toBe('https://mine.test/v1/chat/completions');
    expect(out.request.headers).not.toHaveProperty('Authorization');
  });
});
