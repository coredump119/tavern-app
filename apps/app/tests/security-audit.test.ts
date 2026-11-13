/**
 * Security self-check (DEV_NOTES §9.38): the checklist items that can be read off the sources.
 * The behaviour behind them is covered where it lives (tm-data `archive` / `crashlog` / `seal`,
 * tm-net `error`, the ext tests); this file turns red when a later change walks around a rule.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function files(dir: string, pattern: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'gen') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files(path, pattern, out);
    else if (pattern.test(entry.name)) out.push(path);
  }
  return out;
}

const PAGE_SOURCES = [
  ...files('apps/app/src', /\.(svelte|ts)$/),
  ...files('packages/core/src', /\.ts$/),
  ...files('packages/ui/src', /\.(svelte|ts)$/),
];
const RUST_SOURCES = [...files('crates', /\.rs$/), ...files('apps/app/src-tauri/src', /\.rs$/)];
const appRust = read('apps/app/src-tauri/src/lib.rs');

/** names that mark a value as a credential or a connection address */
const SENSITIVE =
  /api_?key|secret|passw(or)?d|proxy_password|reverse_proxy|server_urls|authorization|bearer/i;

/** statements that start with `open` on a line, up to the closing `;` */
function statements(source: string, open: RegExp): string[] {
  const out: string[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!open.test(lines[i]!)) continue;
    let end = i;
    while (end < lines.length - 1 && end - i < 12 && !/;\s*$/.test(lines[end]!)) end += 1;
    out.push(lines.slice(i, end + 1).join('\n'));
  }
  return out;
}

describe('security self-check (DEV_NOTES §9.38)', () => {
  it('has no command that hands a stored key back to the page', () => {
    const handler = appRust.slice(appRust.indexOf('generate_handler!['));
    const commands = [...handler.slice(0, handler.indexOf(']')).matchAll(/\bsecret_\w+/g)]
      .map((m) => m[0])
      .sort();
    expect(commands).toEqual([
      'secret_backend_info',
      'secret_delete',
      'secret_find',
      'secret_rename',
      'secret_rotate',
      'secret_state',
      'secret_write',
    ]);
    // what the listing command returns: a masked value at most, never the key itself
    const vault = read('crates/tm-keys/src/vault.rs');
    const meta = vault.slice(vault.indexOf('pub struct SecretMeta'));
    const fields = [...meta.slice(0, meta.indexOf('\n}')).matchAll(/pub (\w+):/g)].map((m) => m[1]);
    expect(fields).toEqual(['id', 'label', 'active', 'masked']);
  });

  it('talks to Rust only through lib/ipc.ts', () => {
    const direct = PAGE_SOURCES.filter((path) =>
      /from '@tauri-apps\/api\/core'|__TAURI_INTERNALS__\s*\.\s*invoke/.test(read(path)),
    ).map((path) => relative('apps/app/src', path));
    expect(direct).toEqual(['lib/ipc.ts']);
  });

  it('prints no credential or connection address to the console', () => {
    const hits: string[] = [];
    for (const path of PAGE_SOURCES)
      for (const s of statements(read(path), /console\.(log|info|warn|error|debug)\(/))
        if (SENSITIVE.test(s)) hits.push(`${path}: ${s.trim().slice(0, 80)}`);
    expect(hits).toEqual([]);
  });

  it('prints no credential or connection address from Rust', () => {
    const hits: string[] = [];
    for (const path of RUST_SOURCES) {
      if (path.includes('/tests/') || path.includes('/bin/')) continue;
      const source = read(path).split('#[cfg(test)]')[0]!;
      for (const s of statements(source, /\b(e?println|dbg)!\(/))
        if (SENSITIVE.test(s) || /\burl\b/i.test(s)) hits.push(`${path}: ${s.trim().slice(0, 80)}`);
    }
    expect(hits).toEqual([]);
  });

  it('keeps addresses out of network error text', () => {
    expect(read('crates/tm-net/src/error.rs')).toContain('e.without_url()');
    const policy = read('crates/tm-net/src/policy.rs').split('#[cfg(test)]')[0]!;
    expect(policy).not.toMatch(/format!\([^)]*\{raw\}/);
  });

  it('keeps the crash log outside the data root and redacts every text field', () => {
    expect(appRust).toMatch(
      /install_panic_log\(app\.path\(\)\.app_data_dir\(\)\?\.join\("logs"\)\)/,
    );
    const append = read('crates/tm-data/src/crashlog.rs');
    const body = append.slice(append.indexOf('pub fn append'));
    for (const field of ['message', 'source', 'stack'])
      expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(
        new RegExp(`redact\\(&entry\\.${field}`),
      );
  });

  it('never stores or logs the backup password', () => {
    const dataPage = read('apps/app/src/routes/Data.svelte');
    expect(dataPage).not.toMatch(/localStorage|sessionStorage/);
    // the Rust side takes it by reference and hands it only to the seal module
    for (const m of appRust.matchAll(/^.*\bpassword\b.*$/gm))
      expect(m[0]).not.toMatch(/println!|crashlog::|settings::|fs::write/);
  });
});
