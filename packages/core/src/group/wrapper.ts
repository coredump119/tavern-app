/**
 * generateGroupWrapper 的编排：选人 → 逐个 Generate（含 auto-continue）→ 队列回调。
 * I/O（Generate、发用户消息、UI 状态）全部由 host 注入，core 只负责顺序与规则。
 */
import type { CharacterLike, GroupLike } from '../state.js';
import { selectGroupMembers } from './activation.js';
import type { GroupActivationContext, GroupGenerationType, GroupSelection } from './types.js';

export interface GroupGenerateResult {
  messageChunk?: string | undefined;
  [key: string]: unknown;
}

export interface GroupGenerationHost {
  /** Generate(type, { automatic_trigger, ...params })，宿主需先 setCharacterId(chId) */
  generate: (
    chId: number,
    type: GroupSelection['generateType'] | 'continue',
    params: { automatic_trigger: boolean } & Record<string, unknown>,
  ) => Promise<GroupGenerateResult | string | undefined | void>;
  /** shouldAutoContinue(messageChunk, isImpersonate) */
  shouldAutoContinue?: ((messageChunk: string, isImpersonate: boolean) => boolean) | undefined;
  /** 没有人被激活时：把用户输入原样发出（sendMessageAsUser + saveChat + 清空输入框） */
  sendUserMessageAsIs?:
    ((userInput: string, type: string | null | undefined) => Promise<void>) | undefined;
  /** GROUP_WRAPPER_STARTED / GROUP_MEMBER_DRAFTED / GROUP_WRAPPER_FINISHED */
  onStarted?: ((info: { type: string | null | undefined }) => Promise<void> | void) | undefined;
  onMemberDrafted?: ((chId: number) => Promise<void> | void) | undefined;
  onFinished?: ((info: { type: string | null | undefined }) => Promise<void> | void) | undefined;
  /** power_user.show_group_chat_queue：队列（avatar → 序号）变化 */
  onQueueChanged?: ((queue: ReadonlyMap<string, number>) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface GroupGenerationInput {
  group: GroupLike;
  type?: GroupGenerationType | string | null | undefined;
  userInput: string;
  byAutoMode: boolean;
  params?: ({ force_chid?: number | undefined } & Record<string, unknown>) | undefined;
  showQueue?: boolean | undefined;
}

export interface GroupGenerationOutcome {
  selection: GroupSelection;
  /** 最后一次 Generate 的返回 */
  textResult: GroupGenerateResult | string | undefined | void;
  /** 本批次 id（Date.now()） */
  generationId: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('AbortSignal was fired. Group generation stopped');
}

/**
 * 返回 undefined 表示 ST 会直接 return 的情形（无群组或无成员）。
 * 其余异常（被中止、Deleted group member swiped）向上抛，宿主负责 toast / 状态复位。
 */
export async function generateGroup(
  input: GroupGenerationInput,
  ctx: GroupActivationContext & { now?: (() => number) | undefined },
  host: GroupGenerationHost,
): Promise<GroupGenerationOutcome | undefined> {
  const { group, type = null, userInput, byAutoMode } = input;
  if (!group || !Array.isArray(group.members) || !group.members.length) return undefined;

  const params = input.params ?? {};
  throwIfAborted(host.signal);
  const generationId = (ctx.now ?? Date.now)();

  const selection = selectGroupMembers(
    { group, type, userInput, byAutoMode, forceChid: params.force_chid },
    ctx,
  );
  const { activatedMembers } = selection;

  if (activatedMembers.length === 0) {
    await host.sendUserMessageAsIs?.(userInput, type);
  }

  const queue = new Map<string, number>();
  const characters: readonly CharacterLike[] = ctx.characters;
  const avatarOf = (chId: number) => characters[chId]?.avatar ?? String(chId);
  if (input.showQueue) {
    activatedMembers.forEach((chId, i) => queue.set(avatarOf(chId), i + 1));
    host.onQueueChanged?.(queue);
  }

  let textResult: GroupGenerateResult | string | undefined | void;
  try {
    await host.onStarted?.({ type });
    for (const chId of activatedMembers) {
      throwIfAborted(host.signal);
      await host.onMemberDrafted?.(chId);
      const generateType = selection.generateType;
      textResult = await host.generate(chId, generateType, {
        automatic_trigger: byAutoMode,
        ...params,
      });
      let messageChunk =
        typeof textResult === 'object' && textResult ? textResult.messageChunk : undefined;
      if (messageChunk && host.shouldAutoContinue) {
        while (host.shouldAutoContinue(messageChunk, type === 'impersonate')) {
          textResult = await host.generate(chId, 'continue', {
            automatic_trigger: byAutoMode,
            ...params,
          });
          messageChunk =
            typeof textResult === 'object' && textResult ? textResult.messageChunk : undefined;
          if (!messageChunk) break;
        }
      }
      if (input.showQueue) {
        queue.delete(avatarOf(chId));
        for (const [k, v] of queue) queue.set(k, v - 1);
        host.onQueueChanged?.(queue);
      }
    }
  } finally {
    if (input.showQueue) {
      queue.clear();
      host.onQueueChanged?.(queue);
    }
    await host.onFinished?.({ type });
  }

  return { selection, textResult, generationId };
}
