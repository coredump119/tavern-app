// ST chat-macros.js 移植：聊天记录与 swipe 状态。
import { MacroCategory, MacroValueType, type MacroRegistry } from '../registry.js';
import type { ChatMessageLike, CoreState } from '../../state.js';

export function getLastMessageId(
  chat: readonly ChatMessageLike[],
  {
    exclude_swipe_in_propress = true,
    filter = null,
  }: {
    exclude_swipe_in_propress?: boolean;
    filter?: ((m: ChatMessageLike) => boolean) | null;
  } = {},
): number | null {
  if (!Array.isArray(chat) || chat.length === 0) return null;
  for (let i = chat.length - 1; i >= 0; i--) {
    const message = chat[i]!;
    if (
      exclude_swipe_in_propress &&
      message.swipes &&
      (message.swipe_id ?? 0) >= message.swipes.length
    )
      continue;
    if (!filter || filter(message)) return i;
  }
  return null;
}

const mesAt = (chat: readonly ChatMessageLike[], mid: number | null) =>
  typeof mid === 'number' ? (chat[mid]?.mes ?? '') : '';

export function registerChatMacros(registry: MacroRegistry): void {
  const chatOf = (s: CoreState) => s.chat;
  registry.registerMacro('lastMessage', {
    category: MacroCategory.CHAT,
    description: 'Last message in the chat.',
    returns: 'Last message in the chat.',
    handler: ({ env }) =>
      String(mesAt(chatOf(env.runtime), getLastMessageId(chatOf(env.runtime))) ?? ''),
  });
  registry.registerMacro('lastMessageId', {
    category: MacroCategory.CHAT,
    description: 'Index of the last message in the chat.',
    returns: 'Index of the last message in the chat.',
    returnType: MacroValueType.INTEGER,
    handler: ({ env }) => String(getLastMessageId(chatOf(env.runtime)) ?? ''),
  });
  registry.registerMacro('lastUserMessage', {
    category: MacroCategory.CHAT,
    description: 'Last user message in the chat.',
    returns: 'Last user message in the chat.',
    handler: ({ env }) => {
      const chat = chatOf(env.runtime);
      return String(
        mesAt(chat, getLastMessageId(chat, { filter: (m) => !!m.is_user && !m.is_system })) ?? '',
      );
    },
  });
  registry.registerMacro('lastCharMessage', {
    category: MacroCategory.CHAT,
    description: 'Last character/bot message in the chat.',
    returns: 'Last character/bot message in the chat.',
    handler: ({ env }) => {
      const chat = chatOf(env.runtime);
      return String(
        mesAt(chat, getLastMessageId(chat, { filter: (m) => !m.is_user && !m.is_system })) ?? '',
      );
    },
  });
  registry.registerMacro('firstIncludedMessageId', {
    category: MacroCategory.CHAT,
    description: 'Index of the first message included in the current context.',
    returns: 'Index of the first message included in the context.',
    returnType: MacroValueType.INTEGER,
    handler: ({ env }) => {
      const value = env.runtime.chatMetadata['lastInContextMessageId'];
      return String(typeof value === 'number' ? value : '');
    },
  });
  registry.registerMacro('firstDisplayedMessageId', {
    category: MacroCategory.CHAT,
    description: 'Index of the first displayed message in the chat.',
    returns: 'Index of the first displayed message in the chat.',
    returnType: MacroValueType.INTEGER,
    handler: ({ env }) => {
      const id = env.runtime.firstDisplayedMessageId;
      return String(typeof id === 'number' && !Number.isNaN(id) && id >= 0 ? id : '');
    },
  });
  registry.registerMacro('lastSwipeId', {
    category: MacroCategory.CHAT,
    description: '1-based index of the last swipe for the last message.',
    returns: '1-based index of the last swipe.',
    returnType: MacroValueType.INTEGER,
    handler: ({ env }) => {
      const chat = chatOf(env.runtime);
      const mid = getLastMessageId(chat, { exclude_swipe_in_propress: false });
      if (typeof mid !== 'number') return '';
      const swipes = chat[mid]?.swipes;
      return String(Array.isArray(swipes) ? swipes.length : '');
    },
  });
  registry.registerMacro('currentSwipeId', {
    category: MacroCategory.CHAT,
    description: '1-based index of the current swipe.',
    returns: '1-based index of the current swipe.',
    returnType: MacroValueType.INTEGER,
    handler: ({ env }) => {
      const chat = chatOf(env.runtime);
      const mid = getLastMessageId(chat, { exclude_swipe_in_propress: false });
      if (typeof mid !== 'number') return '';
      const swipeId = chat[mid]?.swipe_id;
      return String(typeof swipeId === 'number' ? swipeId + 1 : '');
    },
  });
  registry.registerMacro('allChatRange', {
    category: MacroCategory.CHAT,
    description:
      'Range of all message IDs in the chat (e.g. "0-10"). Empty string if the chat is empty.',
    returns: 'Range string from 0 to last message ID, or empty string.',
    handler: ({ env }) => {
      const chat = chatOf(env.runtime);
      return !Array.isArray(chat) || chat.length === 0 ? '' : `0-${chat.length - 1}`;
    },
  });
}
