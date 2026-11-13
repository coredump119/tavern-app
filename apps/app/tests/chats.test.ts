import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockFs, ipcModule } from './ipc-mock';

const fs = createMockFs();
vi.mock('../src/lib/ipc', () => ({
  ...ipcModule(fs),
  dataRename: vi.fn(async (root: string, from: string, to: string) => {
    const a = `${root}/${from}`;
    const b = `${root}/${to}`;
    if (!fs.files.has(a)) throw new Error(`not a file: ${from}`);
    if (fs.files.has(b)) throw new Error(`already exists: ${to}`);
    fs.files.set(b, fs.files.get(a)!);
    fs.files.delete(a);
  }),
  indexSearch: vi.fn(async (_root: string, q: string) =>
    q === 'glade'
      ? [
          { chat_file: 'Sera.png/a.jsonl', idx: 0, name: 'Sera', snippet: 'the [glade]' },
          { chat_file: 'Sera.png/a.jsonl', idx: 3, name: 'User', snippet: 'again [glade]' },
          { chat_file: 'Other.png/z.jsonl', idx: 0, name: 'O', snippet: '[glade]' },
        ]
      : [],
  ),
}));

const {
  chatToTxt,
  deleteCharacterChat,
  deleteGroupChat,
  newChatFileName,
  renameCharacterChat,
  renameGroupChat,
  searchCharacterChats,
} = await import('../src/lib/chats');
const ROOT = '/data';

describe('lib/chats', () => {
  beforeEach(() => fs.files.clear());

  it('newChatFileName follows ST rename rules', () => {
    expect(newChatFileName('old.jsonl', ' New: name? ')).toBe('New name.jsonl');
    expect(() => newChatFileName('old.jsonl', 'old')).toThrow('没有变化');
    expect(() => newChatFileName('old.jsonl', 'OLD')).toThrow('大小写');
    expect(() => newChatFileName('old.jsonl', '???')).toThrow('无效');
  });

  it('renames a character chat and updates the card chat pointer only when it matched', async () => {
    fs.files.set(`${ROOT}/chats/Sera/a.jsonl`, '{}\n{"mes":"x"}');
    fs.files.set(
      `${ROOT}/characters/Sera.png`,
      JSON.stringify({ name: 'Sera', chat: 'a', data: {} }),
    );
    const r = await renameCharacterChat(ROOT, 'Sera.png', 'a.jsonl', 'b');
    expect(r).toEqual({ file: 'b.jsonl', cardUpdated: true });
    expect(fs.files.has(`${ROOT}/chats/Sera/b.jsonl`)).toBe(true);
    expect(JSON.parse(fs.files.get(`${ROOT}/characters/Sera.png`)!).chat).toBe('b');
    // a card pointing elsewhere is left alone
    fs.files.set(
      `${ROOT}/characters/Sera.png`,
      JSON.stringify({ name: 'Sera', chat: 'other', data: {} }),
    );
    const r2 = await renameCharacterChat(ROOT, 'Sera.png', 'b.jsonl', 'c');
    expect(r2.cardUpdated).toBe(false);
    expect(JSON.parse(fs.files.get(`${ROOT}/characters/Sera.png`)!).chat).toBe('other');
    await expect(renameCharacterChat(ROOT, 'Sera.png', 'missing.jsonl', 'd')).rejects.toThrow();
  });

  it('renames / deletes group chats and rewrites the group file like ST', async () => {
    fs.files.set(`${ROOT}/group chats/c1.jsonl`, '{}');
    fs.files.set(`${ROOT}/group chats/c2.jsonl`, '{}');
    const group = { id: '1', name: 'g', members: [], chats: ['c1', 'c2'], chat_id: 'c1' };
    const id = await renameGroupChat(ROOT, group, 'c1', 'first');
    expect(id).toBe('first');
    expect(group.chats).toEqual(['c2', 'first']); // ST re-appends the renamed id
    expect(group.chat_id).toBe('first');
    expect(fs.files.has(`${ROOT}/group chats/first.jsonl`)).toBe(true);
    expect(JSON.parse(fs.files.get(`${ROOT}/groups/1.json`)!).chat_id).toBe('first');
    await deleteGroupChat(ROOT, group, 'first');
    expect(group.chats).toEqual(['c2']);
    expect(group.chat_id).toBe('');
    expect(fs.files.has(`${ROOT}/group chats/first.jsonl`)).toBe(false);
    await deleteCharacterChat(ROOT, 'Sera.png', 'nope.jsonl').catch(() => undefined);
  });

  it('txt export skips system messages and prefers display_text (ST /export)', () => {
    const txt = chatToTxt([
      { name: 'Sera', is_user: false, mes: 'Hi\r\nthere', send_date: 1 },
      { name: 'Sys', is_user: false, is_system: true, mes: 'hidden', send_date: 1 },
      { name: 'User', is_user: true, mes: 'raw', extra: { display_text: 'shown' }, send_date: 1 },
      { name: 'Empty', is_user: false, mes: '', send_date: 1 },
    ]);
    expect(txt).toBe('Sera: Hi\nthere\n\nUser: shown\n\n');
  });

  it('search maps index hits (keyed <avatar>/<file>) to this character only, first hit per file', async () => {
    const hits = await searchCharacterChats(ROOT, 'Sera.png', 'glade');
    expect([...hits.keys()]).toEqual(['a.jsonl']);
    expect(hits.get('a.jsonl')!.snippet).toBe('the [glade]');
    expect((await searchCharacterChats(ROOT, 'Sera.png', '  ')).size).toBe(0);
  });
});
