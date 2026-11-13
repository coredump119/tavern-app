import type { ChatMessageLike, CharacterLike, GroupLike } from '../state.js';

export { GROUP_ACTIVATION_STRATEGY, GROUP_GENERATION_MODE } from '../state.js';

export const DEFAULT_AUTO_MODE_DELAY = 5;
/** script.js talkativeness_default */
export const TALKATIVENESS_DEFAULT = 0.5;
/** system_message_types.NARRATOR */
export const NARRATOR_MESSAGE_TYPE = 'narrator';

/** 群聊轮转用到的宿主状态 */
export interface GroupActivationContext {
  characters: readonly CharacterLike[];
  chat: readonly ChatMessageLike[];
  random?: (() => number) | undefined;
}

export type GroupGenerationType =
  'normal' | 'auto' | 'quiet' | 'swipe' | 'continue' | 'impersonate' | 'regenerate';

export interface GroupSelectionInput {
  group: GroupLike;
  type: GroupGenerationType | string | null | undefined;
  /** #send_textarea 内容 */
  userInput: string;
  byAutoMode: boolean;
  /** params.force_chid */
  forceChid?: number | undefined;
}

export interface GroupSelection {
  /** 本轮依次发言的 characters 下标 */
  activatedMembers: number[];
  /** 触发激活的文本（用户输入或最后一条非系统消息） */
  activationText: string;
  isUserInput: boolean;
  /** 传给 Generate 的类型 */
  generateType: 'normal' | 'swipe' | 'impersonate' | 'quiet' | 'continue';
}

export class DeletedGroupMemberSwipedError extends Error {
  constructor() {
    super('Deleted group member swiped');
    this.name = 'DeletedGroupMemberSwipedError';
  }
}
