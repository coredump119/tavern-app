/**
 * Seed an app data root for device checks: materializes an oracle scenario (card + chat + settings.json
 * pointing at the slow mock) into `<out>/default-user`, ready to copy into the app's data directory.
 *
 *   pnpm --filter @tm/tool-st-oracle run seed -- --out /tmp/seed --proxy http://127.0.0.1:4010/v1
 */
import { mkdirSync, rmSync } from 'node:fs';
import { locateSillyTavern } from './src/locate.js';
import { materialize } from './src/materialize.js';
import { scenarios } from './tests/scenarios.js';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const out = opt('out', '/tmp/tm-seed');
const proxy = opt('proxy', 'http://127.0.0.1:4010/v1');
const which = opt('scenario', scenarios[0]!.name);
const stDir = locateSillyTavern();
if (!stDir) {
  console.error(
    'SillyTavern checkout not found (ST_ORACLE_DIR / tools/st-oracle/.st / ../SillyTavern)',
  );
  process.exit(1);
}
const sc = scenarios.find((s) => s.name === which) ?? scenarios[0]!;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const m = materialize(sc, { stDir, dataRoot: out, proxyUrl: proxy });
console.log(
  `seeded ${out}/default-user from scenario "${sc.name}" (avatar ${m.avatar}, ${m.messages.length} messages, proxy ${proxy})`,
);
