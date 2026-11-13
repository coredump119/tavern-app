/**
 * Group files and the group-chat message shape (ST group-chats.js createGroup / saveGroupChat /
 * saveReply group branch — DEV_NOTES §9.21). Pure helpers; files are written by the host.
 */
import type { ChatMessageLike, GroupLike } from '../state.js';
import { GROUP_ACTIVATION_STRATEGY, GROUP_GENERATION_MODE } from '../state.js';
import { DEFAULT_AUTO_MODE_DELAY } from './types.js';

/** script.js default_avatar */
export const DEFAULT_GROUP_AVATAR = 'img/ai4.png';

/**
 * ST `getGroupAvatar`: a group's own picture is used only when `avatar_url` is an image the app
 * stores (`isValidImageUrl`: a data URL, or a path under `user/`); anything else, the default
 * `img/ai4.png` included, means the member collage. Returns the data URL, or the path relative to
 * the data root (no leading slash); null for the collage.
 */
export function groupCustomAvatar(avatarUrl: unknown): string | null {
  if (typeof avatarUrl !== 'string') return null;
  if (avatarUrl.startsWith('data:image/')) return avatarUrl;
  const rel = avatarUrl.replace(/^\/+/, '');
  if (!rel.startsWith('user/') || rel.split('/').includes('..')) return null;
  return rel;
}

/** `getThumbnailUrl(type, file)` — what ST stores in `force_avatar` */
export function thumbnailUrl(type: 'avatar' | 'persona', file: string): string {
  return `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`;
}

export interface NewGroupInput {
  name?: string | undefined;
  members: readonly string[];
  /** names of the members, for the default group name */
  memberNames?: readonly string[] | undefined;
  allowSelfResponses?: boolean | undefined;
  activationStrategy?: number | undefined;
  generationMode?: number | undefined;
  autoModeDelay?: number | undefined;
  fav?: boolean | undefined;
  hideMutedSprites?: boolean | undefined;
  avatarUrl?: string | undefined;
  /** humanizedDateTime() */
  chatName: string;
  /** Date.now() */
  now?: (() => number) | undefined;
}

/** `createGroup` (client model) + `/api/groups/create` (server fills id / defaults) */
export function newGroup(input: NewGroupInput): GroupLike & Record<string, unknown> {
  const id = String((input.now ?? Date.now)());
  const name = input.name?.trim() || `Group: ${(input.memberNames ?? input.members).join(', ')}`;
  return {
    id,
    name,
    members: [...input.members],
    avatar_url: input.avatarUrl || DEFAULT_GROUP_AVATAR,
    allow_self_responses: !!input.allowSelfResponses,
    hideMutedSprites: !!input.hideMutedSprites,
    activation_strategy: input.activationStrategy ?? GROUP_ACTIVATION_STRATEGY.NATURAL,
    generation_mode: input.generationMode ?? GROUP_GENERATION_MODE.SWAP,
    disabled_members: [],
    fav: !!input.fav,
    chat_id: input.chatName,
    chats: [input.chatName],
    auto_mode_delay: input.autoModeDelay ?? DEFAULT_AUTO_MODE_DELAY,
    generation_mode_join_prefix: '',
    generation_mode_join_suffix: '',
  };
}

/** `saveGroupChat` header line */
export function groupChatHeader(chatMetadata: Record<string, unknown>): Record<string, unknown> {
  return { chat_metadata: { ...chatMetadata }, user_name: 'unused', character_name: 'unused' };
}

/**
 * `saveReply` group branch: the fields a freshly generated group message carries.
 * `avatar === 'none'` falls back to the default avatar image like ST.
 */
export function groupMessageFields(
  avatar: string,
  generationId: number,
): { original_avatar: string; force_avatar: string; gen_id: number } {
  return {
    original_avatar: avatar,
    force_avatar: avatar !== 'none' ? thumbnailUrl('avatar', avatar) : DEFAULT_GROUP_AVATAR,
    gen_id: generationId,
  };
}

/** `/api/groups/all` orders nothing; ST's list sorts by date_last_chat desc. */
export function sortGroups<T extends { date_last_chat?: unknown }>(groups: readonly T[]): T[] {
  return [...groups].sort((a, b) => Number(b.date_last_chat ?? 0) - Number(a.date_last_chat ?? 0));
}

/** `getGroupAvatar`: up to four member avatars (file names), skipping missing / 'none' */
export function groupCollageAvatars(
  group: GroupLike,
  characters: ReadonlyArray<{ avatar: string }>,
): string[] {
  const out: string[] = [];
  for (const member of group.members) {
    const c = characters.find((x) => x.avatar === member);
    if (c && c.avatar !== 'none') out.push(c.avatar);
    if (out.length === 4) break;
  }
  return out;
}

/** `openGroupChat` / `createNewGroupChat` / `deleteGroupChat` bookkeeping on the group object */
export function switchGroupChat(group: GroupLike, chatId: string, now = Date.now): void {
  group.chat_id = chatId;
  group['date_last_chat'] = now();
}
export function addGroupChat(group: GroupLike, chatId: string, now = Date.now): void {
  const chats = Array.isArray(group['chats']) ? (group['chats'] as string[]) : [];
  chats.push(chatId);
  group['chats'] = chats;
  switchGroupChat(group, chatId, now);
}
/** returns the chat to open next (`''` means a new one must be created) */
export function removeGroupChat(group: GroupLike, chatId: string): string {
  const chats = (Array.isArray(group['chats']) ? (group['chats'] as string[]) : []).filter(
    (c) => c !== chatId,
  );
  group['chats'] = chats;
  if (group.chat_id === chatId) group.chat_id = chats[chats.length - 1] ?? '';
  return group.chat_id ?? '';
}

/** `renameGroupMember` on the group file: members + disabled_members */
export function renameGroupMemberInGroup(
  group: GroupLike,
  oldAvatar: string,
  newAvatar: string,
): boolean {
  let changed = false;
  const swap = (list: unknown) => {
    if (!Array.isArray(list)) return list;
    return list.map((x) => {
      if (x === oldAvatar) {
        changed = true;
        return newAvatar;
      }
      return x;
    });
  };
  group.members = swap(group.members) as string[];
  if (group.disabled_members) group.disabled_members = swap(group.disabled_members) as string[];
  return changed;
}

/** `renameGroupMember` on one group-chat message (header lines are skipped by the caller) */
export function renameGroupMemberInMessage(
  message: ChatMessageLike & Record<string, unknown>,
  oldAvatar: string,
  newAvatar: string,
  newName: string,
): boolean {
  if (message.is_user || message.is_system) return false;
  const fa = message['force_avatar'];
  const enc = encodeURIComponent(oldAvatar);
  if (typeof fa !== 'string' || !fa.includes(enc)) return false;
  message.name = newName;
  message['force_avatar'] = fa.replace(enc, encodeURIComponent(newAvatar));
  message['original_avatar'] = newAvatar;
  return true;
}

export const GROUP_ACTIVATION_OPTIONS = [
  { value: GROUP_ACTIVATION_STRATEGY.NATURAL, label: '自然顺序', hint: '按关键词与健谈度' },
  { value: GROUP_ACTIVATION_STRATEGY.LIST, label: '列表顺序', hint: '每轮全体按顺序发言' },
  { value: GROUP_ACTIVATION_STRATEGY.MANUAL, label: '手动', hint: '只有你点谁谁才说' },
  { value: GROUP_ACTIVATION_STRATEGY.POOLED, label: '轮流', hint: '没说过的优先' },
] as const;
export const GROUP_GENERATION_MODE_OPTIONS = [
  { value: GROUP_GENERATION_MODE.SWAP, label: '切换角色卡', hint: '只带当前发言者的设定' },
  { value: GROUP_GENERATION_MODE.APPEND, label: '合并角色卡（不含静音）' },
  { value: GROUP_GENERATION_MODE.APPEND_DISABLED, label: '合并角色卡（含静音）' },
] as const;
