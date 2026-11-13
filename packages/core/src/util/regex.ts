/** ST utils.escapeRegex */
export function escapeRegex(str: string): string {
  return str.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * ST world-info.parseRegexFromString：把 `/pattern/flags` 形式的字符串转为 RegExp，
 * pattern 内未转义的 `/` 视为非法；无法编译返回 null。
 */
export function parseRegexFromString(input: string): RegExp | null {
  const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(input);
  if (!match) return null;
  let pattern = match[1]!;
  const flags = match[2]!;
  if (/(^|[^\\])\//.test(pattern)) return null;
  pattern = pattern.replace('\\/', '/');
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}
