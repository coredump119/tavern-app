/** group-chats.js getFirstCharacterMessage / getGroupChat 新建群聊时的开场白 */
import type { ChatMessageLike, CharacterLike, GroupLike } from '../state.js';

export interface FirstMessageDeps {
  /** substituteParams(text, { name2Override }) */
  substitute: (text: string, name2Override: string) => string;
  /** getMessageTimeStamp() */
  timestamp: () => string;
  random?: (() => number) | undefined;
  /** Date.now() */
  now?: (() => number) | undefined;
  /** CHARACTER_FIRST_MESSAGE_SELECTED 钩子：返回非空字符串则替换 */
  onFirstMessageSelected?:
    ((input: string, character: CharacterLike) => string | undefined) | undefined;
  /** getThumbnailUrl('avatar', avatar)；默认原样返回文件名 */
  thumbnailUrl?: ((avatar: string) => string) | undefined;
  /** default_avatar */
  defaultAvatar?: string | undefined;
}

export interface GroupFirstMessage extends ChatMessageLike {
  is_user: false;
  is_system: false;
  name: string;
  send_date: string;
  original_avatar: string;
  extra: { gen_id: number };
  force_avatar: string;
}

export function getFirstCharacterMessage(
  character: CharacterLike,
  deps: FirstMessageDeps,
): GroupFirstMessage {
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  let messageText = character.first_mes ?? '';

  const alternates = character.data?.alternate_greetings;
  if (Array.isArray(alternates)) {
    const messageTexts = [character.first_mes, ...alternates].filter((x): x is string => !!x);
    messageText = messageTexts[Math.floor(random() * messageTexts.length)] ?? '';
  }

  const override = deps.onFirstMessageSelected?.(messageText, character);
  if (override) messageText = override;

  const thumb = deps.thumbnailUrl ?? ((a: string) => a);
  return {
    is_user: false,
    is_system: false,
    name: character.name,
    send_date: deps.timestamp(),
    original_avatar: character.avatar,
    extra: { gen_id: now() * random() * 1000000 },
    mes: messageText ? deps.substitute(messageText.trim(), character.name) : '',
    force_avatar:
      character.avatar != 'none' ? thumb(character.avatar) : (deps.defaultAvatar ?? 'img/ai4.png'),
  };
}

/** getGroupChat 的 freshChat 分支：按成员顺序生成开场白，跳过没有开场白的成员 */
export function buildGroupFirstMessages(
  group: GroupLike,
  characters: readonly CharacterLike[],
  deps: FirstMessageDeps,
): GroupFirstMessage[] {
  const out: GroupFirstMessage[] = [];
  for (const member of group.members) {
    const character = characters.find((x) => x.avatar === member || x.name === member);
    if (!character) continue;
    const mes = getFirstCharacterMessage(character, deps);
    if (!mes.mes) continue;
    out.push(mes);
  }
  return out;
}
