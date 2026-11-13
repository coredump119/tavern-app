/** ST data backup (zip of the data root, DEV_NOTES §5 / §9.27). */
import { backupFileName } from './backup-rules';
import { dataExport, dataImport, exportDir, settingsRead, type ImportReport } from './ipc';
import { chatStore } from './chat/store.svelte';
import { describeExport, exportTarget, isMobilePlatform } from './export';

/**
 * Export the whole data root (index + secrets excluded) to a user-chosen / export-dir path.
 * With `password` the result is a sealed `.tmbackup` (DEV_NOTES §9.38).
 */
export async function exportBackup(
  root: string,
  password: string | null = null,
): Promise<string | null> {
  const t = await exportTarget(backupFileName(new Date(), password !== null));
  if (!t) return null;
  // the file is written straight to its destination by Rust (no copy through the data dir)
  await dataExport(root, t.path, false, password);
  return describeExport(t);
}

/** Import an ST backup zip or a sealed backup, then reload what the store caches. */
export async function importBackup(
  zipPath: string,
  password: string | null = null,
): Promise<ImportReport> {
  const root = chatStore.root;
  if (!root) throw new Error('no data root');
  const r = await dataImport(zipPath, root, password);
  await chatStore.refreshCharacters();
  await chatStore.refreshGroups();
  chatStore.settings = (await settingsRead(root)) as Record<string, unknown> | null;
  return r;
}

export { exportDir, isMobilePlatform };
export { backupFileName, backupPasswordProblem, WRONG_BACKUP_PASSWORD } from './backup-rules';
