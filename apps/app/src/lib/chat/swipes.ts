import type { ChatMessage } from '@tm/formats';

/**
 * ST `loadFromSwipeId()` + `syncSwipeToMes()`: `message` showing its stored swipe `id`, with that
 * swipe's date and extra. `null` when it has no such swipe.
 */
export function withSwipe(message: ChatMessage, id: number): ChatMessage | null {
  const swipes = message.swipes ?? [message.mes];
  if (!Number.isInteger(id) || id < 0 || id >= swipes.length) return null;
  const info = message.swipe_info?.[id];
  return {
    ...message,
    swipe_id: id,
    mes: swipes[id] ?? '',
    ...(info?.send_date ? { send_date: info.send_date } : {}),
    ...(info?.extra ? { extra: info.extra as ChatMessage['extra'] } : {}),
  };
}
