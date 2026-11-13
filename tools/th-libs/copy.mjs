// Copies the libraries TavernHelper cards expect (DEV_NOTES §9.5, round 3) from node_modules into
// `apps/app/public/th/lib/`, where the realm serves them as `/th/lib/…`. Runs before `dev` and
// `build` of @tm/app; the output is not committed.
import { copyFileSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const modules = join(root, 'apps/app/node_modules');
const out = join(root, 'apps/app/public/th/lib');

/** [path under `apps/app/node_modules`, path under `/th/lib/`]; a trailing `/` copies a directory's files */
const FILES = [
  ['jquery/dist/jquery.min.js', 'jquery.min.js'],
  ['jquery-ui/dist/jquery-ui.min.js', 'jquery-ui.min.js'],
  ['jquery-ui/dist/themes/base/theme.css', 'jquery-ui/theme.css'],
  ['jquery-ui/dist/themes/base/images/', 'jquery-ui/images/'],
  ['jquery-ui-touch-punch/jquery.ui.touch-punch.min.js', 'jquery.ui.touch-punch.min.js'],
  ['vue/dist/vue.global.prod.js', 'vue.global.prod.js'],
  ['vue-router/dist/vue-router.global.prod.js', 'vue-router.global.prod.js'],
  // the name cards written for SillyTavern ask for
  ['@tailwindcss/browser/dist/index.global.js', 'tailwindcss.min.js'],
  ['@fortawesome/fontawesome-free/css/all.min.css', 'fontawesome/css/all.min.css'],
  ['@fortawesome/fontawesome-free/css/fontawesome.min.css', 'fontawesome/css/fontawesome.min.css'],
  ['@fortawesome/fontawesome-free/css/solid.min.css', 'fontawesome/css/solid.min.css'],
  ['@fortawesome/fontawesome-free/css/brands.min.css', 'fontawesome/css/brands.min.css'],
  ['@fortawesome/fontawesome-free/webfonts/', 'fontawesome/webfonts/'],
];

function expand([from, to]) {
  if (!from.endsWith('/')) return [[join(modules, from), join(out, to)]];
  return readdirSync(join(modules, from), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => [join(modules, from, entry.name), join(out, to, entry.name)]);
}

/** Same size and modification time: the copy below stamps the source's time on its output */
function upToDate(source, target) {
  const existing = statSync(target, { throwIfNoEntry: false });
  return (
    !!existing &&
    existing.size === source.size &&
    Math.abs(existing.mtimeMs - source.mtimeMs) < 1000
  );
}

let copied = 0;
let kept = 0;
let bytes = 0;
try {
  for (const [from, to] of FILES.flatMap(expand)) {
    const source = statSync(from);
    bytes += source.size;
    if (upToDate(source, to)) {
      kept += 1;
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    utimesSync(to, source.atime, source.mtime);
    copied += 1;
  }
} catch (e) {
  console.error(`th-libs: ${e instanceof Error ? e.message : e} (run \`pnpm install\` first)`);
  process.exit(1);
}
const size = `${(bytes / 1024).toFixed(0)} KB`;
console.log(`th-libs: ${copied} copied, ${kept} up to date (${size}) -> ${relative(root, out)}`);
