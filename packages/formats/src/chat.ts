/**
 * ST chat jsonl. Line 0 is the header, every following line one message. ST joins lines with
 * `\n` and writes no trailing newline. Loose schemas, no defaults — see README.
 */
import { z } from 'zod';

const str = z.string();
const dateish = z.union([z.string(), z.number()]);

export const ChatMetadataSchema = z.looseObject({
  integrity: str.optional(),
  note_prompt: str.optional(),
  note_interval: z.number().optional(),
  note_position: z.number().optional(),
  note_depth: z.number().optional(),
  note_role: z.number().optional(),
  tainted: z.boolean().optional(),
  lastInContextMessageId: z.number().optional(),
  main_chat: str.nullable().optional(),
  world_info: z.unknown().optional(),
  timedWorldInfo: z.unknown().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
});

/** Group chats carry only chat_metadata (+ optional names); ST's import check accepts any of the three. */
export const ChatHeaderSchema = z.looseObject({
  user_name: str.optional(),
  character_name: str.optional(),
  create_date: dateish.optional(),
  chat_metadata: ChatMetadataSchema.optional(),
});

export const SwipeInfoSchema = z.looseObject({
  send_date: dateish.optional(),
  gen_started: dateish.optional(),
  gen_finished: dateish.optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export const MessageExtraSchema = z.looseObject({
  api: str.optional(),
  model: str.optional(),
  reasoning: str.optional(),
  reasoning_type: str.optional(),
  reasoning_duration: z.number().nullable().optional(),
  reasoning_signature: str.nullable().optional(),
  time_to_first_token: z.number().nullable().optional(),
  bias: str.nullable().optional(),
  isSmallSys: z.boolean().optional(),
  display_text: str.optional(),
  token_count: z.number().optional(),
  type: str.optional(),
  gen_id: dateish.optional(),
  image: str.optional(),
  inline_image: z.boolean().optional(),
  title: str.optional(),
});

export const ChatMessageSchema = z.looseObject({
  name: str,
  is_user: z.boolean(),
  is_system: z.boolean().optional(),
  send_date: dateish,
  mes: str,
  extra: MessageExtraSchema.optional(),
  swipe_id: z.number().optional(),
  swipes: z.array(str).optional(),
  swipe_info: z.array(SwipeInfoSchema.nullable()).optional(),
  force_avatar: str.optional(),
  original_avatar: str.optional(),
  gen_started: dateish.optional(),
  gen_finished: dateish.optional(),
  title: str.optional(),
});

export type ChatMetadata = z.infer<typeof ChatMetadataSchema>;
export type ChatHeader = z.infer<typeof ChatHeaderSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type SwipeInfo = z.infer<typeof SwipeInfoSchema>;

export interface ParsedChat {
  header: ChatHeader;
  messages: ChatMessage[];
}

/** Same test ST runs on import: a header has user_name, name or chat_metadata. */
export function looksLikeChatHeader(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    o['user_name'] !== undefined || o['name'] !== undefined || o['chat_metadata'] !== undefined
  );
}

export function parseChatHeader(raw: unknown): ChatHeader {
  if (!looksLikeChatHeader(raw)) throw new Error('chat: first line is not a chat header');
  return ChatHeaderSchema.parse(raw);
}

export function parseChatMessage(raw: unknown): ChatMessage {
  return ChatMessageSchema.parse(raw);
}

/** Non-blank lines only; CRLF tolerated. */
export function splitJsonl(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0);
}

export function parseChatJsonl(text: string): ParsedChat {
  const lines = splitJsonl(text);
  if (lines.length === 0) throw new Error('chat: empty file');
  const header = parseChatHeader(JSON.parse(lines[0]!));
  const messages = lines.slice(1).map((l, i) => {
    try {
      return parseChatMessage(JSON.parse(l));
    } catch (e) {
      throw new Error(`chat: message ${i} invalid: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return { header, messages };
}

/** Exactly ST's on-disk shape: lines joined by `\n`, no trailing newline. */
export function serializeChatJsonl(chat: ParsedChat): string {
  return [chat.header, ...chat.messages].map((o) => JSON.stringify(o)).join('\n');
}

export function serializeMessage(m: ChatMessage): string {
  return JSON.stringify(m);
}
