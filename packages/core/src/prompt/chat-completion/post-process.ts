/** ST src/prompt-converters.js：mergeMessages / postProcessPrompt / addAssistantPrefix / setJsonObjectFormat */
import type { PromptNames } from './claude.js';

/** ST 出厂 config.yaml 的 promptPlaceholder（代码兜底值是 "Let's get started."） */
export const PROMPT_PLACEHOLDER = '[Start a new chat]';

export const PROMPT_PROCESSING_TYPE = {
  NONE: '',
  CLAUDE: 'claude',
  MERGE: 'merge',
  MERGE_TOOLS: 'merge_tools',
  SEMI: 'semi',
  SEMI_TOOLS: 'semi_tools',
  STRICT: 'strict',
  STRICT_TOOLS: 'strict_tools',
  SINGLE: 'single',
} as const;

export type LooseMessage = Record<string, unknown> & {
  role: string;
  content?: unknown;
  name?: string;
};

function startsWithGroupName(names: PromptNames, message: string): boolean {
  return names.groupNames.some((n) => message.startsWith(`${n}: `));
}

export interface MergeOptions {
  strict?: boolean;
  placeholders?: boolean;
  single?: boolean;
  tools?: boolean;
  /** 媒体占位 token 生成（ST 用 crypto.randomBytes(32).base64）；可注入以便测试 */
  token?: (() => string) | undefined;
  placeholder?: string | undefined;
}

/** mergeMessages：合并相邻同角色，去掉 name，可选严格模式 / 占位 / 单角色 / 保留工具 */
export function mergeMessages(
  messages: LooseMessage[],
  names: PromptNames,
  options: MergeOptions = {},
): LooseMessage[] {
  const { strict = false, placeholders = false, single = false, tools = false } = options;
  const placeholder = options.placeholder ?? PROMPT_PLACEHOLDER;
  const makeToken =
    options.token ??
    (() => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  const contentTokens = new Map<string, unknown>();
  const merged: LooseMessage[] = [];

  for (const message of messages) {
    if (!message.content) message.content = '';
    if (Array.isArray(message.content)) {
      message.content = (message.content as Array<Record<string, unknown>>)
        .map((content) => {
          if (content['type'] === 'text') return String(content['text'] ?? '');
          if (['image_url', 'video_url', 'audio_url'].includes(String(content['type']))) {
            const token = makeToken();
            contentTokens.set(token, content);
            return token;
          }
          return '';
        })
        .join('\n\n');
    }
    const text = () => String(message.content);
    if (message.role === 'system' && message.name === 'example_assistant') {
      if (
        names.charName &&
        !text().startsWith(`${names.charName}: `) &&
        !startsWithGroupName(names, text())
      ) {
        message.content = `${names.charName}: ${text()}`;
      }
    }
    if (message.role === 'system' && message.name === 'example_user') {
      if (names.userName && !text().startsWith(`${names.userName}: `))
        message.content = `${names.userName}: ${text()}`;
    }
    if (message.name && message.role !== 'system') {
      if (!text().startsWith(`${message.name}: `)) message.content = `${message.name}: ${text()}`;
    }
    if (message.role === 'tool' && !tools) message.role = 'user';
    if (single) {
      if (message.role === 'assistant') {
        if (
          names.charName &&
          !text().startsWith(`${names.charName}: `) &&
          !startsWithGroupName(names, text())
        ) {
          message.content = `${names.charName}: ${text()}`;
        }
      }
      if (message.role === 'user') {
        if (names.userName && !text().startsWith(`${names.userName}: `))
          message.content = `${names.userName}: ${text()}`;
      }
      message.role = 'user';
    }
    delete message.name;
    if (!tools) {
      delete message['tool_calls'];
      delete message['tool_call_id'];
    }
  }

  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role && message.content && message.role !== 'tool') {
      last.content = `${String(last.content)}\n\n${String(message.content)}`;
    } else {
      merged.push(message);
    }
  }

  if (merged.length === 0) merged.unshift({ role: 'user', content: placeholder });

  if (contentTokens.size > 0) {
    for (const message of merged) {
      const content = String(message.content);
      const hasToken = Array.from(contentTokens.keys()).some((t) => content.includes(t));
      if (!hasToken) continue;
      const mergedContent: Array<Record<string, unknown>> = [];
      for (const part of content.split('\n\n')) {
        if (contentTokens.has(part)) {
          mergedContent.push(contentTokens.get(part) as Record<string, unknown>);
        } else {
          const last = mergedContent[mergedContent.length - 1];
          if (last && last['type'] === 'text') last['text'] = `${String(last['text'])}\n\n${part}`;
          else mergedContent.push({ type: 'text', text: part });
        }
      }
      message.content = mergedContent;
    }
  }

  if (strict) {
    for (let i = 1; i < merged.length; i++)
      if (merged[i]!.role === 'system') merged[i]!.role = 'user';
    if (merged.length && placeholders) {
      if (merged[0]!.role === 'system' && (merged.length === 1 || merged[1]!.role !== 'user')) {
        merged.splice(1, 0, { role: 'user', content: placeholder });
      } else if (merged[0]!.role !== 'system' && merged[0]!.role !== 'user') {
        merged.unshift({ role: 'user', content: placeholder });
      }
    }
    return mergeMessages(merged, names, {
      strict: false,
      placeholders,
      single: false,
      tools,
      token: makeToken,
      placeholder,
    });
  }
  return merged;
}

/** postProcessPrompt(messages, type, names) */
export function postProcessPrompt(
  messages: LooseMessage[],
  type: string,
  names: PromptNames,
  placeholder?: string,
): LooseMessage[] {
  const o = (strict: boolean, placeholders: boolean, single: boolean, tools: boolean) =>
    mergeMessages(messages, names, { strict, placeholders, single, tools, placeholder });
  switch (type) {
    case PROMPT_PROCESSING_TYPE.MERGE:
    case PROMPT_PROCESSING_TYPE.CLAUDE:
      return o(false, false, false, false);
    case PROMPT_PROCESSING_TYPE.MERGE_TOOLS:
      return o(false, false, false, true);
    case PROMPT_PROCESSING_TYPE.SEMI:
      return o(true, false, false, false);
    case PROMPT_PROCESSING_TYPE.SEMI_TOOLS:
      return o(true, false, false, true);
    case PROMPT_PROCESSING_TYPE.STRICT:
      return o(true, true, false, false);
    case PROMPT_PROCESSING_TYPE.STRICT_TOOLS:
      return o(true, true, false, true);
    case PROMPT_PROCESSING_TYPE.SINGLE:
      return o(true, false, true, false);
    default:
      return messages;
  }
}

/** addAssistantPrefix：无工具且末尾是 assistant 时打上 property（prefix / partial） */
export function addAssistantPrefix(
  prompt: LooseMessage[],
  tools: unknown[] | undefined,
  property: string,
): LooseMessage[] {
  if (!prompt.length) return prompt;
  const hasAnyTools =
    (Array.isArray(tools) && tools.length > 0) || prompt.some((x) => x.role === 'tool');
  const last = prompt[prompt.length - 1]!;
  if (!hasAnyTools && last.role === 'assistant') last[property] = true;
  return prompt;
}

/** setJsonObjectFormat：response_format json_object + 把 schema 作为 user 消息追加 */
export function setJsonObjectFormat(
  bodyParams: Record<string, unknown>,
  messages: LooseMessage[],
  jsonSchema: { value: unknown },
): void {
  bodyParams['response_format'] = { type: 'json_object' };
  messages.push({
    role: 'user',
    content: `JSON schema for the response:\n${JSON.stringify(jsonSchema.value, null, 4)}`,
  });
}
