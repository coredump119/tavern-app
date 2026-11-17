/**
 * Connection profiles (ST's connection-manager extension): a named set of connection choices —
 * API, server address, model, key, reverse proxy — kept in ST's own format under
 * `extension_settings.connectionManager`, so a settings.json moves between the two apps
 * (DEV_NOTES §9.49). Plain data in, plain data out: the app carries a plan out.
 */
import {
  MINIMAX_ENDPOINT,
  SILICONFLOW_ENDPOINT,
  ZAI_ENDPOINT,
} from '../prompt/chat-completion/provider-constants.js';
import { CHAT_COMPLETION_SOURCES as S } from '../prompt/chat-completion/types.js';
import { uuidv4 } from '../tags/index.js';
import { TEXTGEN_TYPES as T } from '../tokens/types.js';
import { POST_PROCESSING_OPTIONS, modelSettingKey, type OaiSettings } from './index.js';
import type { TextgenSettings } from '../prompt/text-completion/request.js';
import { SERVER_URL_TYPES, textgenModelKey } from './textgen.js';

export type ProfileMode = 'cc' | 'tc';

/** One stored profile. Fields this app does not handle stay on it exactly as ST wrote them. */
export interface ConnectionProfile {
  id: string;
  mode: ProfileMode;
  name: string;
  /** fields the user chose to leave out of the profile */
  exclude?: string[];
  [field: string]: unknown;
}

export interface ConnectionProfiles {
  profiles: ConnectionProfile[];
  selectedProfile: string | null;
}

/** The live connection choices a profile is read from and compared with. */
export interface ConnectionState {
  /** `main_api`: 'openai' (Chat Completion) or 'textgenerationwebui' (Text Completion) */
  mainApi: string;
  oai: OaiSettings;
  tg: TextgenSettings;
  /** name of the selected reverse-proxy preset */
  proxyName: string;
  /** id of the key in use for the current API, if it has one */
  secretId: string | null;
}

/** The profile fields this app reads and applies, in ST's order. */
export const PROFILE_FIELDS: Readonly<Record<ProfileMode, readonly string[]>> = {
  cc: ['api', 'api-url', 'model', 'proxy', 'prompt-post-processing', 'secret-id'],
  tc: ['api', 'api-url', 'model', 'secret-id'],
};

/** ST's fields that exist in one mode only: dropped when a profile is re-saved in the other mode. */
const MODE_ONLY: Readonly<Record<ProfileMode, readonly string[]>> = {
  cc: ['proxy', 'prompt-post-processing'],
  tc: ['sysprompt', 'sysprompt-state', 'instruct', 'context', 'instruct-state', 'tokenizer'],
};

const VERTEXAI_DEFAULT_REGION = 'us-central1';
const CC_SOURCES: ReadonlySet<string> = new Set(Object.values(S));
const TC_TYPES: ReadonlySet<string> = new Set(Object.values(T));
/** ST `CONNECT_API_MAP` names that differ from the source / type they stand for */
const CC_ALIASES: Readonly<Record<string, string>> = { oai: S.OPENAI, google: S.MAKERSUITE };
const TC_ALIASES: Readonly<Record<string, string>> = {
  kcpp: T.KOBOLDCPP,
  'openrouter-text': T.OPENROUTER,
};
/** endpoint choices of the sources whose "address" is a pick from a short list */
const ENDPOINT_FIELDS: Readonly<Record<string, { key: string; values: readonly string[] }>> = {
  [S.ZAI]: { key: 'zai_endpoint', values: Object.values(ZAI_ENDPOINT) },
  [S.SILICONFLOW]: { key: 'siliconflow_endpoint', values: Object.values(SILICONFLOW_ENDPOINT) },
  [S.MINIMAX]: { key: 'minimax_endpoint', values: Object.values(MINIMAX_ENDPOINT) },
};

const modeOf = (mainApi: string): ProfileMode => (mainApi === 'openai' ? 'cc' : 'tc');
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** What ST's `/api` returns for the current API: the name a profile stores. */
export function profileApiName(mode: ProfileMode, sourceOrType: string): string {
  if (mode === 'cc') return sourceOrType === S.MAKERSUITE ? 'google' : sourceOrType;
  return sourceOrType === T.OPENROUTER ? 'openrouter-text' : sourceOrType;
}

/** A profile's `api` name back to a Chat Completion source or a Text Completion type. */
export function resolveProfileApi(
  name: string,
): { mode: 'cc'; source: string } | { mode: 'tc'; type: string } | null {
  const key = name.trim().toLowerCase();
  const tcAlias = TC_ALIASES[key];
  if (tcAlias) return { mode: 'tc', type: tcAlias };
  const source = CC_ALIASES[key] ?? key;
  if (CC_SOURCES.has(source)) return { mode: 'cc', source };
  if (TC_TYPES.has(key)) return { mode: 'tc', type: key };
  return null;
}

/** The current choices as profile fields (ST `readProfileFromCommands`); empty ones are left out. */
export function readProfileFields(state: ConnectionState): {
  mode: ProfileMode;
  fields: Record<string, string>;
} {
  const mode = modeOf(state.mainApi);
  const all: Record<string, string> = {};
  if (mode === 'cc') {
    const source = text(state.oai['chat_completion_source']) || S.OPENAI;
    const endpoint = ENDPOINT_FIELDS[source];
    all['api'] = profileApiName('cc', source);
    all['api-url'] =
      source === S.CUSTOM
        ? text(state.oai['custom_url'])
        : source === S.VERTEXAI
          ? text(state.oai['vertexai_region']) || VERTEXAI_DEFAULT_REGION
          : endpoint
            ? text(state.oai[endpoint.key]) || endpoint.values[0]!
            : '';
    all['model'] = text(state.oai[modelSettingKey(source)]);
    all['proxy'] = state.proxyName;
    all['prompt-post-processing'] = text(state.oai['custom_prompt_post_processing']) || 'none';
  } else {
    const type = String(state.tg.type);
    const modelKey = textgenModelKey(type);
    all['api'] = profileApiName('tc', type);
    all['api-url'] = SERVER_URL_TYPES.includes(type) ? text(state.tg.server_urls[type]) : '';
    all['model'] = modelKey ? text(state.tg[modelKey]) : '';
  }
  all['secret-id'] = state.secretId ?? '';
  const fields: Record<string, string> = {};
  for (const name of PROFILE_FIELDS[mode]) if (all[name]) fields[name] = all[name];
  return { mode, fields };
}

/** Tolerant read of `extension_settings.connectionManager`; entries without an id are dropped. */
export function loadConnectionProfiles(raw: unknown): ConnectionProfiles {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(data['profiles']) ? data['profiles'] : [];
  const profiles: ConnectionProfile[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const profile = entry as Record<string, unknown>;
    if (typeof profile['id'] !== 'string' || !profile['id']) continue;
    profiles.push({
      ...profile,
      id: profile['id'],
      mode: profile['mode'] === 'tc' ? 'tc' : 'cc',
      name: text(profile['name']) || profile['id'],
    });
  }
  const selected = data['selectedProfile'];
  return {
    profiles,
    selectedProfile:
      typeof selected === 'string' && profiles.some((p) => p.id === selected) ? selected : null,
  };
}

/** A new profile holding the current choices (ST `createConnectionProfile`). */
export function createConnectionProfile(
  name: string,
  state: ConnectionState,
  uuid: () => string = uuidv4,
): ConnectionProfile {
  const { mode, fields } = readProfileFields(state);
  return { id: uuid(), mode, exclude: [], ...fields, name };
}

/**
 * The profile re-read from the current choices (ST `updateConnectionProfile`). Excluded fields and
 * the ones this app does not handle keep their stored value; a handled field that is now empty is
 * removed, so the profile says what the page shows.
 */
export function updateConnectionProfile(
  profile: ConnectionProfile,
  state: ConnectionState,
): ConnectionProfile {
  const { mode, fields } = readProfileFields(state);
  const excluded = new Set(profile.exclude ?? []);
  const next: ConnectionProfile = { ...profile, mode };
  for (const name of PROFILE_FIELDS[mode]) {
    if (excluded.has(name)) continue;
    if (fields[name]) next[name] = fields[name];
    else delete next[name];
  }
  for (const name of MODE_ONLY[mode === 'cc' ? 'tc' : 'cc']) delete next[name];
  return next;
}

/** Does the profile still say what the current choices are? (the "edited since" mark) */
export function connectionProfileMatches(
  profile: ConnectionProfile,
  state: ConnectionState,
): boolean {
  const { mode, fields } = readProfileFields(state);
  if (profile.mode !== mode) return false;
  const excluded = new Set(profile.exclude ?? []);
  return PROFILE_FIELDS[mode].every((name) => {
    if (excluded.has(name)) return true;
    let stored = text(profile[name]);
    if (name === 'api' && stored) {
      const api = resolveProfileApi(stored);
      if (api) stored = profileApiName(api.mode, api.mode === 'cc' ? api.source : api.type);
    }
    return stored === (fields[name] ?? '');
  });
}

/** What applying a profile changes. `null` members mean "leave as it is". */
export interface ProfilePlan {
  mainApi: string;
  /** `oai_settings` keys to set */
  oai: Record<string, unknown>;
  /** `textgenerationwebui_settings` keys to set */
  tg: Record<string, unknown>;
  /** reverse-proxy preset to select */
  proxy: string | null;
  /** id (or name) of the key to switch to */
  secret: string | null;
  /** fields that could not be applied */
  skipped: string[];
}

/**
 * ST `applyConnectionProfile` as a plan: each stored field, in ST's order, becomes a settings
 * change. A field with no value is skipped, as ST does.
 */
export function planConnectionProfile(
  profile: ConnectionProfile,
  state: ConnectionState,
  proxies: ReadonlyArray<{ name: string; url: string }>,
): ProfilePlan {
  const plan: ProfilePlan = {
    mainApi: state.mainApi,
    oai: {},
    tg: {},
    proxy: null,
    secret: null,
    skipped: [],
  };
  const value = (name: string) => text(profile[name]).trim();
  let source = text(state.oai['chat_completion_source']) || S.OPENAI;
  let type = String(state.tg.type);

  const apiName = value('api');
  if (apiName) {
    const api = resolveProfileApi(apiName);
    if (!api) plan.skipped.push('api');
    else if (api.mode === 'cc') {
      plan.mainApi = 'openai';
      plan.oai['chat_completion_source'] = source = api.source;
    } else {
      plan.mainApi = 'textgenerationwebui';
      plan.tg['type'] = type = api.type;
    }
  }
  const cc = modeOf(plan.mainApi) === 'cc';

  const url = value('api-url');
  if (url) {
    const endpoint = ENDPOINT_FIELDS[source];
    if (!cc) {
      if (SERVER_URL_TYPES.includes(type))
        plan.tg['server_urls'] = { ...state.tg.server_urls, [type]: url };
      else plan.skipped.push('api-url');
    } else if (source === S.CUSTOM) plan.oai['custom_url'] = url;
    else if (source === S.VERTEXAI) plan.oai['vertexai_region'] = url;
    else if (endpoint?.values.includes(url)) plan.oai[endpoint.key] = url;
    else plan.skipped.push('api-url');
  }

  const model = value('model');
  if (model) {
    const modelKey = cc ? modelSettingKey(source) : textgenModelKey(type);
    if (!modelKey) plan.skipped.push('model');
    else if (cc) plan.oai[modelKey] = model;
    else plan.tg[modelKey] = model;
  }

  if (cc) {
    const proxyName = value('proxy');
    if (proxyName) {
      const wanted = proxyName.toLowerCase();
      const proxy =
        proxies.find((p) => p.name === proxyName) ??
        proxies.find((p) => p.name.toLowerCase() === wanted);
      if (proxy) {
        plan.proxy = proxy.name;
        plan.oai['reverse_proxy'] = proxy.url;
      } else plan.skipped.push('proxy');
    }
    const post = value('prompt-post-processing').toLowerCase();
    if (post) {
      const stored = post === 'none' ? '' : post;
      if (POST_PROCESSING_OPTIONS.some((o) => o.value === stored))
        plan.oai['custom_prompt_post_processing'] = stored;
      else plan.skipped.push('prompt-post-processing');
    }
  }

  const secret = value('secret-id');
  if (secret) plan.secret = secret;
  return plan;
}

/** Is the name used by another profile? `<None>` is ST's own entry for "no profile". */
export function profileNameTaken(
  profiles: readonly ConnectionProfile[],
  name: string,
  exceptId?: string,
): boolean {
  return name === '<None>' || profiles.some((p) => p.name === name && p.id !== exceptId);
}

/** A free name to offer for a new profile: where it connects to, then the model. */
export function suggestProfileName(
  state: ConnectionState,
  profiles: readonly ConnectionProfile[],
): string {
  const { fields } = readProfileFields(state);
  let place = fields['api'] ?? '';
  try {
    if (fields['api-url']?.includes('://')) place = new URL(fields['api-url']).hostname || place;
  } catch {
    // not an address: keep the API name
  }
  const base = `${place} ${fields['model'] ?? ''}`.replace(/\s+/g, ' ').trim() || '连接配置';
  let name = base;
  for (let n = 2; profileNameTaken(profiles, name); n += 1) name = `${base} ${n}`;
  return name;
}
