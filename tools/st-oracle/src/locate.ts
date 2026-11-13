import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..', '..');

/**
 * Where is a runnable SillyTavern? In order: $ST_ORACLE_DIR, tools/st-oracle/.st (from
 * `pnpm --filter @tm/tool-st-oracle setup`), or the reference clone beside the repo.
 */
export function locateSillyTavern(): string | null {
  const candidates = [
    process.env['ST_ORACLE_DIR'],
    resolve(here, '..', '.st'),
    resolve(REPO_ROOT, '..', 'SillyTavern'),
  ];
  for (const dir of candidates) {
    if (
      dir &&
      existsSync(join(dir, 'server.js')) &&
      existsSync(join(dir, 'node_modules', 'express'))
    ) {
      return dir;
    }
  }
  return null;
}
