/**
 * What the chat page lets code outside it do (slash commands run by scripts, DEV_NOTES §9.5
 * 第 2 轮). Generation state and the input box live in the page, so these go through it; the page
 * registers itself while it is mounted.
 */
import type { GenType } from './pipeline';

export interface ChatPageActions {
  /** A reply is being generated */
  busy(): boolean;
  /** ST Generate(): no user message is added */
  generate(type: GenType): Promise<void>;
  /** The send button: what is in the input box goes out as the user's message */
  send(): Promise<void>;
  stop(): void;
  /** The arrows on the last message: one step; past the last swipe a new one is generated */
  swipe(dir: -1 | 1): Promise<void>;
  /** Show swipe `swipeId` of message `index` (ST `loadFromSwipeId`); nothing while generating */
  loadSwipe(index: number, swipeId: number): Promise<void>;
  getDraft(): string;
  setDraft(text: string): void;
  /** One line above the input box (the app has no toasts) */
  notify(text: string): void;
}

let current: ChatPageActions | null = null;

/** Returns the unregister function */
export function registerChatPage(actions: ChatPageActions): () => void {
  current = actions;
  return () => {
    if (current === actions) current = null;
  };
}

/** Null while the chat page is not on screen */
export const chatPageIfOpen = (): ChatPageActions | null => current;

/** Throws while the chat page is not on screen */
export function chatPage(): ChatPageActions {
  if (!current) throw new Error('需要先打开聊天页');
  return current;
}
