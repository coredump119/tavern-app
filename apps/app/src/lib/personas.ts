/**
 * Persona (user avatar) file operations + the glue between core `persona` data rules and
 * settings.json / chat metadata (DEV_NOTES §9.24). Pure orchestration over ipc.ts.
 */
import { thumbnailUrl } from '@tm/core';
import {
  dataDelete,
  dataList,
  fileUrl,
  userAvatarCopy,
  userAvatarSeedDefault,
  userAvatarUpload,
  type ImageCrop,
} from './ipc';

export const USER_AVATARS_DIR = 'User Avatars';

/** `/api/avatars/get`: PNG files in `User Avatars/` */
export async function listUserAvatars(root: string): Promise<string[]> {
  return (await dataList(root, USER_AVATARS_DIR, 'png')).sort();
}

export const userAvatarUrl = (root: string, file: string) =>
  fileUrl(`${root}/${USER_AVATARS_DIR}/${file}`);

/** First run: ST seeds user-default.png; returns true when we had to. */
export async function ensureDefaultUserAvatar(root: string): Promise<boolean> {
  try {
    return await userAvatarSeedDefault(root);
  } catch {
    return false;
  }
}

/** Upload a picked image as a persona avatar (resize unless `never_resize_avatars`). */
export async function uploadPersonaAvatar(
  root: string,
  imagePath: string,
  settings: Record<string, unknown> | null,
  overwriteName?: string,
  crop?: ImageCrop,
): Promise<string> {
  const pu = (settings?.['power_user'] as Record<string, unknown> | undefined) ?? {};
  return userAvatarUpload(root, imagePath, !pu['never_resize_avatars'], overwriteName, crop);
}

export async function deleteUserAvatarFile(root: string, file: string): Promise<void> {
  try {
    await dataDelete(root, `${USER_AVATARS_DIR}/${file}`);
  } catch {
    /* already gone: ST ignores a missing file too */
  }
}

export async function copyUserAvatarFile(root: string, from: string, to: string): Promise<void> {
  await userAvatarCopy(root, from, to);
}

/** `sendMessageAsUser`: user messages of a persona carry `force_avatar = /thumbnail?type=persona&file=…` */
export function userForceAvatar(settings: Record<string, unknown> | null): string | undefined {
  const avatar = settings?.['user_avatar'];
  const pu = (settings?.['power_user'] as Record<string, unknown> | undefined) ?? {};
  const personas = (pu['personas'] as Record<string, unknown> | undefined) ?? {};
  return typeof avatar === 'string' && avatar in personas
    ? thumbnailUrl('persona', avatar)
    : undefined;
}

/** The persona file a stored user message points at, or null (older messages / non-persona avatars). */
export function personaFileFromForceAvatar(forceAvatar: unknown): string | null {
  if (typeof forceAvatar !== 'string') return null;
  // ST: `/thumbnail?type=persona&file=<encoded>`; older chats: `User Avatars/<file>`
  const m = /^\/thumbnail\?type=persona&file=([^&]+)/.exec(forceAvatar);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return m[1]!;
    }
  }
  const prefix = `${USER_AVATARS_DIR}/`;
  return forceAvatar.startsWith(prefix) ? forceAvatar.slice(prefix.length) : null;
}
