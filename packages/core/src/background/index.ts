/** Chat backgrounds, data-compatible with ST `backgrounds.js` (DEV_NOTES §9.42). */

export const BACKGROUND_DIR = 'backgrounds';
/** ST's "no background" entry */
export const BACKGROUND_NONE = '__transparent.png';
/** chat_metadata key of a background locked to one chat */
export const BG_METADATA_KEY = 'custom_background';
export const BACKGROUND_FITTINGS = ['classic', 'cover', 'contain', 'stretch', 'center'] as const;
export type BackgroundFitting = (typeof BACKGROUND_FITTINGS)[number];
export const BACKGROUND_IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'avif',
  'bmp',
  'heic',
  'heif',
];

export interface BackgroundSettings {
  name: string;
  url: string;
  fitting: BackgroundFitting;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** ST `generateUrlParameter(bg, false)`: the text stored in settings and chat metadata */
export function backgroundUrlParam(name: string): string {
  return `url("${BACKGROUND_DIR}/${encodeURIComponent(name)}")`;
}

export function isBackgroundImage(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return name !== BACKGROUND_NONE && BACKGROUND_IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Data-root relative path inside a stored `url("…")`. Null for anything that is not a file under
 * `backgrounds/` or `user/images/` (ST also locks generated images, which live there), and for
 * the "no background" entry.
 */
export function backgroundRelOf(urlParam: unknown): string | null {
  if (typeof urlParam !== 'string') return null;
  const m = /^url\(\s*(["']?)(.*?)\1\s*\)$/.exec(urlParam.trim());
  if (!m) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
  rel = rel.replace(/^\/+/, '');
  if (rel.split(/[\\/]/).includes('..')) return null;
  if (!rel.startsWith(`${BACKGROUND_DIR}/`) && !rel.startsWith('user/images/')) return null;
  if (rel === `${BACKGROUND_DIR}/${BACKGROUND_NONE}`) return null;
  return rel;
}

/** settings.json `background`, with ST's defaults for what is missing */
export function backgroundSettingsOf(settings: Json | null | undefined): BackgroundSettings {
  const bg = isObject(settings?.['background']) ? settings['background'] : {};
  const name = typeof bg['name'] === 'string' && bg['name'] ? bg['name'] : BACKGROUND_NONE;
  const fitting = BACKGROUND_FITTINGS.find((f) => f === bg['fitting']) ?? 'classic';
  const url = typeof bg['url'] === 'string' && bg['url'] ? bg['url'] : backgroundUrlParam(name);
  return { name, url, fitting };
}

/** ST `setBackground`: choose the global background (null = none). Other keys of `background` stay. */
export function setGlobalBackground(settings: Json, name: string | null): void {
  const bg = isObject(settings['background']) ? settings['background'] : {};
  const chosen = name ?? BACKGROUND_NONE;
  settings['background'] = { ...bg, name: chosen, url: backgroundUrlParam(chosen) };
}

/** ST `setFittingClass` */
export function setBackgroundFitting(settings: Json, fitting: BackgroundFitting): void {
  const bg = isObject(settings['background']) ? settings['background'] : {};
  settings['background'] = { ...backgroundSettingsOf(settings), ...bg, fitting };
}

/** The image to show: the one locked to the chat, else the global one. Null when neither is set. */
export function activeBackgroundRel(
  settings: Json | null | undefined,
  chatMetadata: Json | null | undefined,
): string | null {
  return (
    backgroundRelOf(chatMetadata?.[BG_METADATA_KEY]) ??
    backgroundRelOf(backgroundSettingsOf(settings).url)
  );
}
