// ST script.js createRawPrompt 的 Text Completion 分支：一组带角色的消息 → 一段文本。
import type { CoreState } from '../../state.js';
import { formatInstructModeChat, formatInstructModePrompt, type Substitute } from './instruct.js';

export interface RawPromptMessage {
  role: 'system' | 'user' | 'assistant';
  /** 宿主已过宏（createRawPrompt 在这里 substituteParams，我们的调用方更早做） */
  content: string;
  /** 缺省：user → name1，assistant → name2，system → 无名 */
  name?: string | undefined;
}

export interface RawTextPromptOptions {
  /** 接在最后一行后的预填（promptBias） */
  prefill?: string | undefined;
  /** true：末行按角色发言写（quietToLoud）；false：按系统指令写 */
  quietToLoud?: boolean | undefined;
}

/** 一条消息在提示词里的写法（instruct：formatInstructModeChat；否则 `Name: content`），也用于按条计 token */
export function formatRawTextMessage(
  state: CoreState,
  substitute: Substitute,
  message: RawPromptMessage,
): string {
  const name1 = state.userName;
  const name2 = state.charName;
  const fallback = message.role === 'user' ? name1 : message.role === 'assistant' ? name2 : '';
  const name = message.name ?? fallback;
  if (!state.powerUser.instruct.enabled) return (name ? `${name}: ` : '') + message.content;
  return formatInstructModeChat(
    state,
    substitute,
    name,
    message.content,
    message.role === 'user',
    message.role === 'system',
    '',
    name1,
    name2,
    false,
  );
}

/**
 * instruct 开启：逐条 formatInstructModeChat，直接相连，末尾接 formatInstructModePrompt（quiet）。
 * 关闭：`Name: content` 逐行相连，末尾换行加预填。
 */
export function createRawTextPrompt(
  state: CoreState,
  substitute: Substitute,
  messages: readonly RawPromptMessage[],
  { prefill = '', quietToLoud = false }: RawTextPromptOptions = {},
): string {
  const isInstruct = !!state.powerUser.instruct.enabled;
  const parts = messages.map((message) => formatRawTextMessage(state, substitute, message));
  const lastLine = isInstruct
    ? formatInstructModePrompt(
        state,
        substitute,
        state.charName,
        false,
        prefill,
        state.userName,
        state.charName,
        true,
        quietToLoud,
      )
    : `\n${prefill}`;
  return parts.join(isInstruct ? '' : '\n') + lastLine;
}
