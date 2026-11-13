/** Backup naming and the sealed-backup password rule (DEV_NOTES §9.38). No store or IPC imports. */

/** shortest password accepted for a sealed backup */
export const BACKUP_PASSWORD_MIN = 8;

export function backupFileName(now = new Date(), sealed = false): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `tavern-backup-${stamp}.${sealed ? 'tmbackup' : 'zip'}`;
}

/** what `data_import` rejects a sealed backup with when the password is wrong (Rust `seal_message`) */
export const WRONG_BACKUP_PASSWORD = '密码不对';

/** Why a sealed-backup password pair cannot be used, or null when it can. */
export function backupPasswordProblem(password: string, repeat: string): string | null {
  if ([...password].length < BACKUP_PASSWORD_MIN) return `密码至少 ${BACKUP_PASSWORD_MIN} 个字符`;
  if (password !== repeat) return '两次输入的密码不一样';
  return null;
}
