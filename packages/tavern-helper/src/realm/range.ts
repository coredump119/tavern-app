/**
 * Message ranges as TavernHelper's `getChatMessages` reads them: `5`, `"5"`, `"0-10"`, negatives
 * counted from the end (`-1` is the last message). The result is clamped to the chat and ordered;
 * null when the text is not a range or nothing is left after clamping.
 */
export function parseRange(input: string | number, length: number): [number, number] | null {
  const m = /^\s*(-?\d+)\s*(?:-\s*(-?\d+)\s*)?$/.exec(String(input));
  if (!m || length === 0) return null;
  const at = (text: string) => {
    const n = Number(text);
    return n < 0 ? length + n : n;
  };
  let from = at(m[1]!);
  let to = m[2] === undefined ? from : at(m[2]);
  if (from > to) [from, to] = [to, from];
  if (to < 0 || from >= length) return null;
  return [Math.max(from, 0), Math.min(to, length - 1)];
}

/** One message id (negatives from the end) → index. Throws when it is not inside the chat. */
export function resolveMessageId(id: number, length: number): number {
  const index = id < 0 ? length + id : id;
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new Error(`楼层号 ${id} 不在聊天范围内（共 ${length} 楼）`);
  }
  return index;
}
