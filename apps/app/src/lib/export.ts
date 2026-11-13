/**
 * Where exported files go (DEV_NOTES §9.27): desktop asks with the system save dialog; iOS and
 * Android have no save dialog, so files land in `export_dir()` (iOS Documents → Files app).
 */
import { save } from '@tauri-apps/plugin-dialog';
import {
  cardExportPng,
  exportCopy,
  exportDir,
  exportExists,
  exportWriteText,
  isTauri,
  ping,
} from './ipc';

let platformCache: string | null = null;
export async function platformName(): Promise<string> {
  if (platformCache) return platformCache;
  platformCache = isTauri() ? (await ping()).platform : 'web';
  return platformCache;
}
export async function isMobilePlatform(): Promise<boolean> {
  const p = await platformName();
  return p === 'ios' || p === 'android';
}

export interface ExportTarget {
  path: string;
  /** true when the user picked the location in a dialog (desktop) */
  viaDialog: boolean;
}

const splitExt = (name: string): [string, string] => {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
};

/**
 * Resolve where `fileName` should be written. Returns null when the user cancelled the dialog.
 * On mobile the name is made unique inside the export folder (`name (2).ext`).
 */
export async function exportTarget(
  fileName: string,
  existing: (path: string) => Promise<boolean> = exportExists,
): Promise<ExportTarget | null> {
  if (!(await isMobilePlatform())) {
    const [, ext] = splitExt(fileName);
    const picked = await save({
      defaultPath: fileName,
      ...(ext
        ? { filters: [{ name: ext.slice(1).toUpperCase(), extensions: [ext.slice(1)] }] }
        : {}),
    });
    return picked ? { path: picked, viaDialog: true } : null;
  }
  const dir = await exportDir();
  const [stem, ext] = splitExt(fileName);
  let candidate = `${dir}/${fileName}`;
  for (let n = 2; (await existing(candidate)) && n < 1000; n++)
    candidate = `${dir}/${stem} (${n})${ext}`;
  return { path: candidate, viaDialog: false };
}

/** Human description of where a file went, for the notice line. */
export async function describeExport(t: ExportTarget): Promise<string> {
  if (t.viaDialog) return `已保存到 ${t.path}`;
  const p = await platformName();
  const base = t.path.split('/').pop() ?? t.path;
  return p === 'ios' ? `已保存到「文件」app → Tavern → ${base}` : `已保存到 ${t.path}`;
}

export async function exportText(fileName: string, text: string): Promise<ExportTarget | null> {
  const t = await exportTarget(fileName);
  if (t) await exportWriteText(t.path, text);
  return t;
}

export async function exportFileCopy(src: string, fileName: string): Promise<ExportTarget | null> {
  const t = await exportTarget(fileName);
  if (t) await exportCopy(src, t.path);
  return t;
}

/** ST `/api/characters/export` png */
export async function exportCardPng(root: string, avatar: string): Promise<ExportTarget | null> {
  const t = await exportTarget(avatar);
  if (t) await cardExportPng(root, avatar, t.path);
  return t;
}
