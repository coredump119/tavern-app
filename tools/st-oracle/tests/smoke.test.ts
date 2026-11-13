import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  locateSillyTavern,
  REPO_ROOT,
  startOracle,
  startMockBackend,
  type Oracle,
  type MockBackend,
} from '../src/index.js';

const stDir = locateSillyTavern();
const compat = readFileSync(join(REPO_ROOT, 'COMPAT_TARGET.md'), 'utf8');
const expectedVersion = /\|\s*ST 版本\s*\|\s*([\d.]+)\s*\|/.exec(compat)?.[1];

describe.skipIf(!stDir)('st-oracle smoke', () => {
  let st: Oracle;
  let backend: MockBackend;

  beforeAll(async () => {
    backend = await startMockBackend();
    st = await startOracle({ stDir: stDir! });
  });
  afterAll(async () => {
    await st?.stop();
    await backend?.stop();
  });

  it('boots the COMPAT_TARGET version', async () => {
    const v = await st.version();
    expect(v.pkgVersion).toBe(expectedVersion);
  });

  it('serves settings and default characters from a throwaway data root', async () => {
    const settings = await st.settings();
    expect(settings).toHaveProperty('settings');
    const chars = await st.characters();
    expect(Array.isArray(chars)).toBe(true);
    expect(chars.length).toBeGreaterThan(0);
    expect(st.dataRoot).toContain('st-oracle-');
  });

  it('routes a chat completion through ST to the mock backend and captures the exact body', async () => {
    const messages = [
      { role: 'system', content: 'You are Lune.' },
      { role: 'user', content: 'hello oracle' },
    ];
    const res = await st.api<{ choices: Array<{ message: { content: string } }> }>(
      '/api/backends/chat-completions/generate',
      {
        chat_completion_source: 'openai',
        reverse_proxy: `${backend.url}/v1`,
        proxy_password: 'oracle',
        model: 'oracle-model',
        messages,
        stream: false,
        max_tokens: 16,
        temperature: 1,
      },
    );
    expect(res.choices[0]?.message.content).toBe('oracle-ok');
    const captured = backend.last();
    expect(captured?.path).toBe('/v1/chat/completions');
    expect((captured?.body as { messages: unknown }).messages).toEqual(messages);
    expect(captured?.headers['authorization']).toBe('<redacted>');
  });
});

describe('mock backend', () => {
  it('answers /models and streams chat completions', async () => {
    const b = await startMockBackend();
    try {
      const models = (await (await fetch(`${b.url}/v1/models`)).json()) as { data: unknown[] };
      expect(models.data.length).toBe(1);
      const r = await fetch(`${b.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', stream: true, messages: [] }),
      });
      const text = await r.text();
      expect(text).toContain('oracle-ok');
      expect(text.trim().endsWith('data: [DONE]')).toBe(true);
      expect(b.captured.length).toBe(2);
    } finally {
      await b.stop();
    }
  });
});
