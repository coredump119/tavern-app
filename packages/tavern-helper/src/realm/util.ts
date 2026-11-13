/** Small helpers shared by the hub and its API modules. */

/** A copy owned by the hub's realm, so it outlives the card frame the value came from. */
export function own<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // functions and the like: keep what JSON keeps, which is also all that gets saved
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

export function printable(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Promises made in a card frame are not `instanceof` this realm's Promise */
export const isThenable = <T>(value: unknown): value is PromiseLike<T> =>
  typeof (value as PromiseLike<T> | null | undefined)?.then === 'function';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `crypto.randomUUID` needs a secure context, which a custom scheme may not be */
export function uuid(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

/** A `File` or `Blob` of any frame: they are not `instanceof` this realm's Blob */
export const isBlob = (value: unknown): value is Blob =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Blob).arrayBuffer === 'function' &&
  typeof (value as Blob).type === 'string';

const BASE64_CHUNK = 0x8000;

/** The bytes as a data URL, which is the one shape of a file that crosses to the app */
export async function toDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}
