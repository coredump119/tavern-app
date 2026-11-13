/**
 * 请求体组装：
 * - createGenerationParameters：ST openai.js 前端发给 /api/backends/chat-completions/generate 的 generate_data
 * - toUpstreamRequestBody：ST 服务端 chat-completions.js /generate 对 OPENAI / CUSTOM 源最终发给上游的 requestBody（键顺序一致）
 * - serializeRequestBody：JSON.stringify（undefined 字段自然丢弃），与 ST 发出的字节一致
 * 只覆盖 OpenAI 兼容路径（OPENAI / CUSTOM / AZURE 的公共部分）；Claude / Google 等专有转换归 Phase 3。
 */
import { embedOpenRouterMedia } from './media.js';
import { CHAT_COMPLETION_SOURCES, type ChatCompletionMessage } from './types.js';
import { TEXT_COMPLETION_MODELS } from '../../tokens/types.js';
import { buildClaudeRequest, promptNamesFrom, type ClaudeConfig } from './claude.js';
import {
  buildCohereRequest,
  buildDeepSeekRequest,
  buildGoogleRequest,
  buildMistralRequest,
  buildXaiRequest,
  type GoogleConfig,
  type MistralConfig,
  type UpstreamRequest,
} from './providers.js';
import {
  PROMPT_PROCESSING_TYPE,
  addAssistantPrefix,
  postProcessPrompt,
  setJsonObjectFormat,
  type LooseMessage,
} from './post-process.js';
import {
  API_URLS,
  GEMINI_SAFETY,
  NANOGPT_REASONING_EFFORT_MAP,
  ZAI_ENDPOINT,
  SILICONFLOW_ENDPOINT,
  MINIMAX_ENDPOINT,
} from './provider-constants.js';
import {
  OPENAI_FIXED_REASONING_EFFORT,
  OPENAI_REASONING_EFFORT_MAP,
  OPENAI_REASONING_EFFORT_MODELS,
  OPENAI_VERBOSITY_MODELS,
} from './request-constants.js';
import { excludeKeysByYaml, mergeObjectWithYaml } from './yaml.js';

const S = CHAT_COMPLETION_SOURCES;

export const REASONING_EFFORT_TYPES = {
  auto: 'auto',
  min: 'min',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
} as const;
export const VERBOSITY_LEVELS = {
  auto: 'auto',
  low: 'low',
  medium: 'medium',
  high: 'high',
} as const;
/** openai.js openai_max_stop_strings */
export const OPENAI_MAX_STOP_STRINGS = 4;

/** oai_settings 中 createGenerationParameters 会读的字段 */
export interface GenerationSettings {
  chat_completion_source: string;
  temp_openai: number | string;
  freq_pen_openai: number | string;
  pres_pen_openai: number | string;
  top_p_openai: number | string;
  top_k_openai?: number | string | undefined;
  openai_max_tokens: number;
  stream_openai: boolean;
  n?: number | undefined;
  seed?: number | undefined;
  reverse_proxy?: string | undefined;
  proxy_password?: string | undefined;
  show_thoughts?: boolean | undefined;
  reasoning_effort?: string | undefined;
  verbosity?: string | undefined;
  enable_web_search?: boolean | undefined;
  request_images?: boolean | undefined;
  request_image_resolution?: string | undefined;
  request_image_aspect_ratio?: string | undefined;
  custom_prompt_post_processing?: string | undefined;
  bias_preset_selected?: string | undefined;
  bias_presets?: Record<string, unknown[]> | undefined;
  custom_url?: string | undefined;
  custom_include_body?: string | undefined;
  custom_exclude_body?: string | undefined;
  custom_include_headers?: string | undefined;
  azure_base_url?: string | undefined;
  azure_deployment_name?: string | undefined;
  azure_api_version?: string | undefined;
  use_sysprompt?: boolean | undefined;
  assistant_prefill?: string | undefined;
  assistant_impersonation?: string | undefined;
  continue_prefill?: boolean | undefined;
  claude_model?: string | undefined;
  openai_model?: string | undefined;
  custom_model?: string | undefined;
  openrouter_model?: string | undefined;
  [key: string]: unknown;
}

export interface GenerationParametersInput {
  settings: GenerationSettings;
  model: string;
  type: string;
  messages: ChatCompletionMessage[];
  /** name1 / name2 / getGroupNames() */
  userName: string;
  charName: string;
  groupNames: string[];
  /** getCustomStoppingStrings(openai_max_stop_strings) 的结果（宿主已过宏） */
  customStoppingStrings: string[];
  /** getCustomStoppingStrings() 不限数量的结果（Claude / Mistral / Chutes 用）；缺省同 customStoppingStrings */
  allCustomStoppingStrings?: string[] | undefined;
  /** substituteParams（Claude prefill 过宏）；缺省恒等 */
  substitute?: ((text: string) => string) | undefined;
  /** calculateLogitBias() 的结果；无 bias 预设时 undefined */
  logitBias?: Record<string, number> | undefined;
  /** power_user.request_token_probabilities */
  requestTokenProbabilities?: boolean | undefined;
  /** ToolManager.registerFunctionToolsOpenAI 的结果（Phase 3；默认无） */
  tools?: unknown[] | undefined;
  /** `auto` / `required` / `none`, or OpenAI's `{ type: 'function', function: { name } }` */
  toolChoice?: string | Record<string, unknown> | undefined;
  jsonSchema?: Record<string, unknown> | null | undefined;
}

export type GenerateData = Record<string, unknown> & {
  type: string;
  messages: ChatCompletionMessage[];
  model: string;
  chat_completion_source: string;
};

export interface GenerationParametersResult {
  generate_data: GenerateData;
  stream: boolean;
  canMultiSwipe: boolean;
}

const GPT_SOURCES: readonly string[] = [S.OPENAI, S.AZURE_OPENAI, S.OPENROUTER];
const SEED_SOURCES: readonly string[] = [
  S.OPENAI,
  S.AZURE_OPENAI,
  S.OPENROUTER,
  S.MISTRALAI,
  S.CUSTOM,
  S.COHERE,
  S.GROQ,
  S.ELECTRONHUB,
  S.NANOGPT,
  S.XAI,
  S.POLLINATIONS,
  S.AIMLAPI,
  S.VERTEXAI,
  S.MAKERSUITE,
  S.CHUTES,
];
const PROXY_SOURCES: readonly string[] = [
  S.CLAUDE,
  S.OPENAI,
  S.MISTRALAI,
  S.MAKERSUITE,
  S.VERTEXAI,
  S.DEEPSEEK,
  S.XAI,
  S.ZAI,
  S.MOONSHOT,
];
const LOGPROBS_SOURCES: readonly string[] = [
  S.OPENAI,
  S.AZURE_OPENAI,
  S.CUSTOM,
  S.DEEPSEEK,
  S.XAI,
  S.AIMLAPI,
  S.CHUTES,
];
export const LOGIT_BIAS_SOURCES: readonly string[] = [
  S.OPENAI,
  S.AZURE_OPENAI,
  S.OPENROUTER,
  S.ELECTRONHUB,
  S.CHUTES,
  S.CUSTOM,
];
const MULTISWIPE_SOURCES: readonly string[] = [
  S.OPENAI,
  S.AZURE_OPENAI,
  S.CUSTOM,
  S.XAI,
  S.AIMLAPI,
  S.MOONSHOT,
];
const REASONING_EFFORT_SOURCES: readonly string[] = [
  S.OPENAI,
  S.AZURE_OPENAI,
  S.CUSTOM,
  S.XAI,
  S.AIMLAPI,
  S.OPENROUTER,
  S.POLLINATIONS,
  S.PERPLEXITY,
  S.COMETAPI,
  S.ELECTRONHUB,
  S.CHUTES,
  S.DEEPSEEK,
];

/** openai.js getReasoningEffort（不含 ElectronHub 的模型能力表过滤） */
export function getReasoningEffort(
  settings: GenerationSettings,
  model: string,
): string | undefined {
  const src = settings.chat_completion_source;
  const effort = settings.reasoning_effort;
  if (!REASONING_EFFORT_SOURCES.includes(src)) return effort;
  if (src === S.DEEPSEEK) {
    switch (effort) {
      case REASONING_EFFORT_TYPES.auto:
        return undefined;
      case REASONING_EFFORT_TYPES.max:
        return REASONING_EFFORT_TYPES.max;
      default:
        return REASONING_EFFORT_TYPES.high;
    }
  }
  if (src === S.CUSTOM && /^koboldcpp\/(.+)$/.test(model)) {
    switch (effort) {
      case REASONING_EFFORT_TYPES.auto:
        return undefined;
      case REASONING_EFFORT_TYPES.min:
        return 'minimal';
      case REASONING_EFFORT_TYPES.low:
      case REASONING_EFFORT_TYPES.medium:
      case REASONING_EFFORT_TYPES.high:
        return effort;
      case REASONING_EFFORT_TYPES.max:
        return 'xhigh';
      default:
        return effort;
    }
  }
  switch (effort) {
    case REASONING_EFFORT_TYPES.auto:
      return undefined;
    case REASONING_EFFORT_TYPES.min:
      if (src === S.OPENROUTER && !settings.show_thoughts) return 'none';
      if (src === S.OPENAI || src === S.AZURE_OPENAI) {
        if (/^gpt-5\.(4|5)/.test(model)) return 'none';
        if (/^gpt-5/.test(model)) return REASONING_EFFORT_TYPES.min;
      }
      return REASONING_EFFORT_TYPES.low;
    case REASONING_EFFORT_TYPES.max:
      return REASONING_EFFORT_TYPES.high;
    default:
      return effort;
  }
}

/** openai.js getVerbosity */
export function getVerbosity(settings: GenerationSettings): string | undefined {
  if (settings.verbosity === VERBOSITY_LEVELS.auto) return undefined;
  return settings.verbosity;
}

/** openai.js createGenerationParameters（OpenAI 兼容源；其它源的专有参数仅保留公共部分） */
export function createGenerationParameters(
  input: GenerationParametersInput,
): GenerationParametersResult {
  const { settings, model, type } = input;
  const src = settings.chat_completion_source;
  const messages = input.messages.filter((m) => m && typeof m === 'object');
  const allStops = input.allCustomStoppingStrings ?? input.customStoppingStrings;

  const isO1 = GPT_SOURCES.includes(src) && ['o1-2024-12-17', 'o1'].includes(model);
  const isWorkersAIJsonMode = src === S.WORKERS_AI && !!input.jsonSchema;
  const stream = !!settings.stream_openai && type !== 'quiet' && !isO1 && !isWorkersAIJsonMode;

  const noMultiSwipeTypes = ['quiet', 'impersonate', 'continue'];
  const n = settings.n ?? 1;
  const canMultiSwipe =
    n > 1 && !noMultiSwipeTypes.includes(type) && MULTISWIPE_SOURCES.includes(src);

  let logit_bias: Record<string, number> | undefined = {};
  const biasList = settings.bias_preset_selected
    ? settings.bias_presets?.[settings.bias_preset_selected]
    : undefined;
  if (
    settings.bias_preset_selected &&
    LOGIT_BIAS_SOURCES.includes(src) &&
    Array.isArray(biasList) &&
    biasList.length
  ) {
    logit_bias = input.logitBias ?? {};
  }
  if (Object.keys(logit_bias).length === 0) logit_bias = undefined;

  const generate_data: GenerateData = {
    type,
    messages,
    model,
    temperature: Number(settings.temp_openai),
    frequency_penalty: Number(settings.freq_pen_openai),
    presence_penalty: Number(settings.pres_pen_openai),
    top_p: Number(settings.top_p_openai),
    max_tokens: settings.openai_max_tokens,
    stream,
    logit_bias,
    stop: input.customStoppingStrings,
    chat_completion_source: src,
    n: canMultiSwipe ? n : undefined,
    user_name: input.userName,
    char_name: input.charName,
    group_names: input.groupNames,
    include_reasoning: Boolean(settings.show_thoughts),
    reasoning_effort: getReasoningEffort(settings, model),
    enable_web_search: Boolean(settings.enable_web_search),
    request_images: Boolean(settings.request_images),
    request_image_resolution: String(settings.request_image_resolution ?? ''),
    request_image_aspect_ratio: String(settings.request_image_aspect_ratio ?? ''),
    custom_prompt_post_processing: settings.custom_prompt_post_processing,
    verbosity: getVerbosity(settings),
  };

  if (src === S.AZURE_OPENAI) {
    generate_data['azure_base_url'] = settings.azure_base_url;
    generate_data['azure_deployment_name'] = settings.azure_deployment_name;
    generate_data['azure_api_version'] = settings.azure_api_version;
    if (/^gpt-[34]/.test(model)) delete generate_data['reasoning_effort'];
  }

  if (!canMultiSwipe && input.tools && input.tools.length) {
    generate_data['tools'] = input.tools;
    generate_data['tool_choice'] = input.toolChoice ?? 'auto';
  }

  const stop = generate_data['stop'];
  if (!Array.isArray(stop) || !stop.length) delete generate_data['stop'];

  if (settings.reverse_proxy && PROXY_SOURCES.includes(src)) {
    generate_data['reverse_proxy'] = settings.reverse_proxy;
    generate_data['proxy_password'] = settings.proxy_password;
  }

  if (input.requestTokenProbabilities && LOGPROBS_SOURCES.includes(src)) {
    generate_data['logprobs'] = 5;
  }

  const isVision = (m: string) =>
    ['gpt', 'vision'].every((x) => typeof m === 'string' && m.includes(x));
  if (GPT_SOURCES.includes(src) && isVision(model)) {
    delete generate_data['logit_bias'];
    delete generate_data['stop'];
    delete generate_data['logprobs'];
  }
  if (GPT_SOURCES.includes(src) && /gpt-4.5/.test(model)) delete generate_data['logprobs'];

  if (src === S.CLAUDE) {
    const sub = input.substitute ?? ((t: string) => t);
    generate_data['top_k'] = Number(settings.top_k_openai);
    generate_data['use_sysprompt'] = settings.use_sysprompt;
    generate_data['stop'] = allStops;
    if (type !== 'quiet' && !(type === 'continue' && settings.continue_prefill)) {
      generate_data['assistant_prefill'] =
        type === 'impersonate'
          ? sub(String(settings.assistant_impersonation ?? ''))
          : sub(String(settings.assistant_prefill ?? ''));
    }
  }

  if (src === S.OPENROUTER) {
    generate_data['top_k'] = Number(settings.top_k_openai);
    generate_data['min_p'] = Number(settings['min_p_openai']);
    generate_data['repetition_penalty'] = Number(settings['repetition_penalty_openai']);
    generate_data['top_a'] = Number(settings['top_a_openai']);
    generate_data['use_fallback'] = settings['openrouter_use_fallback'];
    generate_data['provider'] = settings['openrouter_providers'];
    generate_data['quantizations'] = settings['openrouter_quantizations'];
    generate_data['allow_fallbacks'] = settings['openrouter_allow_fallbacks'];
    generate_data['middleout'] = settings['openrouter_middleout'];
  }

  if (src === S.NANOGPT) {
    generate_data['nanogpt_provider'] = settings['nanogpt_provider'];
    generate_data['nanogpt_payg_override'] = settings['nanogpt_payg_override'];
  }

  if (src === S.MAKERSUITE || src === S.VERTEXAI) {
    const stopStringsLimit = 5;
    generate_data['top_k'] = Number(settings.top_k_openai);
    generate_data['stop'] = allStops
      .slice(0, stopStringsLimit)
      .filter((x) => x.length >= 1 && x.length <= 16);
    generate_data['use_sysprompt'] = settings.use_sysprompt;
    if (src === S.VERTEXAI) {
      generate_data['vertexai_auth_mode'] = settings['vertexai_auth_mode'];
      generate_data['vertexai_region'] = settings['vertexai_region'];
      generate_data['vertexai_express_project_id'] = settings['vertexai_express_project_id'];
    }
  }

  if (src === S.MISTRALAI) {
    generate_data['safe_prompt'] = false;
    generate_data['stop'] = allStops;
  }

  if (src === S.CUSTOM) {
    generate_data['custom_url'] = settings.custom_url;
    generate_data['custom_include_body'] = settings.custom_include_body;
    generate_data['custom_exclude_body'] = settings.custom_exclude_body;
    generate_data['custom_include_headers'] = settings.custom_include_headers;
  }

  if (src === S.COHERE) {
    generate_data['top_p'] = Math.min(Math.max(Number(settings.top_p_openai), 0.01), 0.99);
    generate_data['top_k'] = Number(settings.top_k_openai);
    generate_data['frequency_penalty'] = Math.min(Math.max(Number(settings.freq_pen_openai), 0), 1);
    generate_data['presence_penalty'] = Math.min(Math.max(Number(settings.pres_pen_openai), 0), 1);
    generate_data['stop'] = allStops.slice(0, 5);
  }

  if (src === S.PERPLEXITY) {
    generate_data['top_k'] = Number(settings.top_k_openai);
    generate_data['frequency_penalty'] = Number(settings.freq_pen_openai);
    generate_data['presence_penalty'] = Number(settings.pres_pen_openai);
    delete generate_data['stop'];
  }

  if (src === S.GROQ) {
    delete generate_data['logprobs'];
    delete generate_data['logit_bias'];
    delete generate_data['top_logprobs'];
    delete generate_data['n'];
  }

  if (src === S.DEEPSEEK) {
    generate_data['top_p'] = generate_data['top_p'] || Number.EPSILON;
  }

  if (src === S.XAI) {
    if (model.includes('grok-3-mini')) {
      delete generate_data['presence_penalty'];
      delete generate_data['frequency_penalty'];
      delete generate_data['stop'];
    } else {
      delete generate_data['reasoning_effort'];
    }
    if (model.includes('grok-4') || model.includes('grok-code')) {
      delete generate_data['presence_penalty'];
      delete generate_data['frequency_penalty'];
      if (!model.includes('grok-4-fast-non-reasoning')) delete generate_data['stop'];
    }
  }

  if (src === S.ELECTRONHUB) {
    generate_data['top_k'] = Number(settings.top_k_openai);
  }

  if (src === S.CHUTES) {
    generate_data['min_p'] = Number(settings['min_p_openai']);
    generate_data['top_k'] =
      Number(settings.top_k_openai) > 0 ? Number(settings.top_k_openai) : undefined;
    generate_data['repetition_penalty'] = Number(settings['repetition_penalty_openai']);
    generate_data['stop'] = allStops;
  }

  if (src === S.ZAI) {
    generate_data['top_p'] = generate_data['top_p'] || 0.01;
    generate_data['stop'] = allStops.slice(0, 1);
    generate_data['zai_endpoint'] = settings['zai_endpoint'] || 'common';
    delete generate_data['presence_penalty'];
    delete generate_data['frequency_penalty'];
  }

  if (src === S.SILICONFLOW) {
    generate_data['siliconflow_endpoint'] = settings['siliconflow_endpoint'] || 'global';
  }

  if (src === S.MINIMAX) {
    generate_data['minimax_endpoint'] = settings['minimax_endpoint'] || 'global';
    const t = generate_data['temperature'];
    if (typeof t === 'number' && Number.isFinite(t))
      generate_data['temperature'] = Math.min(Math.max(t, Number.EPSILON), 1.0);
  }

  if (src === S.WORKERS_AI) {
    generate_data['workers_ai_account_id'] = settings['workers_ai_account_id'];
    generate_data['top_k'] =
      Number(settings.top_k_openai) > 0 ? Math.min(Number(settings.top_k_openai), 50) : undefined;
    generate_data['repetition_penalty'] = Number(settings['repetition_penalty_openai']);
    generate_data['seed'] = (settings.seed ?? -1) >= 1 ? Number(settings.seed) : undefined;
    generate_data['top_p'] = Math.max(Number(settings.top_p_openai), 0.001);
    delete generate_data['n'];
    delete generate_data['logit_bias'];
  }

  if (src === S.NANOGPT) {
    generate_data['top_k'] = Number(settings.top_k_openai);
    generate_data['min_p'] = Number(settings['min_p_openai']);
    generate_data['repetition_penalty'] = Number(settings['repetition_penalty_openai']);
    generate_data['top_a'] = Number(settings['top_a_openai']);
  }

  if (src === S.MOONSHOT && /kimi-k2.5/.test(model)) {
    delete generate_data['temperature'];
    delete generate_data['top_p'];
    delete generate_data['frequency_penalty'];
    delete generate_data['presence_penalty'];
  }

  if (SEED_SOURCES.includes(src) && (settings.seed ?? -1) >= 0) {
    generate_data['seed'] = settings.seed;
  }

  const isOSeries =
    ((src === S.OPENAI || src === S.AZURE_OPENAI) && /^(o1|o3|o4)/.test(model)) ||
    (src === S.OPENROUTER && /^openai\/(o1|o3|o4)/.test(model));
  if (isOSeries) {
    generate_data['max_completion_tokens'] = generate_data['max_tokens'];
    delete generate_data['max_tokens'];
    delete generate_data['logprobs'];
    delete generate_data['top_logprobs'];
    delete generate_data['stop'];
    delete generate_data['logit_bias'];
    delete generate_data['temperature'];
    delete generate_data['top_p'];
    delete generate_data['frequency_penalty'];
    delete generate_data['presence_penalty'];
    if (/^(openai\/)?(o1)/.test(model)) {
      for (const msg of generate_data.messages) if (msg.role === 'system') msg.role = 'user';
      delete generate_data['n'];
      delete generate_data['tools'];
      delete generate_data['tool_choice'];
    }
  }

  if (GPT_SOURCES.includes(src) && /gpt-5/.test(model)) {
    generate_data['max_completion_tokens'] = generate_data['max_tokens'];
    delete generate_data['max_tokens'];
    delete generate_data['logprobs'];
    delete generate_data['top_logprobs'];
    if (/gpt-5-chat-latest/.test(model)) {
      delete generate_data['tools'];
      delete generate_data['tool_choice'];
    } else if (
      /gpt-5\.(1|2|3|4)/.test(model) &&
      !/chat-latest/.test(model) &&
      !generate_data['reasoning_effort']
    ) {
      delete generate_data['frequency_penalty'];
      delete generate_data['presence_penalty'];
      delete generate_data['logit_bias'];
      delete generate_data['stop'];
    } else {
      delete generate_data['temperature'];
      delete generate_data['top_p'];
      delete generate_data['frequency_penalty'];
      delete generate_data['presence_penalty'];
      delete generate_data['logit_bias'];
      delete generate_data['stop'];
    }
  }

  if (input.jsonSchema) generate_data['json_schema'] = input.jsonSchema;

  return { generate_data, stream, canMultiSwipe };
}

export interface UpstreamOptions {
  /** config openai.randomizeUserId → user: uuid（默认关） */
  userId?: string | undefined;
  /** Pollinations 无 seed 时的随机源 */
  random?: (() => number) | undefined;
}

/** 服务端 /generate 通用（OpenAI 兼容）路径支持的源 */
export const GENERIC_UPSTREAM_SOURCES: readonly string[] = [
  S.OPENAI,
  S.OPENROUTER,
  S.CUSTOM,
  S.PERPLEXITY,
  S.GROQ,
  S.FIREWORKS,
  S.NANOGPT,
  S.POLLINATIONS,
  S.MOONSHOT,
  S.ZAI,
  S.SILICONFLOW,
  S.WORKERS_AI,
];

/**
 * 服务端 /generate 的通用分支：构造发给 `${apiUrl}/chat/completions` 的 requestBody（键顺序与 ST 一致）。
 * 附带各源需要的额外请求头。文本补全模型（TEXT_COMPLETION_MODELS）不支持。
 */
export function toUpstreamRequest(
  body: GenerateData,
  options: UpstreamOptions = {},
): {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  messages: ChatCompletionMessage[];
} {
  const src = body.chat_completion_source;
  if (!GENERIC_UPSTREAM_SOURCES.includes(src)) {
    throw new Error(`toUpstreamRequest: unsupported chat_completion_source ${src}`);
  }
  const isTextCompletion =
    (!!body.model && TEXT_COMPLETION_MODELS.includes(body.model)) ||
    typeof body.messages === 'string';
  if (isTextCompletion)
    throw new Error('toUpstreamRequest: text completion models are not supported');

  // messages 会被部分源就地改写：先拷贝
  let messages = structuredClone(body.messages) as unknown as LooseMessage[];
  const names = promptNamesFrom(body);
  const headers: Record<string, string> = {};
  const bodyParams: Record<string, unknown> = {};
  const schema = body['json_schema'] as
    { name?: string; description?: string; strict?: boolean; value?: unknown } | undefined;
  const logprobs = body['logprobs'];
  const setLogprobs = () => {
    bodyParams['logprobs'] = logprobs;
    bodyParams['top_logprobs'] = undefined;
    if (typeof logprobs === 'number' && logprobs > 0) {
      bodyParams['top_logprobs'] = logprobs;
      bodyParams['logprobs'] = true;
    }
  };
  const namedSchema = () => ({
    type: 'json_schema',
    json_schema: { name: schema!.name, strict: schema!.strict ?? true, schema: schema!.value },
  });

  switch (src) {
    case S.OPENAI:
      setLogprobs();
      if (options.userId) bodyParams['user'] = options.userId;
      break;
    case S.OPENROUTER: {
      const middleout = body['middleout'];
      bodyParams['transforms'] =
        middleout === 'on' ? ['middle-out'] : middleout === 'off' ? [] : undefined;
      bodyParams['plugins'] = body['enable_web_search'] ? [{ id: 'web' }] : [];
      bodyParams['reasoning'] = { exclude: !body['include_reasoning'] };
      if (body['min_p'] !== undefined) bodyParams['min_p'] = body['min_p'];
      if (body['top_a'] !== undefined) bodyParams['top_a'] = body['top_a'];
      if (body['repetition_penalty'] !== undefined)
        bodyParams['repetition_penalty'] = body['repetition_penalty'];
      const provider = body['provider'];
      if (Array.isArray(provider) && provider.length > 0) {
        bodyParams['provider'] = {
          allow_fallbacks: body['allow_fallbacks'] ?? true,
          order: provider,
        };
      }
      const quant = body['quantizations'];
      if (Array.isArray(quant) && quant.length > 0) {
        const p = (bodyParams['provider'] as Record<string, unknown> | undefined) ?? {};
        p['quantizations'] = quant;
        bodyParams['provider'] = p;
      }
      if (body['use_fallback']) bodyParams['route'] = 'fallback';
      if (body['reasoning_effort'])
        (bodyParams['reasoning'] as Record<string, unknown>)['effort'] = body['reasoning_effort'];
      if (body['verbosity']) bodyParams['verbosity'] = body['verbosity'];
      if (schema) bodyParams['response_format'] = namedSchema();
      if (/google\/gemini/.test(body.model)) bodyParams['safety_settings'] = GEMINI_SAFETY;
      break;
    }
    case S.CUSTOM: {
      setLogprobs();
      mergeObjectWithYaml(bodyParams, body['custom_include_body']);
      const extra: Record<string, unknown> = {};
      mergeObjectWithYaml(extra, body['custom_include_headers']);
      for (const [name, value] of Object.entries(extra)) headers[name] = String(value);
      if (schema) bodyParams['response_format'] = namedSchema();
      break;
    }
    case S.PERPLEXITY:
      bodyParams['reasoning_effort'] = body['reasoning_effort'];
      messages = postProcessPrompt(messages, PROMPT_PROCESSING_TYPE.STRICT, names);
      if (schema)
        bodyParams['response_format'] = {
          type: 'json_schema',
          json_schema: { schema: schema.value },
        };
      break;
    case S.GROQ:
    case S.FIREWORKS:
      if (schema) {
        bodyParams['response_format'] = {
          type: 'json_schema',
          json_schema: {
            name: schema.name,
            description: schema.description,
            schema: schema.value,
            strict: schema.strict ?? true,
          },
        };
      }
      break;
    case S.NANOGPT: {
      if (body['nanogpt_provider']) headers['X-Provider'] = String(body['nanogpt_provider']);
      if (body['nanogpt_payg_override']) {
        headers['X-Billing-Mode'] = 'paygo';
        bodyParams['billing_mode'] = 'paygo';
      }
      if (body['enable_web_search'] && !/:online$/.test(body.model))
        body = { ...body, model: `${body.model}:online` };
      if (body['min_p'] !== undefined) bodyParams['min_p'] = body['min_p'];
      if (body['top_a'] !== undefined) bodyParams['top_a'] = body['top_a'];
      if (body['repetition_penalty'] !== undefined)
        bodyParams['repetition_penalty'] = body['repetition_penalty'];
      if (body['reasoning_effort'])
        bodyParams['reasoning'] = {
          effort: NANOGPT_REASONING_EFFORT_MAP[String(body['reasoning_effort'])],
        };
      break;
    }
    case S.POLLINATIONS:
      bodyParams['reasoning_effort'] = body['reasoning_effort'];
      bodyParams['seed'] = body['seed'] ?? Math.floor((options.random ?? Math.random)() * 99999999);
      if (schema)
        bodyParams['response_format'] = {
          type: 'json_schema',
          json_schema: { schema: schema.value },
        };
      break;
    case S.MOONSHOT:
      bodyParams['thinking'] = { type: body['include_reasoning'] ? 'enabled' : 'disabled' };
      if (schema) setJsonObjectFormat(bodyParams, messages, { value: schema.value });
      else addAssistantPrefix(messages, [], 'partial');
      break;
    case S.ZAI:
      headers['Accept-Language'] = 'en-US,en';
      bodyParams['thinking'] = { type: body['include_reasoning'] ? 'enabled' : 'disabled' };
      if (schema) setJsonObjectFormat(bodyParams, messages, { value: schema.value });
      break;
    case S.SILICONFLOW:
      if (schema) setJsonObjectFormat(bodyParams, messages, { value: schema.value });
      break;
    case S.WORKERS_AI:
      bodyParams['repetition_penalty'] = body['repetition_penalty'];
      if (schema)
        bodyParams['response_format'] = { type: 'json_schema', json_schema: schema.value };
      break;
    default:
      break;
  }

  const effort = body['reasoning_effort'];
  if (effort && typeof effort === 'string' && (src === S.CUSTOM || src === S.OPENAI)) {
    if (OPENAI_REASONING_EFFORT_MODELS.includes(body.model)) {
      bodyParams['reasoning_effort'] =
        OPENAI_FIXED_REASONING_EFFORT[body.model] ?? OPENAI_REASONING_EFFORT_MAP[effort] ?? effort;
    }
    if (src === S.CUSTOM && /^koboldcpp\/(.+)$/.test(body.model))
      bodyParams['reasoning_effort'] = effort;
  }
  if (
    body['verbosity'] &&
    (src === S.CUSTOM || src === S.OPENAI) &&
    OPENAI_VERBOSITY_MODELS.test(body.model)
  ) {
    bodyParams['verbosity'] = body['verbosity'];
  }

  const stop = body['stop'];
  if (Array.isArray(stop) && stop.length > 0) bodyParams['stop'] = stop;

  const tools = body['tools'];
  if (Array.isArray(tools) && tools.length > 0) {
    bodyParams['tools'] = tools;
    bodyParams['tool_choice'] = body['tool_choice'];
  }

  if (schema && !bodyParams['response_format']) bodyParams['response_format'] = namedSchema();

  const out: Record<string, unknown> = {
    messages,
    prompt: undefined,
    model: body.model,
    temperature: body['temperature'],
    max_tokens: body['max_tokens'],
    max_completion_tokens: body['max_completion_tokens'],
    stream: body['stream'],
    presence_penalty: body['presence_penalty'],
    frequency_penalty: body['frequency_penalty'],
    top_p: body['top_p'],
    top_k: body['top_k'],
    stop: body['stop'],
    logit_bias: body['logit_bias'],
    seed: body['seed'],
    n: body['n'],
    ...bodyParams,
  };
  if (src === S.CUSTOM) excludeKeysByYaml(out, body['custom_exclude_body']);
  return { body: out, headers, messages: messages as unknown as ChatCompletionMessage[] };
}

/** 兼容旧签名：只要 body */
export function toUpstreamRequestBody(
  body: GenerateData,
  options: UpstreamOptions = {},
): Record<string, unknown> {
  return toUpstreamRequest(body, options).body;
}

/** 与 ST 服务端 `JSON.stringify(requestBody)` 一致的字节 */
export function serializeRequestBody(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

export const API_OPENAI = API_URLS.API_OPENAI;
export const API_OPENROUTER = 'https://openrouter.ai/api/v1';

export interface ChatCompletionEndpoint {
  url: string;
  headers: Record<string, string>;
  /** 用哪把钥匙：反代用 proxy_password，否则按源名从钥匙串取 */
  secret: { kind: 'proxy_password' } | { kind: 'keyring'; name: string } | { kind: 'none' };
  /** 宿主用：把 secret 变成 Rust 端可解析的引用（proxy_password 需要补上预设名） */
  /** 密钥放哪个头；缺省 Authorization: Bearer */
  authHeader?: string | undefined;
  /** 密钥在 url 的 `{{key}}` 占位里（Google） */
  keyInUrl?: boolean | undefined;
}

const PROXYABLE: readonly string[] = [
  S.CLAUDE,
  S.OPENAI,
  S.MISTRALAI,
  S.MAKERSUITE,
  S.VERTEXAI,
  S.DEEPSEEK,
  S.XAI,
  S.ZAI,
  S.MOONSHOT,
];

/**
 * 服务端各分支的 apiUrl、固定头与密钥来源；url 已含路径（chat/completions、messages、chat…）。
 * Google 的 url 含 `{{key}}` 占位，由宿主替换。
 */
export function resolveChatCompletionEndpoint(
  settings: GenerationSettings,
): ChatCompletionEndpoint {
  const src = settings.chat_completion_source;
  const proxy = String(settings.reverse_proxy ?? '');
  const secret = (name: string): ChatCompletionEndpoint['secret'] =>
    proxy && PROXYABLE.includes(src) ? { kind: 'proxy_password' } : { kind: 'keyring', name };
  const withBase = (def: string) =>
    new URL(proxy && PROXYABLE.includes(src) ? proxy : def).toString().replace(/\/$/, '');
  switch (src) {
    case S.OPENAI:
      return {
        url: `${withBase(API_URLS.API_OPENAI)}/chat/completions`,
        headers: {},
        secret: secret('api_key_openai'),
      };
    case S.CUSTOM:
      return {
        url: `${String(settings.custom_url ?? '').replace(/\/$/, '')}/chat/completions`,
        headers: {},
        secret: { kind: 'keyring', name: 'api_key_custom' },
      };
    case S.CLAUDE:
      return {
        url: `${withBase(API_URLS.API_CLAUDE)}/messages`,
        headers: { 'anthropic-version': '2023-06-01' },
        secret: secret('api_key_claude'),
        authHeader: 'x-api-key',
      };
    case S.OPENROUTER:
      return {
        url: `${API_OPENROUTER}/chat/completions`,
        headers: { 'HTTP-Referer': 'https://sillytavern.app', 'X-Title': 'SillyTavern' },
        secret: { kind: 'keyring', name: 'api_key_openrouter' },
      };
    case S.MAKERSUITE:
      return {
        url: `${withBase(API_URLS.API_MAKERSUITE)}/v1beta/models/{{model}}:{{method}}?key={{key}}`,
        headers: {},
        secret: secret('api_key_makersuite'),
        keyInUrl: true,
      };
    case S.MISTRALAI:
      return {
        url: `${withBase(API_URLS.API_MISTRAL)}/chat/completions`,
        headers: {},
        secret: secret('api_key_mistralai'),
      };
    case S.COHERE:
      return {
        url: `${API_URLS.API_COHERE_V2}/chat`,
        headers: {},
        secret: { kind: 'keyring', name: 'api_key_cohere' },
      };
    case S.DEEPSEEK:
      return {
        url: `${withBase(API_URLS.API_DEEPSEEK)}/chat/completions`,
        headers: {},
        secret: secret('api_key_deepseek'),
      };
    case S.XAI:
      return {
        url: `${withBase(API_URLS.API_XAI)}/chat/completions`,
        headers: {},
        secret: secret('api_key_xai'),
      };
    case S.PERPLEXITY:
      return {
        url: `${API_URLS.API_PERPLEXITY}/chat/completions`,
        headers: {},
        secret: { kind: 'keyring', name: 'api_key_perplexity' },
      };
    case S.GROQ:
      return {
        url: `${API_URLS.API_GROQ}/chat/completions`,
        headers: {},
        secret: { kind: 'keyring', name: 'api_key_groq' },
      };
    case S.FIREWORKS:
      return {
        url: `${API_URLS.API_FIREWORKS}/chat/completions`,
        headers: {},
        secret: { kind: 'keyring', name: 'api_key_fireworks' },
      };
    case S.NANOGPT:
      return {
        url: `${API_URLS.API_NANOGPT}/chat/completions`,
        headers: {},
        secret: { kind: 'keyring', name: 'api_key_nanogpt' },
      };
    case S.POLLINATIONS:
      return {
        url: `${API_URLS.API_POLLINATIONS}/chat/completions`,
        headers: {},
        secret: { kind: 'keyring', name: 'api_key_pollinations' },
      };
    case S.MOONSHOT:
      return {
        url: `${withBase(API_URLS.API_MOONSHOT)}/chat/completions`,
        headers: {},
        secret: secret('api_key_moonshot'),
      };
    case S.ZAI: {
      const def =
        settings['zai_endpoint'] === ZAI_ENDPOINT.CODING
          ? API_URLS.API_ZAI_CODING
          : API_URLS.API_ZAI_COMMON;
      return {
        url: `${withBase(def)}/chat/completions`,
        headers: { 'Accept-Language': 'en-US,en' },
        secret: secret('api_key_zai'),
      };
    }
    case S.SILICONFLOW: {
      const def =
        settings['siliconflow_endpoint'] === SILICONFLOW_ENDPOINT.CN
          ? API_URLS.API_SILICONFLOW_CN
          : API_URLS.API_SILICONFLOW;
      return {
        url: `${def}/chat/completions`,
        headers: {},
        secret: { kind: 'keyring', name: 'api_key_siliconflow' },
      };
    }
    case S.MINIMAX: {
      void MINIMAX_ENDPOINT;
      throw new Error('resolveChatCompletionEndpoint: minimax not supported yet');
    }
    default:
      throw new Error(`resolveChatCompletionEndpoint: unsupported source ${src}`);
  }
}

/** openai.js getChatCompletionModel（常用源） */
export function getChatCompletionModel(settings: GenerationSettings): string {
  switch (settings.chat_completion_source) {
    case S.CLAUDE:
      return String(settings.claude_model ?? '');
    case S.OPENAI:
      return String(settings.openai_model ?? '');
    case S.CUSTOM:
      return String(settings.custom_model ?? '');
    case S.OPENROUTER:
      return settings.openrouter_model !== 'OR_Website'
        ? String(settings.openrouter_model ?? '')
        : '';
    case S.MAKERSUITE:
      return String(settings['google_model'] ?? '');
    case S.VERTEXAI:
      return String(settings['vertexai_model'] ?? '');
    default: {
      const key = `${settings.chat_completion_source}_model`;
      return String(settings[key] ?? '');
    }
  }
}

/** 各专有源的 config.yaml 相关项 */
export interface UpstreamConfigs {
  claude?: ClaudeConfig | undefined;
  google?: GoogleConfig | undefined;
  mistral?: MistralConfig | undefined;
  upstream?: UpstreamOptions | undefined;
}

/**
 * 服务端 /generate 的总调度：先按 custom_prompt_post_processing 做 postProcessPrompt，再按源分派到各自的构造器。
 * 返回最终上游请求（url 可能含 `{{key}}` 占位）。
 */
export function buildUpstreamRequest(
  data: GenerateData,
  configs: UpstreamConfigs = {},
): UpstreamRequest {
  let input = data;
  const post = data['custom_prompt_post_processing'];
  if (Array.isArray(data.messages) && post) {
    const processed = postProcessPrompt(
      structuredClone(data.messages) as unknown as LooseMessage[],
      String(post),
      promptNamesFrom(data),
    );
    input = { ...data, messages: processed as unknown as ChatCompletionMessage[] };
  }
  switch (input.chat_completion_source) {
    case S.CLAUDE: {
      const r = buildClaudeRequest(input, configs.claude);
      return { url: r.url, headers: r.headers, body: r.body, authHeader: 'x-api-key' };
    }
    case S.MAKERSUITE:
    case S.VERTEXAI:
      return buildGoogleRequest(input, configs.google);
    case S.MISTRALAI:
      return buildMistralRequest(input, configs.mistral);
    case S.COHERE:
      return buildCohereRequest(input);
    case S.DEEPSEEK:
      return buildDeepSeekRequest(input);
    case S.XAI:
      return buildXaiRequest(input);
    default: {
      const ep = resolveChatCompletionEndpoint(input as unknown as GenerationSettings);
      // ST embedOpenRouterMedia: OpenAI / Custom send audio as input_audio, OpenRouter also video
      const src = input.chat_completion_source;
      if (
        (src === S.OPENAI || src === S.OPENROUTER || src === S.CUSTOM) &&
        Array.isArray(input.messages) &&
        input.messages.some((m) => Array.isArray(m.content))
      ) {
        const messages = structuredClone(input.messages);
        embedOpenRouterMedia(messages, { audio: true, video: src === S.OPENROUTER });
        input = { ...input, messages };
      }
      const r = toUpstreamRequest(input, configs.upstream);
      return { url: ep.url, headers: { ...ep.headers, ...r.headers }, body: r.body };
    }
  }
}

/** 把 endpoint.secret 变成 Rust 端的 SecretRef（proxy_password 需要当前代理预设名） */
export function secretRefFor(
  endpoint: Pick<ChatCompletionEndpoint, 'secret'>,
  selectedProxyPreset: string | null | undefined,
):
  { kind: 'keyring'; key: string } | { kind: 'proxy_password'; preset: string } | { kind: 'none' } {
  switch (endpoint.secret.kind) {
    case 'keyring':
      return { kind: 'keyring', key: endpoint.secret.name };
    case 'proxy_password':
      return selectedProxyPreset
        ? { kind: 'proxy_password', preset: selectedProxyPreset }
        : { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}
