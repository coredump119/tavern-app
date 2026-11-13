/**
 * 其余专有源：ST src/endpoints/backends/chat-completions.js 的 sendMakerSuiteRequest / sendMistralAIRequest /
 * sendCohereRequest / sendDeepSeekRequest / sendXaiRequest，与 prompt-converters.js 对应的 convert*。
 * 只产出 url / headers / body，不发送；密钥头由宿主填。
 */
import { promptNamesFrom, type PromptNames } from './claude.js';
import {
  PROMPT_PROCESSING_TYPE,
  addAssistantPrefix,
  postProcessPrompt,
  type LooseMessage,
} from './post-process.js';
import { API_URLS, GEMINI_SAFETY, VERTEX_SAFETY } from './provider-constants.js';
import type { GenerateData } from './request.js';

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** 密钥放哪个头；缺省 Authorization: Bearer */
  authHeader?: string | undefined;
  /** 密钥是否已经进了 url（Google 的 ?key=）——宿主此时不再加头 */
  keyInUrl?: boolean | undefined;
}

function startsWithGroupName(names: PromptNames, message: string): boolean {
  return names.groupNames.some((n) => message.startsWith(`${n}: `));
}
const clone = <T>(v: T): T => structuredClone(v);
const tryParse = (s: unknown): unknown => {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------- Google

export interface GoogleConfig {
  /** gemini.apiVersion */
  apiVersion: string;
  /** gemini.thoughtSignatures */
  thoughtSignatures: boolean;
}
export const DEFAULT_GOOGLE_CONFIG: GoogleConfig = {
  apiVersion: 'v1beta',
  thoughtSignatures: true,
};

const GEMINI_MEDIA_RESOLUTION: Record<string, string> = {
  low: 'media_resolution_low',
  high: 'media_resolution_high',
};

export interface GooglePrompt {
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  system_instruction: { parts: Array<{ text: string }> };
}

/** convertGooglePrompt(messages, model, useSysPrompt, names)：会就地修改 messages */
export function convertGooglePrompt(
  messages: LooseMessage[],
  model: string,
  useSysPrompt: boolean,
  names: PromptNames,
  config: GoogleConfig = DEFAULT_GOOGLE_CONFIG,
): GooglePrompt {
  const sysPrompt: string[] = [];
  if (useSysPrompt) {
    while (messages.length > 1 && messages[0]!.role === 'system') {
      const m = messages[0]!;
      const text = () => String(m.content);
      if (names.userName && m.name === 'example_user' && !text().startsWith(`${names.userName}: `))
        m.content = `${names.userName}: ${text()}`;
      if (
        names.charName &&
        m.name === 'example_assistant' &&
        !text().startsWith(`${names.charName}: `) &&
        !startsWithGroupName(names, text())
      ) {
        m.content = `${names.charName}: ${text()}`;
      }
      sysPrompt.push(text());
      messages.shift();
    }
  }
  const system_instruction = { parts: sysPrompt.map((text) => ({ text })) };
  const toolNameMap: Record<string, string> = {};
  const contents: GooglePrompt['contents'] = [];

  messages.forEach((message, index) => {
    if (message.role === 'system' || message.role === 'tool') message.role = 'user';
    else if (message.role === 'assistant') message.role = 'model';

    if (!Array.isArray(message.content)) {
      const toolCalls = message['tool_calls'];
      const toolCallId = message['tool_call_id'];
      const content: Record<string, unknown> =
        Array.isArray(toolCalls) && toolCalls.length > 0
          ? { type: 'tool_calls', tool_calls: toolCalls }
          : typeof toolCallId === 'string' && toolCallId.length > 0
            ? {
                type: 'tool_call_id',
                tool_call_id: toolCallId,
                content: String(message.content ?? ''),
              }
            : { type: 'text', text: String(message.content ?? '') };
      message.content = [content];
    }
    const partsIn = message.content as Array<Record<string, unknown>>;
    if (message.name) {
      for (const part of partsIn) {
        if (part['type'] !== 'text') continue;
        const t = String(part['text']);
        if (message.name === 'example_user') {
          if (names.userName && !t.startsWith(`${names.userName}: `))
            part['text'] = `${names.userName}: ${t}`;
        } else if (message.name === 'example_assistant') {
          if (
            names.charName &&
            !t.startsWith(`${names.charName}: `) &&
            !startsWithGroupName(names, t)
          )
            part['text'] = `${names.charName}: ${t}`;
        } else if (!t.startsWith(`${message.name}: `)) {
          part['text'] = `${message.name}: ${t}`;
        }
      }
      delete message.name;
    }

    const parts: Array<Record<string, unknown>> = [];
    const addDataUrlPart = (url: unknown, defaultMime: string, detail: unknown = null) => {
      if (typeof url === 'string' && url.startsWith('data:')) {
        const [header, base64Data] = url.split(',');
        const mimeType = /data:([^;]+)/.exec(header ?? '')?.[1] || defaultMime;
        const mediaResolution = GEMINI_MEDIA_RESOLUTION[String(detail)] || null;
        const part: Record<string, unknown> = { inlineData: { mimeType, data: base64Data } };
        if (/gemini-3/.test(model) && mediaResolution)
          part['mediaResolution'] = { level: mediaResolution };
        parts.push(part);
      }
    };
    for (const part of partsIn) {
      switch (part['type']) {
        case 'text':
          parts.push({ text: part['text'] });
          break;
        case 'tool_call_id': {
          const name = toolNameMap[String(part['tool_call_id'])] ?? 'unknown';
          parts.push({ functionResponse: { name, response: { name, content: part['content'] } } });
          break;
        }
        case 'tool_calls':
          for (const tc of part['tool_calls'] as Array<{
            id: string;
            function: { name: string; arguments: unknown };
            signature?: string;
          }>) {
            parts.push({
              functionCall: {
                name: tc.function.name,
                args: tryParse(tc.function.arguments) ?? tc.function.arguments,
              },
              ...(tc.signature ? { thoughtSignature: tc.signature } : {}),
            });
            toolNameMap[tc.id] = tc.function.name;
          }
          break;
        case 'image_url':
          addDataUrlPart(
            (part['image_url'] as { url?: string; detail?: string } | undefined)?.url,
            'image/png',
            (part['image_url'] as { detail?: string } | undefined)?.detail,
          );
          break;
        case 'video_url':
          addDataUrlPart(
            (part['video_url'] as { url?: string; detail?: string } | undefined)?.url,
            'video/mp4',
            (part['video_url'] as { detail?: string } | undefined)?.detail,
          );
          break;
        case 'audio_url':
          addDataUrlPart((part['audio_url'] as { url?: string } | undefined)?.url, 'audio/mpeg');
          break;
        default:
          break;
      }
    }

    if (/gemini-3/.test(model) || /gemini-2\.5/.test(model)) {
      const skip = 'skip_thought_signature_validator';
      const textSignature = message['signature'];
      for (const part of parts) {
        if (config.thoughtSignatures && textSignature && typeof part['text'] === 'string') {
          part['thoughtSignature'] = textSignature;
        } else if (/gemini-3/.test(model)) {
          if (part['functionCall'] && !part['thoughtSignature']) part['thoughtSignature'] = skip;
          if (
            /-image/.test(model) &&
            message.role === 'model' &&
            (typeof part['text'] === 'string' || part['inlineData'])
          ) {
            part['thoughtSignature'] = skip;
          }
        }
      }
    }

    const last = contents[contents.length - 1];
    if (index > 0 && last && message.role === last.role) {
      for (const part of parts) {
        if (part['text']) {
          const textPart = last.parts.find((p) => typeof p['text'] === 'string');
          if (textPart) textPart['text'] = `${String(textPart['text'])}\n\n${String(part['text'])}`;
          else last.parts.push(part);
        }
        if (
          part['inlineData'] ||
          part['functionCall'] ||
          part['functionResponse'] ||
          part['thoughtSignature'] ||
          part['mediaResolution']
        ) {
          last.parts.push(part);
        }
      }
    } else {
      contents.push({ role: message.role, parts });
    }
  });
  return { contents, system_instruction };
}

/** calculateGoogleBudgetTokens(maxTokens, reasoningEffort, model)：-1 为 auto，字串为 thinkingLevel，null 不设 */
export function calculateGoogleBudgetTokens(
  maxTokens: number,
  effort: string,
  model: string,
): number | string | null {
  const ratio = () => {
    switch (effort) {
      case 'low':
        return Math.floor(maxTokens * 0.1);
      case 'medium':
        return Math.floor(maxTokens * 0.25);
      case 'high':
        return Math.floor(maxTokens * 0.5);
      case 'max':
        return maxTokens;
      default:
        return 0;
    }
  };
  if (/gemini-3[.\d]*-pro/.test(model)) {
    return (
      (
        { auto: null, min: 'low', low: 'low', medium: 'low', high: 'high', max: 'high' } as Record<
          string,
          string | null
        >
      )[effort] ?? null
    );
  }
  if (/gemini-3[.\d]*-flash/.test(model)) {
    return (
      (
        {
          auto: null,
          min: 'minimal',
          low: 'low',
          medium: 'medium',
          high: 'high',
          max: 'high',
        } as Record<string, string | null>
      )[effort] ?? null
    );
  }
  if (/flash-lite/.test(model)) {
    if (effort === 'auto') return -1;
    if (effort === 'min') return 0;
    return Math.max(Math.min(ratio(), 24576), 512);
  }
  if (/flash/.test(model)) {
    if (effort === 'auto') return -1;
    if (effort === 'min') return 0;
    return Math.min(ratio(), 24576);
  }
  if (/pro/.test(model)) {
    if (effort === 'auto') return -1;
    const b = effort === 'min' ? 128 : ratio();
    return Math.max(Math.min(b, 32768), 128);
  }
  return null;
}

const IMAGE_GENERATION_MODELS = [
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash-exp-image-generation',
  'gemini-2.0-flash-preview-image-generation',
  'gemini-2.5-flash-image-preview',
  'gemini-2.5-flash-image',
  'gemini-3-pro-image-preview',
  'gemini-3.1-flash-image-preview',
];
const NO_SEARCH_MODELS = [
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-lite-001',
  'gemini-2.0-flash-lite-preview-02-05',
  'gemini-robotics-er-1.5-preview',
];

/** sendMakerSuiteRequest（Google AI Studio；Vertex 仅支持反代直连） */
export function buildGoogleRequest(
  data: GenerateData,
  config: GoogleConfig = DEFAULT_GOOGLE_CONFIG,
): UpstreamRequest {
  const useVertexAi = data.chat_completion_source === 'vertexai';
  const model = String(data.model);
  const stream = Boolean(data['stream']);
  const enableWebSearch = Boolean(data['enable_web_search']);
  const requestImages = Boolean(data['request_images']);
  const reasoningEffort = String(data['reasoning_effort']);
  const includeReasoning = Boolean(data['include_reasoning']);
  const aspectRatio = String(data['request_image_aspect_ratio']);
  const imageSize = String(data['request_image_resolution']);
  const isGemma3 = /gemma-3/.test(model);
  const isLearnLM = model.includes('learnlm');
  const schema = data['json_schema'] as { value?: unknown } | undefined;
  const responseMimeType = data['responseMimeType'] ?? (schema ? 'application/json' : undefined);
  const responseSchema = data['responseSchema'] ?? (schema ? schema.value : undefined);

  const generationConfig: Record<string, unknown> = {
    stopSequences: data['stop'],
    candidateCount: 1,
    maxOutputTokens: data['max_tokens'],
    temperature: data['temperature'],
    topP: data['top_p'],
    topK: data['top_k'] || undefined,
    responseMimeType,
    responseSchema,
    seed: data['seed'],
  };
  const isThinkingConfigModel = (m: string) =>
    (/^gemini-2.5-(flash|pro)/.test(m) && !/-image(-preview)?$/.test(m)) ||
    /^gemini-3[.\d]*-(flash|pro)/.test(m);
  const isImageSizeModel = (m: string) => /^gemini-3/.test(m);
  if (
    !Array.isArray(generationConfig['stopSequences']) ||
    !(generationConfig['stopSequences'] as unknown[]).length
  )
    delete generationConfig['stopSequences'];

  const enableImageModality = requestImages && IMAGE_GENERATION_MODELS.includes(model);
  if (enableImageModality) {
    generationConfig['responseModalities'] = ['text', 'image'];
    if (aspectRatio || imageSize) {
      const ic: Record<string, unknown> = {};
      if (imageSize && isImageSizeModel(model)) ic['imageSize'] = imageSize;
      if (aspectRatio) ic['aspectRatio'] = aspectRatio;
      generationConfig['imageConfig'] = ic;
    }
  }
  const useSystemPrompt = !enableImageModality && !isGemma3 && Boolean(data['use_sysprompt']);
  const tools: Array<Record<string, unknown>> = [];
  const prompt = convertGooglePrompt(
    clone(data.messages) as unknown as LooseMessage[],
    model,
    useSystemPrompt,
    promptNamesFrom(data),
    config,
  );
  const safetySettings = [...GEMINI_SAFETY, ...(useVertexAi ? VERTEX_SAFETY : [])];

  const inTools = data['tools'];
  if (Array.isArray(inTools) && inTools.length > 0 && !enableImageModality && !isGemma3) {
    const functionDeclarations: unknown[] = [];
    const customTools: Array<Record<string, unknown>> = [];
    for (const tool of clone(inTools) as Array<Record<string, unknown>>) {
      if (tool['type'] === 'function') {
        const fn = tool['function'] as { parameters?: Record<string, unknown> };
        if (fn.parameters?.['$schema']) delete fn.parameters['$schema'];
        if (
          fn.parameters?.['properties'] &&
          Object.keys(fn.parameters['properties'] as object).length === 0
        )
          delete fn.parameters;
        functionDeclarations.push(fn);
      } else if (tool[String(tool['type'])]) {
        customTools.push({ [String(tool['type'])]: tool[String(tool['type'])] });
      }
    }
    if (functionDeclarations.length > 0)
      tools.push({ function_declarations: functionDeclarations });
    if (functionDeclarations.length === 0 && customTools.length > 0) tools.push(...customTools);
  }
  if (
    enableWebSearch &&
    !enableImageModality &&
    !isGemma3 &&
    !isLearnLM &&
    !NO_SEARCH_MODELS.includes(model)
  ) {
    if (!tools.some((t) => t['function_declarations'])) tools.push({ google_search: {} });
  }
  if (isThinkingConfigModel(model)) {
    const thinkingConfig: Record<string, unknown> = { includeThoughts: includeReasoning };
    const budget = calculateGoogleBudgetTokens(
      Number(generationConfig['maxOutputTokens']),
      reasoningEffort,
      model,
    );
    if (typeof budget === 'number' && Number.isInteger(budget))
      thinkingConfig['thinkingBudget'] = budget;
    if (typeof budget === 'string' && budget.length > 0) thinkingConfig['thinkingLevel'] = budget;
    if (useVertexAi && budget === 0 && thinkingConfig['includeThoughts'])
      thinkingConfig['includeThoughts'] = false;
    generationConfig['thinkingConfig'] = thinkingConfig;
  }

  const body: Record<string, unknown> = {
    contents: prompt.contents,
    safetySettings,
    generationConfig,
  };
  if (useSystemPrompt && prompt.system_instruction.parts.length)
    body['systemInstruction'] = prompt.system_instruction;
  if (tools.length) {
    body['tools'] = tools;
    const toolChoice = data['tool_choice'];
    let fcc: Record<string, unknown> | undefined;
    if (typeof toolChoice === 'string') {
      fcc = (
        { none: { mode: 'NONE' }, required: { mode: 'ANY' }, auto: { mode: 'AUTO' } } as Record<
          string,
          Record<string, unknown>
        >
      )[toolChoice];
    } else if (toolChoice && typeof toolChoice === 'object') {
      const name = (toolChoice as { function?: { name?: string } }).function?.name;
      if (name) fcc = { mode: 'ANY', allowedFunctionNames: [name] };
    }
    if (fcc) body['toolConfig'] = { functionCallingConfig: fcc };
  }

  const responseType = stream ? 'streamGenerateContent' : 'generateContent';
  if (useVertexAi) {
    const base = new URL(String(data['reverse_proxy'] || API_URLS.API_VERTEX_AI))
      .toString()
      .replace(/\/$/, '');
    return {
      url: `${base}/v1/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`,
      headers: {},
      body,
    };
  }
  const base = new URL(String(data['reverse_proxy'] || API_URLS.API_MAKERSUITE))
    .toString()
    .replace(/\/$/, '');
  // ?key= 由宿主拼上密钥：url 里用占位 {{key}}
  return {
    url: `${base}/${config.apiVersion}/models/${model}:${responseType}?key={{key}}${stream ? '&alt=sse' : ''}`,
    headers: {},
    body,
    keyInUrl: true,
  };
}

// ---------------------------------------------------------------- Mistral

export interface MistralConfig {
  enablePrefix: boolean;
  /** crypto.createHash('sha512').update(id).digest('hex').slice(0, 9)；core 无 Node crypto，宿主注入 */
  sanitizeToolId?: ((id: string) => string) | undefined;
}
export const DEFAULT_MISTRAL_CONFIG: MistralConfig = { enablePrefix: false };

/** convertMistralMessages：会就地修改 */
export function convertMistralMessages(
  messages: LooseMessage[],
  names: PromptNames,
  config: MistralConfig = DEFAULT_MISTRAL_CONFIG,
): LooseMessage[] {
  if (!Array.isArray(messages)) return [];
  const last = messages[messages.length - 1];
  if (config.enablePrefix && messages.length > 0 && last?.role === 'assistant')
    last['prefix'] = true;
  const sanitize = config.sanitizeToolId ?? ((id: string) => id);
  for (const msg of messages) {
    const text = () => String(msg.content);
    if (Array.isArray(msg['tool_calls']))
      for (const tool of msg['tool_calls'] as Array<{ id: string }>) tool.id = sanitize(tool.id);
    if ('tool_call_id' in msg && msg.role === 'tool')
      msg['tool_call_id'] = sanitize(String(msg['tool_call_id']));
    if (msg.role === 'system' && msg.name === 'example_assistant') {
      if (
        names.charName &&
        !text().startsWith(`${names.charName}: `) &&
        !startsWithGroupName(names, text())
      )
        msg.content = `${names.charName}: ${text()}`;
      delete msg.name;
    }
    if (msg.role === 'system' && msg.name === 'example_user') {
      if (names.userName && !text().startsWith(`${names.userName}: `))
        msg.content = `${names.userName}: ${text()}`;
      delete msg.name;
    }
    if (msg.name && msg.role !== 'system' && !text().startsWith(`${msg.name}: `)) {
      msg.content = `${msg.name}: ${text()}`;
      delete msg.name;
    }
  }
  let rerun = true;
  while (rerun) {
    rerun = false;
    for (let i = 0; i < messages.length; i++) {
      if (i === messages.length - 1) continue;
      if (messages[i]!.role === 'tool' && messages[i + 1]!.role === 'user') {
        const lastUser = messages.slice(0, i).findLastIndex((m) => m.role === 'user' && m.content);
        if (lastUser !== -1) {
          messages[lastUser]!.content =
            `${String(messages[lastUser]!.content)}\n\n${String(messages[i + 1]!.content)}`;
          messages.splice(i + 1, 1);
          rerun = true;
        }
      }
    }
  }
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i]!.role === 'assistant' && messages[i + 1]!.role === 'system')
      messages[i + 1]!.role = 'user';
  }
  return messages;
}

/** sendMistralAIRequest */
export function buildMistralRequest(
  data: GenerateData,
  config: MistralConfig = DEFAULT_MISTRAL_CONFIG,
): UpstreamRequest {
  const messages = convertMistralMessages(
    clone(data.messages) as unknown as LooseMessage[],
    promptNamesFrom(data),
    config,
  );
  const stop = data['stop'];
  const body: Record<string, unknown> = {
    model: data.model,
    messages,
    temperature: data['temperature'],
    top_p: data['top_p'],
    frequency_penalty: data['frequency_penalty'],
    presence_penalty: data['presence_penalty'],
    max_tokens: data['max_tokens'],
    stream: data['stream'],
    safe_prompt: data['safe_prompt'],
    random_seed: data['seed'] === -1 ? undefined : data['seed'],
    stop: Array.isArray(stop) && stop.length > 0 ? stop : undefined,
  };
  const tools = data['tools'];
  if (Array.isArray(tools) && tools.length > 0) {
    body['tools'] = tools;
    body['tool_choice'] = data['tool_choice'];
  }
  const schema = data['json_schema'] as
    { name?: string; description?: string; value?: unknown; strict?: boolean } | undefined;
  if (schema) {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: {
        name: schema.name,
        description: schema.description,
        schema: schema.value,
        strict: schema.strict ?? true,
      },
    };
  }
  const base = new URL(String(data['reverse_proxy'] || API_URLS.API_MISTRAL)).toString();
  return { url: `${base}/chat/completions`, headers: {}, body };
}

// ---------------------------------------------------------------- Cohere

/** convertCohereMessages：会就地修改 */
export function convertCohereMessages(
  messages: LooseMessage[],
  names: PromptNames,
  placeholder = PROMPT_PLACEHOLDER_COHERE,
): { chatHistory: LooseMessage[] } {
  if (messages.length === 0) messages.unshift({ role: 'user', content: placeholder });
  messages.forEach((msg, index) => {
    const text = () => String(msg.content);
    const toolCalls = msg['tool_calls'];
    if (Array.isArray(toolCalls)) {
      if (index > 0 && messages[index - 1]!.role === 'assistant') {
        msg.content = messages[index - 1]!.content;
        messages.splice(index - 1, 1);
      } else {
        msg.content = `I'm going to call a tool for that: ${(toolCalls as Array<{ function?: { name?: string } }>).map((tc) => tc?.function?.name).join(', ')}`;
      }
    }
    if (msg.name) {
      if (msg.role == 'system' && msg.name == 'example_assistant') {
        if (
          names.charName &&
          !text().startsWith(`${names.charName}: `) &&
          !startsWithGroupName(names, text())
        )
          msg.content = `${names.charName}: ${text()}`;
      }
      if (msg.role == 'system' && msg.name == 'example_user') {
        if (names.userName && !text().startsWith(`${names.userName}: `))
          msg.content = `${names.userName}: ${text()}`;
      }
      if (msg.role !== 'system' && !text().startsWith(`${msg.name}: `))
        msg.content = `${msg.name}: ${text()}`;
      delete msg.name;
    }
  });
  return { chatHistory: messages };
}
const PROMPT_PLACEHOLDER_COHERE = '[Start a new chat]';

/** sendCohereRequest（v2 /chat；无反代） */
export function buildCohereRequest(data: GenerateData): UpstreamRequest {
  const converted = convertCohereMessages(
    clone(data.messages) as unknown as LooseMessage[],
    promptNamesFrom(data),
  );
  const tools: Array<Record<string, unknown>> = [];
  const inTools = data['tools'];
  if (Array.isArray(inTools) && inTools.length > 0) {
    tools.push(...(clone(inTools) as Array<Record<string, unknown>>));
    for (const tool of tools) {
      const params = (tool['function'] as { parameters?: Record<string, unknown> } | undefined)
        ?.parameters;
      if (params?.['$schema']) delete params['$schema'];
    }
  }
  const body: Record<string, unknown> = {
    stream: Boolean(data['stream']),
    model: data.model,
    messages: converted.chatHistory,
    temperature: data['temperature'],
    max_tokens: data['max_tokens'],
    k: data['top_k'],
    p: data['top_p'],
    seed: data['seed'],
    stop_sequences: data['stop'],
    frequency_penalty: data['frequency_penalty'],
    presence_penalty: data['presence_penalty'],
    documents: [],
    tools,
  };
  if (String(data.model).endsWith('08-2024')) body['safety_mode'] = 'OFF';
  const schema = data['json_schema'] as { value?: unknown } | undefined;
  if (schema) body['response_format'] = { type: 'json_schema', schema: schema.value };
  return { url: `${API_URLS.API_COHERE_V2}/chat`, headers: {}, body };
}

// ---------------------------------------------------------------- DeepSeek

/** addReasoningContentToToolCalls */
export function addReasoningContentToToolCalls(messages: LooseMessage[]): void {
  for (const message of messages) {
    if (!Array.isArray(message['tool_calls']) || 'reasoning_content' in message) continue;
    message['reasoning_content'] = '';
  }
}

/** sendDeepSeekRequest */
export function buildDeepSeekRequest(data: GenerateData): UpstreamRequest {
  const bodyParams: Record<string, unknown> = {};
  const logprobs = data['logprobs'];
  if (typeof logprobs === 'number' && logprobs > 0) {
    bodyParams['top_logprobs'] = logprobs;
    bodyParams['logprobs'] = true;
  }
  const inTools = data['tools'];
  if (Array.isArray(inTools) && inTools.length > 0) {
    const tools = clone(inTools) as Array<Record<string, unknown>>;
    bodyParams['tools'] = tools;
    bodyParams['tool_choice'] = data['tool_choice'];
    for (const tool of tools) {
      const params = (tool['function'] as { parameters?: Record<string, unknown> } | undefined)
        ?.parameters;
      const required = params?.['required'];
      if (Array.isArray(required) && required.length === 0 && params) delete params['required'];
    }
  }
  const messages = clone(data.messages) as unknown as LooseMessage[];
  const schema = data['json_schema'] as { value?: unknown } | undefined;
  if (schema) {
    bodyParams['response_format'] = { type: 'json_object' };
    messages.push({
      role: 'user',
      content: `JSON schema for the response:\n${JSON.stringify(schema.value, null, 4)}`,
    });
  }
  const processed = addAssistantPrefix(
    postProcessPrompt(messages, PROMPT_PROCESSING_TYPE.SEMI_TOOLS, promptNamesFrom(data)),
    bodyParams['tools'] as unknown[] | undefined,
    'prefix',
  );
  addReasoningContentToToolCalls(processed);
  if (data['include_reasoning'] && data['reasoning_effort'])
    bodyParams['reasoning_effort'] = data['reasoning_effort'];
  const body: Record<string, unknown> = {
    messages: processed,
    model: data.model,
    temperature: data['temperature'],
    max_tokens: data['max_tokens'],
    stream: data['stream'],
    presence_penalty: data['presence_penalty'],
    frequency_penalty: data['frequency_penalty'],
    top_p: data['top_p'],
    stop: data['stop'],
    seed: data['seed'],
    thinking: { type: data['include_reasoning'] ? 'enabled' : 'disabled' },
    ...bodyParams,
  };
  const base = new URL(String(data['reverse_proxy'] || API_URLS.API_DEEPSEEK)).toString();
  return { url: `${base}/chat/completions`, headers: {}, body };
}

// ---------------------------------------------------------------- xAI

/** convertXAIMessages：会就地修改 */
export function convertXAIMessages(messages: LooseMessage[], names: PromptNames): LooseMessage[] {
  if (!Array.isArray(messages)) return [];
  for (const msg of messages) {
    if (!msg.name || msg.role === 'user') continue;
    const text = String(msg.content);
    const charCond =
      !!names.charName &&
      !text.startsWith(`${names.charName}: `) &&
      !startsWithGroupName(names, text);
    const userCond = !!names.userName && !text.startsWith(`${names.userName}: `);
    const rules: Array<{ role: string; name?: string; condition: boolean }> = [
      { role: 'assistant', condition: charCond },
      { role: 'system', name: 'example_assistant', condition: charCond },
      { role: 'system', name: 'example_user', condition: userCond },
    ];
    const match = rules.find(
      (r) => msg.role === r.role && (!r.name || msg.name === r.name) && r.condition,
    );
    if (match) {
      const prefix =
        msg.role === 'system' && msg.name === 'example_user' ? names.userName : names.charName;
      msg.content = `${prefix}: ${text}`;
    }
    delete msg.name;
  }
  return messages;
}

/** sendXaiRequest */
export function buildXaiRequest(data: GenerateData): UpstreamRequest {
  const bodyParams: Record<string, unknown> = {};
  const logprobs = data['logprobs'];
  if (typeof logprobs === 'number' && logprobs > 0) {
    bodyParams['top_logprobs'] = logprobs;
    bodyParams['logprobs'] = true;
  }
  const tools = data['tools'];
  if (Array.isArray(tools) && tools.length > 0) {
    bodyParams['tools'] = tools;
    bodyParams['tool_choice'] = data['tool_choice'];
  }
  const stop = data['stop'];
  if (Array.isArray(stop) && stop.length > 0) bodyParams['stop'] = stop;
  if (data['reasoning_effort'])
    bodyParams['reasoning_effort'] = data['reasoning_effort'] === 'high' ? 'high' : 'low';
  const schema = data['json_schema'] as
    { name?: string; value?: unknown; strict?: boolean } | undefined;
  if (schema)
    bodyParams['response_format'] = {
      type: 'json_schema',
      json_schema: { name: schema.name, strict: schema.strict ?? true, schema: schema.value },
    };
  const messages = convertXAIMessages(
    clone(data.messages) as unknown as LooseMessage[],
    promptNamesFrom(data),
  );
  const body: Record<string, unknown> = {
    messages,
    model: data.model,
    temperature: data['temperature'],
    max_tokens: data['max_tokens'],
    max_completion_tokens: data['max_completion_tokens'],
    stream: data['stream'],
    presence_penalty: data['presence_penalty'],
    frequency_penalty: data['frequency_penalty'],
    top_p: data['top_p'],
    seed: data['seed'],
    n: data['n'],
    ...bodyParams,
  };
  const base = new URL(String(data['reverse_proxy'] || API_URLS.API_XAI)).toString();
  return { url: `${base}/chat/completions`, headers: {}, body };
}
