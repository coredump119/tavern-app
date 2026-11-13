/**
 * Uncaught errors from extension code (DEV_NOTES §9.34 第 9 轮): a phone has no console, so the
 * host keeps the first few per extension and the extensions page lists them.
 */
import { extensionPath } from '@tm/st-compat';

export interface CrashEntry {
  /** extension folder name */
  name: string;
  message: string;
}

export const MAX_CRASHES_PER_EXTENSION = 5;

/** The extension a script address or a stack trace points into; null when it is not extension code. */
export function crashOwner(base: string, where: string, names: readonly string[]): string | null {
  if (!where) return null;
  let text = where;
  try {
    text = decodeURI(where);
  } catch {
    /* a stack with a stray % stays as it is */
  }
  let owner: string | null = null;
  let first = Infinity;
  for (const name of names) {
    const at = text.indexOf(base + extensionPath(name));
    if (at >= 0 && at < first) {
      first = at;
      owner = name;
    }
  }
  return owner;
}

/** The list with `entry` added; the same list when it is a repeat or the extension has its share. */
export function withCrash(list: readonly CrashEntry[], entry: CrashEntry): readonly CrashEntry[] {
  const own = list.filter((crash) => crash.name === entry.name);
  if (own.length >= MAX_CRASHES_PER_EXTENSION) return list;
  if (own.some((crash) => crash.message === entry.message)) return list;
  return [...list, entry];
}
