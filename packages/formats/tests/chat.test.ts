import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ChatMessageSchema,
  looksLikeChatHeader,
  parseChatJsonl,
  serializeChatJsonl,
  serializeMessage,
  splitJsonl,
} from '../src/index.js';

const text = readFileSync(new URL('./fixtures/chat-sample.jsonl', import.meta.url), 'utf8');

describe('chat jsonl', () => {
  it('parses header + messages and round-trips deep-equal', () => {
    const chat = parseChatJsonl(text);
    expect(chat.header.character_name).toBe('Lune');
    expect(chat.header.chat_metadata?.integrity).toBe('0e3f9c2a');
    expect(chat.messages).toHaveLength(4);
    const lines = splitJsonl(text);
    expect(JSON.parse(JSON.stringify(chat.header))).toEqual(JSON.parse(lines[0]!));
    chat.messages.forEach((m, i) =>
      expect(JSON.parse(JSON.stringify(m))).toEqual(JSON.parse(lines[i + 1]!)),
    );
  });
  it('serializes in ST shape: \\n-joined, no trailing newline, same objects', () => {
    const chat = parseChatJsonl(text);
    const out = serializeChatJsonl(chat);
    expect(out.endsWith('\n')).toBe(false);
    expect(out.split('\n')).toHaveLength(5);
    expect(parseChatJsonl(out)).toEqual(chat);
    expect(JSON.parse(serializeMessage(chat.messages[2]!))).toEqual(
      JSON.parse(splitJsonl(text)[3]!),
    );
  });
  it('keeps swipes, reasoning extra, system messages and unknown keys', () => {
    const { messages } = parseChatJsonl(text);
    const m = messages[2]!;
    expect(m.swipe_id).toBe(1);
    expect(m.swipes).toHaveLength(2);
    expect(m.swipe_info?.[1]?.extra?.['reasoning']).toContain('原谅');
    expect(m.extra?.reasoning_duration).toBe(1200);
    expect((m as Record<string, unknown>)['custom_ext_field']).toEqual({ nested: [1, 2, 3] });
    expect(messages[3]?.is_system).toBe(true);
    expect(messages[3]?.extra?.isSmallSys).toBe(true);
  });
  it('tolerates CRLF and blank lines; rejects non-chat first lines', () => {
    const crlf = text.replace(/\n/g, '\r\n') + '\r\n\r\n';
    expect(parseChatJsonl(crlf).messages).toHaveLength(4);
    expect(looksLikeChatHeader({ chat_metadata: {} })).toBe(true);
    expect(looksLikeChatHeader({ name: 'group' })).toBe(true);
    expect(() => parseChatJsonl('{"foo":1}\n{}')).toThrow(/not a chat header/);
    expect(() => parseChatJsonl('')).toThrow(/empty/);
  });
  it('points at the broken message', () => {
    const bad = text.split('\n');
    bad[2] = '{"name":"x","is_user":"no","send_date":"d","mes":"m"}';
    expect(() => parseChatJsonl(bad.join('\n'))).toThrow(/message 1 invalid/);
    expect(
      ChatMessageSchema.safeParse({ name: 'a', is_user: true, send_date: 1, mes: 'm' }).success,
    ).toBe(true);
  });
});
