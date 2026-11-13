/**
 * Single chat import — ST `src/endpoints/chats.js` `/import` converters (DEV_NOTES §9.32).
 * Pure text in, jsonl text out; the host picks the file and writes the result.
 */

export type ChatImportFormat = 'jsonl' | 'json';

export interface ChatImportResult {
  /** one jsonl document per resulting chat (CAI Tools exports can hold several histories) */
  chats: string[];
  /** which converter ran: 'st' | 'chub' | 'kobold' | 'cai' | 'ooba' | 'agnai' | 'risu' */
  source: string;
}

export class ChatImportError extends Error {}

type Loose = Record<string, unknown>;

const header = () => ({ chat_metadata: {}, user_name: 'unused', character_name: 'unused' });
const nowIso = (now: () => number) => new Date(now()).toISOString();
const toJsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');

function tryParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** ST `flattenChubChat`: `mes.message` → `mes`, swipe objects → their `.message`. Every line is re-serialized. */
export function flattenChubChat(lines: readonly string[]): string {
  const flattenSwipe = (swipe: unknown) =>
    swipe && typeof swipe === 'object' && (swipe as Loose)['message']
      ? (swipe as Loose)['message']
      : swipe;
  return lines
    .map((line) => {
      const data = tryParse(line) as Loose | undefined;
      if (!data) return line;
      const mes = data['mes'] as Loose | undefined;
      if (mes && typeof mes === 'object' && mes['message']) data['mes'] = mes['message'];
      if (Array.isArray(data['swipes'])) data['swipes'] = data['swipes'].map(flattenSwipe);
      return JSON.stringify(data);
    })
    .join('\n');
}

function importKoboldLite(data: Loose, now: () => number): string {
  const input = '{{[INPUT]}}';
  const output = '{{[OUTPUT]}}';
  const saved = (data['savedsettings'] ?? {}) as Loose;
  const userName = String(saved['chatname']);
  const characterName = String(saved['chatopponent']).split('||$||')[0]!;
  const toMessage = (msg: string) => {
    const isUser = msg.includes(input);
    return {
      name: isUser ? userName : characterName,
      is_user: isUser,
      mes: msg.replaceAll(input, '').replaceAll(output, '').trim(),
      send_date: nowIso(now),
      extra: {},
    };
  };
  const actions = Array.isArray(data['actions']) ? (data['actions'] as unknown[]).map(String) : [];
  const messages = actions.map(toMessage);
  if (data['prompt']) messages.unshift(toMessage(String(data['prompt'])));
  return toJsonl([header(), ...messages]);
}

function importCai(data: Loose, userName: string, characterName: string, now: () => number) {
  // ST's version references `newChats` inside its own initializer and throws; this is the intent
  const outer = (data['histories'] ?? {}) as Loose;
  const histories = Array.isArray(outer['histories']) ? (outer['histories'] as Loose[]) : [];
  return histories.map((history) => {
    const msgs = Array.isArray(history['msgs']) ? (history['msgs'] as Loose[]) : [];
    const rows = msgs.map((msg) => {
      const human = !!((msg['src'] ?? {}) as Loose)['is_human'];
      return {
        name: human ? userName : characterName,
        is_user: human,
        send_date: nowIso(now),
        mes: msg['text'],
        extra: {},
      };
    });
    return toJsonl([header(), ...rows]);
  });
}

function importOoba(data: Loose, userName: string, characterName: string, now: () => number) {
  const rows: unknown[] = [header()];
  for (const pair of data['data_visible'] as unknown[]) {
    const arr = Array.isArray(pair) ? pair : [];
    if (arr[0])
      rows.push({ name: userName, is_user: true, send_date: nowIso(now), mes: arr[0], extra: {} });
    if (arr[1])
      rows.push({
        name: characterName,
        is_user: false,
        send_date: nowIso(now),
        mes: arr[1],
        extra: {},
      });
  }
  return toJsonl(rows);
}

function importAgnai(data: Loose, userName: string, characterName: string, now: () => number) {
  const rows: unknown[] = [header()];
  for (const message of data['messages'] as Loose[]) {
    const isUser = !!message['userId'];
    rows.push({
      name: isUser ? userName : characterName,
      is_user: isUser,
      send_date: nowIso(now),
      mes: message['msg'],
      extra: {},
    });
  }
  return toJsonl(rows);
}

function importRisu(data: Loose, userName: string, characterName: string, now: () => number) {
  const rows: unknown[] = [header()];
  const inner = (data['data'] ?? {}) as Loose;
  const list = Array.isArray(inner['message']) ? (inner['message'] as Loose[]) : [];
  for (const message of list) {
    const isUser = message['role'] === 'user';
    rows.push({
      name: message['name'] ?? (isUser ? userName : characterName),
      is_user: isUser,
      send_date: new Date(Number(message['time'] ?? now())).toISOString(),
      mes: message['data'] ?? '',
      extra: {},
    });
  }
  return toJsonl(rows);
}

/** ST's header test for an imported `.jsonl`. */
export function looksLikeImportedHeader(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Loose;
  return (
    o['user_name'] !== undefined || o['name'] !== undefined || o['chat_metadata'] !== undefined
  );
}

/**
 * Character chat import (ST `/api/chats/import`). Throws `ChatImportError` for unknown formats.
 * `userName` = name1, `characterName` = the sanitized character name.
 */
export function importCharacterChat(
  text: string,
  format: ChatImportFormat,
  {
    userName,
    characterName,
    now = Date.now,
  }: { userName: string; characterName: string; now?: () => number },
): ChatImportResult {
  if (format === 'jsonl') {
    const lines = text.split('\n');
    if (!looksLikeImportedHeader(tryParse(lines[0] ?? ''))) {
      throw new ChatImportError('不是酒馆格式的聊天文件（第一行不是聊天头）');
    }
    let flattened = text;
    try {
      flattened = flattenChubChat(lines);
    } catch {
      /* ST: keep the original when flattening fails */
    }
    return { chats: [flattened], source: flattened === text ? 'st' : 'chub' };
  }
  const data = tryParse(text) as Loose | undefined;
  if (!data || typeof data !== 'object') throw new ChatImportError('不是有效的 JSON');
  if (data['savedsettings'] !== undefined)
    return { chats: [importKoboldLite(data, now)], source: 'kobold' };
  if (data['histories'] !== undefined)
    return { chats: importCai(data, userName, characterName, now), source: 'cai' };
  if (Array.isArray(data['data_visible']))
    return { chats: [importOoba(data, userName, characterName, now)], source: 'ooba' };
  if (Array.isArray(data['messages']))
    return { chats: [importAgnai(data, userName, characterName, now)], source: 'agnai' };
  if (data['type'] === 'risuChat')
    return { chats: [importRisu(data, userName, characterName, now)], source: 'risu' };
  throw new ChatImportError(
    '不认识的聊天格式（支持酒馆 jsonl、Kobold Lite、CAI Tools、oobabooga、Agnai、RisuAI）',
  );
}

/**
 * `<name> - <stamp> imported.jsonl`, made unique against `existing` (ST overwrites when several
 * chats land in the same second; we suffix ` (2)`, ` (3)` …).
 */
export function importedChatFileName(
  characterName: string,
  stamp: string,
  existing: readonly string[],
): string {
  const taken = new Set(existing);
  const base = `${characterName} - ${stamp} imported`;
  if (!taken.has(`${base}.jsonl`)) return `${base}.jsonl`;
  for (let i = 2; ; i++) {
    const name = `${base} (${i}).jsonl`;
    if (!taken.has(name)) return name;
  }
}
