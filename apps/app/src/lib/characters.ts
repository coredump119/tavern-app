/**
 * Character editing glue (DEV_NOTES §9.17): card JSON ⇄ ST form, save / delete / rename / duplicate /
 * avatar, and the `tags` / `tag_map` bookkeeping in settings.json. Pure orchestration over ipc.ts.
 */
import {
  characterFormFromCard,
  formatCharacterData,
  parseWorldInfo,
  worldInfoToCharacterBook,
  type CharacterBook,
  type CharacterEditForm,
} from '@tm/formats';
import {
  TAG_IMPORT_SETTING,
  deleteTagKey,
  importTags,
  planTagImport,
  renameTagKey,
  tagStoreOf,
  type Tag,
  type TagImportPlan,
  type TagStore,
} from '@tm/core';
import { renameGroupMemberInGroup } from '@tm/core';
import {
  cardAvatarReplace,
  cardDelete,
  cardDuplicate,
  cardRead,
  cardRename,
  cardWrite,
  chatRenameCharacter,
  chatRenameGroupMember,
  dataList,
  dataReadText,
  type ImageCrop,
} from './ipc';
import { listGroups, writeGroup } from './groups';

export interface LoadedCharacter {
  avatar: string;
  /** the stored card object (`json_data`) */
  raw: Record<string, unknown>;
  form: CharacterEditForm;
}

export async function loadCharacter(root: string, avatar: string): Promise<LoadedCharacter> {
  const raw = JSON.parse(await cardRead(`${root}/characters/${avatar}`)) as Record<string, unknown>;
  return { avatar, raw, form: characterFormFromCard(raw) };
}

/** `worlds/*.json` names without the extension (the `#character_world` select). */
export async function listWorlds(root: string): Promise<string[]> {
  const files = await dataList(root, 'worlds', 'json');
  return files.map((f) => f.replace(/\.json$/i, ''));
}

/** ST server: an imported book keeps `originalData`; otherwise the world is converted on the fly. */
async function characterBookFor(root: string, world: string): Promise<CharacterBook | undefined> {
  if (!world) return undefined;
  try {
    const parsed = JSON.parse(await dataReadText(root, `worlds/${world}.json`)) as Record<
      string,
      unknown
    >;
    const original = parsed['originalData'];
    if (original && typeof original === 'object') return original as CharacterBook;
    return worldInfoToCharacterBook(world, parseWorldInfo(parsed));
  } catch {
    return undefined; // ST: warns and leaves the book alone
  }
}

/** `/api/characters/edit` without an avatar file: format + write the chunks back into the PNG. */
export async function saveCharacter(
  root: string,
  loaded: LoadedCharacter,
  form: CharacterEditForm,
): Promise<Record<string, unknown>> {
  const characterBook = await characterBookFor(root, form.world ?? '');
  const chat = loaded.raw['chat'];
  const createDate = loaded.raw['create_date'];
  const out = formatCharacterData(form, {
    existing: loaded.raw,
    characterBook,
    chat: typeof chat === 'string' ? chat : undefined,
    create_date: typeof createDate === 'string' ? createDate : undefined,
  });
  await cardWrite(`${root}/characters/${loaded.avatar}`, JSON.stringify(out));
  return out;
}

export async function replaceAvatar(
  root: string,
  avatar: string,
  imagePath: string,
  settings: Record<string, unknown> | null,
  keepOriginal = true,
  crop?: ImageCrop,
): Promise<void> {
  const pu = (settings?.['power_user'] as Record<string, unknown> | undefined) ?? {};
  await cardAvatarReplace(root, avatar, imagePath, !pu['never_resize_avatars'], keepOriginal, crop);
}

/** Large avatar copy written by `replaceAvatar` (DEV_NOTES §9.23); may not exist for older cards. */
export const avatarBackgroundRel = (avatar: string) =>
  `backgrounds/character-${avatar.replace(/\.[^/.]+$/, '')}.png`;

/** Delete the card (+ chats) and its tag_map row. Returns the settings object when it changed. */
export async function deleteCharacter(
  root: string,
  avatar: string,
  deleteChats: boolean,
  settings: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  await cardDelete(root, avatar, deleteChats);
  if (!settings) return null;
  const next = structuredClone(settings);
  const store = tagStoreOf(next);
  if (!(avatar in store.tag_map)) return null;
  deleteTagKey(store, avatar);
  return next;
}

export interface RenameResult {
  avatar: string;
  /** settings with tag_map / active_character / charLore / note.chara moved, or null when untouched */
  settings: Record<string, unknown> | null;
  chatsRewritten: number;
  /** groups whose member list pointed at the old avatar (ST renameGroupMember) */
  groupsUpdated: number;
  groupChatsRewritten: number;
}

/** ST renameCharacter: `world_info.charLore[].name` and `extension_settings.note.chara[].name` use the file stem */
function renameSettingsReferences(
  settings: Record<string, unknown>,
  oldAvatar: string,
  newAvatar: string,
): boolean {
  const stem = (a: string) => a.replace(/\.[^/.]+$/, '');
  const oldName = stem(oldAvatar);
  const newName = stem(newAvatar);
  let changed = false;
  const wi = settings['world_info_settings'] as Record<string, unknown> | undefined;
  const wiObj = wi?.['world_info'] as Record<string, unknown> | undefined;
  const charLore = wiObj?.['charLore'];
  if (Array.isArray(charLore)) {
    for (const entry of charLore as Array<Record<string, unknown>>) {
      if (entry['name'] === oldName) {
        entry['name'] = newName;
        changed = true;
      }
    }
  }
  const ext = settings['extension_settings'] as Record<string, unknown> | undefined;
  const note = ext?.['note'] as Record<string, unknown> | undefined;
  const chara = note?.['chara'];
  if (Array.isArray(chara)) {
    for (const entry of chara as Array<Record<string, unknown>>) {
      if (entry['name'] === oldName) {
        entry['name'] = newName;
        changed = true;
      }
    }
  }
  return changed;
}

/** ST renameCharacter: file + chats folder, tag key, active_character, optionally past chats. */
export async function renameCharacter(
  root: string,
  avatar: string,
  newName: string,
  renameChats: boolean,
  settings: Record<string, unknown> | null,
): Promise<RenameResult> {
  const next = await cardRename(root, avatar, newName);
  let changed: Record<string, unknown> | null = null;
  if (settings) {
    const copy = structuredClone(settings);
    const store = tagStoreOf(copy);
    if (avatar in store.tag_map) {
      renameTagKey(store, avatar, next);
      changed = copy;
    }
    if (copy['active_character'] === avatar) {
      copy['active_character'] = next;
      changed = copy;
    }
    if (renameSettingsReferences(copy, avatar, next)) changed = copy;
  }
  const chatsRewritten = renameChats ? await chatRenameCharacter(root, next, newName) : 0;
  // ST renameGroupMember: group member lists + every chat of those groups
  let groupsUpdated = 0;
  let groupChatsRewritten = 0;
  try {
    for (const group of await listGroups(root)) {
      if (!renameGroupMemberInGroup(group, avatar, next)) continue;
      await writeGroup(root, group);
      groupsUpdated++;
      groupChatsRewritten += await chatRenameGroupMember(
        root,
        group.chats ?? [],
        avatar,
        next,
        newName,
      );
    }
  } catch {
    /* groups are optional data; the character itself is already renamed */
  }
  return { avatar: next, settings: changed, chatsRewritten, groupsUpdated, groupChatsRewritten };
}

export async function duplicateCharacter(root: string, avatar: string): Promise<string> {
  return cardDuplicate(root, avatar);
}

// ---- tags ----

export function tagImportSetting(settings: Record<string, unknown> | null): number {
  const pu = (settings?.['power_user'] as Record<string, unknown> | undefined) ?? {};
  const v = Number(pu['tag_import_setting']);
  return Number.isFinite(v) ? v : TAG_IMPORT_SETTING.ASK;
}

export interface PendingTagImport {
  avatar: string;
  name: string;
  plan: TagImportPlan;
}

/**
 * After importing cards: apply the tag import setting to each; cards that need a decision (ASK)
 * come back as `pending` for the host to show a popup. Mutates `store` (a copy of settings).
 */
export async function planImportedTags(
  root: string,
  store: TagStore,
  avatars: readonly string[],
  setting: number,
): Promise<{ pending: PendingTagImport[]; imported: Tag[] }> {
  const pending: PendingTagImport[] = [];
  const imported: Tag[] = [];
  for (const avatar of avatars) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await cardRead(`${root}/characters/${avatar}`)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const data = (raw['data'] as Record<string, unknown> | undefined) ?? raw;
    const tags = Array.isArray(data['tags'])
      ? (data['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    const name = String(data['name'] ?? raw['name'] ?? avatar);
    const plan = planTagImport(store, { avatar, tags }, setting);
    if (plan.names === null) pending.push({ avatar, name, plan });
    else imported.push(...importTags(store, avatar, plan.names));
  }
  return { pending, imported };
}

/** Resolve one ASK popup the way ST's buttons do. */
export function resolveTagImport(
  store: TagStore,
  item: PendingTagImport,
  choice: 'all' | 'existing' | 'none',
): Tag[] {
  const names =
    choice === 'all'
      ? [...item.plan.existing, ...item.plan.fresh].map((t) => t.name)
      : choice === 'existing'
        ? item.plan.existing.map((t) => t.name)
        : [];
  return importTags(store, item.avatar, names);
}
