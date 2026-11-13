/**
 * OpenAI-compatible mock backend. ST is pointed at it via `reverse_proxy`; every request body
 * is captured so tests can compare the exact prompt ST produced (Phase 2 对拍).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  /** 原始请求体字符串（字节级比对用） */
  raw: string;
  receivedAt: number;
}

export interface MockBackend {
  url: string;
  port: number;
  captured: CapturedRequest[];
  /** /models 与 Gemini 模型列表返回的模型名（ST 会把下拉框对齐到列表，缺失时改写 model） */
  models: string[];
  last(): CapturedRequest | undefined;
  reset(): void;
  stop(): Promise<void>;
}

const REDACT = new Set(['authorization', 'x-api-key', 'api-key']);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

export interface MockOptions {
  /** 流式时每个词之间的延迟（ms），用于手动验证切后台 / 中断；0 = 一次吐完 */
  slowMs?: number | undefined;
  /** 流式慢速输出的词数 */
  words?: number | undefined;
  /** 慢速流式时先吐一段 `<think>…</think>`（N 个词），用来验证推理自动解析 */
  thinkWords?: number | undefined;
}

function chatCompletion(
  stream: boolean,
  model: string,
  res: ServerResponse,
  text = 'oracle-ok',
  options: MockOptions = {},
) {
  const id = `chatcmpl-oracle-${Date.now()}`;
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.write(chunk({ role: 'assistant', content: '' }, null));
  const slow = options.slowMs ?? 0;
  if (slow > 0) {
    const words = options.words ?? 40;
    const think = options.thinkWords ?? 0;
    let i = 0;
    let t = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      if (t < think) {
        t++;
        const piece = `${t === 1 ? '<think>' : ' '}think${t}${t === think ? '</think>\n' : ''}`;
        res.write(chunk({ content: piece }, null));
        return;
      }
      i++;
      res.write(chunk({ content: `${i === 1 ? '' : ' '}word${i}` }, null));
      if (i >= words) {
        clearInterval(timer);
        res.write(chunk({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, slow);
    return;
  }
  res.write(chunk({ content: text }, null));
  res.write(chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Anthropic Messages API 形状的回复（非流式 JSON 或 SSE 事件流） */
function claudeMessage(stream: boolean, model: string, res: ServerResponse, text = 'oracle-ok') {
  const id = `msg_oracle_${Date.now()}`;
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const ev = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  res.write(
    ev('message_start', {
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
  );
  res.write(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
  res.write(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }));
  res.write(ev('content_block_stop', { index: 0 }));
  res.write(
    ev('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
  );
  res.write(ev('message_stop', {}));
  res.end();
}

/**
 * Text Completion：OpenAI `/v1/completions`（choices[0].text）与 llama.cpp `/completion`（content）。
 * 没有 `stream` 键时整段返回（ST 非流式路径不带 stream）。
 */
function textCompletion(
  stream: boolean,
  model: string,
  res: ServerResponse,
  llamacpp: boolean,
  text = 'oracle-ok',
  options: MockOptions = {},
) {
  const id = `cmpl-oracle-${Date.now()}`;
  const piece = (t: string, finish: string | null) =>
    llamacpp
      ? { content: t, stop: finish !== null }
      : {
          id,
          object: 'text_completion',
          model,
          choices: [{ index: 0, text: t, finish_reason: finish }],
        };
  const slow = options.slowMs ?? 0;
  const words = slow > 0 ? (options.words ?? 40) : 0;
  const full = words > 0 ? Array.from({ length: words }, (_, i) => `word${i + 1}`).join(' ') : text;
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(piece(full, 'stop')));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (t: string, finish: string | null) =>
    res.write(`data: ${JSON.stringify(piece(t, finish))}\n\n`);
  if (slow > 0) {
    let i = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      i++;
      send(`${i === 1 ? '' : ' '}word${i}`, null);
      if (i >= words) {
        clearInterval(timer);
        send('', 'stop');
        if (!llamacpp) res.write('data: [DONE]\n\n');
        res.end();
      }
    }, slow);
    return;
  }
  send(text, null);
  send('', 'stop');
  if (!llamacpp) res.write('data: [DONE]\n\n');
  res.end();
}

/** Gemini generateContent 形状（非流式 JSON 或单个 SSE data） */
function geminiMessage(stream: boolean, res: ServerResponse, text = 'oracle-ok') {
  const candidate = {
    candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  };
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(candidate));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify(candidate)}\n\n`);
  res.end();
}

export function startMockBackend(port = 0, options: MockOptions = {}): Promise<MockBackend> {
  const captured: CapturedRequest[] = [];
  const models: string[] = ['oracle-model'];
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      /* keep raw */
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = REDACT.has(k) ? '<redacted>' : v;
    }
    const path = req.url ?? '/';
    captured.push({
      method: req.method ?? 'GET',
      path,
      headers,
      body,
      raw,
      receivedAt: Date.now(),
    });
    const route = path.split('?')[0] ?? path;

    // Google AI Studio：模型列表与 generateContent / streamGenerateContent
    if (/\/models$/.test(route) && /\/v1(beta|alpha)\//.test(route)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [
            ...models.map((m) => ({
              name: `models/${m}`,
              supportedGenerationMethods: ['generateContent'],
            })),
          ],
        }),
      );
      return;
    }
    if (/:(streamG|g)enerateContent$/.test(route)) {
      geminiMessage(route.endsWith(':streamGenerateContent'), res);
      return;
    }

    if (route.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }),
      );
      return;
    }
    if (route.endsWith('/messages')) {
      const b = (body ?? {}) as { stream?: boolean; model?: string };
      claudeMessage(!!b.stream, b.model ?? 'claude-oracle', res);
      return;
    }
    if (route.endsWith('/v1/completions') || route === '/completion') {
      const b = (body ?? {}) as { stream?: boolean; model?: string };
      textCompletion(
        !!b.stream,
        b.model ?? 'oracle-model',
        res,
        route === '/completion',
        'oracle-ok',
        options,
      );
      return;
    }
    if (route.endsWith('/chat/completions')) {
      const b = (body ?? {}) as { stream?: boolean; model?: string };
      chatCompletion(!!b.stream, b.model ?? 'oracle-model', res, 'oracle-ok', options);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `mock-backend: no route for ${path}` } }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, options.slowMs ? '0.0.0.0' : '127.0.0.1', () => {
      const p = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${p}`,
        port: p,
        captured,
        models,
        last: () => captured[captured.length - 1],
        reset: () => void captured.splice(0),
        stop: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
