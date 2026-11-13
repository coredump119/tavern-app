/**
 * Chat Completion connection + preset files for the settings pages (DEV_NOTES §9.18).
 * Pure orchestration: @tm/core decides URLs / statuses / what to write, Rust does HTTP and files.
 */
import {
  API_SOURCE_CONFIG,
  TEXTGEN_MODEL_BACKFILL,
  getTextGenServer,
  normalizeTextModels,
  pickTextModel,
  textCompletionAuthHeader,
  textConnectionStatus,
  textModelsEndpoint,
  textStatusResult,
  textgenModelKey,
  textgenSecretKey,
  type TextgenSettings,
  STATUS_NO_CONNECTION,
  canConnectWithoutKey,
  chatConnectionStatus,
  loadOaiSettings,
  modelSettingKey,
  pickChatModel,
  resolveModelsEndpoint,
  sanitizeFilename,
  secretRefFor,
  type GenerationSettings,
  type ModelInfo,
  type OaiSettings,
} from '@tm/core';
import {
  dataDelete,
  dataList,
  dataReadText,
  dataWriteText,
  netFetch,
  netUrlPolicy,
  secretState,
  type SecretRef,
} from './ipc';
import { chatStore } from './chat/store.svelte';

/**
 * ST keeps `model_list` in memory after a connect; image inlining for OpenRouter / Mistral / … needs
 * it (DEV_NOTES §9.30). Written by the connection page, read by the chat page.
 */
export const oaiRuntime = $state<{ source: string; models: ModelInfo[] }>({
  source: '',
  models: [],
});

export const CC_PRESET_DIR = 'OpenAI Settings';

/** `oai_settings` of the loaded settings.json, normalized like ST's loadOpenAISettings. */
export function oaiOf(settings: Record<string, unknown> | null): OaiSettings {
  return loadOaiSettings(settings?.['oai_settings']);
}

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: Record<string, unknown> | null = null;

/** saveSettingsDebounced: merge `patch` into settings.json (whole-object write) after a short delay. */
export function persistSettings(patch: Record<string, unknown>, delay = 400): void {
  pending = { ...(pending ?? {}), ...patch };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushSettings(), delay);
}

export async function flushSettings(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!pending) return;
  const patch = pending;
  pending = null;
  const base = chatStore.settings ? $state.snapshot(chatStore.settings) : {};
  await chatStore.saveSettings({ ...base, ...patch });
}

// ---- preset files (OpenAI Settings/*.json) ----

export async function listCcPresets(root: string): Promise<string[]> {
  return (await dataList(root, CC_PRESET_DIR, 'json')).map((f) => f.replace(/\.json$/i, ''));
}

export async function readCcPreset(root: string, name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await dataReadText(root, `${CC_PRESET_DIR}/${name}.json`)) as Record<
    string,
    unknown
  >;
}

/** `/api/presets/save`: sanitized name, 4-space JSON. Returns the stored name. */
export async function writeCcPreset(
  root: string,
  name: string,
  body: Record<string, unknown>,
): Promise<string> {
  const clean = sanitizeFilename(name);
  if (!clean) throw new Error('预设名无效');
  await dataWriteText(root, `${CC_PRESET_DIR}/${clean}.json`, JSON.stringify(body, null, 4));
  return clean;
}

export async function deleteCcPreset(root: string, name: string): Promise<void> {
  await dataDelete(root, `${CC_PRESET_DIR}/${name}.json`);
}

// ---- connect (onConnectButtonClick → getStatusOpen) ----

export interface ConnectOutcome {
  status: string;
  models: ModelInfo[];
  /** model to write back into `modelSettingKey(source)` (saveModelList's backfill) */
  model?: string | undefined;
  message?: string | undefined;
  /** http to a non-local host: ask the user, then retry with `allowInsecure` */
  needsConfirmUrl?: string | undefined;
}

export async function connectChatCompletion(
  oai: OaiSettings,
  selectedProxyName: string | null,
  opts: { allowInsecure?: boolean } = {},
): Promise<ConnectOutcome> {
  const source = String(oai['chat_completion_source'] ?? '');
  const cfg = API_SOURCE_CONFIG[source];
  if (cfg) {
    const state = await secretState();
    if (!state[cfg.key] && !canConnectWithoutKey(source, String(oai['reverse_proxy'] ?? ''))) {
      return { status: STATUS_NO_CONNECTION, models: [], message: '还没有保存这个来源的密钥' };
    }
  }
  const settings = oai as unknown as GenerationSettings;
  const endpoint = resolveModelsEndpoint(settings);
  if (endpoint.kind !== 'fetch') return { status: endpoint.status, models: [] };
  const policy = await netUrlPolicy(endpoint.url);
  if (!policy.ok && !policy.needs_confirm) {
    return { status: STATUS_NO_CONNECTION, models: [], message: policy.error ?? 'URL 被拒绝' };
  }
  if (policy.needs_confirm && !opts.allowInsecure) {
    return { status: STATUS_NO_CONNECTION, models: [], needsConfirmUrl: endpoint.url };
  }
  const spec = endpoint.secret;
  const secret = secretRefFor(
    {
      secret:
        spec.kind === 'keyring'
          ? { kind: 'keyring', name: spec.name ?? '' }
          : spec.kind === 'proxy_password'
            ? { kind: 'proxy_password' }
            : { kind: 'none' },
    },
    selectedProxyName,
  ) as SecretRef;
  let message: string | undefined;
  let outcome: { ok: boolean; status: number; json: unknown } | null = null;
  try {
    const r = await netFetch(
      {
        url: endpoint.url,
        method: 'GET',
        headers: endpoint.headers,
        auth_header: endpoint.authHeader ?? null,
        allow_insecure_http: policy.needs_confirm,
      },
      secret,
    );
    outcome = { ok: r.ok, status: r.status, json: r.json };
    if (!r.ok) message = `HTTP ${r.status}${r.text ? `：${r.text.slice(0, 200)}` : ''}`;
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  const { status, models } = chatConnectionStatus(source, settings, outcome);
  const key = modelSettingKey(source);
  const model = pickChatModel(source, models, String(oai[key] ?? ''), {
    showExternalModels: !!oai['show_external_models'],
    defaultOpenAiModel: 'gpt-4-turbo',
  });
  return { status, models, model, message };
}

// ---- Text Completion (DEV_NOTES §9.19) ----

export const TC_PRESET_DIR = 'TextGen Settings';
export const TEMPLATE_DIRS = {
  instruct: 'instruct',
  context: 'context',
  sysprompt: 'sysprompt',
} as const;
export type TemplateKind = keyof typeof TEMPLATE_DIRS;

export async function listJsonNames(root: string, dir: string): Promise<string[]> {
  return (await dataList(root, dir, 'json')).map((f) => f.replace(/\.json$/i, ''));
}

export async function readJson(
  root: string,
  dir: string,
  name: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await dataReadText(root, `${dir}/${name}.json`)) as Record<string, unknown>;
}

/** `/api/presets/save` for the textgenerationwebui api: sanitized name, 4-space JSON. */
export async function writeTcPreset(
  root: string,
  name: string,
  body: Record<string, unknown>,
): Promise<string> {
  const clean = sanitizeFilename(name);
  if (!clean) throw new Error('预设名无效');
  await dataWriteText(root, `${TC_PRESET_DIR}/${clean}.json`, JSON.stringify(body, null, 4));
  return clean;
}

export async function deleteTcPreset(root: string, name: string): Promise<void> {
  await dataDelete(root, `${TC_PRESET_DIR}/${name}.json`);
}

/** getStatusTextgen: models endpoint → (probe) → result / backfill / online_status. */
export async function connectTextCompletion(
  tg: TextgenSettings,
  opts: { allowInsecure?: boolean } = {},
): Promise<ConnectOutcome> {
  const type = String(tg.type);
  const server = getTextGenServer(tg);
  const endpoint = textModelsEndpoint(type, server, {
    bypassStatusCheck: !!tg['bypass_status_check'],
  });
  if (!('url' in endpoint)) {
    return {
      status: endpoint.status,
      models: [],
      message: server ? undefined : '先填服务器地址',
    };
  }
  const policy = await netUrlPolicy(endpoint.url);
  if (!policy.ok && !policy.needs_confirm) {
    return { status: STATUS_NO_CONNECTION, models: [], message: policy.error ?? 'URL 被拒绝' };
  }
  if (policy.needs_confirm && !opts.allowInsecure) {
    return { status: STATUS_NO_CONNECTION, models: [], needsConfirmUrl: endpoint.url };
  }
  const key = textgenSecretKey(type);
  const secret: SecretRef = key ? { kind: 'keyring', key } : { kind: 'none' };
  const get = (url: string) =>
    netFetch(
      {
        url,
        method: 'GET',
        headers: endpoint.headers,
        auth_header: textCompletionAuthHeader(type) ?? null,
        allow_insecure_http: policy.needs_confirm,
      },
      secret,
    );
  let models: ModelInfo[] = [];
  let message: string | undefined;
  try {
    const r = await get(endpoint.url);
    const list = r.ok ? normalizeTextModels(type, r.json) : null;
    if (!list) {
      return {
        status: STATUS_NO_CONNECTION,
        models: [],
        message: `HTTP ${r.status}${r.text ? `：${r.text.slice(0, 200)}` : ''}`,
      };
    }
    models = list;
  } catch (e) {
    return {
      status: STATUS_NO_CONNECTION,
      models: [],
      message: e instanceof Error ? e.message : String(e),
    };
  }
  let probe: { ok: boolean; json: unknown } | null = null;
  if (endpoint.probe) {
    try {
      const p = await get(endpoint.probe.url);
      probe = { ok: p.ok, json: p.json };
    } catch {
      probe = { ok: false, json: null };
    }
  }
  const result = textStatusResult(type, models, probe);
  const modelKey = textgenModelKey(type);
  const current = modelKey ? String(tg[modelKey] ?? '') : '';
  const model =
    modelKey && TEXTGEN_MODEL_BACKFILL.includes(type)
      ? pickTextModel(type, models, current)
      : undefined;
  const status = textConnectionStatus(type, model ?? current, result);
  return { status, models, model, message };
}
