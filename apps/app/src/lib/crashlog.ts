/**
 * Local crash log (DEV_NOTES §9.38): uncaught page errors go to a file on this device through
 * `append`; nothing is uploaded. Redaction happens in Rust on write. No Svelte / Tauri imports here.
 */

export interface CrashReport {
  kind: 'js' | 'promise';
  message: string;
  source: string;
  stack: string;
}

export interface CrashLine {
  t: number;
  kind: string;
  message: string;
  source?: string;
  stack?: string;
}

/** reports kept per app launch: a render loop that throws must not fill the log */
const MAX_PER_SESSION = 30;

export function describeError(
  kind: CrashReport['kind'],
  reason: unknown,
  source = '',
): CrashReport {
  if (reason instanceof Error)
    return {
      kind,
      message: `${reason.name}: ${reason.message}`,
      source,
      stack: reason.stack ?? '',
    };
  let message: string;
  if (typeof reason === 'string') message = reason;
  else {
    try {
      message = JSON.stringify(reason) ?? String(reason);
    } catch {
      message = String(reason);
    }
  }
  return { kind, message, source, stack: '' };
}

/** Lets a report through unless it repeats the one before it or the session cap is reached. */
export function crashGate(max = MAX_PER_SESSION): (r: CrashReport) => boolean {
  let last = '';
  let count = 0;
  return (r) => {
    const key = `${r.kind}\n${r.message}\n${r.stack}`;
    if (key === last || count >= max) return false;
    last = key;
    count += 1;
    return true;
  };
}

type Append = (
  kind: CrashReport['kind'],
  message: string,
  source: string,
  stack: string,
) => Promise<void>;

/** Record uncaught errors and unhandled rejections of `target`. Call once at startup. */
export function installCrashCapture(append: Append, target: Window = window): void {
  const pass = crashGate();
  const send = (r: CrashReport) => {
    // a failing log must never throw back into the error path it came from
    if (pass(r)) void append(r.kind, r.message, r.source, r.stack).catch(() => undefined);
  };
  target.addEventListener('error', (e) => {
    const source = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '';
    send(describeError('js', e.error ?? e.message, source));
  });
  target.addEventListener('unhandledrejection', (e) => {
    send(describeError('promise', e.reason));
  });
}

const KIND_LABEL: Record<string, string> = {
  js: '页面错误',
  promise: '未处理的拒绝',
  rust: '内核',
};

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Plain text for the viewer and the export, newest first. */
export function formatCrashLog(entries: readonly CrashLine[]): string {
  return [...entries]
    .reverse()
    .map((e) => {
      const head = `[${stamp(e.t)}] ${KIND_LABEL[e.kind] ?? e.kind}　${e.message}`;
      const rest = [e.source, e.stack].filter(Boolean).join('\n');
      return rest ? `${head}\n${rest.replace(/^/gm, '  ')}` : head;
    })
    .join('\n\n');
}

export function crashLogFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `tavern-crash-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.txt`;
}
