/**
 * Message media attachments (DEV_NOTES §9.30): ST `constants.js` MEDIA_*, `script.js`
 * `ensureMessageMediaIsArray` / `getMediaDisplay` / `getMediaIndex`, and `openai.js`
 * `isImageInliningSupported` / `Message.getImageTokenCost`.
 */
import { CHAT_COMPLETION_SOURCES as S } from './types.js';

export const MEDIA_TYPE = { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' } as const;
export type MediaType = (typeof MEDIA_TYPE)[keyof typeof MEDIA_TYPE];
export const MEDIA_DISPLAY = { LIST: 'list', GALLERY: 'gallery' } as const;
export type MediaDisplay = (typeof MEDIA_DISPLAY)[keyof typeof MEDIA_DISPLAY];
export const MEDIA_SOURCE = {
  API: 'api',
  UPLOAD: 'upload',
  GENERATED: 'generated',
  CAPTIONED: 'captioned',
} as const;

export interface MediaAttachment {
  url: string;
  type?: MediaType | string;
  title?: string;
  source?: string;
  [key: string]: unknown;
}

export interface FileAttachment {
  url: string;
  name?: string;
  size?: number;
  created?: number;
  [key: string]: unknown;
}

/** ST `MEDIA_TYPE.getFromMime` */
export function mediaTypeFromMime(mime: string): MediaType | null {
  if (mime.startsWith('image/')) return MEDIA_TYPE.IMAGE;
  if (mime.startsWith('video/')) return MEDIA_TYPE.VIDEO;
  if (mime.startsWith('audio/')) return MEDIA_TYPE.AUDIO;
  return null;
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'heif'];
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'];
const AUDIO_EXT = ['mp3', 'ogg', 'wav', 'm4a', 'aac', 'flac', 'opus', 'weba'];

/** Media type from a file name / URL extension (when no MIME is known). */
export function mediaTypeFromName(name: string): MediaType | null {
  const ext = name.split(/[?#]/)[0]!.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXT.includes(ext)) return MEDIA_TYPE.IMAGE;
  if (VIDEO_EXT.includes(ext)) return MEDIA_TYPE.VIDEO;
  if (AUDIO_EXT.includes(ext)) return MEDIA_TYPE.AUDIO;
  return null;
}

/** Extensions ST's `/api/images/upload` accepts (`MEDIA_EXTENSIONS`). */
export const MEDIA_EXTENSIONS: readonly string[] = [...IMAGE_EXT, ...VIDEO_EXT, ...AUDIO_EXT];

/**
 * ST `ensureMessageMediaIsArray`: migrate `extra.image` / `extra.image_swipes` / `extra.file` to the
 * 1.18 `media` / `files` arrays. Mutates `extra`; returns true when something changed.
 */
export function ensureMessageMediaIsArray(extra: Record<string, unknown> | undefined): boolean {
  if (!extra || typeof extra !== 'object') return false;
  let changed = false;
  if (Object.hasOwn(extra, 'file')) {
    const files = Array.isArray(extra['files']) ? (extra['files'] as unknown[]) : [];
    const file = extra['file'];
    delete extra['file'];
    if (file) files.push(file);
    extra['files'] = files;
    changed = true;
  }
  if (Array.isArray(extra['image_swipes'])) {
    const media = Array.isArray(extra['media']) ? (extra['media'] as MediaAttachment[]) : [];
    for (const swipe of extra['image_swipes'] as unknown[]) {
      if (swipe && typeof swipe === 'string') {
        extra['media_display'] = MEDIA_DISPLAY.GALLERY;
        media.push({ type: MEDIA_TYPE.IMAGE, url: swipe });
      }
    }
    extra['media'] = media;
    delete extra['image_swipes'];
    changed = true;
  }
  if (Object.hasOwn(extra, 'image')) {
    const media = Array.isArray(extra['media']) ? (extra['media'] as MediaAttachment[]) : [];
    const image = extra['image'];
    delete extra['image'];
    if (image && typeof image === 'string') {
      // the swipe migration above may already hold this url: select it instead of duplicating
      if (extra['media_display'] === MEDIA_DISPLAY.GALLERY) {
        const i = media.findIndex((m) => m.url === image);
        if (i >= 0) extra['media_index'] = i;
        else {
          media.push({ type: MEDIA_TYPE.IMAGE, url: image });
          extra['media_index'] = media.length - 1;
        }
      } else {
        media.push({ type: MEDIA_TYPE.IMAGE, url: image });
      }
    }
    extra['media'] = media;
    changed = true;
  }
  return changed;
}

export function mediaOf(message: { [key: string]: unknown }): MediaAttachment[] {
  const extra = message['extra'] as Record<string, unknown> | undefined;
  const media = extra?.['media'];
  return Array.isArray(media) ? (media as MediaAttachment[]) : [];
}

export function filesOf(message: { [key: string]: unknown }): FileAttachment[] {
  const extra = message['extra'] as Record<string, unknown> | undefined;
  const files = extra?.['files'];
  return Array.isArray(files) ? (files as FileAttachment[]) : [];
}

/** ST `getMediaDisplay`: `extra.media_display` → `power_user.media_display` → list */
export function getMediaDisplay(
  message: { [key: string]: unknown },
  powerUserDefault: unknown = undefined,
): MediaDisplay {
  const extra = message['extra'] as Record<string, unknown> | undefined;
  const value = extra?.['media_display'] || powerUserDefault || MEDIA_DISPLAY.LIST;
  return value === MEDIA_DISPLAY.GALLERY ? MEDIA_DISPLAY.GALLERY : MEDIA_DISPLAY.LIST;
}

/** ST `getMediaIndex`: clamped `extra.media_index`, 0 when absent / out of range */
export function getMediaIndex(message: { [key: string]: unknown }): number {
  const media = mediaOf(message);
  if (!media.length) return 0;
  const v = Number((message['extra'] as Record<string, unknown> | undefined)?.['media_index']);
  if (Number.isNaN(v) || v < 0 || v >= media.length) return 0;
  return v;
}

/** ST `visionSupportedModels` (openai.js isImageInliningSupported) */
export const VISION_SUPPORTED_MODELS: readonly string[] = [
  'chatgpt-4o-latest',
  'gpt-4-turbo',
  'gpt-4-vision',
  'gpt-4.1',
  'gpt-4.5-preview',
  'gpt-4o',
  'gpt-5',
  'o1',
  'o3',
  'o4-mini',
  'claude-3',
  'claude-opus-4',
  'claude-sonnet-4',
  'claude-haiku-4',
  'c4ai-aya-vision',
  'command-a-vision',
  'gemini-2.0',
  'gemini-2.5',
  'gemini-3',
  'gemini-exp-1206',
  'learnlm',
  'gemini-robotics',
  'gemma-3-27b',
  'gemma-3-12b',
  'gemma-3-4b',
  'gemma-4',
  'mistral-small-2503',
  'mistral-small-2506',
  'mistral-small-latest',
  'mistral-medium-latest',
  'mistral-medium-2505',
  'mistral-medium-2508',
  'pixtral',
  'grok-4',
  'grok-2-vision',
  'moonshot-v1-8k-vision-preview',
  'moonshot-v1-32k-vision-preview',
  'moonshot-v1-128k-vision-preview',
  'kimi-k2.5',
  'kimi-latest',
  'glm-4.5v',
  'glm-4.6v',
  'glm-5v-turbo',
  'autoglm-phone',
  'Qwen/Qwen3-VL-32B-Instruct',
  'Qwen/Qwen3-VL-8B-Instruct',
  'Qwen/Qwen3-VL-235B-A22B-Instruct',
  'Qwen/Qwen3-VL-30B-A3B-Instruct',
  'zai-org/GLM-4.5V',
];

type Loose = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const byName = (model: string) => VISION_SUPPORTED_MODELS.some((m) => model.includes(m));
const find = (list: unknown[] | null | undefined, id: string): Loose | undefined =>
  Array.isArray(list)
    ? (list.find((m) => (m as Loose)?.['id'] === id) as Loose | undefined)
    : undefined;

/**
 * ST `isImageInliningSupported()`. `settings` = `oai_settings`; `modelList` = the fetched model list
 * of the current source (needed for OpenRouter / Mistral / AIMLAPI / Chutes / ElectronHub /
 * Pollinations / Moonshot / NanoGPT / Workers AI; absent → not supported, as in ST).
 */
export function isImageInliningSupported(
  settings: Loose,
  modelList: unknown[] | null | undefined = null,
  mainApi = 'openai',
): boolean {
  if (mainApi !== 'openai') return false;
  if (!settings['media_inlining']) return false;
  const source = str(settings['chat_completion_source']);
  switch (source) {
    case S.OPENAI:
    case S.AZURE_OPENAI: {
      const model = str(
        source === S.AZURE_OPENAI ? settings['azure_openai_model'] : settings['openai_model'],
      );
      return (
        byName(model) &&
        ['gpt-4-turbo-preview', 'o1-mini', 'o3-mini'].some((x) => !model.includes(x))
      );
    }
    case S.MAKERSUITE:
      return byName(str(settings['google_model']));
    case S.VERTEXAI:
      return byName(str(settings['vertexai_model']));
    case S.CLAUDE:
      return byName(str(settings['claude_model']));
    case S.OPENROUTER: {
      const arch = find(modelList, str(settings['openrouter_model']))?.['architecture'] as
        Loose | undefined;
      const mods = arch?.['input_modalities'];
      return Array.isArray(mods) && mods.includes('image');
    }
    case S.CUSTOM:
    case S.COMETAPI:
      return true;
    case S.MISTRALAI: {
      const caps = find(modelList, str(settings['mistralai_model']))?.['capabilities'] as
        Loose | undefined;
      return Boolean(caps?.['vision']);
    }
    case S.COHERE:
      return byName(str(settings['cohere_model']));
    case S.XAI:
      return byName(str(settings['xai_model']));
    case S.AIMLAPI: {
      const f = find(modelList, str(settings['aimlapi_model']))?.['features'];
      return Array.isArray(f) && f.includes('openai/chat-completion.vision');
    }
    case S.CHUTES: {
      const mods = find(modelList, str(settings['chutes_model']))?.['input_modalities'];
      return Array.isArray(mods) && mods.includes('image');
    }
    case S.ELECTRONHUB: {
      const meta = find(modelList, str(settings['electronhub_model']))?.['metadata'] as
        Loose | undefined;
      return Boolean(meta?.['vision']);
    }
    case S.POLLINATIONS: {
      const mods = find(modelList, str(settings['pollinations_model']))?.['input_modalities'];
      return Array.isArray(mods) && mods.includes('image');
    }
    case S.MOONSHOT:
      return Boolean(find(modelList, str(settings['moonshot_model']))?.['supports_image_in']);
    case S.NANOGPT: {
      const caps = find(modelList, str(settings['nanogpt_model']))?.['capabilities'] as
        Loose | undefined;
      return Boolean(caps?.['vision']);
    }
    case S.ZAI:
      return byName(str(settings['zai_model']));
    case S.SILICONFLOW:
      return byName(str(settings['siliconflow_model']));
    case S.WORKERS_AI: {
      const props = find(modelList, str(settings['workers_ai_model']))?.['properties'];
      return (
        Array.isArray(props) &&
        props.some((p) => {
          const o = p as Loose;
          return o?.['property_id'] === 'vision' && o?.['value'] === 'true';
        })
      );
    }
    default:
      return false;
  }
}

/** ST `Message.tokensPerImage` */
export const TOKENS_PER_IMAGE = 85;

/** ST `Message.getImageTokenCost`: OpenAI's 512px-tile formula; low / small-auto = 85. */
export function imageTokenCost(width: number, height: number, quality: string): number {
  if (quality === 'low') return TOKENS_PER_IMAGE;
  if (quality === 'auto' && width <= 512 && height <= 512) return TOKENS_PER_IMAGE;
  if (!(width > 0) || !(height > 0)) return TOKENS_PER_IMAGE;
  const scale = 2048 / Math.min(width, height);
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);
  const finalScale = 768 / Math.min(scaledWidth, scaledHeight);
  const finalWidth = Math.round(scaledWidth * finalScale);
  const finalHeight = Math.round(scaledHeight * finalScale);
  const squares = Math.ceil(finalWidth / 512) * Math.ceil(finalHeight / 512);
  return squares * 170 + 85;
}

/** ST `Message` video / audio token estimates (Gemini rates). */
export const VIDEO_TOKENS_PER_SECOND = 263;
export const AUDIO_TOKENS_PER_SECOND = 32;
export const VIDEO_FALLBACK_SECONDS = 40;
export const AUDIO_FALLBACK_SECONDS = 300;

/** ST `videoSupportedModels` (isVideoInliningSupported) */
export const VIDEO_SUPPORTED_MODELS: readonly string[] = [
  'gemini-2.0',
  'gemini-2.5',
  'gemini-exp-1206',
  'gemini-3',
  'gemma-4',
  'glm-4.5v',
  'glm-4.6v',
  'glm-5v-turbo',
];

/** ST `audioSupportedModels` (isAudioInliningSupported) */
export const AUDIO_SUPPORTED_MODELS: readonly string[] = [
  'gemini-2.0',
  'gemini-2.5',
  'gemini-3',
  'gemini-exp-1206',
  'gpt-4o-audio',
  'gpt-4o-realtime',
  'gpt-4o-mini-audio',
  'gpt-4o-mini-realtime',
  'gpt-audio',
  'gpt-realtime',
];

const inList = (list: readonly string[], model: string) => list.some((m) => model.includes(m));
const orModalities = (list: unknown[] | null | undefined, id: string): unknown[] => {
  const arch = find(list, id)?.['architecture'] as Loose | undefined;
  const mods = arch?.['input_modalities'];
  return Array.isArray(mods) ? mods : [];
};

/** ST `isVideoInliningSupported()` */
export function isVideoInliningSupported(
  settings: Loose,
  modelList: unknown[] | null | undefined = null,
  mainApi = 'openai',
): boolean {
  if (mainApi !== 'openai' || !settings['media_inlining']) return false;
  switch (str(settings['chat_completion_source'])) {
    case S.MAKERSUITE:
      return inList(VIDEO_SUPPORTED_MODELS, str(settings['google_model']));
    case S.VERTEXAI:
      return inList(VIDEO_SUPPORTED_MODELS, str(settings['vertexai_model']));
    case S.OPENROUTER:
      return orModalities(modelList, str(settings['openrouter_model'])).includes('video');
    case S.ZAI:
      return inList(VIDEO_SUPPORTED_MODELS, str(settings['zai_model']));
    default:
      return false;
  }
}

/** ST `isAudioInliningSupported()` */
export function isAudioInliningSupported(
  settings: Loose,
  modelList: unknown[] | null | undefined = null,
  mainApi = 'openai',
): boolean {
  if (mainApi !== 'openai' || !settings['media_inlining']) return false;
  switch (str(settings['chat_completion_source'])) {
    case S.OPENAI:
      return inList(AUDIO_SUPPORTED_MODELS, str(settings['openai_model']));
    case S.MAKERSUITE:
      return inList(AUDIO_SUPPORTED_MODELS, str(settings['google_model']));
    case S.VERTEXAI:
      return inList(AUDIO_SUPPORTED_MODELS, str(settings['vertexai_model']));
    case S.OPENROUTER:
      return orModalities(modelList, str(settings['openrouter_model'])).includes('audio');
    case S.CUSTOM:
      return true;
    default:
      return false;
  }
}

/** A resolved attachment: data URL plus whatever the token estimate needs. */
export interface ResolvedMedia {
  dataUrl: string;
  width?: number | undefined;
  height?: number | undefined;
  /** seconds, video / audio */
  duration?: number | undefined;
}

/**
 * What the host hands core so attachments can be inlined without core touching files
 * (DEV_NOTES §9.30). Each flag is the matching ST `is*InliningSupported()` result.
 */
export interface InlineMediaDeps {
  /** `oai_settings.inline_image_quality`: auto / low / high */
  quality: string;
  image: boolean;
  video: boolean;
  audio: boolean;
  /** message `url` → data URL (+ size / duration), or null to skip */
  resolve: (url: string, kind: MediaType) => Promise<ResolvedMedia | null>;
}

/** ST `embedOpenRouterMedia`: `audio_url` → `input_audio` for OpenAI-compatible bodies. */
export function embedOpenRouterMedia(
  messages: unknown,
  { audio = true, video = true }: { audio?: boolean; video?: boolean } = {},
): void {
  if (!Array.isArray(messages)) return;
  const formatMap: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
  for (const message of messages as Loose[]) {
    if (!Array.isArray(message?.['content'])) continue;
    for (const part of message['content'] as Loose[]) {
      const v = part?.['video_url'] as Loose | undefined;
      if (video && part?.['type'] === 'video_url' && str(v?.['url']).startsWith('data:')) {
        part['type'] = 'video_url';
      }
      const a = part?.['audio_url'] as Loose | undefined;
      if (audio && part?.['type'] === 'audio_url' && str(a?.['url']).startsWith('data:')) {
        const [head, data] = str(a?.['url']).split(',');
        const mime = /data:([^;]+)/.exec(head ?? '')?.[1] || 'audio/mpeg';
        part['type'] = 'input_audio';
        part['input_audio'] = { format: formatMap[mime] || 'mp3', data };
        delete part['audio_url'];
      }
    }
  }
}

// ---- text attachments (ST Data Bank, DEV_NOTES §9.30) ----

/** Extensions we accept as text attachments (ST accepts any non-binary file; this is the picker filter). */
export const TEXT_ATTACHMENT_EXTENSIONS: readonly string[] = [
  'txt',
  'md',
  'markdown',
  'json',
  'jsonl',
  'csv',
  'tsv',
  'log',
  'xml',
  'yaml',
  'yml',
  'ini',
  'toml',
  'srt',
  'vtt',
  'html',
  'htm',
  'js',
  'ts',
  'py',
  'css',
  'rtf',
];

/** ST utils `postProcessText` (collapse = false is what markdown import uses). */
export function postProcessText(text: string, collapse = true): string {
  let t = text
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/\u00A0/g, ' ');
  if (collapse) {
    t = t.replace(/\n+/g, '\n');
    t = t
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
  } else {
    t = t.replace(/\n{4,}/g, '\n\n\n\n');
    t = t
      .split('\n')
      .map((l) => (/^\s+$/.test(l) ? '' : l))
      .join('\n');
  }
  return t.replace(/ {2,}/g, ' ').trim();
}

/** ST `validateFile` binary test: a NUL or other low control byte means binary. */
export function looksBinary(text: string): boolean {
  return /[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 8192));
}

/** ST `humanFileSize` (IEC units, one decimal). */
export function humanFileSize(bytes: number, si = false, dp = 1): string {
  const thresh = si ? 1000 : 1024;
  if (Math.abs(bytes) < thresh) return `${bytes} B`;
  const units = si
    ? ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
    : ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
  let u = -1;
  const r = 10 ** dp;
  let b = bytes;
  do {
    b /= thresh;
    ++u;
  } while (Math.round(Math.abs(b) * r) / r >= thresh && u < units.length - 1);
  return `${b.toFixed(dp)} ${units[u]}`;
}

/**
 * ST `appendFileContent`: every attached file's text, joined by blank lines, goes in front of the
 * message (after regex). Core reads `file.text`; the host fills it before generation.
 */
export function appendFileContent(
  extra: Record<string, unknown> | undefined,
  messageText: string,
): string {
  const files = extra?.['files'];
  if (!Array.isArray(files) || files.length === 0) return messageText;
  const texts: string[] = [];
  for (const file of files as Loose[]) {
    const t = file?.['text'];
    if (typeof t === 'string' && t) texts.push(t);
  }
  return `${texts.join('\n\n')}\n\n${messageText}`;
}
