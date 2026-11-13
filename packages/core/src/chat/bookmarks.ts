/**
 * Checkpoints and branches — ST `public/scripts/bookmarks.js` as pure data rules (DEV_NOTES §9.29).
 * The host writes the files; everything here only computes names, snapshots and message marks.
 */
import type { ChatMessageLike } from '../state.js';

export const BOOKMARK_NAME_TOKEN = 'Checkpoint #';
export const BRANCH_NAME_TOKEN = 'Branch #';

/** ST utils `getUniqueName`: first `nameBuilder(base, i)` for which `exists` is false. */
export function getUniqueName(
  baseName: string,
  exists: (name: string) => boolean,
  {
    nameBuilder = null,
    maxTries = 1000,
    startIndex = 1,
  }: {
    nameBuilder?: ((base: string, i: number) => string) | null;
    maxTries?: number;
    startIndex?: number;
  } = {},
): string | null {
  const build = nameBuilder ?? ((base: string, i: number) => (i === 0 ? base : `${base} (${i})`));
  for (let i = startIndex; i < maxTries + startIndex; i++) {
    const name = build(baseName, i);
    if (!exists(name)) return name;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip ` - <Token>N` suffix and legacy `<Token>N - ` prefix, then append ` - <Token>i`. */
function suffixedName(token: string, name: string, i: number): string {
  const t = escapeRegExp(token);
  let clean = name.replace(new RegExp(` - ${t}\\d+$`), '');
  clean = clean.replace(new RegExp(`^${t}\\d+ - `), '');
  return `${clean} - ${token}${i}`;
}

/** `<main> - Checkpoint #i`, unique among `existing` (chat names without `.jsonl`). */
export function checkpointName(mainChatName: string, existing: readonly string[]): string | null {
  const set = new Set(existing);
  return getUniqueName(mainChatName, (x) => set.has(x), {
    nameBuilder: (n, i) => suffixedName(BOOKMARK_NAME_TOKEN, n, i),
  });
}

/** `<main> - Branch #i`, unique among `existing`. */
export function branchName(mainChatName: string, existing: readonly string[]): string | null {
  const set = new Set(existing);
  return getUniqueName(mainChatName, (x) => set.has(x), {
    nameBuilder: (n, i) => suffixedName(BRANCH_NAME_TOKEN, n, i),
  });
}

interface SwipeInfoLike {
  send_date?: unknown;
  gen_started?: unknown;
  gen_finished?: unknown;
  extra?: unknown;
}

/**
 * ST `syncSwipeToMes(null, swipeId, message)`: make `mes` / dates / `extra` reflect `swipes[swipeId]`.
 * Mutates and returns false when the message has no usable swipe data.
 */
export function syncSwipeToMes(message: ChatMessageLike, swipeId: number | null = null): boolean {
  if (swipeId !== null) {
    if (Number.isNaN(swipeId) || swipeId < 0) return false;
    message.swipe_id = swipeId;
  }
  if (typeof message.swipe_id !== 'number') return false;
  if (!Array.isArray(message.swipes)) return false;
  let info = message['swipe_info'] as (SwipeInfoLike | null)[] | undefined;
  if (!Array.isArray(info)) {
    info = message.swipes.map(() => ({
      send_date: message.send_date,
      gen_started: undefined,
      gen_finished: undefined,
      extra: {},
    }));
    message['swipe_info'] = info;
  }
  const id = message.swipe_id;
  if (typeof message.swipes[id] !== 'string') return false;
  const target = info[id];
  message.mes = message.swipes[id]!;
  message.send_date = target?.send_date as string | number;
  message['gen_started'] = target?.gen_started;
  message['gen_finished'] = target?.gen_finished;
  message['extra'] = target?.extra ? structuredClone(target.extra) : {};
  return true;
}

/** ST `getBranchChatSnapshot`: `chat[0..mesId]` cloned, optionally with `mesId` moved to `swipeId`. */
export function branchSnapshot<T extends { mes: string }>(
  chat: readonly T[],
  mesId: number,
  swipeId: number | null = null,
): T[] | null {
  if (mesId < 0 || mesId >= chat.length) return null;
  const snapshot = structuredClone(chat.slice(0, mesId + 1)) as T[];
  if (swipeId === null) return snapshot;
  const last = snapshot[mesId] as unknown as ChatMessageLike;
  const count = Array.isArray(last.swipes) ? last.swipes.length : 0;
  if (!Number.isInteger(swipeId) || swipeId < 0 || swipeId >= count) return null;
  return syncSwipeToMes(last, swipeId) ? snapshot : null;
}

/** Header metadata for a checkpoint / branch file: the current metadata plus `main_chat`. */
export function bookmarkMetadata(
  chatMetadata: Record<string, unknown>,
  mainChat: string,
): Record<string, unknown> {
  return { ...structuredClone(chatMetadata), main_chat: mainChat };
}

/**
 * ST `getMainChatName`: `chat_metadata.main_chat`, else (characters only) derived from a legacy
 * `<main> - Checkpoint #N` chat name. Returns the name and whether the caller should persist it.
 */
export function mainChatName(
  chatMetadata: Record<string, unknown>,
  currentChatName: string | null,
  isGroup: boolean,
): { name: string | null; derived: boolean } {
  const stored = chatMetadata['main_chat'];
  if (typeof stored === 'string' && stored) return { name: stored, derived: false };
  if (isGroup || !currentChatName) return { name: null, derived: false };
  const idx = currentChatName.lastIndexOf(BOOKMARK_NAME_TOKEN);
  if (idx < 0) return { name: null, derived: false };
  return { name: currentChatName.substring(0, idx).trim(), derived: true };
}

function extraOf(message: { [key: string]: unknown }): Record<string, unknown> {
  let extra = message['extra'] as Record<string, unknown> | undefined;
  if (!extra || typeof extra !== 'object') {
    extra = {};
    message['extra'] = extra;
  }
  return extra;
}

/** `extra.bookmark_link = name` (replaces an existing checkpoint link, as ST does). */
export function setBookmarkLink(message: { [key: string]: unknown }, name: string): void {
  extraOf(message)['bookmark_link'] = name;
}

/** `extra.branches.push(name)` */
export function addBranch(message: { [key: string]: unknown }, name: string): void {
  const extra = extraOf(message);
  const list = Array.isArray(extra['branches']) ? (extra['branches'] as unknown[]) : [];
  list.push(name);
  extra['branches'] = list;
}

export function bookmarkLinkOf(message: { [key: string]: unknown }): string | null {
  const v = (message['extra'] as Record<string, unknown> | undefined)?.['bookmark_link'];
  return typeof v === 'string' && v ? v : null;
}
