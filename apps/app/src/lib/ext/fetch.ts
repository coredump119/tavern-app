/**
 * `window.fetch` as ST extensions use it (DEV_NOTES §9.4, §9.34): a same-origin call to ST's
 * server (`/api/…`, `/csrf-token`) is answered in the page by the route table, and a relative URL
 * into an extension folder is read through the `tmext` protocol. A GET of a file ST serves out of
 * the data folder (`/user/images/…`) reads that file. Everything else is untouched.
 */
import { isHostPath, type ApiRouter } from '@tm/st-compat';
import { dataFilePath, EXTENSION_FILES, localFileAddress, type LocalSources } from './data-files';

async function readBody(input: RequestInfo | URL, init: RequestInit | undefined): Promise<unknown> {
  let text: string | undefined;
  if (typeof init?.body === 'string') text = init.body;
  else if (init?.body == null && input instanceof Request) text = await input.clone().text();
  else if (init?.body != null) return init.body;
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** `work`, unless the signal fires first: then the caller gets the abort reason, as `fetch` does */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Wrap `window.fetch`. `base` is the `tmext` origin; `dataFileUrl` gives the address a file of the
 * data root (relative path) can be read from, null while there is no data root. Returns the
 * function that puts the original back.
 */
export function installFetch(
  router: ApiRouter,
  base: string,
  dataFileUrl: (rel: string) => string | null,
): () => void {
  const original = window.fetch;
  const origin = location.origin;

  window.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url: URL;
    try {
      url = new URL(raw, location.href);
    } catch {
      return original(input, init);
    }
    if (url.origin !== origin) return original(input, init);

    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);

    if (isHostPath(url.pathname)) {
      signal?.throwIfAborted();
      const reply = await abortable(
        router.handle({
          method,
          path: url.pathname,
          query: url.searchParams,
          body: await readBody(input, init),
          signal,
        }),
        signal,
      );
      if (reply.stream) {
        return new Response(reply.stream, {
          status: reply.status,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      const text = typeof reply.body === 'string';
      return new Response(
        reply.body === undefined
          ? null
          : text
            ? (reply.body as string)
            : JSON.stringify(reply.body),
        {
          status: reply.status,
          headers: { 'Content-Type': text ? 'text/plain; charset=utf-8' : 'application/json' },
        },
      );
    }
    if (url.pathname.startsWith(EXTENSION_FILES)) {
      return original(base + url.pathname + url.search, init);
    }
    const stored = method === 'GET' || method === 'HEAD' ? dataFilePath(url.pathname) : null;
    if (stored === 'forbidden') return new Response('Forbidden', { status: 403 });
    if (stored) {
      // a file that is not there has to be a 404, as on ST's server, not the app's own page
      const missing = () => new Response('Not Found', { status: 404 });
      const target = dataFileUrl(stored.rel);
      if (!target) return missing();
      try {
        const reply = await original(target + url.search, {
          method,
          cache: 'no-store',
          ...(signal ? { signal } : {}),
        });
        return reply.ok ? reply : missing();
      } catch (error) {
        if (signal?.aborted) throw error;
        return missing();
      }
    }
    return original(input, init);
  };
  return () => {
    window.fetch = original;
  };
}

/** the attributes that make an element fetch a file, per tag */
const ADDRESS_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  IMG: ['src'],
  VIDEO: ['src', 'poster'],
  AUDIO: ['src'],
  SOURCE: ['src'],
  LINK: ['href'],
};
const ADDRESSED = 'img[src],video[src],video[poster],audio[src],source[src],link[href]';

/**
 * Same-origin paths written straight into the DOM (`<img src="/user/images/…">`) never reach
 * `fetch`: rewrite them as they appear (DEV_NOTES §9.34 第 12 轮). Returns the function that
 * stops watching.
 */
export function installAddressRewrite(sources: Omit<LocalSources, 'origin'>): () => void {
  const local: LocalSources = { ...sources, origin: location.origin };
  const fix = (element: Element) => {
    const names = ADDRESS_ATTRIBUTES[element.tagName];
    if (!names) return;
    for (const name of names) {
      const raw = element.getAttribute(name);
      const address = raw ? localFileAddress(raw, location.href, local) : null;
      if (address) element.setAttribute(name, address);
    }
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        fix(record.target as Element);
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        fix(node);
        for (const inner of node.querySelectorAll(ADDRESSED)) fix(inner);
      }
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'poster', 'href'],
  });
  return () => observer.disconnect();
}
