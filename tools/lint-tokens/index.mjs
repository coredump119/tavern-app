#!/usr/bin/env node
/**
 * lint-tokens — fail on hard-coded colors / pixel sizes in UI code.
 * Allowed: packages/ui/src/tokens/*.css (the token definitions) and packages/ui/src/theme/*.ts (palettes).
 * Rules (DESIGN.md §0.1):
 *   - no color literals: #hex, rgb(), rgba(), hsl(), oklch(), named colors in `color:`/`background:`
 *   - no px literals except 0px / 1px / 0.5px / 2px (outline), and inside @media queries
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const SCAN = ['apps', 'packages'];
const EXT = new Set(['.svelte', '.css']);
const ALLOW = [
  /packages\/ui\/src\/tokens\//,
  /packages\/ui\/src\/theme\//,
  /node_modules/,
  /\/dist\//,
  /src-tauri\//,
  // third-party libraries for TavernHelper cards, copied in by tools/th-libs
  /\/public\/th\/lib\//,
];

const COLOR_RE = /(#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\()/;
const PX_RE = /(?<![\w.-])(\d*\.?\d+)px\b/g;
const PX_OK = new Set(['0', '1', '0.5', '2']);
const NAMED =
  /(?:^|[\s:;])(?:color|background(?:-color)?|border(?:-color)?|fill|stroke)\s*:\s*(white|black|red|blue|green|gray|grey|transparent)\b/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (ALLOW.some((re) => re.test(p.split(sep).join('/')))) continue;
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.has(name.slice(name.lastIndexOf('.')))) yield p;
  }
}

let errors = 0;
for (const base of SCAN) {
  let dir;
  try {
    dir = join(ROOT, base);
    statSync(dir);
  } catch {
    continue;
  }
  for (const file of walk(dir)) {
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) =>
      m.replace(/[^\n]/g, ' '),
    );
    const rel = relative(ROOT, file);
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/^\s*@media/.test(code)) return;
      const inStyleish = /:\s*[^;]*$/.test(code) || /\b(?:style|class)=/.test(code);
      if (!inStyleish && !/\.(svelte|css)$/.test(file)) return;
      if (COLOR_RE.test(code) && !/var\(--tm-/.test(code.match(COLOR_RE)?.[0] ?? '')) {
        if (!/color-mix\(/.test(code)) report(rel, i + 1, 'hard-coded color', code);
      }
      if (NAMED.test(code)) report(rel, i + 1, 'named color', code);
      for (const m of code.matchAll(PX_RE)) {
        if (!PX_OK.has(m[1])) report(rel, i + 1, `hard-coded ${m[0]}`, code);
      }
    });
  }
}
function report(file, line, why, code) {
  errors++;
  console.error(`${file}:${line}  ${why}\n    ${code.trim()}`);
}
if (errors) {
  console.error(`\nlint-tokens: ${errors} violation(s). Use --tm-* tokens (DESIGN.md §2).`);
  process.exit(1);
}
console.log('lint-tokens: ok');
