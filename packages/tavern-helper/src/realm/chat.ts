/** TavernHelper's view of chat messages ↔ ST's stored shape (DEV_NOTES §9.5); pure. */
import type { MessagePatch, Names, RawMessage, Variables } from '../protocol.js';
import { swipeVariables } from './variables.js';

export type Role = 'system' | 'assistant' | 'user';

export interface ChatMessage {
  message_id: number;
  name: string;
  role: Role;
  is_hidden: boolean;
  message: string;
  data: Variables;
  extra: Record<string, unknown>;
}

export interface ChatMessageSwiped {
  message_id: number;
  name: string;
  role: Role;
  is_hidden: boolean;
  swipe_id: number;
  swipes: string[];
  swipes_data: Variables[];
  swipes_info: unknown[];
}

export type ChatMessageUpdate = { message_id: number } & Partial<
  Omit<ChatMessage, 'message_id'> & Omit<ChatMessageSwiped, 'message_id'>
>;

export interface ChatMessageCreating {
  name?: string;
  role: Role;
  is_hidden?: boolean;
  message: string;
  data?: Variables;
  extra?: Record<string, unknown>;
}

/** ST has no role field: the narrator is `extra.type === 'narrator'`, `is_system` means hidden */
export function roleOf(message: RawMessage): Role {
  if (message.extra?.['type'] === 'narrator') return 'system';
  return message.is_user ? 'user' : 'assistant';
}

export function toChatMessage(message: RawMessage, id: number): ChatMessage {
  return {
    message_id: id,
    name: message.name,
    role: roleOf(message),
    is_hidden: !!message.is_system,
    message: message.mes,
    data: swipeVariables(message)[message.swipe_id ?? 0] ?? {},
    extra: message.extra ?? {},
  };
}

export function toChatMessageSwiped(message: RawMessage, id: number): ChatMessageSwiped {
  const swipes = message.swipes ?? [message.mes];
  return {
    message_id: id,
    name: message.name,
    role: roleOf(message),
    is_hidden: !!message.is_system,
    swipe_id: message.swipe_id ?? 0,
    swipes,
    swipes_data: swipeVariables(message),
    swipes_info: message.swipe_info ?? swipes.map(() => ({})),
  };
}

function withRole(extra: Record<string, unknown>, role: Role): Record<string, unknown> {
  const { type: _type, ...rest } = extra;
  if (role === 'system') return { ...rest, type: 'narrator' };
  return extra['type'] === 'narrator' ? rest : extra;
}

const pad = <T>(list: readonly T[], length: number, fill: () => T): T[] =>
  Array.from({ length }, (_unused, i) => (i < list.length ? list[i]! : fill()));

/** `setChatMessages`: the stored-shape fields one update changes on `message`. */
export function updateToPatch(message: RawMessage, update: ChatMessageUpdate): MessagePatch {
  const patch: MessagePatch = {};
  if (update.name !== undefined) patch.name = update.name;
  if (update.is_hidden !== undefined) patch.is_system = update.is_hidden;
  if (update.role !== undefined) patch.is_user = update.role === 'user';
  if (update.extra !== undefined || update.role !== undefined) {
    const extra = update.extra ?? message.extra ?? {};
    patch.extra = update.role === undefined ? extra : withRole(extra, update.role);
  }

  const touchesSwipes =
    update.swipes !== undefined ||
    update.swipe_id !== undefined ||
    update.swipes_data !== undefined ||
    update.swipes_info !== undefined;
  if (!touchesSwipes && update.message === undefined && update.data === undefined) return patch;

  const swipes = [...(update.swipes ?? message.swipes ?? [message.mes])];
  if (swipes.length === 0) swipes.push('');
  const wanted = update.swipe_id ?? message.swipe_id ?? 0;
  const current = Math.min(Math.max(Math.trunc(wanted), 0), swipes.length - 1);
  const data = pad(update.swipes_data ?? swipeVariables(message), swipes.length, () => ({}));
  if (update.message !== undefined) swipes[current] = update.message;
  if (update.data !== undefined) data[current] = update.data;

  patch.mes = swipes[current]!;
  patch.variables = data;
  // a message that never had swipes stays that way unless the update is about swipes
  if (touchesSwipes || message.swipes) {
    patch.swipes = swipes;
    patch.swipe_id = current;
    patch.swipe_info = pad(
      update.swipes_info ?? message.swipe_info ?? [],
      swipes.length,
      () => ({}),
    );
  }
  return patch;
}

/** `createChatMessages`: a new message in stored shape (the host adds `send_date`). */
export function creatingToPatch(input: ChatMessageCreating, names: Names): MessagePatch {
  const name =
    input.name ??
    (input.role === 'user' ? names.user : input.role === 'system' ? 'System' : names.char);
  const patch: MessagePatch = {
    name,
    is_user: input.role === 'user',
    is_system: input.is_hidden ?? false,
    mes: input.message,
    extra: withRole(input.extra ?? {}, input.role),
  };
  if (input.data !== undefined) patch.variables = [input.data];
  return patch;
}
