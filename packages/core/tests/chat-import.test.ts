// 单个聊天导入：各家格式 → ST jsonl（DEV_NOTES §9.32）
import { describe, expect, it } from 'vitest';
import {
  ChatImportError,
  flattenChubChat,
  importCharacterChat,
  importedChatFileName,
} from '../src/index.js';

const now = () => Date.UTC(2026, 10, 8, 12, 0, 0);
const opts = { userName: 'Yun', characterName: 'Sera', now };
const rows = (jsonl: string) =>
  jsonl.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

describe('jsonl', () => {
  it('keeps an ST chat byte-identical when nothing needs flattening', () => {
    const text = [
      JSON.stringify({ user_name: 'Yun', character_name: 'Sera', chat_metadata: {} }),
      JSON.stringify({ name: 'Sera', is_user: false, mes: 'hi', send_date: 'x' }),
    ].join('\n');
    const r = importCharacterChat(text, 'jsonl', opts);
    expect(r.chats).toEqual([text]);
    expect(r.source).toBe('st');
  });
  it('flattens Chub message objects and swipes', () => {
    const text = [
      JSON.stringify({ chat_metadata: {} }),
      JSON.stringify({ name: 'S', mes: { message: 'a' }, swipes: [{ message: 'a' }, 'b'] }),
    ].join('\n');
    const r = importCharacterChat(text, 'jsonl', opts);
    expect(r.source).toBe('chub');
    expect(rows(r.chats[0]!)[1]).toEqual({ name: 'S', mes: 'a', swipes: ['a', 'b'] });
    expect(flattenChubChat(['not json'])).toBe('not json');
  });
  it('rejects a jsonl without a chat header', () => {
    expect(() => importCharacterChat('{"mes":"x"}', 'jsonl', opts)).toThrow(ChatImportError);
  });
});

describe('json formats', () => {
  it('oobabooga data_visible pairs', () => {
    const r = importCharacterChat(
      JSON.stringify({
        data_visible: [
          ['hi', 'hello'],
          ['', 'more'],
        ],
      }),
      'json',
      opts,
    );
    const out = rows(r.chats[0]!);
    expect(r.source).toBe('ooba');
    expect(out[0]).toEqual({ chat_metadata: {}, user_name: 'unused', character_name: 'unused' });
    expect(out.slice(1).map((m) => [m['name'], m['is_user'], m['mes']])).toEqual([
      ['Yun', true, 'hi'],
      ['Sera', false, 'hello'],
      ['Sera', false, 'more'],
    ]);
    expect(out[1]!['send_date']).toBe('2026-11-08T12:00:00.000Z');
  });
  it('Agnai, RisuAI, Kobold Lite and CAI Tools', () => {
    const agnai = rows(
      importCharacterChat(
        JSON.stringify({ messages: [{ userId: 'u', msg: 'a' }, { msg: 'b' }] }),
        'json',
        opts,
      ).chats[0]!,
    );
    expect(agnai.slice(1).map((m) => m['is_user'])).toEqual([true, false]);
    const risu = rows(
      importCharacterChat(
        JSON.stringify({
          type: 'risuChat',
          data: {
            message: [
              { role: 'user', data: 'q', time: 0 },
              { role: 'char', data: 'r', name: 'Other' },
            ],
          },
        }),
        'json',
        opts,
      ).chats[0]!,
    );
    expect(risu[1]).toMatchObject({
      name: 'Yun',
      is_user: true,
      mes: 'q',
      send_date: '1970-01-01T00:00:00.000Z',
    });
    expect(risu[2]).toMatchObject({ name: 'Other', is_user: false });
    const kobold = rows(
      importCharacterChat(
        JSON.stringify({
          savedsettings: { chatname: 'K', chatopponent: 'Bot||$||x' },
          prompt: '{{[OUTPUT]}}hey',
          actions: ['{{[INPUT]}}yo'],
        }),
        'json',
        opts,
      ).chats[0]!,
    );
    expect(kobold.slice(1).map((m) => [m['name'], m['mes']])).toEqual([
      ['Bot', 'hey'],
      ['K', 'yo'],
    ]);
    const cai = importCharacterChat(
      JSON.stringify({
        histories: {
          histories: [{ msgs: [{ src: { is_human: true }, text: 'a' }] }, { msgs: [] }],
        },
      }),
      'json',
      opts,
    );
    expect(cai.chats).toHaveLength(2);
    expect(rows(cai.chats[0]!)[1]).toMatchObject({ name: 'Yun', is_user: true, mes: 'a' });
  });
  it('unknown json throws', () => {
    expect(() => importCharacterChat('{"foo":1}', 'json', opts)).toThrow(ChatImportError);
    expect(() => importCharacterChat('nope', 'json', opts)).toThrow(ChatImportError);
  });
});

describe('file names', () => {
  it('suffixes when the same second is taken', () => {
    expect(importedChatFileName('Sera', '2026-11-8@12h00m00s', [])).toBe(
      'Sera - 2026-11-8@12h00m00s imported.jsonl',
    );
    expect(
      importedChatFileName('Sera', '2026-11-8@12h00m00s', [
        'Sera - 2026-11-8@12h00m00s imported.jsonl',
      ]),
    ).toBe('Sera - 2026-11-8@12h00m00s imported (2).jsonl');
  });
});
