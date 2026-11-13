/**
 * ST's HTTP surface as extensions see it (DEV_NOTES §9.4): same-origin `fetch('/api/…')` calls
 * are answered in the page, not by a server. Pure routing; the app supplies the handlers and
 * wraps `window.fetch`.
 */
import type { Coverage } from './coverage.js';

export interface ApiRequest {
  /** upper case */
  method: string;
  /** `/api/extensions/discover` */
  path: string;
  query: URLSearchParams;
  /** parsed JSON body, or the raw text when it is not JSON; undefined when there is none */
  body: unknown;
  /** the caller's `fetch` signal: a long-running handler stops its work when it fires */
  signal?: AbortSignal | undefined;
}

export interface ApiReply {
  status: number;
  /** sent as JSON; a string is sent as text */
  body?: unknown;
  /** a streamed reply (`text/event-stream`); takes the place of `body` */
  stream?: ReadableStream<Uint8Array> | undefined;
}

export type ApiHandler = (request: ApiRequest) => ApiReply | Promise<ApiReply>;

/** keyed `"<METHOD> <path>"`, e.g. `"POST /api/extensions/discover"` */
export type ApiRoutes = Readonly<Record<string, ApiHandler>>;

/** Paths that belong to the ST server: everything else goes to the network untouched. */
export function isHostPath(path: string): boolean {
  return path.startsWith('/api/') || path === '/csrf-token' || path === '/version';
}

export class ApiRouter {
  constructor(
    private readonly routes: ApiRoutes,
    private readonly coverage: Coverage,
  ) {}

  async handle(request: ApiRequest): Promise<ApiReply> {
    const key = `${request.method} ${request.path}`;
    // server plugins run inside ST's Node process; there is nothing to map them to
    if (request.path.startsWith('/api/plugins/')) {
      this.coverage.miss('api', `${request.method} /api/plugins/*`);
      return { status: 501, body: { error: '酒馆服务端插件在本应用里不可用' } };
    }
    const handler = this.routes[key];
    if (!handler) {
      this.coverage.miss('api', key);
      return { status: 501, body: { error: `${key} 尚未实现` } };
    }
    try {
      return await handler(request);
    } catch (e) {
      console.error(`[ext] ${key} failed`, e);
      return { status: 500, body: { error: String(e) } };
    }
  }
}
