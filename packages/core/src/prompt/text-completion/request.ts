/**
 * Text Completion 请求体：
 * - createTextGenGenerationData：ST textgen-settings.js 前端发给 /api/backends/text-completions/generate 的参数
 * - toTextCompletionUpstream：ST 服务端 text-completions.js /generate 对各 api_type 的 URL 路径、请求体过滤与 Ollama 重组
 * 密钥不经过这里：上游请求头由宿主（Rust）按 api_type 从钥匙串补齐。
 */
import type { CoreState } from '../../state.js';
import { TEXTGEN_TYPES, type TextgenType } from '../../tokens/types.js';
import {
  APHRODITE_DEFAULT_ORDER,
  FEATHERLESS_HEADERS,
  FEATHERLESS_KEYS,
  INFERMATICAI_KEYS,
  KOBOLDCPP_ORDER,
  LLAMACPP_DEFAULT_ORDER,
  OLLAMA_KEYS,
  OOBA_DEFAULT_ORDER,
  OPENAI_KEYS,
  OPENROUTER_HEADERS,
  OPENROUTER_KEYS,
  TEXTGEN_SERVERS,
  TOGETHERAI_KEYS,
  VLLM_KEYS,
} from './request-constants.js';

const T = TEXTGEN_TYPES;

/** textgenerationwebui_settings（ST 默认值见 defaultTextgenSettings） */
export interface TextgenSettings {
  type: TextgenType | string;
  temp: number;
  temperature_last: boolean;
  top_p: number;
  top_k: number;
  top_a: number;
  tfs: number;
  epsilon_cutoff: number;
  eta_cutoff: number;
  typical_p: number;
  min_p: number;
  rep_pen: number;
  rep_pen_range: number;
  rep_pen_decay: number;
  rep_pen_slope: number;
  no_repeat_ngram_size: number;
  penalty_alpha: number;
  num_beams: number;
  length_penalty: number;
  min_length: number;
  encoder_rep_pen: number;
  freq_pen: number;
  presence_pen: number;
  skew: number;
  do_sample: boolean;
  early_stopping: boolean;
  dynatemp: boolean;
  min_temp: number;
  max_temp: number;
  dynatemp_exponent: number;
  smoothing_factor: number;
  smoothing_curve: number;
  dry_allowed_length: number;
  dry_multiplier: number;
  dry_base: number;
  dry_sequence_breakers: string;
  dry_penalty_last_n: number;
  max_tokens_second: number;
  seed: number;
  add_bos_token: boolean;
  ban_eos_token: boolean;
  skip_special_tokens: boolean;
  include_reasoning: boolean;
  streaming: boolean;
  mirostat_mode: number;
  mirostat_tau: number;
  mirostat_eta: number;
  guidance_scale: number;
  negative_prompt: string;
  grammar_string: string;
  json_schema: Record<string, unknown> | null;
  json_schema_allow_empty: boolean;
  banned_tokens: string;
  global_banned_tokens: string;
  send_banned_tokens: boolean;
  sampler_priority: string[];
  samplers: string[];
  samplers_priorities: string[];
  ignore_eos_token: boolean;
  spaces_between_special_tokens: boolean;
  speculative_ngram: boolean;
  mancer_model: string;
  togetherai_model: string;
  infermaticai_model: string;
  ollama_model: string;
  openrouter_model: string;
  openrouter_providers: string[];
  openrouter_quantizations: string[];
  openrouter_allow_fallbacks: boolean;
  vllm_model: string;
  aphrodite_model: string;
  dreamgen_model: string;
  tabby_model: string;
  llamacpp_model: string;
  featherless_model: string;
  generic_model: string;
  custom_model: string;
  sampler_order: number[];
  logit_bias: unknown[];
  n: number;
  server_urls: Record<string, string>;
  xtc_threshold: number;
  xtc_probability: number;
  nsigma: number;
  min_keep: number;
  adaptive_target: number;
  adaptive_decay: number;
  [key: string]: unknown;
}

export function defaultTextgenSettings(): TextgenSettings {
  return {
    temp: 0.7,
    temperature_last: true,
    top_p: 0.5,
    top_k: 40,
    top_a: 0,
    tfs: 1,
    epsilon_cutoff: 0,
    eta_cutoff: 0,
    typical_p: 1,
    min_p: 0,
    rep_pen: 1.2,
    rep_pen_range: 0,
    rep_pen_decay: 0,
    rep_pen_slope: 1,
    no_repeat_ngram_size: 0,
    penalty_alpha: 0,
    num_beams: 1,
    length_penalty: 1,
    min_length: 0,
    encoder_rep_pen: 1,
    freq_pen: 0,
    presence_pen: 0,
    skew: 0,
    do_sample: true,
    early_stopping: false,
    dynatemp: false,
    min_temp: 0,
    max_temp: 2.0,
    dynatemp_exponent: 1.0,
    smoothing_factor: 0.0,
    smoothing_curve: 1.0,
    dry_allowed_length: 2,
    dry_multiplier: 0.0,
    dry_base: 1.75,
    dry_sequence_breakers: '["\\n", ":", "\\"", "*"]',
    dry_penalty_last_n: 0,
    max_tokens_second: 0,
    seed: -1,
    add_bos_token: true,
    ban_eos_token: false,
    skip_special_tokens: true,
    include_reasoning: true,
    streaming: false,
    mirostat_mode: 0,
    mirostat_tau: 5,
    mirostat_eta: 0.1,
    guidance_scale: 1,
    negative_prompt: '',
    grammar_string: '',
    json_schema: null,
    json_schema_allow_empty: false,
    banned_tokens: '',
    global_banned_tokens: '',
    send_banned_tokens: true,
    sampler_priority: [...OOBA_DEFAULT_ORDER],
    samplers: [...LLAMACPP_DEFAULT_ORDER],
    samplers_priorities: [...APHRODITE_DEFAULT_ORDER],
    ignore_eos_token: false,
    spaces_between_special_tokens: true,
    speculative_ngram: false,
    type: T.OOBA,
    mancer_model: 'mytholite',
    togetherai_model: 'Gryphe/MythoMax-L2-13b',
    infermaticai_model: '',
    ollama_model: '',
    openrouter_model: 'openrouter/auto',
    openrouter_providers: [],
    openrouter_quantizations: [],
    vllm_model: '',
    aphrodite_model: '',
    dreamgen_model: 'lucid-v1-extra-large/text',
    tabby_model: '',
    llamacpp_model: '',
    sampler_order: [...KOBOLDCPP_ORDER],
    logit_bias: [],
    n: 1,
    server_urls: {},
    custom_model: '',
    openrouter_allow_fallbacks: true,
    xtc_threshold: 0.1,
    xtc_probability: 0,
    nsigma: 0.0,
    min_keep: 0,
    featherless_model: '',
    generic_model: '',
    adaptive_target: -0.01,
    adaptive_decay: 0.9,
  };
}

/** getTextGenServer：固定服务商用常量，其它读 server_urls[type] */
export function getTextGenServer(settings: TextgenSettings, type?: string): string {
  const selected = type ?? settings.type;
  switch (selected) {
    case T.FEATHERLESS:
      return TEXTGEN_SERVERS.featherless;
    case T.MANCER:
      return (settings['mancer_server'] as string | undefined) || TEXTGEN_SERVERS.mancer;
    case T.TOGETHERAI:
      return TEXTGEN_SERVERS.togetherai;
    case T.INFERMATICAI:
      return TEXTGEN_SERVERS.infermaticai;
    case T.DREAMGEN:
      return TEXTGEN_SERVERS.dreamgen;
    case T.OPENROUTER:
      return TEXTGEN_SERVERS.openrouter;
    default:
      return settings.server_urls[selected] ?? '';
  }
}

/** getTextGenModel；Ollama 未选模型时 ST 抛错，这里返回 null 由宿主提示 */
export function getTextGenModel(settings: TextgenSettings): string | null | undefined {
  switch (settings.type) {
    case T.OOBA:
      if (settings.custom_model) return settings.custom_model;
      break;
    case T.GENERIC:
      if (settings.generic_model) return settings.generic_model;
      break;
    case T.MANCER:
      return settings.mancer_model;
    case T.TOGETHERAI:
      return settings.togetherai_model;
    case T.INFERMATICAI:
      return settings.infermaticai_model;
    case T.DREAMGEN:
      return settings.dreamgen_model;
    case T.OPENROUTER:
      return settings.openrouter_model;
    case T.VLLM:
      return settings.vllm_model;
    case T.APHRODITE:
      return settings.aphrodite_model;
    case T.OLLAMA:
      return settings.ollama_model || null;
    case T.FEATHERLESS:
      return settings.featherless_model;
    case T.HUGGINGFACE:
      return 'tgi';
    case T.TABBY:
      if (settings.tabby_model) return settings.tabby_model;
      break;
    default:
      return undefined;
  }
  return undefined;
}

export function getLogprobsNumber(type: string): number {
  return type === T.VLLM || type === T.INFERMATICAI ? 5 : 10;
}

/** index.html 里 dynatemp_block_ooba 的 data-tg-type */
export const DYNATEMP_TYPES: readonly string[] = [
  T.OOBA,
  T.MANCER,
  T.KOBOLDCPP,
  T.TABBY,
  T.LLAMACPP,
  T.APHRODITE,
];
export function isDynamicTemperatureSupported(settings: TextgenSettings): boolean {
  return !!settings.dynatemp && DYNATEMP_TYPES.includes(settings.type);
}

export function toIntArray(str: string | undefined | null): number[] {
  if (!str) return [];
  return str
    .split(',')
    .map((x) => parseInt(x))
    .filter((x) => !Number.isNaN(x));
}

/** replaceMacrosInList：JSON 数组逐项过宏，否则按逗号拆 */
export function replaceMacrosInList(str: unknown, substitute: (t: string) => string): unknown {
  if (!str || typeof str !== 'string') return str;
  try {
    const array: unknown = JSON.parse(str);
    if (!Array.isArray(array)) throw new Error('Not an array');
    return JSON.stringify(array.map((x) => substitute(String(x))));
  } catch {
    return str
      .split(',')
      .map((x) => substitute(x))
      .join(',');
  }
}

export interface TokenBansDeps {
  substitute: (t: string) => string;
  /** 把一行裸文本编成 token id（宿主分词器）；缺省时该行被跳过（ST 会 log 并跳过） */
  encode?: ((text: string) => number[]) | undefined;
  /** textgenerationwebui_banned_in_macros（{{banned}} 宏收集，用后清空由宿主负责） */
  bannedInMacros?: readonly string[] | undefined;
}

/** getCustomTokenBans：`[1,2]` 为 token id，`"text"` 为禁用字串，其它行按分词器编码 */
export function getCustomTokenBans(
  settings: TextgenSettings,
  deps: TokenBansDeps,
): { banned_tokens: string; banned_strings: string[] } {
  const inMacros = deps.bannedInMacros ?? [];
  if (
    !settings.send_banned_tokens ||
    (!settings.banned_tokens && !settings.global_banned_tokens && !inMacros.length)
  ) {
    return { banned_tokens: '', banned_strings: [] };
  }
  const bannedTokens: number[] = [];
  const bannedStrings: string[] = [];
  const sequences = ([] as string[])
    .concat(settings.banned_tokens.split('\n'))
    .concat(settings.global_banned_tokens.split('\n'))
    .concat(inMacros)
    .filter((x) => x.length > 0)
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((x) => deps.substitute(x));
  for (const line of sequences) {
    if (line.startsWith('[') && line.endsWith(']')) {
      try {
        const tokens: unknown = JSON.parse(line);
        if (Array.isArray(tokens) && tokens.every((t) => Number.isInteger(t)))
          bannedTokens.push(...(tokens as number[]));
      } catch {
        /* ST: log and skip */
      }
    } else if (line.startsWith('"') && line.endsWith('"')) {
      bannedStrings.push(line.slice(1, -1));
    } else if (deps.encode) {
      try {
        bannedTokens.push(...deps.encode(line));
      } catch {
        /* ST: log and skip */
      }
    }
  }
  return {
    banned_tokens: bannedTokens
      .filter((v, i, a) => a.indexOf(v) === i)
      .map((x) => String(x))
      .join(','),
    banned_strings: bannedStrings,
  };
}

export interface TextGenGenerationInput {
  settings: TextgenSettings;
  /** 缺省用 getTextGenModel */
  model?: string | null | undefined;
  prompt: string;
  maxTokens: number;
  /** max_context（截断长度） */
  maxContext: number;
  isImpersonate?: boolean | undefined;
  isContinue?: boolean | undefined;
  type?: string | undefined;
  /** getStoppingStrings(isImpersonate, isContinue) 的结果 */
  stoppingStrings: string[];
  substitute: (t: string) => string;
  /** power_user.request_token_probabilities */
  requestTokenProbabilities?: boolean | undefined;
  /** calculateLogitBias(settings) 的结果；logit_bias 为空时忽略 */
  logitBias?: Record<string, number> | undefined;
  cfgValues?:
    | { guidanceScale?: { value: number } | undefined; negativePrompt?: string | undefined }
    | null
    | undefined;
  tokenBans?: TokenBansDeps | undefined;
  /** HuggingFace 无 seed 时的随机 seed 来源（默认 Math.random） */
  random?: (() => number) | undefined;
}

export type TextGenParams = Record<string, unknown>;

function parseSequenceBreakers(value: unknown): unknown {
  try {
    return JSON.parse(String(value));
  } catch {
    if (typeof value === 'string') return value.split(',');
    return undefined;
  }
}

/** createTextGenGenerationData 的移植（去掉 parseSequenceBreakers 方法与事件） */
export function createTextGenGenerationData(input: TextGenGenerationInput): TextGenParams {
  const s = input.settings;
  const type = input.type ?? 'quiet';
  const isImpersonate = !!input.isImpersonate;
  const isContinue = !!input.isContinue;
  const model = input.model === undefined ? getTextGenModel(s) : input.model;
  const canMultiSwipe = !isContinue && !isImpersonate && type !== 'quiet';
  const dynatemp = isDynamicTemperatureSupported(s);
  const { banned_tokens, banned_strings } = getCustomTokenBans(
    s,
    input.tokenBans ?? { substitute: input.substitute },
  );
  const jsonSchema =
    s.json_schema && typeof s.json_schema === 'object'
      ? s.json_schema_allow_empty
        ? s.json_schema
        : Object.keys(s.json_schema).length > 0
          ? s.json_schema
          : undefined
      : undefined;
  const stop = [...input.stoppingStrings];

  let params: TextGenParams = {
    prompt: input.prompt,
    model,
    max_new_tokens: input.maxTokens,
    max_tokens: input.maxTokens,
    logprobs: input.requestTokenProbabilities ? getLogprobsNumber(s.type) : undefined,
    temperature: dynatemp ? (s.min_temp + s.max_temp) / 2 : s.temp,
    top_p: s.top_p,
    typical_p: s.typical_p,
    typical: s.typical_p,
    sampler_seed: s.seed >= 0 ? s.seed : undefined,
    min_p: s.min_p,
    repetition_penalty: s.rep_pen,
    frequency_penalty: s.freq_pen,
    presence_penalty: s.presence_pen,
    top_k: s.top_k,
    skew: s.skew,
    min_length: s.type === T.OOBA ? s.min_length : undefined,
    minimum_message_content_tokens: s.type === T.DREAMGEN ? s.min_length : undefined,
    min_tokens: s.min_length,
    num_beams: s.type === T.OOBA ? s.num_beams : undefined,
    length_penalty: s.type === T.OOBA ? s.length_penalty : undefined,
    early_stopping: s.type === T.OOBA ? s.early_stopping : undefined,
    add_bos_token: s.add_bos_token,
    dynamic_temperature: dynatemp ? true : undefined,
    dynatemp_low: dynatemp ? s.min_temp : undefined,
    dynatemp_high: dynatemp ? s.max_temp : undefined,
    dynatemp_range: dynatemp ? (s.max_temp - s.min_temp) / 2 : undefined,
    dynatemp_exponent: dynatemp ? s.dynatemp_exponent : undefined,
    smoothing_factor: s.smoothing_factor,
    smoothing_curve: s.smoothing_curve,
    dry_allowed_length: s.dry_allowed_length,
    dry_multiplier: s.dry_multiplier,
    dry_base: s.dry_base,
    dry_sequence_breakers: replaceMacrosInList(s.dry_sequence_breakers, input.substitute),
    dry_penalty_last_n: s.dry_penalty_last_n,
    max_tokens_second: s.max_tokens_second,
    sampler_priority: s.type === T.OOBA ? s.sampler_priority : undefined,
    samplers: s.type === T.LLAMACPP ? s.samplers : undefined,
    stopping_strings: stop,
    stop: [...stop],
    truncation_length: input.maxContext,
    ban_eos_token: s.ban_eos_token,
    skip_special_tokens: s.skip_special_tokens,
    include_reasoning: s.include_reasoning,
    top_a: s.top_a,
    tfs: s.tfs,
    epsilon_cutoff: s.type === T.OOBA || s.type === T.MANCER ? s.epsilon_cutoff : undefined,
    eta_cutoff: s.type === T.OOBA || s.type === T.MANCER ? s.eta_cutoff : undefined,
    mirostat_mode: s.mirostat_mode,
    mirostat_tau: s.mirostat_tau,
    mirostat_eta: s.mirostat_eta,
    custom_token_bans:
      s.type === T.APHRODITE || s.type === T.MANCER ? toIntArray(banned_tokens) : banned_tokens,
    banned_strings,
    api_type: s.type,
    api_server: getTextGenServer(s),
    sampler_order: s.type === T.KOBOLDCPP ? s.sampler_order : undefined,
    xtc_threshold: s.xtc_threshold,
    xtc_probability: s.xtc_probability,
    nsigma: s.nsigma,
    top_n_sigma: s.nsigma,
    min_keep: s.min_keep,
    adaptive_target: s.adaptive_target,
    adaptive_decay: s.adaptive_decay,
  };
  const nonAphroditeParams: TextGenParams = {
    rep_pen: s.rep_pen,
    rep_pen_range: s.rep_pen_range,
    repetition_decay: s.type === T.TABBY ? s.rep_pen_decay : undefined,
    repetition_penalty_range: s.rep_pen_range,
    encoder_repetition_penalty: s.type === T.OOBA ? s.encoder_rep_pen : undefined,
    no_repeat_ngram_size: s.type === T.OOBA ? s.no_repeat_ngram_size : undefined,
    penalty_alpha: s.type === T.OOBA ? s.penalty_alpha : undefined,
    temperature_last:
      s.type === T.OOBA || s.type === T.APHRODITE || s.type == T.TABBY
        ? s.temperature_last
        : undefined,
    speculative_ngram: s.type === T.TABBY ? s.speculative_ngram : undefined,
    do_sample: s.type === T.OOBA ? s.do_sample : undefined,
    seed: s.seed >= 0 ? s.seed : undefined,
    guidance_scale: input.cfgValues?.guidanceScale?.value ?? s.guidance_scale ?? 1,
    negative_prompt: input.cfgValues?.negativePrompt ?? input.substitute(s.negative_prompt) ?? '',
    grammar_string: s.grammar_string || undefined,
    json_schema: s.type === T.TABBY || s.type === T.LLAMACPP ? jsonSchema : undefined,
    repeat_penalty: s.rep_pen,
    repeat_last_n: s.rep_pen_range,
    n_predict: input.maxTokens,
    num_predict: input.maxTokens,
    num_ctx: input.maxContext,
    mirostat: s.mirostat_mode,
    ignore_eos: s.ban_eos_token,
    n_probs: input.requestTokenProbabilities ? 10 : undefined,
    rep_pen_slope: s.rep_pen_slope,
  };
  const vllmParams: TextGenParams = {
    n: canMultiSwipe ? s.n : 1,
    ignore_eos: s.ignore_eos_token,
    spaces_between_special_tokens: s.spaces_between_special_tokens,
    seed: s.seed >= 0 ? s.seed : undefined,
  };
  const aphroditeParams: TextGenParams = {
    n: canMultiSwipe ? s.n : 1,
    frequency_penalty: s.freq_pen,
    presence_penalty: s.presence_pen,
    repetition_penalty: s.rep_pen,
    seed: s.seed >= 0 ? s.seed : undefined,
    stop: [...stop],
    temperature: dynatemp ? (s.min_temp + s.max_temp) / 2 : s.temp,
    temperature_last: s.temperature_last,
    top_p: s.top_p,
    top_k: s.top_k,
    top_a: s.top_a,
    min_p: s.min_p,
    tfs: s.tfs,
    eta_cutoff: s.eta_cutoff,
    epsilon_cutoff: s.epsilon_cutoff,
    typical_p: s.typical_p,
    smoothing_factor: s.smoothing_factor,
    smoothing_curve: s.smoothing_curve,
    ignore_eos: s.ignore_eos_token,
    min_tokens: s.min_length,
    skip_special_tokens: s.skip_special_tokens,
    spaces_between_special_tokens: s.spaces_between_special_tokens,
    guided_grammar: s.grammar_string || undefined,
    guided_json: jsonSchema || undefined,
    early_stopping: false,
    include_stop_str_in_output: false,
    dynatemp_min: dynatemp ? s.min_temp : undefined,
    dynatemp_max: dynatemp ? s.max_temp : undefined,
    dynatemp_exponent: dynatemp ? s.dynatemp_exponent : undefined,
    xtc_threshold: s.xtc_threshold,
    xtc_probability: s.xtc_probability,
    nsigma: s.nsigma,
    custom_token_bans: toIntArray(banned_tokens),
    no_repeat_ngram_size: s.no_repeat_ngram_size,
    sampler_priority:
      s.type === T.APHRODITE &&
      JSON.stringify(s.samplers_priorities) !== JSON.stringify(APHRODITE_DEFAULT_ORDER)
        ? s.samplers_priorities
        : undefined,
  };

  if (s.type === T.OPENROUTER) {
    params['provider'] = s.openrouter_providers;
    params['quantizations'] = s.openrouter_quantizations;
    params['allow_fallbacks'] = s.openrouter_allow_fallbacks;
  }
  if (s.type === T.KOBOLDCPP) {
    params['grammar'] = s.grammar_string || undefined;
    params['grammar_retain_state'] = s.grammar_string && isContinue ? true : undefined;
    params['trim_stop'] = true;
    params['dry_sequence_breakers'] = parseSequenceBreakers(params['dry_sequence_breakers']);
  }
  if (s.type === T.HUGGINGFACE) {
    params['top_p'] = Math.min(Math.max(Number(params['top_p']), 0.0), 0.999);
    params['stop'] = Array.isArray(params['stop']) ? (params['stop'] as string[]).slice(0, 4) : [];
    nonAphroditeParams['seed'] =
      s.seed >= 0 ? s.seed : Math.floor((input.random ?? Math.random)() * Math.pow(2, 32));
  }
  if (s.type === T.MANCER) {
    params['n'] = canMultiSwipe ? s.n : 1;
    params['epsilon_cutoff'] = Number(params['epsilon_cutoff']) / 1000;
    params['eta_cutoff'] = Number(params['eta_cutoff']) / 1000;
    params['dynatemp_mode'] = params['dynamic_temperature'] ? 1 : 0;
    params['dynatemp_min'] = params['dynatemp_low'];
    params['dynatemp_max'] = params['dynatemp_high'];
    delete params['dynatemp_low'];
    delete params['dynatemp_high'];
    params['dry_sequence_breakers'] = parseSequenceBreakers(params['dry_sequence_breakers']);
  }
  if (s.type === T.TABBY || s.type === T.LLAMACPP) params['n'] = canMultiSwipe ? s.n : 1;

  switch (s.type) {
    case T.VLLM:
    case T.INFERMATICAI:
      params = Object.assign(params, vllmParams);
      break;
    case T.APHRODITE:
      params = Object.assign(params, aphroditeParams);
      break;
    default:
      params = Object.assign(params, nonAphroditeParams);
  }

  if (Array.isArray(s.logit_bias) && s.logit_bias.length && input.logitBias) {
    params['logit_bias'] = input.logitBias;
  }

  if (s.type === T.LLAMACPP || s.type === T.OLLAMA) {
    const lb = params['logit_bias'];
    const logitBiasArray: Array<[number, unknown]> =
      lb && typeof lb === 'object' && Object.keys(lb as object).length > 0
        ? Object.entries(lb as Record<string, unknown>).map(([k, v]) => [Number(k), v])
        : [];
    logitBiasArray.push(
      ...toIntArray(banned_tokens).map((x): [number, unknown] => [Number(x), false]),
    );
    const sequenceBreakers = parseSequenceBreakers(params['dry_sequence_breakers']);
    params = Object.assign(params, {
      logit_bias: logitBiasArray,
      grammar: s.grammar_string,
      cache_prompt: true,
      dry_sequence_breakers: sequenceBreakers,
    });
    if (!Array.isArray(sequenceBreakers) || sequenceBreakers.length === 0)
      delete params['dry_sequence_breakers'];
  }

  if (s.type === T.LLAMACPP || s.type === T.APHRODITE) {
    if (jsonSchema) {
      delete params['grammar_string'];
      delete params['grammar'];
      delete params['guided_grammar'];
    } else {
      delete params['json_schema'];
      delete params['guided_json'];
    }
  }
  return params;
}

/** util.trimV1 */
export function trimV1(str: unknown): string {
  return String(str ?? '')
    .replace(/\/$/, '')
    .replace(/\/v1$/, '');
}

/** 服务端 /generate 的 URL 路径 */
export function textCompletionEndpointPath(apiType: string): string {
  switch (apiType) {
    case T.DREAMGEN:
      return '/api/openai/v1/completions';
    case T.MANCER:
      return '/oai/v1/completions';
    case T.LLAMACPP:
      return '/completion';
    case T.OLLAMA:
      return '/api/generate';
    case T.OPENROUTER:
      return '/v1/chat/completions';
    default:
      return '/v1/completions';
  }
}

export interface TextCompletionUpstreamOptions {
  /** config ollama.keepAlive（默认 -1） */
  ollamaKeepAlive?: number | undefined;
  /** config ollama.batchSize（默认 -1 不传） */
  ollamaBatchSize?: number | undefined;
}

export interface TextCompletionUpstream {
  url: string;
  body: Record<string, unknown>;
  /** 流式解析方式：Ollama 是 JSON 行，其余 SSE */
  streamFormat: 'sse' | 'json_lines';
}

function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (keys.includes(k)) out[k] = v;
  return out;
}

/** 服务端 text-completions.js /generate：localhost → 127.0.0.1、trimV1、路径、按 api_type 过滤请求体 */
export function toTextCompletionUpstream(
  params: TextGenParams,
  options: TextCompletionUpstreamOptions = {},
): TextCompletionUpstream {
  const apiType = String(params['api_type'] ?? '');
  let apiServer = String(params['api_server'] ?? '');
  if (apiServer.includes('localhost')) apiServer = apiServer.replace('localhost', '127.0.0.1');
  const url = trimV1(apiServer) + textCompletionEndpointPath(apiType);
  let body: Record<string, unknown> = { ...params, api_server: apiServer };

  switch (apiType) {
    case T.TOGETHERAI:
      body = pick(body, TOGETHERAI_KEYS);
      break;
    case T.INFERMATICAI:
      body = pick(body, INFERMATICAI_KEYS);
      break;
    case T.FEATHERLESS:
      body = pick(body, FEATHERLESS_KEYS);
      break;
    case T.GENERIC:
      body = pick(body, OPENAI_KEYS);
      if (Array.isArray(body['stop'])) body['stop'] = (body['stop'] as unknown[]).slice(0, 4);
      break;
    case T.OPENROUTER: {
      const provider = body['provider'];
      if (Array.isArray(provider) && provider.length > 0) {
        body['provider'] = { allow_fallbacks: body['allow_fallbacks'] ?? true, order: provider };
      } else {
        delete body['provider'];
      }
      const quant = body['quantizations'];
      if (Array.isArray(quant) && quant.length > 0) {
        const p = (body['provider'] as Record<string, unknown> | undefined) ?? {};
        p['quantizations'] = quant;
        body['provider'] = p;
      }
      body = pick(body, OPENROUTER_KEYS);
      break;
    }
    case T.VLLM:
      body = pick(body, VLLM_KEYS);
      break;
    case T.OLLAMA: {
      const options_ = pick(body, OLLAMA_KEYS);
      const numBatch = Number(options.ollamaBatchSize ?? -1);
      if (numBatch > 0) options_['num_batch'] = numBatch;
      body = {
        model: body['model'],
        prompt: body['prompt'],
        stream: body['stream'] ?? false,
        keep_alive: Number(options.ollamaKeepAlive ?? -1),
        raw: true,
        options: options_,
      };
      break;
    }
    default:
      break;
  }
  return { url, body, streamFormat: apiType === T.OLLAMA ? 'json_lines' : 'sse' };
}

/** 便于宿主一次拿到 getStoppingStrings 所需的 state 字段 */
export type TextGenHostState = Pick<CoreState, 'mainApi' | 'powerUser'>;

/** src/additional-headers.js setAdditionalHeadersByType：给定密钥时各 api_type 的请求头 */
export function textCompletionHeaders(
  apiType: string,
  apiKey: string | null | undefined,
): Record<string, string> {
  const base: Record<string, string> =
    apiType === T.OPENROUTER
      ? { ...OPENROUTER_HEADERS }
      : apiType === T.FEATHERLESS
        ? { ...FEATHERLESS_HEADERS }
        : {};
  if (!apiKey) return base;
  switch (apiType) {
    case T.MANCER:
    case T.APHRODITE:
      return { ...base, 'X-API-KEY': apiKey, Authorization: `Bearer ${apiKey}` };
    case T.TABBY:
      return { ...base, 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` };
    case T.VLLM:
    case T.TOGETHERAI:
    case T.OOBA:
    case T.INFERMATICAI:
    case T.DREAMGEN:
    case T.OPENROUTER:
    case T.KOBOLDCPP:
    case T.LLAMACPP:
    case T.FEATHERLESS:
    case T.HUGGINGFACE:
    case T.GENERIC:
      return { ...base, Authorization: `Bearer ${apiKey}` };
    default:
      return base;
  }
}
