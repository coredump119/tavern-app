/**
 * Anthropic：ST src/prompt-converters.js 的 convertClaudePrompt / convertClaudeMessages / calculateClaudeBudgetTokens /
 * cachingAtDepthForClaude，以及 src/endpoints/backends/chat-completions.js sendClaudeRequest 的请求体与头（不含发送）。
 */
import type { ChatCompletionMessage } from './types.js';
import type { GenerateData } from './request.js';

export const API_CLAUDE = 'https://api.anthropic.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';

/** 服务端 getPromptNames(request) */
export interface PromptNames {
  charName: string;
  userName: string;
  groupNames: string[];
}
export function promptNamesFrom(data: Record<string, unknown>): PromptNames {
  const groups = data['group_names'];
  return {
    charName: String(data['char_name'] || ''),
    userName: String(data['user_name'] || ''),
    groupNames: Array.isArray(groups) ? groups.map(String) : [],
  };
}
function startsWithGroupName(names: PromptNames, message: string): boolean {
  return names.groupNames.some((n) => message.startsWith(`${n}: `));
}

type Loose = Record<string, unknown> & { role: string; content: unknown; name?: string };

/**
 * convertClaudePrompt(messages, addAssistantPostfix, addAssistantPrefill, withSysPromptSupport, useSystemPrompt, addSysHumanMsg, excludePrefixes)
 * 旧文本格式；分词计数用的是全 false 的调用。会就地修改 messages（与 ST 一致），调用方传副本。
 */
export function convertClaudePrompt(
  messages: Loose[],
  addAssistantPostfix = false,
  addAssistantPrefill = '',
  withSysPromptSupport = false,
  useSystemPrompt = false,
  addSysHumanMsg = '',
  excludePrefixes = false,
): string {
  if (messages.length > 0) {
    for (const m of messages) {
      if (!m.content) m.content = '';
      if (m['tool_calls']) m.content = String(m.content) + JSON.stringify(m['tool_calls']);
    }
    if (excludePrefixes) {
      for (const m of messages.slice(0, -1)) m.role = 'system';
    } else {
      messages[0]!.role = 'system';
    }
    if (addAssistantPostfix) {
      messages.push({ role: 'assistant', content: addAssistantPrefill || '' });
    }
    let hasUser = false;
    const firstAssistantIndex = messages.findIndex((message, i) => {
      if (i >= 0 && (message.role === 'user' || String(message.content).includes('\n\nHuman: ')))
        hasUser = true;
      return message.role === 'assistant' && i > 0;
    });
    if (withSysPromptSupport && useSystemPrompt) {
      messages[0]!.role = 'system';
      if (firstAssistantIndex > 0 && addSysHumanMsg && !hasUser) {
        messages.splice(firstAssistantIndex, 0, { role: 'user', content: addSysHumanMsg });
      }
    } else {
      messages[0]!.role = 'user';
      if (firstAssistantIndex > 0 && !excludePrefixes) {
        const prev = messages[firstAssistantIndex - 1]!;
        prev.role = firstAssistantIndex - 1 !== 0 && prev.role === 'user' ? 'FixHumMsg' : prev.role;
      }
    }
  }
  return messages
    .map((v, i) => {
      const prefixes: Record<string, string> = {
        assistant: '\n\nAssistant: ',
        user: '\n\nHuman: ',
        system:
          i === 0
            ? ''
            : v.name === 'example_assistant'
              ? '\n\nA: '
              : v.name === 'example_user'
                ? '\n\nH: '
                : excludePrefixes && v.name
                  ? `\n\n${v.name}: `
                  : '\n\n',
        FixHumMsg: '\n\nFirst message: ',
      };
      const prefix = prefixes[v.role] ?? '';
      return `${prefix}${v.name && v.role !== 'system' ? `${v.name}: ` : ''}${String(v.content)}`;
    })
    .join('');
}

export type ClaudeContent = Record<string, unknown> & { type: string };
export interface ClaudeMessage {
  role: string;
  content: ClaudeContent[];
}
export interface ClaudeConverted {
  messages: ClaudeMessage[];
  systemPrompt: ClaudeContent[];
}

/** convertClaudeMessages(messages, prefillString, useSysPrompt, useTools, names)：会就地修改 messages */
export function convertClaudeMessages(
  input: Array<Record<string, unknown>>,
  prefillString: string | undefined,
  useSysPrompt: boolean,
  useTools: boolean,
  names: PromptNames,
  promptPlaceholder = '[Start a new chat]',
): ClaudeConverted {
  const messages = input as Loose[];
  const systemPrompt: ClaudeContent[] = [];
  const prefixExample = (m: Loose) => {
    if (names.userName && m.name === 'example_user') {
      if (!String(m.content).startsWith(`${names.userName}: `))
        m.content = `${names.userName}: ${String(m.content)}`;
    }
    if (names.charName && m.name === 'example_assistant') {
      if (
        !String(m.content).startsWith(`${names.charName}: `) &&
        !startsWithGroupName(names, String(m.content))
      ) {
        m.content = `${names.charName}: ${String(m.content)}`;
      }
    }
  };
  if (useSysPrompt) {
    let i = 0;
    for (; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role !== 'system') break;
      prefixExample(m);
      systemPrompt.push({ type: 'text', text: m.content });
    }
    messages.splice(0, i);
    if (messages.length === 0) messages.unshift({ role: 'user', content: promptPlaceholder });
  }

  const parse = (str: unknown) => (typeof str === 'string' ? JSON.parse(str) : str);
  for (const message of messages) {
    const toolCalls = message['tool_calls'] as
      Array<{ id: string; function: { name: string; arguments: unknown } }> | undefined;
    if (message.role === 'assistant' && toolCalls) {
      message.content = toolCalls.map((tc) => ({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parse(tc.function.arguments),
      }));
    }
    if (message.role === 'tool') {
      message.role = 'user';
      message.content = [
        { type: 'tool_result', tool_use_id: message['tool_call_id'], content: message.content },
      ];
    }
    if (message.role === 'system') {
      prefixExample(message);
      message.role = 'user';
      delete message.name;
    }
    if (typeof message.content === 'string') {
      if (message.name) message.content = `${message.name}: ${message.content}`;
      message.content = [{ type: 'text', text: message.content }];
    } else if (Array.isArray(message.content)) {
      message.content = (message.content as Array<Record<string, unknown>>).map((content) => {
        if (content['type'] === 'image_url') {
          const imageData = (content['image_url'] as { url?: string } | undefined)?.url;
          const mimeType = imageData?.split(';')?.[0]?.split(':')?.[1];
          const base64Data = imageData?.split(',')?.[1];
          return {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: base64Data },
          };
        }
        if (content['type'] === 'text') {
          let text = content['text'] as string | undefined;
          if (message.name) text = `${message.name}: ${text}`;
          return { type: 'text', text: text || '​' };
        }
        return content;
      });
    }
    delete message.name;
    delete message['tool_calls'];
    delete message['tool_call_id'];
  }

  const typed = messages as unknown as ClaudeMessage[];
  for (let i = 0; i < typed.length; i++) {
    const m = typed[i]!;
    if (m.role === 'assistant' && m.content.some((c) => c.type === 'image')) {
      let j = i + 1;
      while (j < typed.length && typed[j]!.role !== 'user') j++;
      if (j >= typed.length) typed.splice(i + 1, 0, { role: 'user', content: [] });
      typed[j]!.content.push(...m.content.filter((c) => c.type === 'image'));
      m.content = m.content.filter((c) => c.type !== 'image');
    }
  }

  if (prefillString) {
    typed.push({ role: 'assistant', content: [{ type: 'text', text: prefillString.trimEnd() }] });
  }

  const merged: ClaudeMessage[] = [];
  for (const message of typed) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) last.content.push(...message.content);
    else merged.push(message);
  }

  if (!useTools) {
    for (const message of merged) {
      for (const content of message.content) {
        if (content.type === 'tool_use') {
          content.type = 'text';
          content['text'] = JSON.stringify(content['input']);
          delete content['id'];
          delete content['name'];
          delete content['input'];
        }
        if (content.type === 'tool_result') {
          content.type = 'text';
          content['text'] = content['content'];
          delete content['tool_use_id'];
          delete content['content'];
        }
      }
    }
  }
  return { messages: merged, systemPrompt };
}

/** calculateClaudeBudgetTokens：adaptive 模型返回 effort 字串，否则预算数（≥1024，非流式 ≤21333），auto → null */
export function calculateClaudeBudgetTokens(
  maxTokens: number,
  reasoningEffort: string | undefined,
  stream: boolean,
  isAdaptiveModel: boolean,
): number | string | null {
  if (isAdaptiveModel) {
    switch (reasoningEffort) {
      case 'auto':
        return null;
      case 'min':
      case 'low':
        return 'low';
      case 'medium':
        return 'medium';
      case 'high':
        return 'high';
      case 'max':
        return 'max';
      default:
        return null;
    }
  }
  let budget = 0;
  switch (reasoningEffort) {
    case 'auto':
      return null;
    case 'min':
      budget = 1024;
      break;
    case 'low':
      budget = Math.floor(maxTokens * 0.1);
      break;
    case 'medium':
      budget = Math.floor(maxTokens * 0.25);
      break;
    case 'high':
      budget = Math.floor(maxTokens * 0.5);
      break;
    case 'max':
      budget = Math.floor(maxTokens * 0.95);
      break;
    default:
      break;
  }
  budget = Math.max(budget, 1024);
  if (!stream) budget = Math.min(budget, 21333);
  return budget;
}

/** cachingAtDepthForClaude：在指定深度（跳过末尾 prefill）给最后一个 content 打 cache_control */
export function cachingAtDepthForClaude(
  messages: ClaudeMessage[],
  cachingAtDepth: number,
  ttl: string,
): void {
  let passedThePrefill = false;
  let depth = 0;
  let previousRoleName = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!passedThePrefill && m.role === 'assistant') continue;
    passedThePrefill = true;
    if (m.role !== previousRoleName) {
      if (depth === cachingAtDepth || depth === cachingAtDepth + 2) {
        const last = m.content[m.content.length - 1];
        if (last) last['cache_control'] = { type: 'ephemeral', ttl };
      }
      if (depth === cachingAtDepth + 2) break;
      depth += 1;
      previousRoleName = m.role;
    }
  }
}

/** ST 出厂 default/config.yaml 的 claude.* 与 promptPlaceholder（代码里的 getConfigValue 兜底值不同：adaptive 兜底 true、占位符 "Let's get started."） */
export interface ClaudeConfig {
  enableSystemPromptCache: boolean;
  cachingAtDepth: number;
  extendedTTL: boolean;
  enableAdaptiveThinking: boolean;
  promptPlaceholder: string;
}
export const DEFAULT_CLAUDE_CONFIG: ClaudeConfig = {
  enableSystemPromptCache: false,
  cachingAtDepth: -1,
  extendedTTL: false,
  enableAdaptiveThinking: false,
  promptPlaceholder: '[Start a new chat]',
};

export interface ClaudeRequest {
  /** 不含 `/messages` 以外的路径：`${new URL(reverse_proxy || API_CLAUDE)}/messages` */
  url: string;
  /** anthropic-version / anthropic-beta；x-api-key 由宿主按密钥填 */
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const useThinkingRe =
  /^claude-(3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/;
const useWebSearchRe =
  /^claude-(3-5|3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/;
const limitedSamplingRe = /^claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)/;
const useVerbosityRe = /^claude-(opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/;
const noPrefillRe = /^claude-(opus-4-6|sonnet-4-6|opus-4-7)/;
const adaptiveAlwaysRe = /^claude-(opus-4-7)/;
const adaptiveOptRe = /^claude-(opus-4-6|sonnet-4-6)/;
const noSamplingRe = /^claude-(opus-4-7)/;

/**
 * ST 只写 `{ type: tool_choice }`（字符串）。脚本可能给 OpenAI 的另外两种写法，Claude 不认：
 * `required` → `any`；指定函数 → `{ type: 'tool', name }`。
 */
function claudeToolChoice(choice: unknown): Record<string, unknown> {
  if (choice === 'required') return { type: 'any' };
  if (choice && typeof choice === 'object') {
    const name = (choice as { function?: { name?: unknown } }).function?.name;
    if (typeof name === 'string' && name) return { type: 'tool', name };
  }
  return { type: choice };
}

/** sendClaudeRequest 的请求体与头（messages 会被深拷贝后转换） */
export function buildClaudeRequest(
  data: GenerateData,
  config: ClaudeConfig = DEFAULT_CLAUDE_CONFIG,
): ClaudeRequest {
  const model = data.model;
  const cacheTTL = config.extendedTTL ? '1h' : '5m';
  const betaHeaders = ['output-128k-2025-02-19', 'context-1m-2025-08-07'];
  const tools = data['tools'];
  const useTools = Array.isArray(tools) && tools.length > 0;
  const useSystemPrompt = Boolean(data['use_sysprompt']);
  const messages = structuredClone(data.messages) as unknown as Array<Record<string, unknown>>;
  const converted = convertClaudeMessages(
    messages,
    data['assistant_prefill'] as string | undefined,
    useSystemPrompt,
    useTools,
    promptNamesFrom(data),
    config.promptPlaceholder,
  );
  const useThinking = useThinkingRe.test(model);
  const useWebSearch = useWebSearchRe.test(model) && Boolean(data['enable_web_search']);
  const isLimitedSampling = limitedSamplingRe.test(model);
  const useVerbosity = useVerbosityRe.test(model);
  const noPrefillModel = noPrefillRe.test(model);
  const isAdaptiveModel =
    adaptiveAlwaysRe.test(model) || (config.enableAdaptiveThinking && adaptiveOptRe.test(model));
  const noSamplingModel = noSamplingRe.test(model);
  let fixThinkingPrefill = false;

  const stopSequences: unknown[] = [];
  if (Array.isArray(data['stop'])) stopSequences.push(...(data['stop'] as unknown[]));

  const body: Record<string, unknown> = {
    system: [] as unknown,
    messages: converted.messages,
    model,
    max_tokens: data['max_tokens'],
    stop_sequences: stopSequences,
    temperature: data['temperature'],
    top_p: data['top_p'],
    top_k: data['top_k'],
    stream: data['stream'],
  };
  if (useSystemPrompt) {
    if (config.enableSystemPromptCache && converted.systemPrompt.length) {
      converted.systemPrompt[converted.systemPrompt.length - 1]!['cache_control'] = {
        type: 'ephemeral',
        ttl: cacheTTL,
      };
    }
    body['system'] = converted.systemPrompt;
  } else {
    delete body['system'];
  }
  if (useTools) {
    betaHeaders.push('tools-2024-05-16');
    body['tool_choice'] = claudeToolChoice(data['tool_choice']);
    body['tools'] = (
      tools as Array<{
        type: string;
        function: { name: string; description?: string; parameters?: unknown };
      }>
    )
      .filter((t) => t.type === 'function')
      .map((t) => t.function)
      .map((fn) => ({ name: fn.name, description: fn.description, input_schema: fn.parameters }));
    const list = body['tools'] as Array<Record<string, unknown>>;
    if (config.enableSystemPromptCache && list.length)
      list[list.length - 1]!['cache_control'] = { type: 'ephemeral', ttl: cacheTTL };
  }
  const schema = data['json_schema'] as
    { name: string; description?: string; value: unknown } | undefined;
  if (schema) {
    const jsonTool = {
      name: schema.name,
      description: schema.description || 'Well-formed JSON object',
      input_schema: schema.value,
    };
    body['tools'] = [...((body['tools'] as unknown[]) ?? []), jsonTool];
    body['tool_choice'] = { type: 'tool', name: schema.name };
  }
  if (useWebSearch) {
    body['tools'] = [
      { type: 'web_search_20250305', name: 'web_search' },
      ...((body['tools'] as unknown[]) ?? []),
    ];
  }
  if (config.cachingAtDepth !== -1)
    cachingAtDepthForClaude(converted.messages, config.cachingAtDepth, cacheTTL);
  if (config.enableSystemPromptCache || config.cachingAtDepth !== -1) {
    betaHeaders.push('prompt-caching-2024-07-31');
    betaHeaders.push('extended-cache-ttl-2025-04-11');
  }
  if (isLimitedSampling) {
    if (Number(body['top_p']) < 1) delete body['temperature'];
    else delete body['top_p'];
  }
  if (noSamplingModel) {
    delete body['temperature'];
    delete body['top_p'];
    delete body['top_k'];
  }

  const budgetTokens = calculateClaudeBudgetTokens(
    Number(body['max_tokens']),
    data['reasoning_effort'] as string | undefined,
    Boolean(body['stream']),
    isAdaptiveModel,
  );
  if (useThinking && typeof budgetTokens === 'string') {
    fixThinkingPrefill = true;
    const thinking: Record<string, unknown> = { type: 'adaptive' };
    if (noSamplingModel && Boolean(data['include_reasoning'])) thinking['display'] = 'summarized';
    body['thinking'] = thinking;
    const oc = (body['output_config'] as Record<string, unknown> | undefined) ?? {};
    oc['effort'] = budgetTokens;
    body['output_config'] = oc;
    delete body['top_k'];
  } else if (useThinking && Number.isInteger(budgetTokens)) {
    fixThinkingPrefill = true;
    const minThinkTokens = 1024;
    if (Number(body['max_tokens']) <= minThinkTokens)
      body['max_tokens'] = Number(body['max_tokens']) + minThinkTokens;
    body['thinking'] = { type: 'enabled', budget_tokens: budgetTokens };
    delete body['temperature'];
    delete body['top_p'];
    delete body['top_k'];
  }
  const last = converted.messages[converted.messages.length - 1];
  if ((fixThinkingPrefill || noPrefillModel) && last && last.role === 'assistant')
    last.role = 'user';

  const effortSet = (body['output_config'] as Record<string, unknown> | undefined)?.['effort'];
  if (useVerbosity && data['verbosity'] && !effortSet) {
    betaHeaders.push('effort-2025-11-24');
    const oc = (body['output_config'] as Record<string, unknown> | undefined) ?? {};
    oc['effort'] = data['verbosity'];
    body['output_config'] = oc;
  }

  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
  if (betaHeaders.length) headers['anthropic-beta'] = betaHeaders.join(',');
  const base = new URL(String(data['reverse_proxy'] || API_CLAUDE)).toString();
  return { url: `${base}/messages`, headers, body };
}

/** 非流式回复包回 OAI 形状（服务端做法）：{choices:[{message:{content}}], content} */
export function wrapClaudeReply(json: { content?: Array<{ text?: string }> }): {
  choices: Array<{ message: { content: string } }>;
  content: unknown;
} {
  return {
    choices: [{ message: { content: json?.content?.[0]?.text || '' } }],
    content: json.content,
  };
}

export type { ChatCompletionMessage as ClaudeInputMessage };
