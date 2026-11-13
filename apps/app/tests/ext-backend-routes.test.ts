import { describe, expect, it, vi } from 'vitest';
import { ApiRouter, Coverage } from '@tm/st-compat';
import { backendRoutes, type BackendDeps } from '../src/lib/ext/backend-routes';
import type { FetchRequest, GenEvent, GenerateRequest, SecretRef } from '../src/lib/ipc';

const ADDRESS = 'https://side.test/v1';
const openaiBody = (over: Record<string, unknown> = {}) => ({
  chat_completion_source: 'openai',
  reverse_proxy: `${ADDRESS}/`,
  proxy_password: 'side-key',
  model: 'side-model',
  messages: [{ role: 'user', content: 'hi' }],
  temperature: 0.5,
  max_tokens: 32,
  stream: false,
  ...over,
});

function setup(overrides: Partial<BackendDeps> = {}) {
  const started: { request: GenerateRequest; secret: SecretRef }[] = [];
  const fetched: { request: FetchRequest; secret: SecretRef }[] = [];
  let emit: (event: GenEvent) => void = () => undefined;
  const coverage = new Coverage();
  const deps = {
    confirm: vi.fn(async (apiurl: string) => ({
      address: apiurl.replace(/\/+$/, ''),
      insecure: false,
    })),
    fetch: vi.fn(async (request: FetchRequest, secret: SecretRef) => {
      fetched.push({ request, secret });
      return { status: 200, ok: true, json: { data: [{ id: 'm1' }] }, text: '', headers: {} };
    }),
    start: vi.fn(async (request: GenerateRequest, secret: SecretRef, onEvent) => {
      started.push({ request, secret });
      emit = onEvent;
      return 'gen-1';
    }),
    abort: vi.fn(async () => true),
    forget: vi.fn(async () => undefined),
    unsupported: (what: string) => coverage.miss('api', what),
    ...overrides,
  } satisfies BackendDeps;
  const router = new ApiRouter(backendRoutes(deps), coverage);
  const post = (route: 'generate' | 'status', body: unknown, signal?: AbortSignal) =>
    router.handle({
      method: 'POST',
      path: `/api/backends/chat-completions/${route}`,
      query: new URLSearchParams(),
      body,
      signal,
    });
  /** let the handler reach `start` before events are fed in */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { post, deps, started, fetched, coverage, settle, emit: (e: GenEvent) => emit(e) };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}
const done = (text: string, raw: unknown = null): GenEvent => ({
  type: 'done',
  text,
  reasoning: '',
  swipes: [],
  raw,
});
const delta = (text: string, reasoning = ''): GenEvent => ({
  type: 'delta',
  text,
  chunk: '',
  reasoning,
  swipes: [],
});

describe('extension side API: generate (DEV_NOTES §9.34 第 6 轮)', () => {
  it('sends to the confirmed address with the key from the body and no secret', async () => {
    const t = setup();
    const pending = t.post('generate', openaiBody());
    await t.settle();
    const raw = { choices: [{ message: { content: 'hello' } }] };
    t.emit(done('hello', raw));
    expect(await pending).toEqual({ status: 200, body: raw });

    expect(t.deps.confirm).toHaveBeenCalledWith(`${ADDRESS}/`);
    const { request, secret } = t.started[0]!;
    expect(secret).toEqual({ kind: 'none' });
    expect(request.url).toBe(`${ADDRESS}/chat/completions`);
    expect(request.headers?.['Authorization']).toBe('Bearer side-key');
    expect(request.stream).toBe(false);
    const sent = request.body as Record<string, unknown>;
    expect(sent['model']).toBe('side-model');
    expect(JSON.stringify(sent)).not.toContain('side-key');
    expect('reverse_proxy' in sent || 'proxy_password' in sent).toBe(false);
    expect(t.deps.forget).toHaveBeenCalledWith('gen-1');
  });

  it('custom source: the key travels in custom_include_headers', async () => {
    const t = setup();
    const pending = t.post('generate', {
      ...openaiBody(),
      chat_completion_source: 'custom',
      reverse_proxy: undefined,
      proxy_password: undefined,
      custom_url: ADDRESS,
      custom_include_headers: 'Authorization: Bearer yaml-key',
      custom_include_body: 'min_p: 0.1',
    });
    await t.settle();
    t.emit(done('ok'));
    expect(await pending).toEqual({
      status: 200,
      body: {
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      },
    });
    const { request, secret } = t.started[0]!;
    expect(secret).toEqual({ kind: 'none' });
    expect(request.headers?.['Authorization']).toBe('Bearer yaml-key');
    expect((request.body as Record<string, unknown>)['min_p']).toBe(0.1);
  });

  it('sends nothing when the user refuses', async () => {
    const t = setup({ confirm: vi.fn(async () => Promise.reject(new Error('用户拒绝了'))) });
    expect(await t.post('generate', openaiBody())).toEqual({
      status: 403,
      body: { error: { message: '用户拒绝了' } },
    });
    expect(t.started).toHaveLength(0);
  });

  it('refuses a request that would leave the confirmed address', async () => {
    const t = setup({
      confirm: vi.fn(async () => ({ address: 'https://other.test/v1', insecure: false })),
    });
    const reply = await t.post('generate', openaiBody());
    expect(reply.status).toBe(400);
    expect(t.started).toHaveLength(0);
  });

  it('does not serve a body without an address of its own', async () => {
    const t = setup();
    for (const body of [
      openaiBody({ reverse_proxy: '' }),
      openaiBody({ chat_completion_source: 'claude' }),
      'not json',
    ]) {
      expect(await t.post('generate', body)).toEqual({ status: 400, body: { error: true } });
      expect(await t.post('status', body)).toEqual({ status: 400, body: { error: true } });
    }
    expect(t.deps.confirm).not.toHaveBeenCalled();
    expect(t.coverage.list().length).toBeGreaterThan(0);
  });

  it('reports upstream and network errors the way ST does', async () => {
    const t = setup();
    let pending = t.post('generate', openaiBody());
    await t.settle();
    t.emit({ type: 'error', status: 429, message: 'insufficient_quota: no credit' });
    expect(await pending).toEqual({
      status: 200,
      body: { error: { message: 'insufficient_quota: no credit' }, quota_error: true },
    });
    pending = t.post('generate', openaiBody());
    await t.settle();
    t.emit({ type: 'error', status: null, message: 'connection refused' });
    expect(await pending).toEqual({
      status: 502,
      body: { error: { message: 'connection refused' } },
    });
    const failing = setup({ start: vi.fn(async () => Promise.reject(new Error('blocked'))) });
    expect(await failing.post('generate', openaiBody())).toEqual({
      status: 502,
      body: { error: { message: 'blocked' } },
    });
  });

  it('stops the upstream request when the caller aborts', async () => {
    const t = setup();
    const controller = new AbortController();
    const pending = t.post('generate', openaiBody(), controller.signal);
    await t.settle();
    controller.abort();
    expect((await pending).status).toBe(499);
    await t.settle();
    expect(t.deps.abort).toHaveBeenCalledWith('gen-1');
    expect(t.deps.forget).toHaveBeenCalledWith('gen-1');
  });
});

describe('extension side API: stream', () => {
  it('re-encodes the cumulative text as OpenAI deltas and ends with [DONE]', async () => {
    const t = setup();
    const pending = t.post('generate', openaiBody({ stream: true }));
    await t.settle();
    expect(t.started[0]!.request.stream).toBe(true);
    t.emit({ type: 'started', status: 200 });
    const reply = await pending;
    expect(reply.status).toBe(200);
    t.emit(delta('', 'think'));
    t.emit(delta('He', 'think'));
    t.emit(delta('Hello', 'think'));
    t.emit(done('Hello!'));
    const lines = (await readAll(reply.stream!)).split('\n\n').filter(Boolean);
    expect(lines.at(-1)).toBe('data: [DONE]');
    const chunks = lines.slice(0, -1).map(
      (line) =>
        (
          JSON.parse(line.slice('data: '.length)) as {
            choices: { delta: Record<string, string>; finish_reason: string | null }[];
          }
        ).choices[0]!,
    );
    expect(chunks.map((c) => c.delta)).toEqual([
      { reasoning_content: 'think' },
      { content: 'He' },
      { content: 'llo' },
      { content: '!' },
      {},
    ]);
    expect(chunks.at(-1)!.finish_reason).toBe('stop');
    expect(t.deps.forget).toHaveBeenCalledWith('gen-1');
  });

  it('an upstream refusal before the stream opens is a plain error reply', async () => {
    const t = setup();
    const pending = t.post('generate', openaiBody({ stream: true }));
    await t.settle();
    t.emit({ type: 'error', status: 401, message: 'bad key' });
    expect(await pending).toEqual({ status: 401, body: { error: { message: 'bad key' } } });
  });

  it('a mid-stream error is sent as an error line', async () => {
    const t = setup();
    const pending = t.post('generate', openaiBody({ stream: true }));
    await t.settle();
    t.emit({ type: 'started', status: 200 });
    const reply = await pending;
    t.emit(delta('par'));
    t.emit({ type: 'error', status: null, message: 'cut off' });
    const out = await readAll(reply.stream!);
    expect(out).toContain('"content":"par"');
    expect(out.trimEnd().endsWith('data: {"error":{"message":"cut off"}}')).toBe(true);
  });

  it('aborts upstream when the reader cancels or the signal fires', async () => {
    const t = setup();
    let pending = t.post('generate', openaiBody({ stream: true }));
    await t.settle();
    t.emit({ type: 'started', status: 200 });
    await (await pending).stream!.cancel();
    await t.settle();
    expect(t.deps.abort).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    pending = t.post('generate', openaiBody({ stream: true }), controller.signal);
    await t.settle();
    t.emit({ type: 'started', status: 200 });
    const reply = await pending;
    controller.abort(new Error('stop'));
    await expect(readAll(reply.stream!)).rejects.toThrow('stop');
    await t.settle();
    expect(t.deps.abort).toHaveBeenCalledTimes(2);
  });
});

describe('extension side API: status', () => {
  it('lists the models of the confirmed address with the key from the body', async () => {
    const t = setup();
    expect(await t.post('status', openaiBody())).toEqual({
      status: 200,
      body: { data: [{ id: 'm1' }] },
    });
    expect(t.fetched[0]).toEqual({
      request: {
        url: `${ADDRESS}/models`,
        method: 'GET',
        headers: { Authorization: 'Bearer side-key' },
        allow_insecure_http: false,
      },
      secret: { kind: 'none' },
    });
  });

  it('answers failures with error: true', async () => {
    const down = setup({
      fetch: vi.fn(async () => ({ status: 500, ok: false, json: null, text: '', headers: {} })),
    });
    expect(await down.post('status', openaiBody())).toEqual({
      status: 200,
      body: { error: true, data: { data: [] } },
    });
    const refused = setup({ confirm: vi.fn(async () => Promise.reject(new Error('no'))) });
    expect(await refused.post('status', openaiBody())).toEqual({
      status: 200,
      body: { error: true },
    });
    expect(refused.fetched).toHaveLength(0);
  });
});
