/**
 * ST public/scripts/group-chats.js 的成员激活策略（activate* 系列 + generateGroupWrapper 的分派段）。
 * 全部纯函数：characters / chat / random 由 ctx 注入。
 */
import type { ChatMessageLike, CharacterLike, GroupLike } from '../state.js';
import { extractAllWords, onlyUnique, shuffle } from '../util/array.js';
import {
  DeletedGroupMemberSwipedError,
  GROUP_ACTIVATION_STRATEGY,
  NARRATOR_MESSAGE_TYPE,
  TALKATIVENESS_DEFAULT,
  type GroupActivationContext,
  type GroupSelection,
  type GroupSelectionInput,
} from './types.js';

function rnd(ctx: GroupActivationContext): () => number {
  return ctx.random ?? Math.random;
}

function isNarrator(message: ChatMessageLike): boolean {
  return (message.extra as { type?: unknown } | undefined)?.type === NARRATOR_MESSAGE_TYPE;
}

function originalAvatar(message: ChatMessageLike): string | undefined {
  const v = message.original_avatar;
  return typeof v === 'string' && v ? v : undefined;
}

/** 头像文件名 → characters 下标，找不到的丢弃 */
export function membersToCharacterIds(
  avatars: readonly string[],
  characters: readonly CharacterLike[],
): number[] {
  return avatars.map((x) => characters.findIndex((y) => y.avatar === x)).filter((x) => x !== -1);
}

/** 'impersonate'：随机一名成员 */
export function activateImpersonate(
  members: readonly string[],
  ctx: GroupActivationContext,
): number[] {
  const randomIndex = Math.floor(rnd(ctx)() * members.length);
  const picked = members[randomIndex];
  return membersToCharacterIds(picked === undefined ? [] : [picked], ctx.characters);
}

/** 'swipe' / 'continue' / 'quiet'：按最后一条消息找发言者 */
export function activateSwipe(
  members: readonly string[],
  ctx: GroupActivationContext,
  { allowSystem = false }: { allowSystem?: boolean } = {},
): number[] {
  const activatedNames: string[] = [];
  const chat = ctx.chat;
  const lastMessage = chat[chat.length - 1];
  if (!lastMessage) return [];

  const skip = (m: ChatMessageLike) =>
    !!m.is_user || (!allowSystem && !!m.is_system) || isNarrator(m);

  if (skip(lastMessage)) {
    for (const message of chat.slice().reverse()) {
      if (skip(message)) continue;
      const avatar = originalAvatar(message);
      if (avatar) {
        activatedNames.push(avatar);
        break;
      }
    }
    if (activatedNames.length === 0) {
      const first = shuffle(members.slice(), rnd(ctx))[0];
      if (first !== undefined) activatedNames.push(first);
    }
  }

  // 旧版群聊（消息没有 original_avatar）：按名字匹配
  const lastAvatar = originalAvatar(lastMessage);
  if (!lastAvatar) {
    const matches = ctx.characters.filter((x) => x.name == lastMessage.name);
    for (const match of matches) {
      if (members.includes(match.avatar)) {
        activatedNames.push(match.avatar);
        break;
      }
    }
  } else {
    activatedNames.push(lastAvatar);
  }

  return membersToCharacterIds(activatedNames, ctx.characters);
}

/** LIST：成员顺序去重 */
export function activateListOrder(
  members: readonly string[],
  ctx: GroupActivationContext,
): number[] {
  return membersToCharacterIds(members.filter(onlyUnique), ctx.characters);
}

/** POOLED：优先没在上一轮用户消息后发言过的成员，否则随机（多成员时排除最后发言者） */
export function activatePooledOrder(
  members: readonly string[],
  lastMessage: ChatMessageLike | undefined,
  isUserInput: boolean,
  ctx: GroupActivationContext,
): number[] {
  const random = rnd(ctx);
  let activatedMember: string | null = null;
  const spokenSinceUser: string[] = [];

  for (const message of ctx.chat.slice().reverse()) {
    if (message.is_user || isUserInput) break;
    if (message.is_system || isNarrator(message)) continue;
    const avatar = originalAvatar(message);
    if (avatar) spokenSinceUser.push(avatar);
  }

  const haveNotSpoken = members.filter((x) => !spokenSinceUser.includes(x));
  if (haveNotSpoken.length) {
    activatedMember = haveNotSpoken[Math.floor(random() * haveNotSpoken.length)] ?? null;
  }

  if (activatedMember === null) {
    const lastMessageAvatar =
      members.length > 1 && lastMessage && !lastMessage.is_user && originalAvatar(lastMessage);
    const randomPool = lastMessageAvatar ? members.filter((x) => x !== lastMessageAvatar) : members;
    activatedMember = randomPool[Math.floor(random() * randomPool.length)] ?? null;
  }

  const memberId = ctx.characters.findIndex((y) => y.avatar === activatedMember);
  return memberId !== -1 ? [memberId] : [];
}

/** NATURAL：提名（名字单词命中）→ 按健谈度掷骰 → 兜底随机一名（优先健谈度 > 0） */
export function activateNaturalOrder(
  members: readonly string[],
  input: string,
  lastMessage: ChatMessageLike | undefined,
  allowSelfResponses: boolean | undefined,
  isUserInput: boolean,
  ctx: GroupActivationContext,
): number[] {
  const random = rnd(ctx);
  const characters = ctx.characters;
  let activatedMembers: string[] = [];

  // 防止同一角色连续发言……除非允许自我回复
  let bannedUser: string | false | undefined =
    !isUserInput && lastMessage && !lastMessage.is_user && lastMessage.name;
  if (allowSelfResponses) bannedUser = undefined;

  if (input && input.length) {
    for (const inputWord of extractAllWords(input)) {
      for (const member of members) {
        const character = characters.find((x) => x.avatar === member);
        if (!character || character.name === bannedUser) continue;
        if (extractAllWords(character.name).includes(inputWord)) {
          activatedMembers.push(member);
          break;
        }
      }
    }
  }

  const chattyMembers: string[] = [];
  const shuffledMembers = shuffle([...members], random);
  for (const member of shuffledMembers) {
    const character = characters.find((x) => x.avatar === member);
    if (!character || character.name === bannedUser) continue;
    const rollValue = random();
    const raw = character.talkativeness;
    const talkativeness =
      Number.isNaN(Number(raw)) || raw === undefined ? TALKATIVENESS_DEFAULT : Number(raw);
    if (talkativeness >= rollValue) activatedMembers.push(member);
    if (talkativeness > 0) chattyMembers.push(member);
  }

  let retries = 0;
  const randomPool = chattyMembers.length > 0 ? chattyMembers : members;
  while (activatedMembers.length === 0 && ++retries <= randomPool.length) {
    const randomIndex = Math.floor(random() * randomPool.length);
    const avatar = randomPool[randomIndex];
    const character = characters.find((x) => x.avatar === avatar);
    if (!character || avatar === undefined) continue;
    activatedMembers.push(avatar);
  }

  activatedMembers = activatedMembers.filter(onlyUnique);
  return membersToCharacterIds(activatedMembers, characters);
}

/** MANUAL 且非用户输入：随机一名 */
export function activateManual(members: readonly string[], ctx: GroupActivationContext): number[] {
  return shuffle([...members], rnd(ctx))
    .slice(0, 1)
    .map((x) => ctx.characters.findIndex((y) => y.avatar === x))
    .filter((x) => x !== -1);
}

/** group.members 去掉 disabled_members */
export function getEnabledMembers(group: GroupLike): string[] {
  const disabled = group.disabled_members ?? [];
  return group.members.filter((x) => !disabled.includes(x));
}

/**
 * generateGroupWrapper 的激活分派段：决定本轮发言者。
 * 'swipe' / 'continue' 找不到发言者时抛 DeletedGroupMemberSwipedError（ST 弹 toast 并中止）。
 */
export function selectGroupMembers(
  input: GroupSelectionInput,
  ctx: GroupActivationContext,
): GroupSelection {
  const { group, type, userInput, byAutoMode } = input;
  const chat = ctx.chat;
  const lastMessage = chat[chat.length - 1];
  let activationText = '';
  let isUserInput = false;

  if (userInput?.length && !byAutoMode) {
    isUserInput = true;
    activationText = userInput;
  } else if (lastMessage && !lastMessage.is_system) {
    activationText = lastMessage.mes;
  }

  const activationStrategy = Number(group.activation_strategy ?? GROUP_ACTIVATION_STRATEGY.NATURAL);
  const enabledMembers = getEnabledMembers(group);
  let activatedMembers: number[] = [];

  if (typeof input.forceChid === 'number') {
    activatedMembers = [input.forceChid];
  } else if (type === 'quiet') {
    activatedMembers = activateSwipe(group.members, ctx, { allowSystem: true }).slice(0, 1);
    if (activatedMembers.length === 0) {
      activatedMembers = activateListOrder(group.members.slice(0, 1), ctx);
    }
  } else if (type === 'swipe' || type === 'continue') {
    activatedMembers = activateSwipe(group.members, ctx, { allowSystem: false });
    if (activatedMembers.length === 0) throw new DeletedGroupMemberSwipedError();
  } else if (type === 'impersonate') {
    activatedMembers = activateImpersonate(group.members, ctx);
  } else if (activationStrategy === GROUP_ACTIVATION_STRATEGY.NATURAL) {
    activatedMembers = activateNaturalOrder(
      enabledMembers,
      activationText,
      lastMessage,
      group.allow_self_responses,
      isUserInput,
      ctx,
    );
  } else if (activationStrategy === GROUP_ACTIVATION_STRATEGY.LIST) {
    activatedMembers = activateListOrder(enabledMembers, ctx);
  } else if (activationStrategy === GROUP_ACTIVATION_STRATEGY.POOLED) {
    activatedMembers = activatePooledOrder(enabledMembers, lastMessage, isUserInput, ctx);
  } else if (activationStrategy === GROUP_ACTIVATION_STRATEGY.MANUAL && !isUserInput) {
    activatedMembers = activateManual(enabledMembers, ctx);
  }

  const generateType =
    type === 'swipe' || type === 'impersonate' || type === 'quiet' || type === 'continue'
      ? type
      : 'normal';

  return { activatedMembers, activationText, isUserInput, generateType };
}

/** getLastMessageGenerationId：最后一条是角色消息时取 extra.gen_id */
export function getLastMessageGenerationId(chat: readonly ChatMessageLike[]): unknown {
  const lastMes = chat[chat.length - 1];
  if (!lastMes) return null;
  if (!lastMes.is_user && !lastMes.is_system && lastMes.extra) {
    return (lastMes.extra as { gen_id?: unknown }).gen_id ?? null;
  }
  return null;
}

/**
 * regenerateGroup 的删除段：返回要从尾部删掉的消息条数
 * （同一 gen_id 批次的全部角色消息；旧消息无 gen_id 时删到第一条用户/系统消息为止）。
 */
export function countMessagesToRegenerate(chat: readonly ChatMessageLike[]): number {
  const generationId = getLastMessageGenerationId(chat);
  let n = 0;
  for (let i = chat.length - 1; i >= 0; i--) {
    const lastMes = chat[i] as ChatMessageLike;
    const thisGenerationId = (lastMes.extra as { gen_id?: unknown } | undefined)?.gen_id;
    if (generationId && thisGenerationId && generationId !== thisGenerationId) break;
    if (lastMes.is_user || lastMes.is_system) break;
    n++;
  }
  return n;
}
