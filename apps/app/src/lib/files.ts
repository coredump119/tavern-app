/** File pickers via the Tauri dialog plugin (desktop + iOS + Android). Returns absolute paths Rust can read. */
import { open } from '@tauri-apps/plugin-dialog';
import { fileReadText, isTauri, pickedStage, pickedUnstage } from './ipc';

/** Size cap for a picked JSON import (script library, regex scripts). */
const JSON_IMPORT_MAX_BYTES = 20 * 1024 * 1024;

export async function pickFiles(opts: {
  extensions: string[];
  multiple?: boolean;
  title?: string;
}): Promise<string[]> {
  if (!isTauri()) return [];
  const picked = await open({
    multiple: opts.multiple ?? false,
    directory: false,
    ...(opts.title ? { title: opts.title } : {}),
    filters: [{ name: opts.title ?? 'files', extensions: opts.extensions }],
  });
  if (!picked) return [];
  return Promise.all((Array.isArray(picked) ? picked : [picked]).map(localPick));
}

/**
 * Android's picker hands out `content://` addresses: nothing can open them by path and they carry
 * no file name, so each one is copied into our own folder right away and the copy's path is what
 * callers get (DEV_NOTES §9.46). The copies are cleared on the next start.
 */
function localPick(path: string): Promise<string> {
  return path.startsWith('content://') ? pickedStage(path) : Promise.resolve(path);
}

/**
 * Run `use` on our own copy of a picked file, for flows that ask the user something between the
 * pick and the read: the iOS document picker deletes its copy about a minute after the pick
 * (DEV_NOTES §9.37). The copy is removed afterwards.
 */
export async function withStagedPick<T>(
  path: string,
  use: (staged: string) => Promise<T>,
): Promise<T> {
  const staged = await pickedStage(path);
  try {
    return await use(staged);
  } finally {
    void pickedUnstage(staged).catch(() => undefined);
  }
}

/** Parse a picked JSON file. Goes through `file_read_text`, which understands iOS `file://` picker URLs. */
export async function readPickedJson(path: string): Promise<unknown> {
  return JSON.parse(await fileReadText(path, JSON_IMPORT_MAX_BYTES)) as unknown;
}
