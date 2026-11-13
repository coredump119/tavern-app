import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockFs, ipcModule } from './ipc-mock';

const fs = createMockFs();
vi.mock('../src/lib/ipc', () => ipcModule(fs));

const { listGroups, writeGroup, deleteGroup, groupChatPath } = await import('../src/lib/groups');

const ROOT = '/data';
const group = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, name: `G${id}`, members: ['a.png'], chats: [id], chat_id: id, ...extra });

describe('lib/groups', () => {
  beforeEach(() => {
    fs.files.clear();
    fs.calls.length = 0;
  });

  it('lists parseable groups newest chat first and skips broken files', async () => {
    fs.files.set(`${ROOT}/groups/1.json`, group('1', { date_last_chat: 10 }));
    fs.files.set(`${ROOT}/groups/2.json`, group('2', { date_last_chat: 20 }));
    fs.files.set(`${ROOT}/groups/bad.json`, '{not json');
    fs.files.set(`${ROOT}/groups/notes.txt`, 'ignored');
    const list = await listGroups(ROOT);
    expect(list.map((g) => g.id)).toEqual(['2', '1']);
  });

  it('writeGroup drops chat_metadata / past_metadata like the ST server and pretty-prints', async () => {
    await writeGroup(ROOT, {
      id: '7',
      name: 'x',
      members: [],
      chat_metadata: { note_prompt: 'no' },
      past_metadata: {},
    });
    const raw = fs.files.get(`${ROOT}/groups/7.json`)!;
    expect(raw).toContain('\n    "id": "7"');
    expect(JSON.parse(raw)).toEqual({ id: '7', name: 'x', members: [] });
  });

  it('deleteGroup removes every listed chat file then the group file; missing chats are tolerated', async () => {
    fs.files.set(`${ROOT}/groups/9.json`, group('9', { chats: ['c1', 'c2'] }));
    fs.files.set(`${ROOT}/group chats/c1.jsonl`, '{}');
    await deleteGroup(ROOT, { id: '9', name: 'x', members: [], chats: ['c1', 'c2'] });
    expect(fs.calls).toEqual([
      'delete group chats/c1.jsonl',
      'delete group chats/c2.jsonl',
      'delete groups/9.json',
    ]);
    expect(fs.files.has(`${ROOT}/groups/9.json`)).toBe(false);
  });

  it('group chat path follows ST `group chats/<id>.jsonl`', () => {
    expect(groupChatPath(ROOT, '2026-1-1@1h2m3s')).toBe('/data/group chats/2026-1-1@1h2m3s.jsonl');
  });
});
