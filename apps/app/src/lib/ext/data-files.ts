/**
 * The folders of the data root ST's server hands out as plain files (the static routes at the end
 * of `src/users.js`): an extension reads back what it stored with an ordinary GET, or points an
 * `<img>` at it (DEV_NOTES §9.34 第 12 轮). Rune-free, so the node tests reach it.
 */
export const EXTENSION_FILES = '/scripts/extensions/third-party/';
const SERVED = ['/user/images/', '/user/files/', '/characters/', '/backgrounds/', '/User Avatars/'];

/** `rel` is data-root relative; `forbidden` is a path that tries to leave its folder */
export type DataFile = { rel: string } | 'forbidden';

/** Where a same-origin URL path points inside the data root; null when ST would not serve it. */
export function dataFilePath(pathname: string): DataFile | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const prefix = SERVED.find((served) => path.startsWith(served));
  if (!prefix) return null;
  const inside = path.slice(prefix.length);
  if (inside.includes('\\') || inside.split('/').includes('..')) return 'forbidden';
  return { rel: path.slice(1) };
}

/** Where the two kinds of local file are really read from. */
export interface LocalSources {
  /** the page's own origin */
  origin: string;
  /** the `tmext` origin extension folders are served from */
  extensionBase: string;
  /** address of a data-root file (relative path); null while there is no data root */
  dataFileUrl: (rel: string) => string | null;
}

/**
 * The address a DOM attribute (`src`, `href`, `poster`) has to carry instead of `raw`, when `raw`
 * is a same-origin path into an extension folder or a served data folder; null leaves it alone.
 */
export function localFileAddress(raw: string, page: string, sources: LocalSources): string | null {
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return null;
  let url: URL;
  try {
    url = new URL(raw, page);
  } catch {
    return null;
  }
  if (url.origin !== sources.origin) return null;
  if (url.pathname.startsWith(EXTENSION_FILES)) {
    return sources.extensionBase + url.pathname + url.search;
  }
  const stored = dataFilePath(url.pathname);
  if (!stored || stored === 'forbidden') return null;
  const target = sources.dataFileUrl(stored.rel);
  return target ? target + url.search : null;
}
