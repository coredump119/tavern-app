/**
 * ST's chat-completions backend for extensions that bring an address and a key of their own
 * (DEV_NOTES §9.34 第 6 轮). Rune-free: the host injects the user's consent and the network.
 *
 * Two rules hold for every request made here: the user agreed to the address, and the request
 * carries the key from its own body and nothing from the keychain (`secret` is always `none`).
 */
import { buildUpstreamRequest, mergeObjectWithYaml, type GenerateData } from '@tm/core';
import type { ApiReply, ApiRequest, ApiRoutes } from '@tm/st-compat';
import { isUnder, withScriptKey } from '../helper/custom-api';
import type { FetchRequest, FetchResponse, GenEvent, GenerateRequest, SecretRef } from '../ipc';

export interface BackendDeps {
  /** the user's answer for this address (asked once per run); rejects when refused or not allowed */
  confirm(apiurl: string): Promise<{ address: string; insecure: boolean }>;
  fetch(request: FetchRequest, secret: SecretRef): Promise<FetchResponse>;
  /** resolves to the generation id; events may arrive before it does */
  start(
    request: GenerateRequest,
    secret: SecretRef,
    onEvent: (event: GenEvent) => void,
  ): Promise<string>;
  abort(id: string): Promise<unknown>;
  forget(id: string): Promise<unknown>;
  /** a call shape this host does not serve, for the coverage report */
  unsupported(what: string): void;
}

type Body = Record<string, unknown>;
type Built = { request: GenerateRequest; secret: SecretRef };

const GENERATE = 'POST /api/backends/chat-completions/generate';
const STATUS = 'POST /api/backends/chat-completions/status';

const isRecord = (value: unknown): value is Body =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const failure = (status: number, message: string): ApiReply => ({
  status,
  body: { error: { message } },
});

/** The address and key a body brings along; null when it relies on what ST's server would have stored */
function ownTarget(body: Body): { source: string; url: string; key: string } | null {
  const source = text(body['chat_completion_source']);
  if (source === 'custom') {
    const url = text(body['custom_url']);
    // its key travels in `custom_include_headers`
    return url ? { source, url, key: '' } : null;
  }
  if (source !== 'openai') return null;
  const url = text(body['reverse_proxy']);
  return url ? { source, url, key: text(body['proxy_password']) } : null;
}

function yamlHeaders(yaml: unknown): Record<string, string> {
  const parsed: Body = {};
  mergeObjectWithYaml(parsed, yaml);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) headers[name] = String(value);
  return headers;
}

/** One upstream generation and the two ways to end it */
function launch(deps: BackendDeps, built: Built, onEvent: (event: GenEvent) => void) {
  const id = deps.start(built.request, built.secret, onEvent);
  id.catch((e: unknown) => onEvent({ type: 'error', status: null, message: errorText(e) }));
  const settle = (work: (id: string) => Promise<unknown>) =>
    void id.then(work).catch(() => undefined);
  return {
    forget: () => settle((i) => deps.forget(i)),
    stop: () => settle((i) => deps.abort(i).then(() => deps.forget(i))),
  };
}

/** ST: an upstream refusal is a 200 with `error`; a request that never got out is a 502 */
function errorReply(event: Extract<GenEvent, { type: 'error' }>): ApiReply {
  if (event.status === null) return failure(502, event.message);
  return {
    status: 200,
    body: {
      error: { message: event.message },
      quota_error: event.status === 429 && event.message.includes('insufficient_quota'),
    },
  };
}

function complete(deps: BackendDeps, built: Built, signal: AbortSignal | undefined) {
  return new Promise<ApiReply>((resolve) => {
    const finish = (reply: ApiReply) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(reply);
    };
    const run = launch(deps, built, (event) => {
      if (event.type !== 'done' && event.type !== 'error') return;
      run.forget();
      if (event.type === 'error') return finish(errorReply(event));
      const message = { role: 'assistant', content: event.text };
      finish({
        status: 200,
        body: event.raw ?? { choices: [{ index: 0, message, finish_reason: 'stop' }] },
      });
    });
    // the caller's `fetch` has already rejected; this only stops the upstream request
    const onAbort = () => {
      run.stop();
      finish(failure(499, 'aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The reply as an OpenAI stream, re-encoded from the cumulative text (candidate 0 only) */
function streamed(deps: BackendDeps, built: Built, signal: AbortSignal | undefined) {
  return new Promise<ApiReply>((resolve) => {
    const encoder = new TextEncoder();
    const sent = { content: '', reasoning_content: '' };
    let opened = false;
    let closed = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
      // the reader went away
      cancel: () => end(() => run.stop()),
    });

    const end = (how: () => void) => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', onAbort);
      how();
    };
    const open = (status: number) => {
      if (opened) return;
      opened = true;
      resolve({ status, stream });
    };
    const send = (data: unknown) => {
      if (closed) return;
      const line = typeof data === 'string' ? data : JSON.stringify(data);
      controller.enqueue(encoder.encode(`data: ${line}\n\n`));
    };
    const chunk = (delta: Body, finish_reason: string | null = null) =>
      send({ choices: [{ index: 0, delta, finish_reason }] });
    const advance = (field: keyof typeof sent, full: string) => {
      if (full.length <= sent[field].length) return;
      chunk({ [field]: full.slice(sent[field].length) });
      sent[field] = full;
    };

    const run = launch(deps, built, (event) => {
      if (event.type === 'started') return open(event.status);
      if (event.type === 'error') {
        if (!opened) {
          run.forget();
          return end(() => resolve(failure(event.status ?? 502, event.message)));
        }
        send({ error: { message: event.message } });
      } else {
        open(200);
        advance('reasoning_content', event.reasoning);
        advance('content', event.text);
        if (event.type === 'delta') return;
        chunk({}, 'stop');
        send('[DONE]');
      }
      run.forget();
      end(() => controller.close());
    });
    const onAbort = () =>
      end(() => {
        run.stop();
        if (opened) controller.error(signal?.reason);
        else resolve(failure(499, 'aborted'));
      });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function generate(deps: BackendDeps, request: ApiRequest): Promise<ApiReply> {
  const body = request.body;
  const target = isRecord(body) ? ownTarget(body) : null;
  if (!isRecord(body) || !target) {
    deps.unsupported(`${GENERATE}（请求体没有自带地址，或不是 OpenAI 兼容源）`);
    return { status: 400, body: { error: true } };
  }
  let consent: { address: string; insecure: boolean };
  try {
    consent = await deps.confirm(target.url);
  } catch (e) {
    return failure(403, errorText(e));
  }
  const upstream = buildUpstreamRequest(body as GenerateData);
  // the address the user agreed to is the only place this request may go
  if (!isUnder(upstream.url, consent.address)) return failure(400, '请求地址和确认过的地址不一致');
  const stream = body['stream'] === true;
  const built = withScriptKey(
    {
      url: upstream.url,
      headers: upstream.headers,
      auth_header: upstream.authHeader ?? null,
      body: upstream.body,
      stream,
      format: { kind: 'chat_completion', source: target.source },
      timeout_ms: null,
    },
    target.key,
    consent.insecure,
  );
  return (stream ? streamed : complete)(deps, built, request.signal);
}

/** ST: the model list of the endpoint; every failure is a 200 with `error: true` */
async function status(deps: BackendDeps, request: ApiRequest): Promise<ApiReply> {
  const body = request.body;
  const target = isRecord(body) ? ownTarget(body) : null;
  if (!isRecord(body) || !target) {
    deps.unsupported(`${STATUS}（请求体没有自带地址，或不是 OpenAI 兼容源）`);
    return { status: 400, body: { error: true } };
  }
  try {
    const { address, insecure } = await deps.confirm(target.url);
    const headers = {
      ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}),
      ...(target.source === 'custom' ? yamlHeaders(body['custom_include_headers']) : {}),
    };
    const reply = await deps.fetch(
      { url: `${address}/models`, method: 'GET', headers, allow_insecure_http: insecure },
      { kind: 'none' },
    );
    if (reply.ok && reply.json !== null) return { status: 200, body: reply.json };
    return { status: 200, body: { error: true, data: { data: [] } } };
  } catch {
    return { status: 200, body: { error: true } };
  }
}

export function backendRoutes(deps: BackendDeps): ApiRoutes {
  return {
    [GENERATE]: (request) => generate(deps, request),
    [STATUS]: (request) => status(deps, request),
  };
}
