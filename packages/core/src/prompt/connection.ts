/**
 * 连接检测与模型列表：
 * - CC：ST 服务端 /api/backends/chat-completions/status 各源的 URL / 头 / 查询参数，响应归一化（含 saveModelList 的过滤与默认模型回填），
 *   前端 getStatusOpen 的 online_status 语义（noValidate 源、bypass、失败）
 * - TC：/api/backends/text-completions/status 各 api_type 的 URL、响应归一化、`result` 与前端 getStatusTextgen 的状态文本 / 默认模型
 * - Kobold：/api/backends/kobold/status 的三个探测 URL 与结果合成
 * 全部纯函数；真正的 HTTP 由宿主（Rust `net_fetch`）完成。
 */
import { TEXTGEN_TYPES } from '../tokens/types.js';
import { CHAT_COMPLETION_SOURCES } from './chat-completion/types.js';
import { API_URLS, SILICONFLOW_ENDPOINT } from './chat-completion/provider-constants.js';
import type { GenerationSettings } from './chat-completion/request.js';
import { textCompletionHeaders, trimV1 } from './text-completion/request.js';

const S = CHAT_COMPLETION_SOURCES;
const T = TEXTGEN_TYPES;

export interface ModelInfo {
  id: string;
  name?: string | undefined;
  raw: Record<string, unknown>;
}

export interface SecretSpec {
  kind: 'keyring' | 'proxy_password' | 'none';
  name?: string | undefined;
}

export interface ModelsEndpoint {
  kind: 'fetch';
  url: string;
  headers: Record<string, string>;
  secret: SecretSpec;
  /** 密钥头；缺省 Authorization: Bearer */
  authHeader?: string | undefined;
  /** 密钥在 url 的 `{{key}}` 占位里（Google） */
  keyInUrl?: boolean | undefined;
}
export interface NoValidateEndpoint {
  kind: 'no_validate';
  /** 直接作为 online_status 显示 */
  status: string;
}
export interface InvalidEndpoint {
  kind: 'invalid';
  status: string;
}

/** ST t`Key saved; press "Test Message" to verify.` */
export const STATUS_KEY_SAVED = 'Key saved; press "Test Message" to verify.';
export const STATUS_VALID = 'Valid';
export const STATUS_BYPASSED = 'Status check bypassed';
export const STATUS_NO_CONNECTION = 'no_connection';
export const STATUS_CONNECTED = 'Connected';

const NO_VALIDATE_SOURCES: readonly string[] = [
  S.CLAUDE,
  S.AI21,
  S.VERTEXAI,
  S.PERPLEXITY,
  S.ZAI,
  S.MINIMAX,
];
const PROXY_STATUS_SOURCES: readonly string[] = [
  S.OPENAI,
  S.MISTRALAI,
  S.DEEPSEEK,
  S.XAI,
  S.MOONSHOT,
  S.MAKERSUITE,
];

function isValidUrl(s: unknown): boolean {
  try {
    new URL(String(s));
    return true;
  } catch {
    return false;
  }
}

/** util.urlJoin：`new URL(path, base)` 风格的拼接（保留 base 路径） */
export function urlJoin(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** 服务端 /chat-completions/status 的 URL 与头；前端 getStatusOpen 的 noValidate / 非法 URL 判定 */
export function resolveModelsEndpoint(
  settings: GenerationSettings,
): ModelsEndpoint | NoValidateEndpoint | InvalidEndpoint {
  const src = settings.chat_completion_source;
  if (NO_VALIDATE_SOURCES.includes(src)) return { kind: 'no_validate', status: STATUS_KEY_SAVED };
  if (src === S.CUSTOM && !isValidUrl(settings.custom_url)) {
    return { kind: 'invalid', status: 'Invalid endpoint URL. Requests may fail.' };
  }
  if (src === S.AZURE_OPENAI && !isValidUrl(settings.azure_base_url)) {
    return { kind: 'invalid', status: 'Invalid Azure endpoint URL. Requests may fail.' };
  }
  const proxy = String(settings.reverse_proxy ?? '');
  const secretFor = (name: string): SecretSpec =>
    proxy && PROXY_STATUS_SOURCES.includes(src)
      ? { kind: 'proxy_password' }
      : { kind: 'keyring', name };
  const fetch = (
    base: string,
    name: string,
    extra: Partial<ModelsEndpoint> = {},
  ): ModelsEndpoint => ({
    kind: 'fetch',
    url: urlJoin(base, '/models'),
    headers: {},
    secret: secretFor(name),
    ...extra,
  });
  const withProxy = (def: string) =>
    new URL(proxy && PROXY_STATUS_SOURCES.includes(src) ? proxy : def).toString();
  switch (src) {
    case S.OPENAI:
      return fetch(withProxy(API_URLS.API_OPENAI), 'api_key_openai');
    case S.OPENROUTER:
      return fetch('https://openrouter.ai/api/v1', 'api_key_openrouter', {
        headers: { 'HTTP-Referer': 'https://sillytavern.app', 'X-Title': 'SillyTavern' },
      });
    case S.MISTRALAI:
      return fetch(withProxy(API_URLS.API_MISTRAL), 'api_key_mistralai');
    case S.CUSTOM:
      return fetch(String(settings.custom_url), 'api_key_custom');
    case S.COHERE:
      return fetch(API_URLS.API_COHERE_V1, 'api_key_cohere');
    case S.CHUTES:
      return fetch(API_URLS.API_CHUTES, 'api_key_chutes');
    case S.ELECTRONHUB:
      return fetch(API_URLS.API_ELECTRONHUB, 'api_key_electronhub');
    case S.NANOGPT:
      return {
        ...fetch(API_URLS.API_NANOGPT, 'api_key_nanogpt'),
        url: `${urlJoin(API_URLS.API_NANOGPT, '/models')}?detailed=true`,
      };
    case S.DEEPSEEK:
      return fetch(withProxy(API_URLS.API_DEEPSEEK.replace('/beta', '')), 'api_key_deepseek');
    case S.XAI:
      return fetch(withProxy(API_URLS.API_XAI), 'api_key_xai');
    case S.AIMLAPI:
      return fetch(API_URLS.API_AIMLAPI, 'api_key_aimlapi', {
        headers: { 'HTTP-Referer': 'https://sillytavern.app', 'X-Title': 'SillyTavern' },
      });
    case S.POLLINATIONS:
      return fetch('https://gen.pollinations.ai/text', 'api_key_pollinations');
    case S.GROQ:
      return fetch(API_URLS.API_GROQ, 'api_key_groq');
    case S.MOONSHOT:
      return fetch(withProxy(API_URLS.API_MOONSHOT), 'api_key_moonshot');
    case S.FIREWORKS:
      return fetch(API_URLS.API_FIREWORKS, 'api_key_fireworks');
    case S.MAKERSUITE: {
      const base = (proxy || API_URLS.API_MAKERSUITE).replace(/\/$/, '');
      return {
        kind: 'fetch',
        url: `${base}/v1beta/models?key={{key}}`,
        headers: {},
        secret: secretFor('api_key_makersuite'),
        keyInUrl: true,
      };
    }
    case S.SILICONFLOW: {
      const base =
        settings['siliconflow_endpoint'] === SILICONFLOW_ENDPOINT.CN
          ? API_URLS.API_SILICONFLOW_CN
          : API_URLS.API_SILICONFLOW;
      return {
        ...fetch(base, 'api_key_siliconflow'),
        url: `${urlJoin(base, '/models')}?type=text&sub_type=chat`,
      };
    }
    case S.WORKERS_AI: {
      const account = String(settings['workers_ai_account_id'] ?? '').trim();
      if (!account) return { kind: 'invalid', status: STATUS_NO_CONNECTION };
      return {
        kind: 'fetch',
        url: `${API_URLS.API_WORKERS_AI}/${encodeURIComponent(account)}/ai/models/search?task=Text+Generation&per_page=1000`,
        headers: {},
        secret: { kind: 'keyring', name: 'api_key_workers_ai' },
      };
    }
    default:
      return { kind: 'invalid', status: STATUS_NO_CONNECTION };
  }
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const toInfo = (m: Record<string, unknown>, id: unknown = m['id']): ModelInfo => ({
  id: String(id ?? ''),
  name: typeof m['name'] === 'string' ? m['name'] : undefined,
  raw: m,
});

/** 服务端对 /models 响应的改写 + 前端 saveModelList 的过滤；返回按 id 排序的列表（saveModelList 会排序） */
export function normalizeChatModels(source: string, json: unknown): ModelInfo[] {
  let list: Record<string, unknown>[] = [];
  const obj = asObj(json);
  switch (source) {
    case S.MAKERSUITE: {
      const models = (obj?.['models'] as Record<string, unknown>[] | undefined) ?? [];
      list = models
        .filter(
          (m) =>
            Array.isArray(m['supportedGenerationMethods']) &&
            (m['supportedGenerationMethods'] as string[]).includes('generateContent'),
        )
        .map((m) => ({ ...m, id: String(m['name']).replace('models/', '') }));
      break;
    }
    case S.POLLINATIONS:
      list = Array.isArray(json)
        ? (json as Record<string, unknown>[]).map((m) => ({ id: m['name'], ...m }))
        : [];
      break;
    case S.COHERE:
      list = ((obj?.['models'] as Record<string, unknown>[] | undefined) ?? []).map((m) => ({
        id: m['name'],
        ...m,
      }));
      break;
    case S.WORKERS_AI:
      list = Array.isArray(obj?.['result'])
        ? (obj!['result'] as Record<string, unknown>[]).map((m) => ({ ...m, id: m['name'] }))
        : [];
      break;
    default:
      list = Array.isArray(obj?.['data']) ? (obj!['data'] as Record<string, unknown>[]) : [];
  }
  let out = list.filter((m) => m && typeof m === 'object').map((m) => toInfo(m));
  out.sort((a, b) => a.id.localeCompare(b.id));
  switch (source) {
    case S.MISTRALAI:
      out = out.filter(
        (m) =>
          !!(m.raw['capabilities'] as { completion_chat?: boolean } | undefined)?.completion_chat,
      );
      break;
    case S.AIMLAPI:
      out = out.filter((m) => m.raw['type'] === 'chat-completion');
      break;
    case S.ELECTRONHUB:
      out = out.filter(
        (m) =>
          Array.isArray(m.raw['endpoints']) &&
          (m.raw['endpoints'] as string[]).includes('/v1/chat/completions'),
      );
      break;
    case S.CHUTES:
      out = out.filter((m) => !m.id.toLowerCase().includes('affine'));
      break;
    default:
      break;
  }
  return out;
}

/** saveModelList 里对当前模型的回填规则；返回应当写回 settings 的模型（undefined = 不改） */
export function pickChatModel(
  source: string,
  models: ModelInfo[],
  current: string,
  options: { showExternalModels?: boolean; defaultOpenAiModel?: string } = {},
): string | undefined {
  const has = models.some((m) => m.id === current);
  switch (source) {
    case S.OPENAI:
      if (options.showExternalModels)
        return has ? current : (options.defaultOpenAiModel ?? 'gpt-4-turbo');
      return undefined;
    case S.CUSTOM:
      return !current && models.length > 0 ? models[0]!.id : undefined;
    case S.AIMLAPI:
      return !current && models.length > 0 ? models[0]!.id : undefined;
    case S.MISTRALAI:
      return has ? undefined : models[0]?.id;
    case S.ELECTRONHUB:
    case S.CHUTES:
      return models.length > 0 && (!has || !current) ? models[0]!.id : undefined;
    default:
      return undefined;
  }
}

export interface FetchOutcome {
  ok: boolean;
  status: number;
  json: unknown;
}

/** getStatusOpen 收到服务端响应后的 online_status（服务端 bypass / error 包装在这里一并处理） */
export function chatConnectionStatus(
  source: string,
  settings: GenerationSettings,
  outcome: FetchOutcome | null,
): { status: string; models: ModelInfo[] } {
  const canBypass =
    (source === S.OPENAI && Boolean(settings['bypass_status_check'])) || source === S.CUSTOM;
  if (!outcome) return { status: canBypass ? STATUS_BYPASSED : STATUS_NO_CONNECTION, models: [] };
  if (!outcome.ok) {
    // 服务端对 makersuite 失败返回 {error:true, bypass:true}（status 200）；其它失败 → 前端 catch → no_connection
    return { status: canBypass ? STATUS_BYPASSED : STATUS_NO_CONNECTION, models: [] };
  }
  const models = normalizeChatModels(source, outcome.json);
  const obj = asObj(outcome.json);
  const hasError = !!obj && 'error' in obj;
  let status = hasError ? (canBypass ? STATUS_BYPASSED : STATUS_NO_CONNECTION) : STATUS_VALID;
  if (canBypass) status = STATUS_BYPASSED;
  return { status, models };
}

// ---------------------------------------------------------------- Text Completion

export interface TextModelsEndpoint {
  url: string;
  headers: Record<string, string>;
  /** 需要先从钥匙串取出密钥再 textCompletionHeaders（宿主做） */
  secret: SecretSpec;
  /** ooba / tabby 的二次探测 */
  probe?: { url: string; field: 'model_name' | 'id' } | undefined;
  bypass?: boolean | undefined;
}

export function textModelsPath(apiType: string): string {
  switch (apiType) {
    case T.DREAMGEN:
      return '/api/openai/v1/models';
    case T.MANCER:
      return '/oai/v1/models';
    case T.TABBY:
      return '/v1/model/list';
    case T.TOGETHERAI:
      return '/api/models?&info';
    case T.OLLAMA:
      return '/api/tags';
    case T.HUGGINGFACE:
      return '/info';
    default:
      return '/v1/models';
  }
}

/** 服务端 /text-completions/status 的 URL 与二次探测；前端 bypass_status_check */
export function textModelsEndpoint(
  apiType: string,
  server: string,
  options: { bypassStatusCheck?: boolean } = {},
): TextModelsEndpoint | NoValidateEndpoint | InvalidEndpoint {
  if (!server) return { kind: 'invalid', status: STATUS_NO_CONNECTION };
  if ((apiType === T.GENERIC || apiType === T.OOBA) && options.bypassStatusCheck)
    return { kind: 'no_validate', status: STATUS_BYPASSED };
  const base = trimV1(
    server.includes('localhost') ? server.replace('localhost', '127.0.0.1') : server,
  );
  const probe =
    apiType === T.OOBA
      ? { url: `${base}/v1/internal/model/info`, field: 'model_name' as const }
      : apiType === T.TABBY
        ? { url: `${base}/v1/model`, field: 'id' as const }
        : undefined;
  return {
    url: `${base}${textModelsPath(apiType)}`,
    headers: textCompletionHeaders(apiType, null),
    secret: { kind: 'keyring', name: `api_key_${apiType}` },
    probe,
  };
}

/** 服务端对各类型响应的改写 → data 数组 */
export function normalizeTextModels(apiType: string, json: unknown): ModelInfo[] | null {
  const obj = asObj(json);
  let data: unknown;
  if (apiType === T.TOGETHERAI && Array.isArray(json))
    data = (json as Record<string, unknown>[]).map((x) => ({ id: x['name'], ...x }));
  else if (apiType === T.OLLAMA && Array.isArray(obj?.['models']))
    data = (obj!['models'] as Record<string, unknown>[]).map((x) => ({ id: x['name'], ...x }));
  else if (apiType === T.HUGGINGFACE) data = [];
  else data = obj?.['data'];
  if (!Array.isArray(data)) return null; // 服务端 400
  return (data as Record<string, unknown>[]).map((m) => toInfo(m));
}

/** 服务端 `result`：modelIds[0] || 'Valid'，ooba / tabby 用探测结果覆盖（tabby 探测失败 → 'None'） */
export function textStatusResult(
  apiType: string,
  models: ModelInfo[],
  probe: { ok: boolean; json: unknown } | null,
): string {
  let result = models[0]?.id || STATUS_VALID;
  if (apiType === T.OOBA && probe?.ok) {
    const name = asObj(probe.json)?.['model_name'];
    if (typeof name === 'string' && name) result = name;
  } else if (apiType === T.TABBY && probe) {
    if (probe.ok) {
      const id = asObj(probe.json)?.['id'];
      if (typeof id === 'string' && id) result = id;
    } else {
      result = 'None';
    }
  }
  return result;
}

/** 前端 load*Models 的默认模型回填（当前模型不在列表里 → 第一项；tabby 列表前置空项） */
export function pickTextModel(apiType: string, models: ModelInfo[], current: string): string {
  const list =
    apiType === T.TABBY
      ? [{ id: '', raw: {} } as ModelInfo, ...[...models].sort((a, b) => a.id.localeCompare(b.id))]
      : models;
  if (list.some((m) => m.id === current)) return current;
  return list[0]?.id ?? '';
}

/** 前端 getStatusTextgen：各类型的 online_status 文本 */
export function textConnectionStatus(
  apiType: string,
  model: string,
  result: string | undefined,
): string {
  switch (apiType) {
    case T.OLLAMA:
      return model || STATUS_CONNECTED;
    case T.TABBY:
      return model || result || STATUS_NO_CONNECTION;
    case T.LLAMACPP:
    case T.GENERIC:
      return model || result || STATUS_CONNECTED;
    case T.MANCER:
    case T.TOGETHERAI:
    case T.INFERMATICAI:
    case T.DREAMGEN:
    case T.OPENROUTER:
    case T.VLLM:
    case T.APHRODITE:
    case T.FEATHERLESS:
      return model || STATUS_NO_CONNECTION;
    default:
      return result || STATUS_NO_CONNECTION;
  }
}

// ---------------------------------------------------------------- Kobold

export function koboldStatusUrls(server: string): {
  version: string;
  cppVersion: string;
  model: string;
} {
  const base = server.includes('localhost') ? server.replace('localhost', '127.0.0.1') : server;
  return {
    version: `${base}/v1/info/version`,
    cppVersion: `${base}/extra/version`,
    model: `${base}/v1/model`,
  };
}

export function koboldStatus(responses: {
  version: unknown | null;
  cppVersion: unknown | null;
  model: unknown | null;
}): { koboldUnitedVersion: string; koboldCppVersion: string; model: string } {
  const v = asObj(responses.version)?.['result'];
  const c = asObj(responses.cppVersion)?.['result'];
  const m = asObj(responses.model)?.['result'];
  return {
    koboldUnitedVersion: typeof v === 'string' ? v : '0.0.0',
    koboldCppVersion: typeof c === 'string' ? c : '0.0',
    model: !responses.model || m === 'ReadOnly' || typeof m !== 'string' ? STATUS_NO_CONNECTION : m,
  };
}
