#!/usr/bin/env node
/**
 * Bundle ST's default formatting templates and Text Completion presets (COMPAT_TARGET
 * `default/content`) into one JSON the app seeds on first run, like ST's content-manager
 * (DEV_NOTES §9.19). Run after bumping COMPAT_TARGET:
 *   node tools/default-content/build.mjs [path/to/SillyTavern]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const st = process.argv[2] ?? join(ROOT, '..', 'SillyTavern');
const contentDir = join(st, 'default', 'content');
const index = JSON.parse(readFileSync(join(contentDir, 'index.json'), 'utf8'));

/** content-manager.js getUserTargetByType for the types we seed */
const TARGETS = {
  instruct: 'instruct',
  context: 'context',
  sysprompt: 'sysprompt',
  reasoning: 'reasoning',
  textgen_preset: 'TextGen Settings',
  world: 'worlds',
};

const items = index
  .filter((x) => x.type in TARGETS)
  .map((x) => ({
    filename: x.filename,
    type: x.type,
    target: `${TARGETS[x.type]}/${basename(x.filename)}`,
    content: readFileSync(join(contentDir, x.filename), 'utf8'),
  }));

const out = join(ROOT, 'apps', 'app', 'src-tauri', 'assets', 'st-default-content.json');
writeFileSync(out, JSON.stringify({ source: 'SillyTavern default/content', items }));
console.log(`${items.length} items → ${out}`);
