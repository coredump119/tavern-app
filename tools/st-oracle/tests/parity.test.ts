/**
 * Phase 2 exit: 同一场景，真实 ST（Playwright 驾驭前端）发给上游的请求体 vs @tm/core 回放，字节级一致。
 * 需要可运行的 ST 与 Playwright chromium；没有时跳过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getChatCompletionModel, type GenerationSettings } from '@tm/core';
import {
  locateSillyTavern,
  materialize,
  replay,
  startDriver,
  startMockBackend,
  startOracle,
  type MockBackend,
  type Oracle,
  type StDriver,
} from '../src/index.js';
import { scenarios } from './scenarios.js';

const stDir = locateSillyTavern();
const hasChromium = [
  '~/Library/Caches/ms-playwright',
  '~/.cache/ms-playwright',
  process.env['PLAYWRIGHT_BROWSERS_PATH'],
]
  .filter((p): p is string => !!p)
  .some((p) => existsSync(p.replace(/^~/, homedir())));
const only = process.env['ORACLE_ONLY'];
const selected = only ? scenarios.filter((s) => s.name.includes(only)) : scenarios;

describe.skipIf(!stDir || !hasChromium)('Phase 2 exit: CC 请求体对拍', () => {
  let st: Oracle;
  let backend: MockBackend;
  let driver: StDriver;

  beforeAll(async () => {
    backend = await startMockBackend();
    st = await startOracle({ stDir: stDir! });
    // 让 ST 先完成 default-user 的首启内容拷贝
    await st.settings();
    driver = await startDriver(st.baseUrl, { headless: process.env['ORACLE_HEADED'] !== '1' });
  }, 120_000);

  afterAll(async () => {
    await driver?.close();
    await st?.stop();
    await backend?.stop();
  });

  it('has at least 30 scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(only ? 1 : 30);
  });

  for (const sc of selected) {
    it(
      sc.name,
      async () => {
        await driver.park();
        const m = materialize(sc, {
          stDir: stDir!,
          dataRoot: st.dataRoot,
          proxyUrl: `${backend.url}/v1`,
        });
        // 模型列表里要有场景的模型，否则 ST 会把 model 对齐到列表第一项
        const scenarioModel = getChatCompletionModel(
          m.settings['oai_settings'] as unknown as GenerationSettings,
        );
        backend.models.splice(
          0,
          backend.models.length,
          ...(scenarioModel ? [scenarioModel, 'oracle-model'] : ['oracle-model']),
        );
        try {
          await driver.load({ avatar: m.avatar, chatLength: m.messages.length });
        } catch (e) {
          const paths = backend.captured.map((c) => `${c.method} ${c.path}`);
          throw new Error(
            `${String(e)}\nbackend saw: ${JSON.stringify(paths)}\nST stdout tail:\n${st.stdout().slice(-1500)}`,
          );
        }
        let captured;
        try {
          captured = await driver.generate(
            { text: sc.input, type: sc.type ?? 'normal', quietPrompt: sc.quietPrompt },
            backend,
          );
        } catch (e) {
          const paths = backend.captured.map((c) => `${c.method} ${c.path}`);
          throw new Error(
            `${String(e)}\nbackend saw: ${JSON.stringify(paths)}\npage errors:\n${driver.errors().slice(-8).join('\n')}\nST stdout tail:\n${st.stdout().slice(-1200)}`,
          );
        }
        const ours = await replay(m, { stDir: stDir! });
        const theirs = JSON.parse(captured.raw) as Record<string, unknown>;
        expect(ours.requestBody).toEqual(theirs);
        expect(ours.body).toBe(captured.raw);
      },
      120_000,
    );
  }
});
