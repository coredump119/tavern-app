/**
 * Boot a real SillyTavern (COMPAT_TARGET) with throwaway config + data dirs and talk to its API.
 * CSRF is disabled and the whitelist is off, so plain fetch works from tests.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { locateSillyTavern } from './locate.js';

export interface OracleOptions {
  stDir?: string;
  port?: number;
  /** Use this data root instead of a fresh temp dir (not deleted on stop). */
  dataRoot?: string;
  /** keep temp dirs after stop() for inspection */
  keepData?: boolean;
  startupTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface StVersion {
  agent: string;
  pkgVersion: string;
  gitRevision?: string | null;
  gitBranch?: string | null;
}

export interface Oracle {
  baseUrl: string;
  port: number;
  stDir: string;
  dataRoot: string;
  /** Raw fetch with JSON headers; relative paths are resolved against baseUrl. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** POST JSON, parse JSON. Throws on non-2xx with the response text. */
  api<T = unknown>(path: string, body?: unknown): Promise<T>;
  version(): Promise<StVersion>;
  settings(): Promise<Record<string, unknown>>;
  characters(): Promise<Array<Record<string, unknown>>>;
  stdout(): string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startOracle(opts: OracleOptions = {}): Promise<Oracle> {
  const stDir = opts.stDir ?? locateSillyTavern();
  if (!stDir) {
    throw new Error(
      'st-oracle: no SillyTavern found. Run `pnpm --filter @tm/tool-st-oracle run setup-st` or set ST_ORACLE_DIR.',
    );
  }
  const port = opts.port ?? (await freePort());
  const tmp = mkdtempSync(join(tmpdir(), 'st-oracle-'));
  const dataRoot = opts.dataRoot ?? join(tmp, 'data');
  const configPath = join(tmp, 'config.yaml');
  const args = [
    'server.js',
    '--configPath',
    configPath,
    '--dataRoot',
    dataRoot,
    '--port',
    String(port),
    '--listen',
    'false',
    '--whitelist',
    'false',
    '--basicAuthMode',
    'false',
    '--browserLaunchEnabled',
    'false',
    '--disableCsrf',
  ];
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: stDir,
    env: { ...process.env, NODE_ENV: 'production', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const onData = (c: Buffer) => {
    const s = c.toString('utf8');
    out += s;
    opts.log?.(s.trimEnd());
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (opts.startupTimeoutMs ?? 60_000);
  let exited: number | null = null;
  child.once('exit', (code) => (exited = code ?? -1));
  for (;;) {
    if (exited !== null)
      throw new Error(`st-oracle: ST exited with ${exited}\n${out.slice(-2000)}`);
    try {
      const r = await fetch(`${baseUrl}/version`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`st-oracle: ST did not start within timeout\n${out.slice(-2000)}`);
    }
    await sleep(250);
  }

  const doFetch = (path: string, init: RequestInit = {}) =>
    fetch(path.startsWith('http') ? path : `${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });

  const api = async <T>(path: string, body: unknown = {}): Promise<T> => {
    const r = await doFetch(path, { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`st-oracle: ${path} → ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  };

  const stop = async () => {
    if (exited === null) {
      child.kill('SIGTERM');
      const t = Date.now() + 5000;
      while (exited === null && Date.now() < t) await sleep(50);
      if (exited === null) child.kill('SIGKILL');
    }
    if (!opts.keepData) rmSync(tmp, { recursive: true, force: true });
  };

  return {
    baseUrl,
    port,
    stDir,
    dataRoot,
    fetch: doFetch,
    api,
    version: async () => (await (await doFetch('/version')).json()) as StVersion,
    settings: () => api('/api/settings/get'),
    characters: () => api('/api/characters/all'),
    stdout: () => out,
    stop,
  };
}
