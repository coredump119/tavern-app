/**
 * Regex script storage for the three ST sources (DEV_NOTES §9.25): global
 * (`extension_settings.regex`), the active preset (`<bucket>.extensions.regex_scripts` + the preset
 * file) and the character card (`data.extensions.regex_scripts`). Allow lists live in
 * `extension_settings`. Settings objects are plain snapshots; the caller persists them.
 */
import {
  REGEX_SCRIPT_TYPES,
  setPresetRegexAllowed,
  setScopedRegexAllowed,
  type RegexScript,
} from '@tm/core';
import { mainApiOf } from './chat/core-state';
import { cardRead, cardWrite, dataReadText, dataWriteText } from './ipc';

type Obj = Record<string, unknown>;

export interface RegexPresetContext {
  api: string;
  presetName: string;
  /** settings.json key holding `extensions.regex_scripts` */
  bucketKey: 'oai_settings' | 'textgenerationwebui_settings';
  /** preset directory under the data root */
  presetDir: 'OpenAI Settings' | 'TextGen Settings';
}

/** Which preset the PRESET scripts belong to right now (ST getCurrentPresetAPI / getCurrentPresetName) */
export function regexPresetContext(settings: Obj): RegexPresetContext {
  const api = mainApiOf(settings);
  if (api === 'openai') {
    const oai = (settings['oai_settings'] as Obj | undefined) ?? {};
    return {
      api,
      presetName: String(oai['preset_settings_openai'] ?? ''),
      bucketKey: 'oai_settings',
      presetDir: 'OpenAI Settings',
    };
  }
  const tg = (settings['textgenerationwebui_settings'] as Obj | undefined) ?? {};
  return {
    api,
    presetName: String(tg['preset'] ?? ''),
    bucketKey: 'textgenerationwebui_settings',
    presetDir: 'TextGen Settings',
  };
}

export function extOf(settings: Obj): Obj {
  if (!settings['extension_settings'] || typeof settings['extension_settings'] !== 'object')
    settings['extension_settings'] = {};
  return settings['extension_settings'] as Obj;
}

export function globalRegexScripts(settings: Obj): RegexScript[] {
  const list = extOf(settings)['regex'];
  return Array.isArray(list) ? (list as RegexScript[]) : [];
}

export function presetRegexScripts(settings: Obj): RegexScript[] {
  const { bucketKey } = regexPresetContext(settings);
  const bucket = (settings[bucketKey] as Obj | undefined) ?? {};
  const ext = (bucket['extensions'] as Obj | undefined) ?? {};
  return Array.isArray(ext['regex_scripts']) ? (ext['regex_scripts'] as RegexScript[]) : [];
}

export async function scopedRegexScripts(root: string, avatar: string): Promise<RegexScript[]> {
  const card = JSON.parse(await cardRead(`${root}/characters/${avatar}`)) as Obj;
  const data = (card['data'] as Obj | undefined) ?? {};
  const ext = (data['extensions'] as Obj | undefined) ?? {};
  return Array.isArray(ext['regex_scripts']) ? (ext['regex_scripts'] as RegexScript[]) : [];
}

/** GLOBAL: `extension_settings.regex = scripts` (mutates the snapshot) */
export function setGlobalRegexScripts(settings: Obj, scripts: RegexScript[]): void {
  extOf(settings)['regex'] = scripts;
}

/**
 * PRESET: `writePresetExtensionField` = the settings bucket **and** the preset file on disk; saving
 * also allow-lists the preset (ST `allowPresetScripts`). Mutates the snapshot.
 */
export async function setPresetRegexScripts(
  root: string,
  settings: Obj,
  scripts: RegexScript[],
): Promise<void> {
  const { api, presetName, bucketKey, presetDir } = regexPresetContext(settings);
  const bucket = (settings[bucketKey] as Obj | undefined) ?? {};
  const ext = (bucket['extensions'] as Obj | undefined) ?? {};
  bucket['extensions'] = { ...ext, regex_scripts: scripts };
  settings[bucketKey] = bucket;
  setPresetRegexAllowed(extOf(settings), api, presetName, true);
  if (!presetName) return;
  const rel = `${presetDir}/${presetName}.json`;
  let preset: Obj | null = null;
  try {
    preset = JSON.parse(await dataReadText(root, rel)) as Obj;
  } catch {
    preset = null; // no file for this preset name (e.g. unsaved defaults): the bucket is the source
  }
  if (preset) {
    const pext = (preset['extensions'] as Obj | undefined) ?? {};
    preset['extensions'] = { ...pext, regex_scripts: scripts };
    await dataWriteText(root, rel, JSON.stringify(preset, null, 4));
  }
}

/** SCOPED: `writeExtensionField(chid, 'regex_scripts', scripts)` on the card + allow-list the avatar. */
export async function setScopedRegexScripts(
  root: string,
  settings: Obj,
  avatar: string,
  scripts: RegexScript[],
): Promise<void> {
  const path = `${root}/characters/${avatar}`;
  const card = JSON.parse(await cardRead(path)) as Obj;
  const data = (card['data'] as Obj | undefined) ?? {};
  const ext = (data['extensions'] as Obj | undefined) ?? {};
  card['data'] = { ...data, extensions: { ...ext, regex_scripts: scripts } };
  await cardWrite(path, JSON.stringify(card));
  setScopedRegexAllowed(extOf(settings), avatar, true);
}

export const REGEX_SCOPE_TYPE = {
  global: REGEX_SCRIPT_TYPES.GLOBAL,
  preset: REGEX_SCRIPT_TYPES.PRESET,
  scoped: REGEX_SCRIPT_TYPES.SCOPED,
} as const;
export type RegexScope = keyof typeof REGEX_SCOPE_TYPE;
