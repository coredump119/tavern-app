/**
 * 手动验证用的 mock 后端：`pnpm --filter @tm/tool-st-oracle run mock -- --port 4010 --slow 400 --words 40`
 * 慢速流式时监听 0.0.0.0，方便模拟器 / 真机访问（Android 模拟器用 http://10.0.2.2:4010/v1，iOS 模拟器用 http://127.0.0.1:4010/v1）。
 */
import { startMockBackend } from './src/mock-backend.ts';

const args = process.argv.slice(2);
const num = (flag: string, def: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const port = num('--port', 4010);
const slowMs = num('--slow', 400);
const words = num('--words', 40);
const thinkWords = num('--think', 0);
const backend = await startMockBackend(port, { slowMs, words, thinkWords });
console.log(
  `mock backend on ${backend.url} (slow ${slowMs}ms × ${words} words${thinkWords ? `, think ${thinkWords}` : ''})`,
);
setInterval(() => {
  const last = backend.last();
  if (last) {
    // media inlining check (DEV_NOTES §9.30): how many image_url parts rode along
    let images = 0;
    try {
      const body = JSON.parse(last.raw) as { messages?: { content?: unknown }[] };
      for (const m of body.messages ?? [])
        if (Array.isArray(m.content))
          images += m.content.filter((c) =>
            ['image_url', 'video_url', 'audio_url', 'input_audio'].includes(
              String((c as { type?: string })?.type),
            ),
          ).length;
    } catch {
      /* not JSON */
    }
    // last user turn, first 120 chars: shows Data Bank text landing in the prompt
    let lastUser = '';
    try {
      const body = JSON.parse(last.raw) as { messages?: { role?: string; content?: unknown }[] };
      const u = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
      const c = u?.content;
      const text = Array.isArray(c)
        ? c.map((p) => (p as { text?: string })?.text ?? '').join(' ')
        : String(c ?? '');
      lastUser = text.replace(/\s+/g, ' ').slice(0, 120);
    } catch {
      /* not JSON */
    }
    console.log(
      `${new Date(last.receivedAt).toISOString()} ${last.method} ${last.path}${images ? ` media=${images}` : ''}${lastUser ? ` user="${lastUser}"` : ''}`,
    );
    backend.reset();
  }
}, 1000);
