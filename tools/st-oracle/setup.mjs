#!/usr/bin/env node
/**
 * Fetch the COMPAT_TARGET SillyTavern commit into tools/st-oracle/.st and install its deps.
 * Idempotent: skips when the checkout already matches the pinned commit.
 * Env: ST_ORACLE_DIR — use an existing ST checkout instead (nothing is downloaded).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const target = join(here, '.st');
const ST_REPO = 'https://github.com/SillyTavern/SillyTavern.git';

const compat = readFileSync(join(repoRoot, 'COMPAT_TARGET.md'), 'utf8');
const commit = /\|\s*commit\s*\|\s*`([0-9a-f]{40})`\s*\|/.exec(compat)?.[1];
if (!commit) throw new Error('COMPAT_TARGET.md: commit row not found');

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
const head = (cwd) => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

if (process.env.ST_ORACLE_DIR) {
  console.log(`st-oracle: using ST_ORACLE_DIR=${process.env.ST_ORACLE_DIR}`);
  process.exit(0);
}

if (head(target) !== commit) {
  console.log(`st-oracle: fetching SillyTavern@${commit.slice(0, 7)} → ${target}`);
  if (!existsSync(join(target, '.git'))) {
    run('git', ['init', '-q', target]);
    run('git', ['remote', 'add', 'origin', ST_REPO], target);
  }
  run('git', ['fetch', '--depth', '1', 'origin', commit], target);
  run('git', ['checkout', '-q', '--force', 'FETCH_HEAD'], target);
} else {
  console.log('st-oracle: checkout already at COMPAT_TARGET');
}

if (!existsSync(join(target, 'node_modules', 'express'))) {
  console.log('st-oracle: npm ci (production deps)');
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], target);
} else {
  console.log('st-oracle: node_modules present');
}
console.log('st-oracle: ready');
