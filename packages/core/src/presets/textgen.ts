/**
 * Text Completion settings, presets, connection vocab and formatting templates
 * (ST textgen-settings.js / preset-manager.js / instruct-mode.js / power-user.js — DEV_NOTES §9.19).
 */
import { TEXTGEN_TYPES as T } from '../tokens/types.js';
import {
  APHRODITE_DEFAULT_ORDER,
  KOBOLDCPP_ORDER,
  LLAMACPP_DEFAULT_ORDER,
  OOBA_DEFAULT_ORDER,
} from '../prompt/text-completion/request-constants.js';
import { defaultTextgenSettings, type TextgenSettings } from '../prompt/text-completion/request.js';

/** textgen-settings.js `setting_names` (what a preset carries / selectPreset applies) */
export const TEXTGEN_SETTING_NAMES: readonly string[] = [
  'temp',
  'temperature_last',
  'rep_pen',
  'rep_pen_range',
  'rep_pen_decay',
  'rep_pen_slope',
  'no_repeat_ngram_size',
  'top_k',
  'top_p',
  'top_a',
  'tfs',
  'epsilon_cutoff',
  'eta_cutoff',
  'typical_p',
  'min_p',
  'penalty_alpha',
  'num_beams',
  'length_penalty',
  'min_length',
  'dynatemp',
  'min_temp',
  'max_temp',
  'dynatemp_exponent',
  'smoothing_factor',
  'smoothing_curve',
  'dry_allowed_length',
  'dry_multiplier',
  'dry_base',
  'dry_sequence_breakers',
  'dry_penalty_last_n',
  'max_tokens_second',
  'encoder_rep_pen',
  'freq_pen',
  'presence_pen',
  'skew',
  'do_sample',
  'early_stopping',
  'seed',
  'add_bos_token',
  'ban_eos_token',
  'skip_special_tokens',
  'include_reasoning',
  'streaming',
  'mirostat_mode',
  'mirostat_tau',
  'mirostat_eta',
  'guidance_scale',
  'negative_prompt',
  'grammar_string',
  'json_schema',
  'banned_tokens',
  'global_banned_tokens',
  'send_banned_tokens',
  'ignore_eos_token',
  'spaces_between_special_tokens',
  'speculative_ngram',
  'sampler_order',
  'sampler_priority',
  'samplers',
  'samplers_priorities',
  'n',
  'logit_bias',
  'custom_model',
  'bypass_status_check',
  'openrouter_allow_fallbacks',
  'xtc_threshold',
  'xtc_probability',
  'nsigma',
  'min_keep',
  'generic_model',
  'extensions',
  'json_schema_allow_empty',
  'adaptive_target',
  'adaptive_decay',
];

/** preset-manager.js getPresetSettings `filteredKeys` */
export const TEXTGEN_PRESET_FILTERED_KEYS: readonly string[] = [
  'api_server',
  'preset',
  'streaming',
  'truncation_length',
  'n',
  'streaming_url',
  'stopping_strings',
  'can_use_tokenization',
  'can_use_streaming',
  'preset_settings_novel',
  'preset_settings',
  'streaming_novel',
  'nai_preamble',
  'model_novel',
  'streaming_kobold',
  'enabled',
  'bind_to_context',
  'seed',
  'legacy_api',
  'mancer_model',
  'togetherai_model',
  'ollama_model',
  'vllm_model',
  'aphrodite_model',
  'llamacpp_model',
  'server_urls',
  'type',
  'custom_model',
  'bypass_status_check',
  'infermaticai_model',
  'dreamgen_model',
  'openrouter_model',
  'featherless_model',
  'max_tokens_second',
  'openrouter_providers',
  'openrouter_quantizations',
  'openrouter_allow_fallbacks',
  'tabby_model',
  'derived',
  'generic_model',
  'include_reasoning',
  'global_banned_tokens',
  'send_banned_tokens',
  'auto_parse',
  'add_to_prompts',
  'auto_expand',
  'show_hidden',
  'max_additions',
];

/** power-user.js */
export const MAX_CONTEXT_DEFAULT = 8192;
export const MAX_RESPONSE_DEFAULT = 2048;
/** script.js `let amount_gen = 80; let max_context = 2048;` */
export const AMOUNT_GEN_DEFAULT = 80;
export const TC_MAX_CONTEXT_DEFAULT = 2048;

/** `loadTextGenSettings`: Object.assign over the defaults + legacy single-server migration. */
export function loadTextgenSettings(settings: Record<string, unknown>): TextgenSettings {
  const out = Object.assign(
    defaultTextgenSettings(),
    structuredClone((settings['textgenerationwebui_settings'] as object | undefined) ?? {}),
  ) as TextgenSettings;
  if (!out.server_urls || typeof out.server_urls !== 'object') out.server_urls = {};
  const legacy = settings['api_server_textgenerationwebui'];
  if (typeof legacy === 'string' && legacy) {
    for (const type of SERVER_URL_TYPES) out.server_urls[type] = legacy;
  }
  if (settings['api_use_mancer_webui']) out.type = T.MANCER;
  return out;
}

/** preset-manager `getPresetSettings('textgenerationwebui')` */
export function getTextgenPreset(
  settings: TextgenSettings,
  amountGen: number,
  maxContext: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = structuredClone({ ...settings });
  for (const key of TEXTGEN_PRESET_FILTERED_KEYS) delete body[key];
  body['genamt'] = amountGen;
  body['max_length'] = maxContext;
  return body;
}

function withMissing<V>(defaults: readonly V[], value: unknown): V[] {
  const arr = Array.isArray(value) ? ([...value] as V[]) : [...defaults];
  for (const item of defaults) if (!arr.includes(item)) arr.push(item);
  return arr;
}

/** `setSettingByName` (data side only; DOM sorting does not change the stored order) */
export function setTextgenSetting(settings: TextgenSettings, name: string, value: unknown): void {
  if (name === 'extensions') {
    settings['extensions'] = value || {};
    return;
  }
  if (name === 'json_schema') {
    settings.json_schema = (value ?? null) as TextgenSettings['json_schema'];
    return;
  }
  if (value === null || value === undefined) return;
  switch (name) {
    case 'sampler_order':
      settings.sampler_order = Array.isArray(value) ? (value as number[]) : [...KOBOLDCPP_ORDER];
      return;
    case 'sampler_priority':
      settings.sampler_priority = withMissing(OOBA_DEFAULT_ORDER, value);
      return;
    case 'samplers_priorities':
      settings.samplers_priorities = withMissing(APHRODITE_DEFAULT_ORDER, value);
      return;
    case 'samplers':
      settings.samplers = withMissing(LLAMACPP_DEFAULT_ORDER, value);
      return;
    case 'logit_bias':
      settings.logit_bias = Array.isArray(value) ? value : [];
      return;
    default:
      settings[name] = value;
  }
}

export interface TextgenPresetApplied {
  amountGen?: number | undefined;
  maxContext?: number | undefined;
  /** setGenerationParamsFromPreset's `needsUnlock` */
  maxContextUnlocked: boolean;
}

/** `selectPreset(name)` + `setGenerationParamsFromPreset(preset)`. Mutates `settings`. */
export function applyTextgenPreset(
  settings: TextgenSettings,
  preset: Record<string, unknown>,
  name: string,
  current: { amountGen: number; maxContext: number },
): TextgenPresetApplied {
  settings['preset'] = name;
  for (const key of TEXTGEN_SETTING_NAMES) setTextgenSetting(settings, key, preset[key]);
  const genamt = preset['genamt'];
  const maxLength = preset['max_length'];
  const maxContextUnlocked =
    Number(maxLength ?? current.maxContext) > MAX_CONTEXT_DEFAULT ||
    Number(genamt ?? current.amountGen) > MAX_RESPONSE_DEFAULT;
  return {
    amountGen: genamt === undefined ? undefined : Number(genamt),
    maxContext: maxLength === undefined ? undefined : Number(maxLength),
    maxContextUnlocked,
  };
}

// ---- connection vocab ----

/** `#textgen_type` options (ST order and labels) */
export const TEXTGEN_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: T.APHRODITE, label: 'Aphrodite' },
  { value: T.DREAMGEN, label: 'DreamGen' },
  { value: T.FEATHERLESS, label: 'Featherless' },
  { value: T.GENERIC, label: 'Generic (OpenAI-compatible) [LM Studio, LiteLLM, etc.]' },
  { value: T.HUGGINGFACE, label: 'HuggingFace (Inference Endpoint)' },
  { value: T.INFERMATICAI, label: 'InfermaticAI' },
  { value: T.KOBOLDCPP, label: 'KoboldCpp' },
  { value: T.LLAMACPP, label: 'llama.cpp' },
  { value: T.MANCER, label: 'Mancer' },
  { value: T.OLLAMA, label: 'Ollama' },
  { value: T.OPENROUTER, label: 'OpenRouter' },
  { value: T.TABBY, label: 'TabbyAPI' },
  { value: T.OOBA, label: 'Text Generation WebUI (oobabooga)' },
  { value: T.TOGETHERAI, label: 'TogetherAI' },
  { value: T.VLLM, label: 'vLLM' },
];

/** Types whose server is user-entered (`SERVER_INPUTS`); the rest use getTextGenServer constants. */
export const SERVER_URL_TYPES: readonly string[] = [
  T.OOBA,
  T.VLLM,
  T.APHRODITE,
  T.TABBY,
  T.KOBOLDCPP,
  T.LLAMACPP,
  T.OLLAMA,
  T.HUGGINGFACE,
  T.GENERIC,
];

/** ST placeholder per type (index.html) */
export const TEXTGEN_SERVER_PLACEHOLDERS: Readonly<Record<string, string>> = {
  [T.OOBA]: 'http://127.0.0.1:5000',
  [T.VLLM]: 'http://127.0.0.1:8000',
  [T.APHRODITE]: 'http://127.0.0.1:2242',
  [T.TABBY]: 'http://127.0.0.1:5000',
  [T.KOBOLDCPP]: 'http://127.0.0.1:5001',
  [T.LLAMACPP]: 'http://127.0.0.1:8080',
  [T.OLLAMA]: 'http://127.0.0.1:11434',
  [T.HUGGINGFACE]: 'https://<endpoint>.endpoints.huggingface.cloud',
  [T.GENERIC]: 'http://127.0.0.1:1234/v1',
};

/** SECRET_KEYS for TC types (`api_key_<type>`); Ollama has none. */
export function textgenSecretKey(type: string): string | null {
  return type === T.OLLAMA ? null : `api_key_${type}`;
}

/**
 * additional-headers.js as a Rust `auth_header` list (comma-separated; `bearer` =
 * `Authorization: Bearer <key>`). Undefined = default Bearer.
 */
export function textCompletionAuthHeader(type: string): string | undefined {
  switch (type) {
    case T.MANCER:
    case T.APHRODITE:
      return 'X-API-KEY,bearer';
    case T.TABBY:
      return 'x-api-key,bearer';
    default:
      return undefined;
  }
}

/** Which textgen setting holds the user's model for a type (null = the server decides). */
export function textgenModelKey(type: string): string | null {
  switch (type) {
    case T.OOBA:
      return 'custom_model';
    case T.GENERIC:
      return 'generic_model';
    case T.KOBOLDCPP:
    case T.HUGGINGFACE:
      return null;
    default:
      return `${type}_model`;
  }
}

/** Types whose model list is a select ST backfills after connecting (load*Models). */
export const TEXTGEN_MODEL_BACKFILL: readonly string[] = [
  T.MANCER,
  T.TOGETHERAI,
  T.INFERMATICAI,
  T.DREAMGEN,
  T.OPENROUTER,
  T.VLLM,
  T.APHRODITE,
  T.FEATHERLESS,
  T.TABBY,
  T.LLAMACPP,
  T.OLLAMA,
];

export interface TextgenSamplerSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
}
/** The common TC sliders (index.html ranges) */
export const TC_SAMPLER_SPECS: readonly TextgenSamplerSpec[] = [
  { key: 'temp', label: 'Temperature', min: 0, max: 5, step: 0.01 },
  { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.01 },
  { key: 'top_k', label: 'Top K', min: -1, max: 500, step: 1 },
  { key: 'min_p', label: 'Min P', min: 0, max: 1, step: 0.001 },
  { key: 'typical_p', label: 'Typical P', min: 0, max: 1, step: 0.01 },
  { key: 'top_a', label: 'Top A', min: 0, max: 1, step: 0.01 },
  { key: 'tfs', label: 'TFS', min: 0, max: 1, step: 0.001 },
  { key: 'rep_pen', label: 'Repetition Penalty', min: 1, max: 3, step: 0.01 },
  { key: 'rep_pen_range', label: 'Rep. Pen. Range', min: -1, max: 8192, step: 1 },
  { key: 'freq_pen', label: 'Frequency Penalty', min: -2, max: 2, step: 0.01 },
  { key: 'presence_pen', label: 'Presence Penalty', min: -2, max: 2, step: 0.01 },
  { key: 'xtc_threshold', label: 'XTC Threshold', min: 0, max: 0.5, step: 0.01 },
  { key: 'xtc_probability', label: 'XTC Probability', min: 0, max: 1, step: 0.01 },
  { key: 'dry_multiplier', label: 'DRY Multiplier', min: 0, max: 5, step: 0.01 },
];
/** `#amount_gen` / `#max_context` ranges (locked) */
export const AMOUNT_GEN_RANGE = { min: 16, max: 2048, step: 1 } as const;
export const TC_MAX_CONTEXT_RANGE = { min: 512, max: 8192, step: 64 } as const;
/** unlocked upper bounds: power-user.js MAX_CONTEXT_UNLOCKED = 512 * 1024, MAX_RESPONSE_UNLOCKED = 64 * 1024 */
export const TC_UNLOCKED = { maxContext: 512 * 1024, amountGen: 64 * 1024 } as const;

// ---- formatting templates (instruct / context / sysprompt) ----

/** instruct-mode.js `controls` properties */
export const INSTRUCT_TEMPLATE_PROPERTIES: readonly string[] = [
  'enabled',
  'wrap',
  'macro',
  'story_string_prefix',
  'story_string_suffix',
  'input_sequence',
  'input_suffix',
  'output_sequence',
  'output_suffix',
  'system_sequence',
  'system_suffix',
  'last_system_sequence',
  'user_alignment_message',
  'stop_sequence',
  'first_output_sequence',
  'last_output_sequence',
  'first_input_sequence',
  'last_input_sequence',
  'activation_regex',
  'bind_to_context',
  'skip_examples',
  'names_behavior',
  'system_same_as_user',
  'sequences_as_stop_strings',
];

/** power-user.js `contextControls` (global = written on power_user, not power_user.context) */
export const CONTEXT_TEMPLATE_CONTROLS: ReadonlyArray<{
  property: string;
  global: boolean;
  defaultValue?: unknown;
}> = [
  { property: 'story_string', global: false },
  { property: 'example_separator', global: false },
  { property: 'chat_start', global: false },
  { property: 'use_stop_strings', global: false, defaultValue: false },
  { property: 'names_as_stop_strings', global: false, defaultValue: true },
  { property: 'story_string_position', global: false, defaultValue: 0 },
  { property: 'story_string_depth', global: false, defaultValue: 1 },
  { property: 'story_string_role', global: false, defaultValue: 0 },
  { property: 'always_force_name2', global: true, defaultValue: true },
  { property: 'trim_sentences', global: true, defaultValue: false },
  { property: 'single_line', global: true, defaultValue: false },
];

/** instruct-mode.js `migrateInstructModeSettings` */
export function migrateInstructModeSettings(s: Record<string, unknown>): Record<string, unknown> {
  if (s['separator_sequence'] !== undefined) {
    s['output_suffix'] = s['separator_sequence'] || '';
    delete s['separator_sequence'];
  }
  if (s['names'] !== undefined) {
    s['names_behavior'] = s['names'] ? 'always' : s['names_force_groups'] ? 'force' : 'none';
    delete s['names'];
    delete s['names_force_groups'];
  }
  const defaults: Record<string, unknown> = {
    input_suffix: '',
    system_sequence: '',
    system_suffix: '',
    user_alignment_message: '',
    last_system_sequence: '',
    first_input_sequence: '',
    last_input_sequence: '',
    skip_examples: false,
    system_same_as_user: false,
    names_behavior: 'force',
    sequences_as_stop_strings: true,
    story_string_prefix: '',
    story_string_suffix: '',
  };
  for (const [k, v] of Object.entries(defaults)) if (s[k] === undefined) s[k] = v;
  for (const f of [
    'names',
    'names_force_groups',
    'system_sequence_prefix',
    'system_sequence_suffix',
  ])
    delete s[f];
  return s;
}

/** power-user.js `autoFixStoryString` */
export function autoFixStoryString(ctx: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(ctx, 'story_string_position')) return ctx;
  let storyString = String(ctx['story_string'] ?? '');
  const fix = (field: string, position: 'start' | 'end') => {
    if (storyString.includes(`{{${field}}}`)) return;
    const tpl = `{{#if ${field}}}{{${field}}}\n{{/if}}`;
    const first = storyString.includes('{{') ? storyString.indexOf('{{') : 0;
    const lastCurly = storyString.includes('}}')
      ? storyString.lastIndexOf('}}') + 2
      : storyString.length;
    const lastTrim = storyString.includes('{{trim}}')
      ? storyString.lastIndexOf('{{trim}}')
      : storyString.length;
    const end = Math.min(lastTrim, lastCurly);
    storyString =
      position === 'start'
        ? storyString.slice(0, first) + tpl + storyString.slice(first)
        : storyString.slice(0, end) + tpl + storyString.slice(end);
  };
  fix('anchorBefore', 'start');
  fix('anchorAfter', 'end');
  ctx['story_string'] = storyString;
  return ctx;
}

type PowerUser = Record<string, unknown>;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** `#instruct_presets` change. Returns the context template name to also select (bind_to_context). */
export function applyInstructTemplate(
  powerUser: PowerUser,
  template: Record<string, unknown>,
  name: string,
): string | null {
  const preset = migrateInstructModeSettings(structuredClone(template));
  const instruct = obj(powerUser['instruct']);
  powerUser['instruct'] = instruct;
  instruct['preset'] = name;
  for (const p of INSTRUCT_TEMPLATE_PROPERTIES)
    if (preset[p] !== undefined) instruct[p] = preset[p];
  return instruct['bind_to_context'] ? name : null;
}

/** `#context_presets` change. Returns the instruct template name to also select (bind_to_context). */
export function applyContextTemplate(
  powerUser: PowerUser,
  template: Record<string, unknown>,
  name: string,
): string | null {
  const preset = autoFixStoryString(structuredClone(template));
  const context = obj(powerUser['context']);
  powerUser['context'] = context;
  context['preset'] = name;
  for (const c of CONTEXT_TEMPLATE_CONTROLS) {
    const value = preset[c.property] ?? c.defaultValue;
    if (value === undefined) continue;
    if (c.global) powerUser[c.property] = value;
    else context[c.property] = value;
  }
  return obj(powerUser['instruct'])['bind_to_context'] ? name : null;
}

/** selectInstructPreset: also turns instruct mode on. */
export function enableInstruct(powerUser: PowerUser): void {
  const instruct = obj(powerUser['instruct']);
  powerUser['instruct'] = instruct;
  instruct['enabled'] = true;
}

/** `#sysprompt_select` change */
export function applySystemPromptTemplate(
  powerUser: PowerUser,
  template: Record<string, unknown>,
  name: string,
): void {
  const sp = obj(powerUser['sysprompt']);
  powerUser['sysprompt'] = sp;
  sp['enabled'] = true;
  sp['name'] = name;
  sp['content'] = String(template['content'] ?? '');
  sp['post_history'] = String(template['post_history'] ?? '');
}
