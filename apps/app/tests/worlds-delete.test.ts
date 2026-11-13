import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockFs, ipcModule } from './ipc-mock';

const fs = createMockFs();
vi.mock('../src/lib/ipc', () => ipcModule(fs));

const { deleteWorld } = await import('../src/lib/worlds');
const ROOT = '/data';

describe('deleteWorld (ST deleteWorldInfo)', () => {
  beforeEach(() => {
    fs.files.clear();
    fs.files.set(`${ROOT}/worlds/Eldoria.json`, '{"entries":{}}');
  });

  it('removes the file, the globalSelect entry and the persona lorebook link', async () => {
    const next = await deleteWorld(ROOT, 'Eldoria', {
      world_info_settings: {
        world_info: {
          globalSelect: ['Eldoria', 'Other'],
          charLore: [{ name: 'Seraphina', extraBooks: ['Eldoria'] }],
        },
      },
      power_user: { persona_description_lorebook: 'Eldoria' },
    });
    expect(fs.files.has(`${ROOT}/worlds/Eldoria.json`)).toBe(false);
    const wi = next!['world_info_settings'] as {
      world_info: { globalSelect: string[]; charLore: unknown[] };
    };
    expect(wi.world_info.globalSelect).toEqual(['Other']);
    expect(wi.world_info.charLore).toEqual([]);
    expect((next!['power_user'] as Record<string, unknown>)['persona_description_lorebook']).toBe(
      '',
    );
  });

  it('returns null when settings did not reference the book', async () => {
    const next = await deleteWorld(ROOT, 'Eldoria', {
      world_info_settings: { world_info: { globalSelect: ['Other'] } },
      power_user: { persona_description_lorebook: 'Other' },
    });
    expect(next).toBeNull();
  });
});
