/**
 * Message attachments on the app side (DEV_NOTES §9.30): picking files, storing media under
 * `user/images/<character>/` (Rust `media_upload`) and text under `user/files/` (ST Data Bank), URLs
 * for display, and the resolvers core uses to inline images / video / audio into the prompt.
 */
import {
  CHAT_COMPLETION_SOURCES as S,
  MEDIA_EXTENSIONS,
  MEDIA_SOURCE,
  MEDIA_TYPE,
  TEXT_ATTACHMENT_EXTENSIONS,
  getStringHash,
  isAudioInliningSupported,
  isImageInliningSupported,
  isVideoInliningSupported,
  looksBinary,
  mediaTypeFromName,
  postProcessText,
  type FileAttachment,
  type InlineMediaDeps,
  type MediaAttachment,
  type MediaType,
  type ResolvedMedia,
} from '@tm/core';
import { pickFiles } from '../files';
import {
  dataDelete,
  dataReadText,
  dataWriteText,
  fileReadText,
  fileUrl,
  mediaUpload,
} from '../ipc';

/**
 * A picked file waiting in the composer — already stored in the data root (media under
 * `user/images/`, text under `user/files/`) so the preview can load and the send is instant.
 */
export interface PendingMedia {
  /** data-root relative path with ST's leading slash (what the message will store) */
  url: string;
  name: string;
  /** media type, or 'file' for a Data Bank text attachment */
  type: MediaType | 'file';
  previewUrl: string;
  /** text attachments: byte size of the stored text */
  size?: number | undefined;
}

/** UI cap for text attachments (ST allows 350 MB; the whole text goes into every prompt). */
export const TEXT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

const extOf = (name: string) => name.split(/[?#]/)[0]!.split('.').pop()?.toLowerCase() ?? '';
const relOf = (url: string) => url.replace(/^\/+/, '');

/** ST extractTextFromHTML (body text) / extractTextFromMarkdown (postProcessText(…, false)). */
export function textForAttachment(name: string, raw: string): string {
  const ext = extOf(name);
  if (ext === 'html' || ext === 'htm') {
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    doc.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
    // block elements end a line, as a browser's innerText would
    doc
      .querySelectorAll(
        'p, div, br, li, tr, pre, blockquote, section, article, h1, h2, h3, h4, h5, h6',
      )
      .forEach((n) => n.append('\n'));
    return postProcessText(doc.body?.textContent ?? '', true);
  }
  if (ext === 'md' || ext === 'markdown') return postProcessText(raw, false);
  return raw;
}

/** ST `/api/files/upload` naming: `user/files/<now>_<hash(original name)>.txt`. */
export function textAttachmentRel(name: string, now = Date.now()): string {
  return `user/files/${now}_${getStringHash(name)}.txt`;
}

/**
 * Pick files and store them right away (ST uploads on send; we store on pick because the asset
 * protocol can only show files inside the data root). `discardMedia` removes what is not sent.
 * Media → `user/images/<character>/`; text → `user/files/` (ST Data Bank). Throws a user-facing
 * message for binary / oversized text files.
 */
export async function pickMedia(root: string, chName: string): Promise<PendingMedia[]> {
  const paths = await pickFiles({
    extensions: [...MEDIA_EXTENSIONS, ...TEXT_ATTACHMENT_EXTENSIONS],
    multiple: true,
    title: '附件',
  });
  const out: PendingMedia[] = [];
  const problems: string[] = [];
  for (const path of paths) {
    const name = decodeURIComponent(path.split(/[\\/]/).pop() ?? path);
    const type = mediaTypeFromName(name);
    if (type) {
      const url = await mediaUpload(root, chName, path, name);
      out.push({ url, name, type, previewUrl: mediaUrl(root, url) });
      continue;
    }
    if (!TEXT_ATTACHMENT_EXTENSIONS.includes(extOf(name))) {
      problems.push(`${name}：不支持的文件类型`);
      continue;
    }
    let raw: string;
    try {
      raw = await fileReadText(path, TEXT_ATTACHMENT_MAX_BYTES);
    } catch (e) {
      problems.push(`${name}：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (looksBinary(raw)) {
      problems.push(`${name}：二进制文件不支持，请选文本文件或图片`);
      continue;
    }
    const text = textForAttachment(name, raw);
    const rel = textAttachmentRel(name);
    await dataWriteText(root, rel, text);
    out.push({
      url: `/${rel}`,
      name,
      type: 'file',
      previewUrl: '',
      size: new TextEncoder().encode(text).length,
    });
  }
  if (problems.length && !out.length) throw new Error(problems.join('；'));
  return out;
}

/** Remove a pending file that will not be sent. */
export async function discardMedia(root: string, pending: PendingMedia): Promise<void> {
  try {
    await dataDelete(root, relOf(pending.url));
  } catch {
    /* already gone */
  }
}

/** ST populateFileAttachment: `extra.media` for media, `extra.files` for text attachments. */
export function toAttachments(pending: readonly PendingMedia[]): {
  media: MediaAttachment[];
  files: FileAttachment[];
} {
  const media: MediaAttachment[] = [];
  const files: FileAttachment[] = [];
  for (const p of pending) {
    if (p.type === 'file')
      files.push({ url: p.url, size: p.size ?? 0, name: p.name, created: Date.now() });
    else media.push({ url: p.url, type: p.type, title: p.name, source: MEDIA_SOURCE.UPLOAD });
  }
  return { media, files };
}

/**
 * Generation input: a copy of `chat` whose `extra.files[].text` is filled from disk, so core's
 * `appendFileContent` can prepend it (ST reads the file at generation time too). Unreadable files
 * are left without text, which ST also tolerates.
 */
export async function withFileTexts<T extends { extra?: unknown }>(
  root: string,
  chat: readonly T[],
): Promise<T[]> {
  const cache = new Map<string, string | null>();
  const out: T[] = [];
  for (const m of chat) {
    const extra = m.extra as Record<string, unknown> | undefined;
    const files = extra?.['files'];
    if (!Array.isArray(files) || files.length === 0) {
      out.push(m);
      continue;
    }
    const filled: FileAttachment[] = [];
    for (const f of files as FileAttachment[]) {
      if (typeof f?.['text'] === 'string' || !f?.url) {
        filled.push(f);
        continue;
      }
      if (!cache.has(f.url)) {
        try {
          cache.set(f.url, await dataReadText(root, relOf(f.url)));
        } catch {
          cache.set(f.url, null);
        }
      }
      const text = cache.get(f.url);
      filled.push(text ? { ...f, text } : f);
    }
    out.push({ ...m, extra: { ...extra, files: filled } });
  }
  return out;
}

/** Display URL for a stored media `url` (data-root relative, or already absolute / data:). */
export function mediaUrl(root: string, url: string): string {
  if (/^(data:|blob:|https?:)/i.test(url)) return url;
  return fileUrl(`${root}/${url.replace(/^\/+/, '')}`);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load the image.'));
    img.src = src;
  });
}

/** ST utils `calculateThumbnailSize` + `createThumbnail` (jpeg, white backing). */
function thumbnail(
  img: HTMLImageElement,
  maxW: number | null,
  maxH: number | null,
  type = 'image/jpeg',
): string {
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (maxW && maxH && (w > maxW || h > maxH)) {
    const ratio = Math.min(maxW / w, maxH / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL(type);
}

const COMPRESS_SOURCES: readonly string[] = [S.OPENROUTER, S.MAKERSUITE, S.MISTRALAI, S.VERTEXAI];
const SAFE_MIME = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * ST `Message.compressImage`: for OpenRouter / Google / Mistral / Vertex shrink anything over 2MB
 * into a 2048 box; any non jpeg/png/webp becomes jpeg. Returns the data URL and its pixel size.
 */
export async function resolveImageForPrompt(
  root: string,
  url: string,
  source: string,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    let dataUrl: string;
    if (url.startsWith('data:')) dataUrl = url;
    else {
      const res = await fetch(mediaUrl(root, url), { cache: 'force-cache' });
      if (!res.ok) return null;
      dataUrl = await blobToDataUrl(await res.blob());
    }
    const mime = dataUrl.split(';')[0]?.split(':')[1] ?? '';
    const dataSize = dataUrl.length * 0.75;
    let img = await loadImage(dataUrl);
    if (COMPRESS_SOURCES.includes(source) && dataSize > 2 * 1024 * 1024) {
      dataUrl = thumbnail(img, 2048, 2048);
      img = await loadImage(dataUrl);
    } else if (!SAFE_MIME.includes(mime)) {
      dataUrl = thumbnail(img, null, null);
      img = await loadImage(dataUrl);
    }
    return { dataUrl, width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    return null;
  }
}

/** Duration in seconds of a video / audio data URL (0 when the WebView cannot tell). */
function mediaDuration(dataUrl: string, kind: 'video' | 'audio'): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement(kind);
    el.preload = 'metadata';
    const done = (v: number) => {
      el.removeAttribute('src');
      resolve(Number.isFinite(v) ? v : 0);
    };
    el.onloadedmetadata = () => done(el.duration);
    el.onerror = () => done(0);
    setTimeout(() => done(0), 5000);
    el.src = dataUrl;
  });
}

/** Video / audio for the prompt: no compression (ST addVideo / addAudio), duration for the token estimate. */
export async function resolveAvForPrompt(
  root: string,
  url: string,
  kind: 'video' | 'audio',
): Promise<ResolvedMedia | null> {
  try {
    let dataUrl: string;
    if (url.startsWith('data:')) dataUrl = url;
    else {
      const res = await fetch(mediaUrl(root, url), { cache: 'force-cache' });
      if (!res.ok) return null;
      dataUrl = await blobToDataUrl(await res.blob());
    }
    return { dataUrl, duration: await mediaDuration(dataUrl, kind) };
  } catch {
    return null;
  }
}

/**
 * The host half of media inlining: each flag is ST's `is{Image,Video,Audio}InliningSupported()`
 * for the current source / model (list-driven sources need the fetched model list, `modelList`).
 */
export function inlineMediaDeps(
  root: string,
  settings: Record<string, unknown>,
  modelList: unknown[] | null,
): InlineMediaDeps | undefined {
  const oai = (settings['oai_settings'] as Record<string, unknown> | undefined) ?? {};
  const mainApi = String(settings['main_api'] ?? 'openai');
  const image = isImageInliningSupported(oai, modelList, mainApi);
  const video = isVideoInliningSupported(oai, modelList, mainApi);
  const audio = isAudioInliningSupported(oai, modelList, mainApi);
  if (!image && !video && !audio) return undefined;
  const source = String(oai['chat_completion_source'] ?? '');
  return {
    quality: String(oai['inline_image_quality'] ?? 'auto'),
    image,
    video,
    audio,
    resolve: (url, kind) =>
      kind === 'image'
        ? resolveImageForPrompt(root, url, source)
        : resolveAvForPrompt(root, url, kind === 'video' ? 'video' : 'audio'),
  };
}

export { MEDIA_TYPE };
