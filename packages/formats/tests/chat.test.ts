import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ChatMessageSchema,
  looksLikeChatHeader,
  parseChatHeader,
  parseChatMessage,
  parseChatJsonl,
  serializeChatJsonl,
  serializeMessage,
  splitJsonl,
} from '../src/index.js';

const text = readFileSync(new URL('./fixtures/chat-sample.jsonl', import.meta.url), 'utf8');

describe('chat lines with fields of the wrong type', () => {
  it('opens a message whose optional fields are null or mistyped', () => {
    const m = parseChatMessage({
      name: 'Sera',
      is_user: false,
      send_date: 'June 1, 2026 9:00am',
      mes: 'hi',
      original_avatar: null,
      force_avatar: null,
      title: 5,
      swipe_id: '0',
      swipes: ['hi', null, 7],
      swipe_info: [{ send_date: null }, 'x'],
      extra: { api: null, token_count: '12', kept: { deep: true } },
      custom_field: [1, 2],
    });
    expect(m).toEqual({
      name: 'Sera',
      is_user: false,
      send_date: 'June 1, 2026 9:00am',
      mes: 'hi',
      swipes: ['hi', '', '7'],
      swipe_info: [{}, null],
      extra: { kept: { deep: true } },
      custom_field: [1, 2],
    });
  });

  it('coerces the required fields instead of failing', () => {
    const m = parseChatMessage({ name: null, is_user: 1, send_date: null, mes: 42 });
    expect(m).toEqual({ name: '', is_user: true, send_date: '', mes: '42' });
  });

  it('leaves a well-formed message untouched and still rejects a non-object', () => {
    const raw = { name: 'A', is_user: true, send_date: 1, mes: 'x', original_avatar: 'a.png' };
    expect(parseChatMessage(raw)).toEqual(raw);
    expect(() => parseChatMessage('nope')).toThrow();
  });

  it('opens a header with mistyped metadata', () => {
    const h = parseChatHeader({
      user_name: 'U',
      character_name: null,
      chat_metadata: { note_interval: '1', variables: null, tainted: true },
    });
    expect(h).toEqual({ user_name: 'U', chat_metadata: { tainted: true } });
  });
});

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
    bad[2] = '["not", "a", "message"]';
    expect(() => parseChatJsonl(bad.join('\n'))).toThrow(/message 1 invalid/);
    expect(
      ChatMessageSchema.safeParse({ name: 'a', is_user: true, send_date: 1, mes: 'm' }).success,
    ).toBe(true);
  });
});
