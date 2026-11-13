/**
 * Chat Completion settings & presets (ST openai.js), ported as data + pure functions
 * (DEV_NOTES §9.18): `settingsToUpdate`, `default_settings`, preset ⇄ `oai_settings`
 * (`getChatCompletionPreset` / `onSettingsPresetChange`), settings migration, reverse-proxy
 * presets, per-source connect config, the static model lists of ST's dropdowns and the
 * sampler slider ranges of ST's panel.
 */
import {
  CHARACTER_NAMES_BEHAVIOR,
  CHAT_COMPLETION_SOURCES,
  CONTINUE_POSTFIX_TYPES,
  DEFAULT_CONTINUE_NUDGE_PROMPT,
  DEFAULT_GROUP_NUDGE_PROMPT,
  DEFAULT_IMPERSONATION_PROMPT,
  DEFAULT_NEW_CHAT_PROMPT,
  DEFAULT_NEW_EXAMPLE_CHAT_PROMPT,
  DEFAULT_NEW_GROUP_CHAT_PROMPT,
  DEFAULT_PERSONALITY_FORMAT,
  DEFAULT_SCENARIO_FORMAT,
  DEFAULT_WI_FORMAT,
  chatCompletionDefaultPrompts,
} from '../prompt/chat-completion/types.js';
import {
  MINIMAX_ENDPOINT,
  SILICONFLOW_ENDPOINT,
  ZAI_ENDPOINT,
} from '../prompt/chat-completion/provider-constants.js';

const S = CHAT_COMPLETION_SOURCES;

export const MAX_CONTEXT = {
  max_2k: 2047,
  max_4k: 4095,
  max_8k: 8191,
  max_16k: 16383,
  max_32k: 32767,
  max_64k: 65535,
  max_128k: 128 * 1000,
  max_200k: 200 * 1000,
  max_256k: 256 * 1000,
  max_1mil: 1000 * 1000,
  max_2mil: 2000 * 1000,
  unlocked_max: 2000 * 1000,
  oai_max_temp: 2.0,
  claude_max_temp: 1.0,
} as const;

export const OPENROUTER_WEBSITE_MODEL = 'OR_Website';
export const DEFAULT_BIAS = 'Default (none)';

/** `[presetKey, oaiSettingsKey, isCheckbox, isConnection]` — openai.js `settingsToUpdate` (selectors dropped) */
export const CC_PRESET_FIELDS: ReadonlyArray<readonly [string, string, boolean, boolean]> = [
  ['chat_completion_source', 'chat_completion_source', false, true],
  ['temperature', 'temp_openai', false, false],
  ['frequency_penalty', 'freq_pen_openai', false, false],
  ['presence_penalty', 'pres_pen_openai', false, false],
  ['top_p', 'top_p_openai', false, false],
  ['top_k', 'top_k_openai', false, false],
  ['top_a', 'top_a_openai', false, false],
  ['min_p', 'min_p_openai', false, false],
  ['repetition_penalty', 'repetition_penalty_openai', false, false],
  ['max_context_unlocked', 'max_context_unlocked', true, false],
  ['group_models', 'group_models', true, true],
  ['sort_models', 'sort_models', false, true],
  ['openai_model', 'openai_model', false, true],
  ['claude_model', 'claude_model', false, true],
  ['openrouter_model', 'openrouter_model', false, true],
  ['openrouter_use_fallback', 'openrouter_use_fallback', true, true],
  ['openrouter_providers', 'openrouter_providers', false, true],
  ['openrouter_quantizations', 'openrouter_quantizations', false, true],
  ['openrouter_allow_fallbacks', 'openrouter_allow_fallbacks', true, true],
  ['openrouter_middleout', 'openrouter_middleout', false, true],
  ['tool_reasoning_mode', 'tool_reasoning_mode', false, false],
  ['ai21_model', 'ai21_model', false, true],
  ['mistralai_model', 'mistralai_model', false, true],
  ['cohere_model', 'cohere_model', false, true],
  ['perplexity_model', 'perplexity_model', false, true],
  ['groq_model', 'groq_model', false, true],
  ['chutes_model', 'chutes_model', false, true],
  ['siliconflow_model', 'siliconflow_model', false, true],
  ['siliconflow_endpoint', 'siliconflow_endpoint', false, true],
  ['minimax_model', 'minimax_model', false, true],
  ['minimax_endpoint', 'minimax_endpoint', false, true],
  ['electronhub_model', 'electronhub_model', false, true],
  ['nanogpt_model', 'nanogpt_model', false, true],
  ['nanogpt_provider', 'nanogpt_provider', false, true],
  ['nanogpt_payg_override', 'nanogpt_payg_override', true, true],
  ['deepseek_model', 'deepseek_model', false, true],
  ['aimlapi_model', 'aimlapi_model', false, true],
  ['xai_model', 'xai_model', false, true],
  ['pollinations_model', 'pollinations_model', false, true],
  ['moonshot_model', 'moonshot_model', false, true],
  ['fireworks_model', 'fireworks_model', false, true],
  ['cometapi_model', 'cometapi_model', false, true],
  ['custom_model', 'custom_model', false, true],
  ['custom_url', 'custom_url', false, true],
  ['custom_include_body', 'custom_include_body', false, true],
  ['custom_exclude_body', 'custom_exclude_body', false, true],
  ['custom_include_headers', 'custom_include_headers', false, true],
  ['custom_prompt_post_processing', 'custom_prompt_post_processing', false, true],
  ['google_model', 'google_model', false, true],
  ['vertexai_model', 'vertexai_model', false, true],
  ['zai_model', 'zai_model', false, true],
  ['zai_endpoint', 'zai_endpoint', false, true],
  ['workers_ai_model', 'workers_ai_model', false, true],
  ['workers_ai_account_id', 'workers_ai_account_id', false, true],
  ['openai_max_context', 'openai_max_context', false, false],
  ['openai_max_tokens', 'openai_max_tokens', false, false],
  ['names_behavior', 'names_behavior', false, false],
  ['send_if_empty', 'send_if_empty', false, false],
  ['impersonation_prompt', 'impersonation_prompt', false, false],
  ['new_chat_prompt', 'new_chat_prompt', false, false],
  ['new_group_chat_prompt', 'new_group_chat_prompt', false, false],
  ['new_example_chat_prompt', 'new_example_chat_prompt', false, false],
  ['continue_nudge_prompt', 'continue_nudge_prompt', false, false],
  ['bias_preset_selected', 'bias_preset_selected', false, false],
  ['reverse_proxy', 'reverse_proxy', false, true],
  ['wi_format', 'wi_format', false, false],
  ['scenario_format', 'scenario_format', false, false],
  ['personality_format', 'personality_format', false, false],
  ['group_nudge_prompt', 'group_nudge_prompt', false, false],
  ['stream_openai', 'stream_openai', true, false],
  ['prompts', 'prompts', false, false],
  ['prompt_order', 'prompt_order', false, false],
  ['show_external_models', 'show_external_models', true, true],
  ['proxy_password', 'proxy_password', false, true],
  ['assistant_prefill', 'assistant_prefill', false, false],
  ['assistant_impersonation', 'assistant_impersonation', false, false],
  ['use_sysprompt', 'use_sysprompt', true, false],
  ['vertexai_auth_mode', 'vertexai_auth_mode', false, true],
  ['vertexai_region', 'vertexai_region', false, true],
  ['vertexai_express_project_id', 'vertexai_express_project_id', false, true],
  ['squash_system_messages', 'squash_system_messages', true, false],
  ['media_inlining', 'media_inlining', true, false],
  ['inline_image_quality', 'inline_image_quality', false, false],
  ['continue_prefill', 'continue_prefill', true, false],
  ['continue_postfix', 'continue_postfix', false, false],
  ['function_calling', 'function_calling', true, false],
  ['tool_call_recurse_limit', 'tool_call_recurse_limit', false, false],
  ['show_thoughts', 'show_thoughts', true, false],
  ['reasoning_effort', 'reasoning_effort', false, false],
  ['verbosity', 'verbosity', false, false],
  ['enable_web_search', 'enable_web_search', true, false],
  ['seed', 'seed', false, false],
  ['n', 'n', false, false],
  ['bypass_status_check', 'bypass_status_check', true, true],
  ['request_images', 'request_images', true, false],
  ['request_image_aspect_ratio', 'request_image_aspect_ratio', false, false],
  ['request_image_resolution', 'request_image_resolution', false, false],
  ['azure_base_url', 'azure_base_url', false, true],
  ['azure_deployment_name', 'azure_deployment_name', false, true],
  ['azure_api_version', 'azure_api_version', false, true],
  ['azure_openai_model', 'azure_openai_model', false, true],
  ['extensions', 'extensions', false, false],
];

export type OaiSettings = Record<string, unknown>;

/** openai.js `default_settings` (prompt_order is empty: PromptManager adds the dummy order on first use) */
export function defaultOaiSettings(): OaiSettings {
  return {
    preset_settings_openai: 'Default',
    temp_openai: 1.0,
    freq_pen_openai: 0,
    pres_pen_openai: 0,
    top_p_openai: 1.0,
    top_k_openai: 0,
    min_p_openai: 0,
    top_a_openai: 0,
    repetition_penalty_openai: 1,
    stream_openai: false,
    openai_max_context: MAX_CONTEXT.max_4k,
    openai_max_tokens: 300,
    prompts: structuredClone(chatCompletionDefaultPrompts),
    prompt_order: [],
    send_if_empty: '',
    impersonation_prompt: DEFAULT_IMPERSONATION_PROMPT,
    new_chat_prompt: DEFAULT_NEW_CHAT_PROMPT,
    new_group_chat_prompt: DEFAULT_NEW_GROUP_CHAT_PROMPT,
    new_example_chat_prompt: DEFAULT_NEW_EXAMPLE_CHAT_PROMPT,
    continue_nudge_prompt: DEFAULT_CONTINUE_NUDGE_PROMPT,
    bias_preset_selected: DEFAULT_BIAS,
    bias_presets: { [DEFAULT_BIAS]: [] },
    wi_format: DEFAULT_WI_FORMAT,
    group_nudge_prompt: DEFAULT_GROUP_NUDGE_PROMPT,
    scenario_format: DEFAULT_SCENARIO_FORMAT,
    personality_format: DEFAULT_PERSONALITY_FORMAT,
    sort_models: 'alphabetically',
    group_models: false,
    openai_model: 'gpt-4-turbo',
    claude_model: 'claude-sonnet-4-5',
    google_model: 'gemini-2.5-pro',
    vertexai_model: 'gemini-2.5-pro',
    ai21_model: 'jamba-large',
    mistralai_model: 'mistral-large-latest',
    cohere_model: 'command-r-plus',
    perplexity_model: 'sonar-pro',
    groq_model: 'llama-3.3-70b-versatile',
    chutes_model: 'deepseek-ai/DeepSeek-V3-0324',
    siliconflow_model: 'deepseek-ai/DeepSeek-V3',
    siliconflow_endpoint: SILICONFLOW_ENDPOINT.GLOBAL,
    minimax_model: 'MiniMax-M2.7',
    minimax_endpoint: MINIMAX_ENDPOINT.GLOBAL,
    electronhub_model: 'gpt-4o-mini',
    nanogpt_model: 'gpt-4o-mini',
    nanogpt_provider: '',
    nanogpt_payg_override: false,
    deepseek_model: 'deepseek-v4-flash',
    aimlapi_model: 'chatgpt-4o-latest',
    xai_model: 'grok-3-beta',
    pollinations_model: 'openai',
    cometapi_model: 'gpt-4o',
    moonshot_model: 'kimi-latest',
    fireworks_model: 'accounts/fireworks/models/kimi-k2-instruct',
    zai_model: 'glm-4.6',
    zai_endpoint: ZAI_ENDPOINT.COMMON,
    workers_ai_model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    workers_ai_account_id: '',
    azure_base_url: '',
    azure_deployment_name: '',
    azure_api_version: '2024-02-15-preview',
    azure_openai_model: '',
    custom_model: '',
    custom_url: '',
    custom_include_body: '',
    custom_exclude_body: '',
    custom_include_headers: '',
    openrouter_model: OPENROUTER_WEBSITE_MODEL,
    openrouter_use_fallback: false,
    openrouter_providers: [],
    openrouter_quantizations: [],
    openrouter_allow_fallbacks: true,
    openrouter_middleout: 'on',
    tool_reasoning_mode: 'disabled',
    reverse_proxy: '',
    chat_completion_source: S.OPENAI,
    max_context_unlocked: false,
    show_external_models: false,
    proxy_password: '',
    assistant_prefill: '',
    assistant_impersonation: '',
    use_sysprompt: false,
    vertexai_auth_mode: 'express',
    vertexai_region: 'us-central1',
    vertexai_express_project_id: '',
    squash_system_messages: false,
    media_inlining: true,
    inline_image_quality: 'auto',
    bypass_status_check: false,
    continue_prefill: false,
    function_calling: false,
    tool_call_recurse_limit: 5,
    names_behavior: CHARACTER_NAMES_BEHAVIOR.DEFAULT,
    continue_postfix: CONTINUE_POSTFIX_TYPES.SPACE,
    custom_prompt_post_processing: '',
    show_thoughts: true,
    reasoning_effort: 'auto',
    verbosity: 'auto',
    enable_web_search: false,
    request_images: false,
    request_image_aspect_ratio: '',
    request_image_resolution: '',
    seed: -1,
    n: 1,
    bind_preset_to_connection: true,
    extensions: {},
  };
}

/** openai.js `migrateChatCompletionSettings` (works on oai_settings and on preset bodies alike) */
export function migrateChatCompletionSettings(settings: OaiSettings): OaiSettings {
  const map: Array<{ oldKey: string; oldValue: unknown; newKey: string; newValue: unknown }> = [
    {
      oldKey: 'names_in_completion',
      oldValue: true,
      newKey: 'names_behavior',
      newValue: CHARACTER_NAMES_BEHAVIOR.COMPLETION,
    },
    {
      oldKey: 'chat_completion_source',
      oldValue: 'palm',
      newKey: 'chat_completion_source',
      newValue: S.MAKERSUITE,
    },
    {
      oldKey: 'custom_prompt_post_processing',
      oldValue: 'claude',
      newKey: 'custom_prompt_post_processing',
      newValue: 'merge',
    },
    { oldKey: 'ai21_model', oldValue: /^j2-/, newKey: 'ai21_model', newValue: 'jamba-large' },
    { oldKey: 'image_inlining', oldValue: false, newKey: 'media_inlining', newValue: false },
    { oldKey: 'image_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
    { oldKey: 'video_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
    { oldKey: 'audio_inlining', oldValue: true, newKey: 'media_inlining', newValue: true },
    { oldKey: 'claude_use_sysprompt', oldValue: true, newKey: 'use_sysprompt', newValue: true },
    { oldKey: 'use_makersuite_sysprompt', oldValue: true, newKey: 'use_sysprompt', newValue: true },
    {
      oldKey: 'mistralai_model',
      oldValue: /^(mistral-medium|mistral-small)$/,
      newKey: 'mistralai_model',
      newValue: `${String(settings['mistralai_model'])}-latest`,
    },
    {
      oldKey: 'deepseek_model',
      oldValue: /^deepseek-(chat|reasoner|coder)$/,
      newKey: 'deepseek_model',
      newValue: 'deepseek-v4-flash',
    },
    {
      oldKey: 'openrouter_sort_models',
      oldValue: 'alphabetically',
      newKey: 'sort_models',
      newValue: 'alphabetically',
    },
    {
      oldKey: 'openrouter_sort_models',
      oldValue: 'pricing.prompt',
      newKey: 'sort_models',
      newValue: 'pricing.prompt',
    },
    {
      oldKey: 'openrouter_sort_models',
      oldValue: 'context_length',
      newKey: 'sort_models',
      newValue: 'context_length',
    },
    { oldKey: 'openrouter_group_models', oldValue: true, newKey: 'group_models', newValue: true },
  ];
  for (const m of map) {
    if (!Object.hasOwn(settings, m.oldKey)) continue;
    const should =
      m.oldValue instanceof RegExp
        ? m.oldValue.test(String(settings[m.oldKey]))
        : settings[m.oldKey] === m.oldValue;
    if (should) settings[m.newKey] = m.newValue;
    if (m.oldKey !== m.newKey) delete settings[m.oldKey];
  }
  return settings;
}

/** `loadOpenAISettings`: every default key from the file (migrated) or its default. Unknown keys are dropped. */
export function loadOaiSettings(raw: unknown): OaiSettings {
  const src: OaiSettings =
    raw && typeof raw === 'object' ? structuredClone(raw as OaiSettings) : {};
  migrateChatCompletionSettings(src);
  const out = defaultOaiSettings();
  for (const key of Object.keys(out)) out[key] = src[key] ?? out[key];
  return out;
}

/** `getChatCompletionPreset(settings)`: the preset body is every settingsToUpdate field, preset-keyed. */
export function getChatCompletionPreset(settings: OaiSettings): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [presetKey, settingsKey] of CC_PRESET_FIELDS) body[presetKey] = settings[settingsKey];
  return structuredClone(body);
}

/**
 * `onSettingsPresetChange`: apply a (migrated) preset to oai_settings. Connection fields are skipped
 * unless `bind_preset_to_connection`; `extensions` is always replaced (`preset.extensions || {}`);
 * keys the preset lacks keep their current value. Mutates and returns `settings`.
 */
export function applyChatCompletionPreset(
  settings: OaiSettings,
  presetInput: Record<string, unknown>,
  presetName: string,
): OaiSettings {
  const preset = migrateChatCompletionSettings(structuredClone(presetInput));
  settings['preset_settings_openai'] = presetName;
  const bind = !!settings['bind_preset_to_connection'];
  for (const [key, setting, , isConnection] of CC_PRESET_FIELDS) {
    if (isConnection && !bind) continue;
    if (key === 'extensions') {
      settings['extensions'] = preset['extensions'] || {};
      continue;
    }
    if (preset[key] !== undefined) settings[setting] = preset[key];
  }
  return settings;
}

// ---- sources ----

/** `#chat_completion_source` options in ST's order, with ST's labels */
export const CHAT_COMPLETION_SOURCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: S.OPENAI, label: 'OpenAI' },
  { value: S.CUSTOM, label: 'Custom (OpenAI-compatible)' },
  { value: S.AI21, label: 'AI21' },
  { value: S.AIMLAPI, label: 'AI/ML API' },
  { value: S.AZURE_OPENAI, label: 'Azure OpenAI' },
  { value: S.CHUTES, label: 'Chutes' },
  { value: S.CLAUDE, label: 'Claude' },
  { value: S.WORKERS_AI, label: 'Cloudflare Workers AI' },
  { value: S.COHERE, label: 'Cohere' },
  { value: S.COMETAPI, label: 'CometAPI' },
  { value: S.DEEPSEEK, label: 'DeepSeek' },
  { value: S.ELECTRONHUB, label: 'Electron Hub' },
  { value: S.FIREWORKS, label: 'Fireworks AI' },
  { value: S.GROQ, label: 'Groq' },
  { value: S.MAKERSUITE, label: 'Google AI Studio' },
  { value: S.VERTEXAI, label: 'Google Vertex AI' },
  { value: S.MISTRALAI, label: 'MistralAI' },
  { value: S.MINIMAX, label: 'MiniMax' },
  { value: S.MOONSHOT, label: 'Moonshot AI' },
  { value: S.NANOGPT, label: 'NanoGPT' },
  { value: S.OPENROUTER, label: 'OpenRouter' },
  { value: S.PERPLEXITY, label: 'Perplexity' },
  { value: S.POLLINATIONS, label: 'Pollinations' },
  { value: S.SILICONFLOW, label: 'SiliconFlow' },
  { value: S.XAI, label: 'xAI (Grok)' },
  { value: S.ZAI, label: 'Z.AI (GLM)' },
];

export interface ApiSourceConfig {
  /** keyring key (ST SECRET_KEYS) */
  key: string;
  /** a reverse proxy may replace the key */
  proxy: boolean;
  /** connecting without a key is allowed */
  keyless?: boolean;
}

/** `onConnectButtonClick` apiSourceConfig (vertexai = express mode) */
export const API_SOURCE_CONFIG: Readonly<Record<string, ApiSourceConfig>> = {
  [S.OPENROUTER]: { key: 'api_key_openrouter', proxy: false },
  [S.MAKERSUITE]: { key: 'api_key_makersuite', proxy: true },
  [S.CLAUDE]: { key: 'api_key_claude', proxy: true },
  [S.OPENAI]: { key: 'api_key_openai', proxy: true },
  [S.AI21]: { key: 'api_key_ai21', proxy: false },
  [S.MISTRALAI]: { key: 'api_key_mistralai', proxy: true },
  [S.CUSTOM]: { key: 'api_key_custom', proxy: false, keyless: true },
  [S.COHERE]: { key: 'api_key_cohere', proxy: false },
  [S.PERPLEXITY]: { key: 'api_key_perplexity', proxy: false },
  [S.GROQ]: { key: 'api_key_groq', proxy: false },
  [S.SILICONFLOW]: { key: 'api_key_siliconflow', proxy: false },
  [S.ELECTRONHUB]: { key: 'api_key_electronhub', proxy: false },
  [S.NANOGPT]: { key: 'api_key_nanogpt', proxy: false },
  [S.DEEPSEEK]: { key: 'api_key_deepseek', proxy: true },
  [S.XAI]: { key: 'api_key_xai', proxy: true },
  [S.AIMLAPI]: { key: 'api_key_aimlapi', proxy: false },
  [S.MOONSHOT]: { key: 'api_key_moonshot', proxy: true },
  [S.FIREWORKS]: { key: 'api_key_fireworks', proxy: false },
  [S.COMETAPI]: { key: 'api_key_cometapi', proxy: false },
  [S.AZURE_OPENAI]: { key: 'api_key_azure_openai', proxy: false },
  [S.ZAI]: { key: 'api_key_zai', proxy: true },
  [S.CHUTES]: { key: 'api_key_chutes', proxy: false },
  [S.POLLINATIONS]: { key: 'api_key_pollinations', proxy: false },
  [S.WORKERS_AI]: { key: 'api_key_workers_ai', proxy: false },
  [S.MINIMAX]: { key: 'api_key_minimax', proxy: false },
  [S.VERTEXAI]: { key: 'api_key_vertexai', proxy: true },
};

/** Which `oai_settings` key holds the selected model for a source (`getChatCompletionModel` inverse). */
export function modelSettingKey(source: string): string {
  if (source === S.MAKERSUITE) return 'google_model';
  return `${source}_model`;
}

/** `onConnectButtonClick`: may this source connect without a stored key? */
export function canConnectWithoutKey(source: string, reverseProxy: string): boolean {
  const cfg = API_SOURCE_CONFIG[source];
  if (!cfg) return true;
  return !!cfg.keyless || (cfg.proxy && !!reverseProxy);
}

/** The hard-coded model dropdowns of sources with no /models endpoint (ST index.html). */
export const STATIC_MODEL_LISTS: Readonly<Record<string, readonly string[]>> = {
  [S.CLAUDE]: [
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-1',
    'claude-opus-4-1-20250805',
    'claude-opus-4-0',
    'claude-opus-4-20250514',
    'claude-sonnet-4-0',
    'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-latest',
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-latest',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-sonnet-20240620',
    'claude-3-5-haiku-latest',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229',
    'claude-3-haiku-20240307',
  ],
  [S.AI21]: [
    'jamba-mini',
    'jamba-large',
    'jamba-1.7-mini',
    'jamba-1.7-large',
    'jamba-1.6-mini',
    'jamba-1.6-large',
    'jamba-1.5-mini',
    'jamba-1.5-large',
    'jamba-instruct-preview',
  ],
  [S.PERPLEXITY]: [
    'sonar',
    'sonar-pro',
    'sonar-reasoning',
    'sonar-reasoning-pro',
    'sonar-deep-research',
    'r1-1776',
    'llama-3.1-sonar-small-128k-online',
    'llama-3.1-sonar-large-128k-online',
    'llama-3.1-sonar-huge-128k-online',
    'llama-3.1-sonar-small-128k-chat',
    'llama-3.1-sonar-large-128k-chat',
  ],
  [S.ZAI]: [
    'glm-5.2',
    'glm-5-turbo',
    'glm-5v-turbo',
    'glm-5.1',
    'glm-5',
    'glm-4.7',
    'glm-4.7-flash',
    'glm-4.7-flashx',
    'glm-4.6',
    'glm-4.6v',
    'glm-4.6v-flash',
    'glm-4.6v-flashx',
    'glm-4.5v',
    'glm-4.5',
    'glm-4.5-air',
    'glm-4.5-x',
    'glm-4.5-airx',
    'glm-4.5-flash',
    'glm-4-32b-0414-128k',
    'autoglm-phone-multilingual',
  ],
  [S.MINIMAX]: [
    'MiniMax-M2.7',
    'MiniMax-M2.7-highspeed',
    'MiniMax-M2.5',
    'MiniMax-M2.5-highspeed',
    'MiniMax-M2.1',
    'MiniMax-M2.1-highspeed',
    'MiniMax-M2',
    'M2-her',
  ],
  [S.VERTEXAI]: [
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite-preview',
    'gemini-3.1-flash-image-preview',
    'gemini-3-pro-preview',
    'gemini-3-pro-image-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash-image',
    'gemini-2.5-flash-image-preview',
    'gemini-2.0-flash-exp',
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite-001',
  ],
  [S.OPENAI]: [
    'gpt-5.5',
    'gpt-5.5-2026-04-23',
    'gpt-5.4',
    'gpt-5.4-2026-03-05',
    'gpt-5.4-mini',
    'gpt-5.4-mini-2026-03-17',
    'gpt-5.4-nano',
    'gpt-5.4-nano-2026-03-17',
    'gpt-5.3-chat-latest',
    'gpt-5.2',
    'gpt-5.2-2025-12-11',
    'gpt-5.2-chat-latest',
    'gpt-5.1',
    'gpt-5.1-2025-11-13',
    'gpt-5.1-chat-latest',
    'gpt-5',
    'gpt-5-2025-08-07',
    'gpt-5-chat-latest',
    'gpt-5-mini',
    'gpt-5-mini-2025-08-07',
    'gpt-5-nano',
    'gpt-5-nano-2025-08-07',
    'gpt-4o',
    'gpt-4o-2024-11-20',
    'gpt-4o-2024-08-06',
    'gpt-4o-2024-05-13',
    'chatgpt-4o-latest',
    'gpt-4o-mini',
    'gpt-4o-mini-2024-07-18',
    'gpt-4.1',
    'gpt-4.1-2025-04-14',
    'gpt-4.1-mini',
    'gpt-4.1-mini-2025-04-14',
    'gpt-4.1-nano',
    'gpt-4.1-nano-2025-04-14',
    'o1',
    'o1-2024-12-17',
    'o1-mini',
    'o1-mini-2024-09-12',
    'o1-preview',
    'o1-preview-2024-09-12',
    'o3',
    'o3-2025-04-16',
    'o3-mini',
    'o3-mini-2025-01-31',
    'o4-mini',
    'o4-mini-2025-04-16',
    'gpt-4.5-preview',
    'gpt-4.5-preview-2025-02-27',
    'gpt-4-turbo',
    'gpt-4-turbo-2024-04-09',
    'gpt-4-turbo-preview',
    'gpt-4-0125-preview',
    'gpt-4-1106-preview',
    'gpt-4',
    'gpt-4-0613',
    'gpt-4-0314',
    'gpt-3.5-turbo',
    'gpt-3.5-turbo-0125',
    'gpt-3.5-turbo-1106',
    'gpt-3.5-turbo-instruct',
    'babbage-002',
    'davinci-002',
  ],
};

/**
 * Upper bound of the context slider. ST sets it per model in `onModelChange` (a long table);
 * this is the per-source summary of that table, `unlocked_max` when `max_context_unlocked`.
 */
export function maxContextFor(source: string, unlocked: boolean): number {
  if (unlocked) return MAX_CONTEXT.unlocked_max;
  switch (source) {
    case S.CLAUDE:
    case S.DEEPSEEK:
      return MAX_CONTEXT.max_200k;
    case S.MAKERSUITE:
    case S.VERTEXAI:
      return MAX_CONTEXT.max_1mil;
    case S.CUSTOM:
    case S.OPENROUTER:
      return MAX_CONTEXT.unlocked_max;
    default:
      return MAX_CONTEXT.max_128k;
  }
}

// ---- reverse proxy presets (top-level settings.json `proxies` / `selected_proxy`) ----

export interface ProxyPreset {
  name: string;
  url: string;
  /** always '' on disk here: the password lives in the keyring under the preset name */
  password: string;
}
export const PROXY_NONE: ProxyPreset = { name: 'None', url: '', password: '' };

/** `loadProxyPresets`: `proxies` from settings (or the built-in None), `selected_proxy` or the first. */
export function loadProxyPresets(settings: Record<string, unknown>): {
  proxies: ProxyPreset[];
  selected: ProxyPreset;
} {
  const raw = settings['proxies'];
  const proxies: ProxyPreset[] =
    Array.isArray(raw) && raw.length > 0
      ? raw.map((p) => {
          const o = (p ?? {}) as Record<string, unknown>;
          return {
            name: String(o['name'] ?? ''),
            url: String(o['url'] ?? ''),
            password: typeof o['password'] === 'string' ? o['password'] : '',
          };
        })
      : [{ ...PROXY_NONE }];
  const sel = settings['selected_proxy'] as Record<string, unknown> | undefined;
  const selected =
    (sel && proxies.find((p) => p.name === String(sel['name']))) ??
    proxies.find((p) => p.name === 'None') ??
    proxies[0]!;
  return { proxies, selected };
}

/** `setProxyPreset`: update or append; returns the now-selected preset. */
export function setProxyPreset(
  proxies: ProxyPreset[],
  name: string,
  url: string,
  password = '',
): ProxyPreset {
  const existing = proxies.find((p) => p.name === name);
  if (existing) {
    existing.url = url;
    existing.password = password;
    return existing;
  }
  const next: ProxyPreset = { name, url, password };
  proxies.push(next);
  return next;
}

/** `#delete_proxy`: remove by name; selection falls back to the previous entry or None. */
export function deleteProxyPreset(proxies: ProxyPreset[], name: string): ProxyPreset | null {
  const index = proxies.findIndex((p) => p.name === name);
  if (index === -1) return null;
  proxies.splice(index, 1);
  return proxies.length > 0 ? proxies[Math.max(0, index - 1)]! : { ...PROXY_NONE };
}

// ---- panel vocab ----

export interface SamplerSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
}
/** ST panel sliders (ids → oai_settings keys) with their ranges */
export const CC_SAMPLER_SPECS: readonly SamplerSpec[] = [
  { key: 'temp_openai', label: 'Temperature', min: 0, max: 2, step: 0.01 },
  { key: 'freq_pen_openai', label: 'Frequency Penalty', min: -2, max: 2, step: 0.01 },
  { key: 'pres_pen_openai', label: 'Presence Penalty', min: -2, max: 2, step: 0.01 },
  { key: 'top_p_openai', label: 'Top P', min: 0, max: 1, step: 0.01 },
  { key: 'top_k_openai', label: 'Top K', min: 0, max: 500, step: 1 },
  { key: 'repetition_penalty_openai', label: 'Repetition Penalty', min: 1, max: 2, step: 0.01 },
  { key: 'min_p_openai', label: 'Min P', min: 0, max: 1, step: 0.001 },
  { key: 'top_a_openai', label: 'Top A', min: 0, max: 1, step: 0.001 },
];

export const NAMES_BEHAVIOR_OPTIONS = [
  { value: CHARACTER_NAMES_BEHAVIOR.NONE, label: 'None' },
  { value: CHARACTER_NAMES_BEHAVIOR.DEFAULT, label: 'Default' },
  { value: CHARACTER_NAMES_BEHAVIOR.COMPLETION, label: 'Completion Object' },
  { value: CHARACTER_NAMES_BEHAVIOR.CONTENT, label: 'Message Content' },
] as const;
export const CONTINUE_POSTFIX_OPTIONS = [
  { value: CONTINUE_POSTFIX_TYPES.NONE, label: 'None' },
  { value: CONTINUE_POSTFIX_TYPES.SPACE, label: 'Space' },
  { value: CONTINUE_POSTFIX_TYPES.NEWLINE, label: 'Newline' },
  { value: CONTINUE_POSTFIX_TYPES.DOUBLE_NEWLINE, label: 'Double Newline' },
] as const;
export const REASONING_EFFORT_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'min', label: 'Minimum' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Maximum' },
] as const;
export const VERBOSITY_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const;
export const POST_PROCESSING_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'merge_tools', label: 'Merge consecutive roles (with tools)' },
  { value: 'semi_tools', label: 'Semi-strict (alternating roles; with tools)' },
  { value: 'strict_tools', label: 'Strict (user first, alternating roles; with tools)' },
  { value: 'merge', label: 'Merge consecutive roles (no tools)' },
  { value: 'semi', label: 'Semi-strict (alternating roles; no tools)' },
  { value: 'strict', label: 'Strict (user first, alternating roles; no tools)' },
  { value: 'single', label: 'Single user message (no tools)' },
] as const;
export const SILICONFLOW_ENDPOINT_OPTIONS = [
  { value: SILICONFLOW_ENDPOINT.GLOBAL, label: 'Global (siliconflow.com)' },
  { value: SILICONFLOW_ENDPOINT.CN, label: 'China (siliconflow.cn)' },
] as const;
export const MINIMAX_ENDPOINT_OPTIONS = [
  { value: MINIMAX_ENDPOINT.GLOBAL, label: 'Global (minimax.io)' },
  { value: MINIMAX_ENDPOINT.CN, label: 'China (minimaxi.com)' },
] as const;
export const ZAI_ENDPOINT_OPTIONS = [
  { value: ZAI_ENDPOINT.COMMON, label: 'Common API' },
  { value: ZAI_ENDPOINT.CODING, label: 'Coding API' },
] as const;

/** npm sanitize-filename with '' replacement (what `/api/presets/save` does to the name). */
export function sanitizeFilename(input: string): string {
  let s = input
    .replace(/[/?<>\\:*|"]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x80-\x9f]/g, '')
    .replace(/^\.+$/, '')
    .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '')
    .replace(/[. ]+$/, '');
  const enc = new TextEncoder();
  while (enc.encode(s).length > 255) s = s.slice(0, -1);
  return s;
}
