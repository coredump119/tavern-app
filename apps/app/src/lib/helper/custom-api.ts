/**
 * TavernHelper `custom_api`: a script chooses where one generation goes (DEV_NOTES §9.5 第 3 轮).
 * Pure helpers; asking the user and sending live in `generate.svelte.ts`.
 *
 * The rule this file enforces: a request to an address a script chose carries the key the script
 * gave and nothing from the keychain (`withScriptKey` always returns `secret: none`).
 */
import { modelSettingKey } from '@tm/core';
import type { GenerateRequest, SecretRef } from '../ipc';

type Settings = Record<string, unknown>;

const SAMPLERS = {
  max_tokens: 'openai_max_tokens',
  temperature: 'temp_openai',
  frequency_penalty: 'freq_pen_openai',
  presence_penalty: 'pres_pen_openai',
  top_p: 'top_p_openai',
  top_k: 'top_k_openai',
} as const;
type Sampler = keyof typeof SAMPLERS;
const SAMPLER_NAMES = Object.keys(SAMPLERS) as Sampler[];

/** request body keys of a sampler: OpenAI-compatible / Claude at the root, Google in `generationConfig` */
const BODY_KEYS: Record<Sampler, readonly string[]> = {
  max_tokens: ['max_tokens', 'max_completion_tokens', 'maxOutputTokens'],
  temperature: ['temperature'],
  frequency_penalty: ['frequency_penalty', 'frequencyPenalty'],
  presence_penalty: ['presence_penalty', 'presencePenalty'],
  top_p: ['top_p', 'topP'],
  top_k: ['top_k', 'topK'],
};

/** sources whose address a script may replace: `reverse_proxy` reaches them, or they are `custom` */
const ADDRESSABLE: readonly string[] = [
  'openai',
  'custom',
  'claude',
  'makersuite',
  'mistralai',
  'deepseek',
  'xai',
  'zai',
  'moonshot',
];

/** `oai_settings` fields written for the user's own endpoint; never sent to another one */
const OWN_ENDPOINT_FIELDS = [
  'proxy_password',
  'custom_include_body',
  'custom_exclude_body',
  'custom_include_headers',
] as const;

export interface CustomApi {
  /** '' when the script gave none */
  apiurl: string;
  key: string;
  model: string;
  source: string;
  proxyPreset: string;
  /** a number to set; samplers the script left to the preset are absent */
  set: Partial<Record<Sampler, number>>;
  /** samplers to leave out of the request body */
  unset: Sampler[];
  includeBody: Record<string, unknown>;
  excludeBody: string[];
  includeHeaders: Record<string, string>;
}

/** Where a `custom_api` generation goes */
export type CustomTarget =
  | { kind: 'own' }
  | { kind: 'preset'; name: string; url: string }
  | { kind: 'address'; url: string; key: string; insecure: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export function parseCustomApi(value: unknown): CustomApi | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error('custom_api 必须是对象');
  const api: CustomApi = {
    apiurl: text(value['apiurl']),
    key: text(value['key']),
    model: text(value['model']),
    source: text(value['source']) || 'openai',
    proxyPreset: text(value['proxy_preset']),
    set: {},
    unset: [],
    includeBody: isRecord(value['custom_include_body']) ? value['custom_include_body'] : {},
    excludeBody: Array.isArray(value['custom_exclude_body'])
      ? value['custom_exclude_body'].filter((k): k is string => typeof k === 'string')
      : [],
    includeHeaders: {},
  };
  for (const name of SAMPLER_NAMES) {
    const wanted = value[name];
    if (wanted === 'unset') api.unset.push(name);
    else if (typeof wanted === 'number' && Number.isFinite(wanted)) api.set[name] = wanted;
    else if (wanted !== undefined && wanted !== 'same_as_preset')
      throw new Error(`custom_api.${name} 只接受数字、'same_as_preset' 或 'unset'`);
  }
  if (isRecord(value['custom_include_headers'])) {
    for (const [name, header] of Object.entries(value['custom_include_headers'])) {
      api.includeHeaders[name] = String(header);
    }
  }
  return api;
}

/**
 * The address the user is asked about and that is remembered once allowed: origin + path, no
 * trailing slash. Throws for anything that is not a plain http(s) address.
 */
export function scriptAddress(apiurl: string, field = 'custom_api.apiurl'): string {
  let url: URL;
  try {
    url = new URL(apiurl);
  } catch {
    throw new Error(`${field} 不是有效的地址：${apiurl}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`${field} 只能是 http(s) 地址`);
  // nothing may hide in the address the user reads
  if (url.username || url.password) throw new Error(`${field} 不能带用户名或密码`);
  if (url.search || url.hash) throw new Error(`${field} 不能带 ? 或 # 部分`);
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** `from` of a request an ST extension makes through the host's routes (DEV_NOTES §9.34 第 6 轮) */
export const EXTENSION_ASKER = 'extension';

/** Who asks, from the frame name the bridge passes (`TH-message--<楼层>--<n>` / `TH-script--<名字>--<id>`) */
export function askerLabel(from: string): string {
  if (from === EXTENSION_ASKER) return '一个扩展';
  const message = /^TH-message--(\d+)--/.exec(from);
  if (message) return `第 ${message[1]} 楼的卡片`;
  const script = /^TH-script--(.*)--[^-]*$/.exec(from);
  if (script?.[1]) return `脚本「${script[1]}」`;
  return '一个脚本';
}

/** The dialog shown the first time a script names an address */
export function confirmRequest(
  from: string,
  address: string,
  insecure: boolean,
): { title: string; text: string; okButton: string; cancelButton: string } {
  const extension = from === EXTENSION_ASKER;
  const lines = [
    `${askerLabel(from)}想把提示词发到下面这个地址，而不是你在「API 连接」里设置的服务：`,
    address,
    extension
      ? '发什么由扩展决定，可能包括角色卡、世界书和聊天记录。请求只带扩展自己提供的密钥，你保存的密钥不会发过去。'
      : '发过去的是完整的提示词，包括角色卡、世界书和聊天记录。请求只带脚本自己提供的密钥，你保存的密钥不会发过去。',
    ...(insecure ? ['注意：这是未加密的 http 地址，内容会以明文在网络上传输。'] : []),
    '同意后，本次运行期间发往这个地址的请求不再询问。',
  ];
  return {
    title: extension ? '扩展想把提示词发到别的地址' : '脚本想把提示词发到别的地址',
    text: lines.join('\n\n'),
    okButton: '允许发送',
    cancelButton: '拒绝',
  };
}

/** Point the cloned settings of one generation at the script's target and apply its overrides */
export function applyCustomApi(settings: Settings, api: CustomApi, target: CustomTarget): void {
  const oai = settings['oai_settings'];
  if (!isRecord(oai)) throw new Error('settings.json 里没有 oai_settings');
  if (target.kind !== 'own') {
    if (!ADDRESSABLE.includes(api.source))
      throw new Error(`custom_api.source「${api.source}」不能指定地址`);
    settings['main_api'] = 'openai';
    oai['chat_completion_source'] = api.source;
    oai[api.source === 'custom' ? 'custom_url' : 'reverse_proxy'] = target.url;
    // what the user set up for their own endpoint (it may hold credentials) stays with that endpoint
    for (const own of OWN_ENDPOINT_FIELDS) oai[own] = '';
    // the secret of a preset is looked up by this name; an address gets none (`withScriptKey`)
    if (target.kind === 'preset') settings['selected_proxy'] = { name: target.name };
  } else if (settings['main_api'] !== 'openai') {
    throw new Error('custom_api 只支持 Chat Completion');
  }
  const source = String(oai['chat_completion_source'] ?? '');
  if (api.model) oai[modelSettingKey(source)] = api.model;
  for (const name of SAMPLER_NAMES) {
    const value = api.set[name];
    if (value !== undefined) oai[SAMPLERS[name]] = value;
  }
}

function dropSamplers(body: Record<string, unknown>, api: CustomApi, source: string): void {
  const config = body['generationConfig'];
  for (const name of api.unset) {
    // Claude refuses a request without max_tokens
    if (name === 'max_tokens' && source === 'claude') continue;
    for (const key of BODY_KEYS[name]) {
      delete body[key];
      if (isRecord(config)) delete config[key];
    }
  }
}

/** The script's last word on the built request: unset samplers, and for `custom` its body / header edits */
export function editRequest(request: GenerateRequest, api: CustomApi, source: string): void {
  if (!isRecord(request.body)) return;
  dropSamplers(request.body, api, source);
  if (source !== 'custom') return;
  Object.assign(request.body, api.includeBody);
  for (const key of api.excludeBody) delete request.body[key];
  request.headers = { ...request.headers, ...api.includeHeaders };
}

/** Is `url` the address itself or something under it? */
export function isUnder(url: string, address: string): boolean {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url.replace('{{key}}', ''));
    base = new URL(address);
  } catch {
    return false;
  }
  const path = base.pathname.replace(/\/+$/, '');
  return (
    target.origin === base.origin &&
    (target.pathname === path || target.pathname.startsWith(`${path}/`))
  );
}

/**
 * A request to an address the script chose: the script's own key goes where the keychain key would
 * have gone, and the secret reference becomes `none`, so the backend attaches nothing of the user's.
 */
export function withScriptKey(
  request: GenerateRequest,
  key: string,
  insecure: boolean,
): { request: GenerateRequest; secret: SecretRef } {
  const headers = { ...request.headers };
  let url = request.url;
  if (url.includes('{{key}}')) {
    // Google keeps the key in the query; the backend refuses to fill it without a secret
    url = url.replace('{{key}}', encodeURIComponent(key));
  } else if (key) {
    const names = (request.auth_header ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    // same rule as the backend's own key: `bearer` (or no name) is Authorization, others take it raw
    const hasAuthorization = Object.keys(headers).some((h) => h.toLowerCase() === 'authorization');
    for (const name of names.length > 0 ? names : ['bearer']) {
      if (name.toLowerCase() !== 'bearer') headers[name] = key;
      else if (!hasAuthorization) headers['Authorization'] = `Bearer ${key}`;
    }
  }
  return {
    request: { ...request, url, headers, allow_insecure_http: insecure },
    secret: { kind: 'none' },
  };
}

/**
 * The request and secret that actually go out for a `custom_api` generation. `secret` is the one the
 * pipeline chose for the user's own connection: it survives only when the target is that connection.
 */
export function routeRequest(
  built: { request: GenerateRequest; secret: SecretRef; source: string },
  api: CustomApi,
  target: CustomTarget,
): { request: GenerateRequest; secret: SecretRef } {
  editRequest(built.request, api, built.source);
  if (target.kind === 'own') return { request: built.request, secret: built.secret };
  // the address the user agreed to (or saved) is the only place this request may go
  if (!isUnder(built.request.url, target.url))
    throw new Error('custom_api 的请求地址和确认过的地址不一致');
  if (target.kind === 'preset')
    return { request: built.request, secret: { kind: 'proxy_password', preset: target.name } };
  return withScriptKey(built.request, target.key, target.insecure);
}
