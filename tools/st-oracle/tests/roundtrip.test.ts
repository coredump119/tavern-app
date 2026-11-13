/**
 * Phase 1 exit test (PHASES.md): zip an ST data dir → `tm-data import` → `tm-data export` →
 * a fresh ST reads the result identically. Needs a runnable ST and the tm-data binary
 * ($TM_DATA_BIN, or `cargo build -p tm-data` is run here).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateSillyTavern, REPO_ROOT, startOracle, type Oracle } from '../src/index.js';

const stDir = locateSillyTavern();

function tmDataBin(): string {
  const env = process.env['TM_DATA_BIN'];
  if (env && existsSync(env)) return env;
  execFileSync('cargo', ['build', '-p', 'tm-data', '--quiet'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  return join(REPO_ROOT, 'target', 'debug', 'tm-data');
}
const tmData = (bin: string, ...args: string[]) =>
  JSON.parse(execFileSync(bin, args, { encoding: 'utf8' })) as Record<string, unknown>;

interface Snapshot {
  characters: Array<Record<string, unknown>>;
  world: unknown;
  settings: unknown;
  chat: unknown;
  worlds: string[];
}

const VOLATILE = new Set(['date_added', 'date_last_chat', 'chat_size']);

async function snapshot(st: Oracle): Promise<Snapshot> {
  const characters = (await st.characters()).map((c) => {
    const copy = { ...c };
    for (const k of VOLATILE) delete copy[k];
    return copy;
  });
  const world = await st.api('/api/worldinfo/get', { name: 'Eldoria' });
  const settingsRes = await st.api<{ settings: string; world_names: string[] }>(
    '/api/settings/get',
  );
  const chat = await st.api('/api/chats/get', {
    avatar_url: 'default_Seraphina.png',
    file_name: 'oracle',
  });
  return {
    characters,
    world,
    settings: JSON.parse(settingsRes.settings),
    chat,
    worlds: settingsRes.world_names,
  };
}

describe.skipIf(!stDir)('Phase 1 exit: ST zip → import → export → ST reads losslessly', () => {
  const work = mkdtempSync(join(tmpdir(), 'tm-roundtrip-'));
  let bin: string;
  let before: Snapshot;
  let stA: Oracle | undefined;
  let stC: Oracle | undefined;

  beforeAll(async () => {
    bin = tmDataBin();
    stA = await startOracle({ stDir: stDir!, dataRoot: join(work, 'A', 'data'), keepData: true });
    // give ST something user-generated: a chat with swipes, saved through ST's own API
    await stA.api('/api/chats/save', {
      avatar_url: 'default_Seraphina.png',
      file_name: 'oracle',
      chat: [
        {
          user_name: 'User',
          character_name: 'Seraphina',
          create_date: '2026-10-31@12h00m00s',
          chat_metadata: { integrity: 'abc' },
        },
        {
          name: 'Seraphina',
          is_user: false,
          send_date: 'now',
          mes: '*She smiles.* 你来晚了。',
          extra: {},
          swipe_id: 0,
          swipes: ['*She smiles.* 你来晚了。'],
          swipe_info: [{ send_date: 'now', gen_started: 'x', gen_finished: 'y', extra: {} }],
        },
        {
          name: 'User',
          is_user: true,
          send_date: 'now',
          mes: 'hello oracle',
          extra: { custom: true },
        },
      ],
      force: true,
    });
    before = await snapshot(stA);
    await stA.stop();
  }, 180_000);

  afterAll(async () => {
    await stA?.stop();
    await stC?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  it('round-trips through tm-data and a fresh ST sees the same data', async () => {
    expect(before.characters.length).toBeGreaterThan(0);
    expect(before.worlds).toContain('Eldoria');

    // 1. the user's "ST export": zip the data dir with its wrapper folder
    const stZip = join(work, 'st-export.zip');
    execFileSync('zip', ['-qr', stZip, 'data'], { cwd: join(work, 'A') });

    // 2. import into our data root, index it, export again
    const B = join(work, 'B');
    const imp = tmData(bin, 'import', stZip, B);
    // ST's --dataRoot is the multi-user root; the user's data lives in data/default-user
    expect(imp['stripped_prefix']).toBe('data/default-user');
    expect(imp['files']).toBeGreaterThan(5);
    const scan = tmData(bin, 'index', 'rebuild', B);
    expect(scan['characters_updated']).toBe(before.characters.length);
    expect(scan['chats_updated']).toBeGreaterThanOrEqual(1);
    const hits = tmData(bin, 'index', 'search', B, 'oracle') as unknown as Array<{ idx: number }>;
    expect(hits.some((h) => h.idx === 1)).toBe(true);
    expect(existsSync(join(B, 'index.sqlite'))).toBe(true);

    const outZip = join(work, 'tm-export.zip');
    const exp = tmData(bin, 'export', B, outZip);
    expect(exp['files']).toBe(imp['files']);
    const listing = execFileSync('unzip', ['-Z1', outZip], { encoding: 'utf8' });
    expect(listing).not.toMatch(/index\.sqlite|secrets\.json/);

    // 3. a fresh ST on the exported tree (as its default-user)
    const C = join(work, 'C', 'data');
    mkdirSync(join(C, 'default-user'), { recursive: true });
    execFileSync('unzip', ['-q', outZip, '-d', join(C, 'default-user')]);
    stC = await startOracle({ stDir: stDir!, dataRoot: C, keepData: true });
    const after = await snapshot(stC);

    expect(after.characters).toEqual(before.characters);
    expect(after.world).toEqual(before.world);
    expect(after.chat).toEqual(before.chat);
    expect(after.worlds).toEqual(before.worlds);
    expect(after.settings).toEqual(before.settings);
  }, 180_000);
});
