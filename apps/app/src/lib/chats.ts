/**
 * Chat file management (DEV_NOTES §9.27): rename / delete / search / export for character chats
 * (`chats/<stem>/*.jsonl`) and group chats (`group chats/<id>.jsonl`). Pure orchestration over ipc.
 */
import type { ChatMessage, Group } from '@tm/formats';
import {
  ChatImportError,
  equalsIgnoreCaseAndAccents,
  importCharacterChat,
  importedChatFileName,
  sanitizeFilename,
  type ChatImportFormat,
} from '@tm/core';
import {
  cardRead,
  cardWrite,
  chatCreate,
  dataDelete,
  dataRename,
  fileReadText,
  indexSearch,
  type SearchHit,
} from './ipc';
import { groupChatFile, groupChatPath, writeGroup } from './groups';

export const chatStem = (file: string) => file.replace(/\.jsonl$/i, '');
export const characterChatRel = (avatar: string, file: string) =>
  `chats/${avatar.replace(/\.png$/i, '')}/${file}`;

export interface RenameChatResult {
  /** new file name with extension */
  file: string;
  /** the card's `chat` field pointed at the old name and was updated */
  cardUpdated: boolean;
}

/** ST `renameGroupOrCharacterChat` checks: trims, sanitizes, refuses same / case-only changes. */
export function newChatFileName(oldFile: string, newName: string): string {
  const clean = sanitizeFilename(newName.trim());
  if (!clean) throw new Error('名字无效');
  const next = `${clean}.jsonl`;
  if (next === oldFile) throw new Error('名字没有变化');
  if (equalsIgnoreCaseAndAccents(next, oldFile))
    throw new Error('只改了大小写或重音，酒馆不接受这样的改名');
  return next;
}

/** Character chat: move the file; update the card's `chat` when it referenced the old name. */
export async function renameCharacterChat(
  root: string,
  avatar: string,
  oldFile: string,
  newName: string,
): Promise<RenameChatResult> {
  const file = newChatFileName(oldFile, newName);
  await dataRename(root, characterChatRel(avatar, oldFile), characterChatRel(avatar, file));
  let cardUpdated = false;
  try {
    const path = `${root}/characters/${avatar}`;
    const card = JSON.parse(await cardRead(path)) as Record<string, unknown>;
    if (card['chat'] === chatStem(oldFile)) {
      card['chat'] = chatStem(file);
      await cardWrite(path, JSON.stringify(card));
      cardUpdated = true;
    }
  } catch {
    /* the chat is renamed; the card pointer is best effort */
  }
  return { file, cardUpdated };
}

/** ST `renameGroupChat`: move the file, replace the id in `chats` (ST re-appends it) and `chat_id`. */
export async function renameGroupChat(
  root: string,
  group: Group,
  oldId: string,
  newName: string,
): Promise<string> {
  const file = newChatFileName(`${oldId}.jsonl`, newName);
  const newId = chatStem(file);
  await dataRename(root, groupChatFile(oldId), groupChatFile(newId));
  const chats = (group.chats ?? []).filter((c) => c !== oldId);
  chats.push(newId);
  group.chats = chats;
  if (group.chat_id === oldId) group.chat_id = newId;
  await writeGroup(root, group);
  return newId;
}

export async function deleteCharacterChat(
  root: string,
  avatar: string,
  file: string,
): Promise<void> {
  await dataDelete(root, characterChatRel(avatar, file));
}

/** ST `deleteGroupChat` bookkeeping: file + `chats` entry; `chat_id` cleared when it was current. */
export async function deleteGroupChat(root: string, group: Group, chatId: string): Promise<void> {
  try {
    await dataDelete(root, groupChatFile(chatId));
  } catch {
    /* already gone */
  }
  group.chats = (group.chats ?? []).filter((c) => c !== chatId);
  if (group.chat_id === chatId) group.chat_id = '';
  await writeGroup(root, group);
}

/** ST `/api/chats/export` txt: skip system messages, `name: display_text|mes`, blank line between. */
export function chatToTxt(messages: readonly ChatMessage[]): string {
  let out = '';
  for (const m of messages) {
    if (m.is_system) continue;
    if (!m.mes) continue;
    const display = (m.extra as { display_text?: unknown } | undefined)?.display_text;
    const text = String(typeof display === 'string' && display ? display : m.mes).replace(
      /\r?\n/g,
      '\n',
    );
    out += `${m.name}: ${text}\n\n`;
  }
  return out;
}

/** Files of `avatar` whose messages match `query` (index key is `<avatar>/<file>`). */
export async function searchCharacterChats(
  root: string,
  avatar: string,
  query: string,
  limit = 200,
): Promise<Map<string, SearchHit>> {
  const q = query.trim();
  const out = new Map<string, SearchHit>();
  if (!q) return out;
  const prefix = `${avatar}/`;
  for (const hit of await indexSearch(root, q, limit)) {
    if (!hit.chat_file.startsWith(prefix)) continue;
    const file = hit.chat_file.slice(prefix.length);
    if (!out.has(file)) out.set(file, hit);
  }
  return out;
}

// ---- single chat import (ST #chat_import_file, DEV_NOTES §9.32) ----

/** chat imports are text; anything bigger than this is almost certainly not a chat */
const IMPORT_MAX_BYTES = 200 * 1024 * 1024;

export interface ChatImportOutcome {
  /** new chat files (with `.jsonl`) */
  imported: string[];
  /** per-file problems, already phrased for the user */
  errors: string[];
}

const formatOf = (path: string): ChatImportFormat | null => {
  const ext = path.split(/[?#]/)[0]!.split('.').pop()?.toLowerCase();
  return ext === 'json' || ext === 'jsonl' ? ext : null;
};
const baseName = (path: string) => decodeURIComponent(path.split(/[\\/]/).pop() ?? path);
const jsonlLines = (text: string) => text.replace(/\n+$/, '').split('\n');

/**
 * ST importCharacterChat: convert each picked file and write it into `chats/<avatar stem>/`.
 * `stamp` is `humanizedDateTime()`; `existing` the character's current chat file names.
 */
export async function importCharacterChats(
  root: string,
  character: { avatar: string; name: string },
  userName: string,
  paths: readonly string[],
  stamp: string,
  existing: readonly string[],
): Promise<ChatImportOutcome> {
  const out: ChatImportOutcome = { imported: [], errors: [] };
  const taken = [...existing];
  const characterName = sanitizeFilename(character.name) || 'Character';
  for (const path of paths) {
    const name = baseName(path);
    const format = formatOf(path);
    if (!format) {
      out.errors.push(`${name}：只支持 .json / .jsonl`);
      continue;
    }
    try {
      const text = await fileReadText(path, IMPORT_MAX_BYTES);
      const result = importCharacterChat(text, format, {
        userName: sanitizeFilename(userName) || 'User',
        characterName,
      });
      for (const chat of result.chats) {
        const file = importedChatFileName(characterName, stamp, taken);
        taken.push(file);
        await chatCreate(`${root}/${characterChatRel(character.avatar, file)}`, jsonlLines(chat));
        out.imported.push(file);
      }
    } catch (e) {
      const msg = e instanceof ChatImportError || e instanceof Error ? e.message : String(e);
      out.errors.push(`${name}：${msg}`);
    }
  }
  return out;
}

/** ST importGroupChat: `.jsonl` only, copied verbatim as a new group chat and listed on the group. */
export async function importGroupChats(
  root: string,
  group: Group,
  paths: readonly string[],
  stamp: string,
): Promise<ChatImportOutcome> {
  const out: ChatImportOutcome = { imported: [], errors: [] };
  const chats = Array.isArray(group.chats) ? [...group.chats] : [];
  for (const path of paths) {
    const name = baseName(path);
    if (formatOf(path) !== 'jsonl') {
      out.errors.push(`${name}：群聊只支持酒馆自己的 .jsonl 格式`);
      continue;
    }
    try {
      const text = await fileReadText(path, IMPORT_MAX_BYTES);
      let id = stamp;
      for (let i = 2; chats.includes(id); i++) id = `${stamp} (${i})`;
      await chatCreate(groupChatPath(root, id), jsonlLines(text));
      chats.push(id);
      out.imported.push(`${id}.jsonl`);
    } catch (e) {
      out.errors.push(`${name}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (out.imported.length) await writeGroup(root, { ...group, chats });
  return out;
}
