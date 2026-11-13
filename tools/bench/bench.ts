/**
 * Phase 4 performance budget (DEV_NOTES §9.31): a 3000-message chat must open in < 200ms.
 * "Open" on the TS side = parse every jsonl line + render the first screen (40 rows) with the same
 * formatter + sanitizer the app uses. The full 3000-row render is reported but not gated (the
 * virtual list never renders it at once). Budgets are relaxed 3× here because CI runners are slow.
 *
 *   pnpm bench            → prints JSON, exit 1 when over budget
 *   BENCH_ROWS=10000 pnpm bench
 */
import { performance } from 'node:perf_hooks';
import { JSDOM } from 'jsdom';
import { parseChatMessage, serializeMessage, type ChatMessage } from '@tm/formats';
import {
  DEFAULT_FORMAT_POWER_USER,
  createMessageFormatter,
  decodeStyleTags,
  type FormatPowerUser,
} from '@tm/core';
import { createMessageSanitizer } from '@tm/ui';

const ROWS = Number(process.env['BENCH_ROWS'] ?? 3000);
const FIRST_SCREEN = 40;
const BUDGET_MS = 200;
const SLACK = Number(process.env['BENCH_SLACK'] ?? 3);

// deterministic ST-shaped messages: markdown, quotes, italics, a code block now and then, some HTML
const SNIPPETS = [
  '*She looks up from the ledger.* "You again? Sit down, the tea is still warm."',
  'The glade was quiet. **Too** quiet — the kind of quiet that presses on your ears.\n\nShe waited.',
  '"Three things," she said, counting on her fingers. "The key, the map, and *your* word."',
  'Okay, let me think about this...\n\n1. We go north\n2. We avoid the river\n3. We never mention the fox',
  '```\n> status: nominal\n> mana: 42%\n```\nThe readout flickered and went dark.',
  '<span class="whisper">(almost inaudible)</span> "Don\'t turn around."',
  'A long paragraph. '.repeat(12).trim(),
  "Fine. *Fine.* You win. But if the bridge gives out, I'm blaming you in the afterlife.",
];

function synth(n: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    const user = i % 2 === 1;
    out.push({
      name: user ? 'Yun' : 'Sera',
      is_user: user,
      is_system: false,
      send_date: `2026-11-08 10:${String(i % 60).padStart(2, '0')}`,
      mes: `${SNIPPETS[i % SNIPPETS.length]!} (#${i})`,
      extra: user ? { bias: null, isSmallSys: false } : { api: 'openai', model: 'gpt-4o' },
      ...(user ? {} : { swipe_id: 0, swipes: [SNIPPETS[i % SNIPPETS.length]!] }),
    });
  }
  return out;
}

function time<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const v = fn();
  return [v, performance.now() - t0];
}

const lines = synth(ROWS).map(serializeMessage);

// ① parse
const [chat, parseMs] = time(() => lines.map((l) => parseChatMessage(JSON.parse(l))));

// ② first screen
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const win = dom.window as unknown as Window & typeof globalThis;
const powerUser: FormatPowerUser = { ...DEFAULT_FORMAT_POWER_USER };
const formatter = createMessageFormatter({ powerUser, substitute: (t) => t });
const sanitize = createMessageSanitizer(win, { mediaAllowed: () => true });
const render = (m: ChatMessage, i: number) =>
  decodeStyleTags(
    sanitize(
      formatter.format(m.mes, {
        chName: m.name,
        isSystem: !!m.is_system,
        isUser: m.is_user,
        messageId: i,
        chat,
      }),
    ),
    { mediaAllowed: true },
  );
const start = Math.max(0, chat.length - FIRST_SCREEN);
const [, firstScreenMs] = time(() => {
  for (let i = start; i < chat.length; i++) render(chat[i]!, i);
});

// ③ everything (upper bound for scrolling the whole chat once)
const [, allMs] = time(() => {
  for (let i = 0; i < chat.length; i++) render(chat[i]!, i);
});

const openMs = parseMs + firstScreenMs;
const report = {
  rows: ROWS,
  parse_ms: +parseMs.toFixed(1),
  first_screen_ms: +firstScreenMs.toFixed(1),
  open_ms: +openMs.toFixed(1),
  all_rows_ms: +allMs.toFixed(1),
  per_row_ms: +(allMs / ROWS).toFixed(3),
  budget_ms: BUDGET_MS,
  limit_ms: BUDGET_MS * SLACK,
  ok: openMs <= BUDGET_MS * SLACK,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error(`bench: open took ${openMs.toFixed(1)}ms, over ${BUDGET_MS * SLACK}ms`);
  process.exit(1);
}
