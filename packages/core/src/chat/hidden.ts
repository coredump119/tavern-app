/**
 * Hiding messages from the prompt — ST `hideChatMessageRange` as a pure rule (DEV_NOTES §9.47).
 * A hidden message is `is_system`: it stays in the chat and on screen, and is left out of prompts.
 */

interface Hideable {
  is_system?: boolean | undefined;
}

/**
 * Hide or show again every message in `[start, end]`. `first` is the first changed index
 * (-1 when nothing changed), so the caller rewrites the chat file from there.
 */
export function setHiddenRange<T extends Hideable>(
  messages: readonly T[],
  start: number,
  end: number,
  hidden: boolean,
): { messages: T[]; first: number; changed: number } {
  let first = -1;
  let changed = 0;
  const next = messages.map((m, i) => {
    if (i < start || i > end || !!m.is_system === hidden) return m;
    if (first < 0) first = i;
    changed += 1;
    return { ...m, is_system: hidden };
  });
  return { messages: next, first, changed };
}

/** How many messages in `[start, end]` a `setHiddenRange` call would change. */
export function countHiddenChange(
  messages: readonly Hideable[],
  start: number,
  end: number,
  hidden: boolean,
): number {
  let n = 0;
  for (let i = Math.max(0, start); i <= end && i < messages.length; i++)
    if (!!messages[i]!.is_system !== hidden) n += 1;
  return n;
}
