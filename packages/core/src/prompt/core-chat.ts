// Generate() 共用的 coreChat 预处理：过滤系统消息、swipe 弹出、正则钩子、标题追加、reasoning 拼接。
import type { ChatMessageLike, CoreState } from '../state.js';
import {
  DEFAULT_REASONING_SETTINGS,
  PromptReasoning,
  type ReasoningSettings,
} from './reasoning.js';
import { appendFileContent } from './chat-completion/media.js';

export type RegexPlacement = 'user' | 'ai' | 'reasoning' | 'world_info';
export type ApplyRegex = (
  text: string,
  placement: RegexPlacement,
  options: { isPrompt: boolean; depth: number | null },
) => string;

export type CoreChatMessage = ChatMessageLike & { index: number };

/** ST: a system message that records the tool calls of one model turn (`extra.tool_invocations`) */
const hasToolInvocations = (m: ChatMessageLike): boolean =>
  Array.isArray((m['extra'] as Record<string, unknown> | undefined)?.['tool_invocations']);

export function prepareCoreChat(
  state: CoreState,
  {
    type,
    applyRegex,
    reasoning,
    substitute,
    canUseTools = false,
  }: {
    type: string;
    applyRegex?: ApplyRegex | undefined;
    reasoning?: ReasoningSettings | undefined;
    /** ST `ToolManager.isToolCallingSupported()`: tool-call messages stay in the prompt */
    canUseTools?: boolean | undefined;
    substitute: (t: string) => string;
  },
): CoreChatMessage[] {
  const isContinue = type === 'continue';
  const isGroup = !!state.selectedGroup;
  const regex = applyRegex ?? ((t: string) => t);

  // 第一条消息的宏随设置变化（ST 就地修改 chat[0]）
  const first = state.chat[0];
  if (first) first.mes = substitute(first.mes);

  // Generate()：regenerate 时若最后一条不是用户消息，ST 会先把它从 chat 里删掉（宿主负责持久化这次删除）
  let source: readonly ChatMessageLike[] = state.chat;
  const last = source[source.length - 1];
  if (type === 'regenerate' && last && !last.is_user) source = source.slice(0, -1);

  let coreChat: CoreChatMessage[] = source
    .filter((x) => !x.is_system || (canUseTools && hasToolInvocations(x)))
    .map((x, index) => ({ ...x, index }));
  if (type === 'swipe') coreChat.pop();

  coreChat = coreChat.map((chatItem, index) => {
    let mes = regex(chatItem.mes, chatItem.is_user ? 'user' : 'ai', {
      isPrompt: true,
      depth: coreChat.length - index - (isContinue ? 2 : 1),
    });
    const extra = (chatItem['extra'] ?? {}) as Record<string, unknown>;
    // ST appendFileContent: Data Bank file texts in front of the message (DEV_NOTES §9.30)
    mes = appendFileContent(extra, mes);
    const titles: string[] = [];
    if (extra['append_title'] && extra['title']) titles.push(String(extra['title']));
    if (titles.length > 0) mes = `${mes}\n\n${titles.join('\n\n')}`;
    return { ...chatItem, mes, index };
  });

  const promptReasoning = new PromptReasoning(reasoning ?? DEFAULT_REASONING_SETTINGS, substitute);
  for (let i = coreChat.length - 1; i >= 0; i--) {
    const depth = coreChat.length - i - (isContinue ? 2 : 1);
    const isPrefix = isContinue && i === coreChat.length - 1;
    const item = coreChat[i]!;
    const extra = (item['extra'] ?? {}) as Record<string, unknown>;
    const isOtherGroupMember = isGroup && item.name !== state.charName;
    coreChat[i] = {
      ...item,
      mes: isOtherGroupMember
        ? item.mes
        : promptReasoning.addToMessage(
            item.mes,
            regex(String(extra['reasoning'] ?? ''), 'reasoning', { isPrompt: true, depth }),
            isPrefix,
            extra['reasoning_duration'] as number | undefined,
          ),
    };
    if (promptReasoning.isLimitReached()) break;
  }
  return coreChat;
}
