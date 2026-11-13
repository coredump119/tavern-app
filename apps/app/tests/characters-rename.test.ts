import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockFs, ipcModule } from './ipc-mock';

const fs = createMockFs();
const ipc = ipcModule(fs);
vi.mock('../src/lib/ipc', () => ipc);

const { renameCharacter } = await import('../src/lib/characters');
const ROOT = '/data';

describe('renameCharacter reference sync (ST renameCharacter + renameGroupMember)', () => {
  beforeEach(() => {
    fs.files.clear();
    fs.calls.length = 0;
    vi.clearAllMocks();
  });

  it('moves tag_map, active_character, charLore and note.chara, and rewrites group members + their chats', async () => {
    fs.files.set(
      `${ROOT}/groups/1.json`,
      JSON.stringify({
        id: '1',
        name: 'g',
        members: ['Sera.png', 'Other.png'],
        disabled_members: ['Sera.png'],
        chats: ['c1', 'c2'],
      }),
    );
    fs.files.set(
      `${ROOT}/groups/2.json`,
      JSON.stringify({ id: '2', name: 'g2', members: ['Other.png'], chats: ['c3'] }),
    );
    const settings = {
      active_character: 'Sera.png',
      tags: [{ id: 't1', name: 'tag' }],
      tag_map: { 'Sera.png': ['t1'] },
      world_info_settings: {
        world_info: { charLore: [{ name: 'Sera', extraBooks: ['Eldoria'] }] },
      },
      extension_settings: {
        note: {
          chara: [
            { name: 'Sera', prompt: 'p' },
            { name: 'Other', prompt: 'q' },
          ],
        },
      },
    };
    const r = await renameCharacter(ROOT, 'Sera.png', 'Seraphina', true, settings);
    expect(r.avatar).toBe('Seraphina.png');
    expect(r.chatsRewritten).toBe(2);
    expect(r.groupsUpdated).toBe(1);
    expect(r.groupChatsRewritten).toBe(2);
    const s = r.settings!;
    expect(s['active_character']).toBe('Seraphina.png');
    expect((s['tag_map'] as Record<string, string[]>)['Seraphina.png']).toEqual(['t1']);
    expect((s['tag_map'] as Record<string, unknown>)['Sera.png']).toBeUndefined();
    const charLore = (s['world_info_settings'] as { world_info: { charLore: { name: string }[] } })
      .world_info.charLore;
    expect(charLore[0]!.name).toBe('Seraphina');
    const chara = (s['extension_settings'] as { note: { chara: { name: string }[] } }).note.chara;
    expect(chara.map((c) => c.name)).toEqual(['Seraphina', 'Other']);
    // the original object is untouched
    expect(settings.active_character).toBe('Sera.png');
    const g1 = JSON.parse(fs.files.get(`${ROOT}/groups/1.json`)!);
    expect(g1.members).toEqual(['Seraphina.png', 'Other.png']);
    expect(g1.disabled_members).toEqual(['Seraphina.png']);
    expect(ipc.chatRenameGroupMember).toHaveBeenCalledWith(
      ROOT,
      ['c1', 'c2'],
      'Sera.png',
      'Seraphina.png',
      'Seraphina',
    );
    // group 2 did not contain the character and is not rewritten
    expect(fs.calls.filter((c) => c.startsWith('write'))).toEqual(['write groups/1.json']);
  });

  it('returns null settings when nothing referenced the old avatar', async () => {
    const r = await renameCharacter(ROOT, 'Nobody.png', 'Someone', false, { tag_map: {} });
    expect(r.settings).toBeNull();
    expect(r.chatsRewritten).toBe(0);
    expect(r.groupsUpdated).toBe(0);
  });
});
