/**
 * The libraries every frame gets from the hub by reference (DEV_NOTES §9.5). Only pure JS that
 * keeps no document of its own belongs here; what must run inside a card's document (Vue, jQuery
 * UI, tailwind, Font Awesome) is loaded per document, see `detectLibs` in srcdoc.ts.
 */
import showdown from 'showdown';
import * as YAML from 'yaml';
import { z } from 'zod';
import type { Hub } from './hub.js';

type HubCalls = Pick<Hub, 'call'>;
type ToastKind = 'success' | 'info' | 'warning' | 'error';
type Toast = (message?: unknown, title?: unknown, options?: unknown) => unknown;

export interface Toastr extends Record<ToastKind, Toast> {
  /** the app owns its toasts and their lifetime: both are accepted and do nothing */
  clear(toast?: unknown): void;
  remove(toast?: unknown): void;
  /** scripts write their preferences here; none of them reaches the app */
  options: Record<string, unknown>;
}

/**
 * Stands in for the element toastr returns: scripts chain `.remove()`, `.find(…).on(…)` and the
 * like on it. Every method answers the stub itself; `then` stays undefined so `await` does not
 * take it for a promise and hang.
 */
const TOAST_STUB: unknown = new Proxy<Record<PropertyKey, unknown>>(
  { length: 0 },
  {
    get(target, key) {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      return key in target ? target[key] : () => TOAST_STUB;
    },
  },
);

const text = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value);

/** `toastr` for scripts: each call becomes one `toast` request to the app, which draws it. */
export function createToastr(hub: HubCalls): Toastr {
  const show =
    (kind: ToastKind): Toast =>
    (message, title) => {
      // fire and forget: a toast that cannot be shown must not break the script that asked for it
      try {
        hub.call('toast', [kind, text(message), text(title)]).catch(() => undefined);
      } catch {
        /* same */
      }
      return TOAST_STUB;
    };
  return {
    success: show('success'),
    info: show('info'),
    warning: show('warning'),
    error: show('error'),
    clear: () => undefined,
    remove: () => undefined,
    options: {},
  };
}

let localized = false;

/** The globals to put into `hub.libraries`, under the names upstream documents. */
export function sharedLibraries(hub: HubCalls): Record<string, unknown> {
  if (!localized) {
    // upstream reports schema errors in Chinese; scripts show these messages to the user
    z.config(z.locales.zhCN());
    localized = true;
  }
  return { YAML, z, showdown, toastr: createToastr(hub) };
}
