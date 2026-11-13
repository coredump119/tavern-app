/**
 * Group files (`groups/<id>.json`) and group chat files (`group chats/<chat_id>.jsonl`) for the
 * app (DEV_NOTES §9.21). Orchestration over ipc.ts; the data rules live in @tm/core/group.
 */
import { parseGroup, type Group } from '@tm/formats';
import { sortGroups } from '@tm/core';
import { dataDelete, dataList, dataReadText, dataWriteText } from './ipc';

export const GROUPS_DIR = 'groups';
export const GROUP_CHATS_DIR = 'group chats';

export const groupFile = (id: string) => `${GROUPS_DIR}/${id}.json`;
export const groupChatFile = (chatId: string) => `${GROUP_CHATS_DIR}/${chatId}.jsonl`;
export const groupChatPath = (root: string, chatId: string) => `${root}/${groupChatFile(chatId)}`;

/** `/api/groups/all`: every parseable group, newest chat first. Unreadable files are skipped. */
export async function listGroups(root: string): Promise<Group[]> {
  const files = await dataList(root, GROUPS_DIR, 'json');
  const out: Group[] = [];
  for (const f of files) {
    try {
      out.push(parseGroup(JSON.parse(await dataReadText(root, `${GROUPS_DIR}/${f}`))));
    } catch {
      /* skip */
    }
  }
  return sortGroups(out);
}

export async function readGroup(root: string, id: string): Promise<Group> {
  return parseGroup(JSON.parse(await dataReadText(root, groupFile(id))));
}

/** `/api/groups/edit`: the whole object, 4-space JSON (ST warns on and drops chat_metadata / past_metadata). */
export async function writeGroup(root: string, group: Group): Promise<void> {
  const body: Record<string, unknown> = { ...group };
  delete body['chat_metadata'];
  delete body['past_metadata'];
  await dataWriteText(root, groupFile(group.id), JSON.stringify(body, null, 4));
}

/** `/api/groups/delete`: every chat file listed in `chats`, then the group file. */
export async function deleteGroup(root: string, group: Group): Promise<void> {
  for (const chat of group.chats ?? []) {
    try {
      await dataDelete(root, groupChatFile(chat));
    } catch {
      /* already gone */
    }
  }
  await dataDelete(root, groupFile(group.id));
}

export async function deleteGroupChatFile(root: string, chatId: string): Promise<void> {
  await dataDelete(root, groupChatFile(chatId));
}
