/** 用 Playwright 驾驭真实 ST 前端：打开页面、等角色与聊天就位、触发 Generate，并等 mock 后端收到请求。 */
import { chromium, type Browser, type Page } from 'playwright';
import type { CapturedRequest, MockBackend } from './mock-backend.js';

export interface StDriver {
  page: Page;
  /** 写完场景文件后调用：重新加载页面并等待就位 */
  load(expect: { avatar: string; chatLength: number }): Promise<void>;
  /** 触发一次生成，返回 mock 后端捕获的 /chat/completions 请求 */
  generate(
    input: { text: string; type: string; quietPrompt?: string | undefined },
    backend: MockBackend,
  ): Promise<CapturedRequest>;
  /** 离开页面（杀掉 debounce 定时器），下一场景写文件前调用 */
  park(): Promise<void>;
  errors(): string[];
  close(): Promise<void>;
}

export async function startDriver(baseUrl: string, { headless = true } = {}): Promise<StDriver> {
  const browser: Browser = await chromium.launch({ headless });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('dialog', (d) => void d.dismiss());

  const load: StDriver['load'] = async ({ avatar, chatLength }) => {
    await page.goto(baseUrl, { waitUntil: 'load' });
    try {
      await waitReady({ avatar, chatLength });
    } catch (e) {
      // 只有带密钥的源会自动连接（RA_autoconnect）；经反代的 Gemini / Mistral / DeepSeek / xAI 需要点一次「连接」
      const offline = await page.evaluate(() => {
        const st = (
          globalThis as unknown as { SillyTavern?: { getContext: () => Record<string, unknown> } }
        ).SillyTavern;
        return st?.getContext?.()['onlineStatus'] === 'no_connection';
      });
      if (offline) {
        await page.evaluate(() => {
          const btn = document.getElementById('api_button_openai');
          btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        try {
          await waitReady({ avatar, chatLength });
          return;
        } catch {
          /* 下面统一报诊断 */
        }
      }
      void e;
      const diag = await page.evaluate(() => {
        const st = (
          globalThis as unknown as { SillyTavern?: { getContext: () => Record<string, unknown> } }
        ).SillyTavern;
        if (!st?.getContext) return 'no SillyTavern.getContext';
        const ctx = st.getContext();
        const chars = (ctx['characters'] as Array<{ avatar: string }> | undefined)?.map(
          (c) => c.avatar,
        );
        return JSON.stringify({
          characterId: ctx['characterId'],
          chatLength: (ctx['chat'] as unknown[] | undefined)?.length,
          onlineStatus: ctx['onlineStatus'],
          mainApi: ctx['mainApi'],
          reverseProxy: (ctx['chatCompletionSettings'] as Record<string, unknown> | undefined)?.[
            'reverse_proxy'
          ],
          source: (ctx['chatCompletionSettings'] as Record<string, unknown> | undefined)?.[
            'chat_completion_source'
          ],
          characters: chars,
          popups: document.querySelectorAll('dialog[open], .popup').length,
          popupText: Array.from(document.querySelectorAll('dialog[open]')).map((d) =>
            d.textContent?.slice(0, 200),
          ),
        });
      });
      throw new Error(
        `st-oracle: page not ready: ${String(e)}\n${diag}\nerrors:\n${errors.slice(-8).join('\n')}`,
      );
    }
  };

  const waitReady = async ({ avatar, chatLength }: { avatar: string; chatLength: number }) => {
    await page.waitForFunction(
      ({ avatar, chatLength }) => {
        const st = (
          globalThis as unknown as { SillyTavern?: { getContext: () => Record<string, unknown> } }
        ).SillyTavern;
        if (!st?.getContext) return false;
        const ctx = st.getContext();
        const chars = ctx['characters'] as Array<{ avatar: string }> | undefined;
        const id = ctx['characterId'] as number | string | undefined;
        const chat = ctx['chat'] as unknown[] | undefined;
        const status = ctx['onlineStatus'] as string | undefined;
        return (
          id !== undefined &&
          chars?.[Number(id)]?.avatar === avatar &&
          chat?.length === chatLength &&
          !!status &&
          status !== 'no_connection'
        );
      },
      { avatar, chatLength },
      { timeout: 45_000 },
    );
  };

  const generate: StDriver['generate'] = async ({ text, type, quietPrompt }, backend) => {
    backend.reset();
    await page.evaluate(
      async ({ text, type, quietPrompt }) => {
        const st = (
          globalThis as unknown as { SillyTavern: { getContext: () => Record<string, unknown> } }
        ).SillyTavern;
        const ctx = st.getContext();
        const ta = document.getElementById('send_textarea') as HTMLTextAreaElement;
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const gen = ctx['generate'] as (
          type: string,
          params?: Record<string, unknown>,
        ) => Promise<unknown>;
        await gen(type, quietPrompt ? { quiet_prompt: quietPrompt } : undefined);
      },
      { text, type, quietPrompt },
    );
    const deadline = Date.now() + 30_000;
    for (;;) {
      const hit = backend.captured.find((c) =>
        /\/chat\/completions(\?|$)|\/messages(\?|$)|:(streamG|g)enerateContent(\?|$)/.test(c.path),
      );
      if (hit) return hit;
      if (Date.now() > deadline)
        throw new Error(
          `st-oracle: no /chat/completions, /messages or generateContent captured\n${errors.slice(-5).join('\n')}`,
        );
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const park = async () => {
    await page.goto('about:blank');
    await new Promise((r) => setTimeout(r, 300));
  };

  return { page, load, generate, park, errors: () => errors.slice(), close: () => browser.close() };
}
