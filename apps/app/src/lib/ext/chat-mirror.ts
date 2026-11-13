/**
 * ST's `chat` array as extensions hold it (DEV_NOTES §9.34): one array for the life of the page,
 * refilled in place from the store. Extensions change messages in place and then call
 * `saveChat()` / `updateMessageBlock()`; the store never mutates, it replaces. The two meet here.
 */
import { parseChatMessage, type ChatMessage } from '@tm/formats';
import { deriveEvents, diffByReference, type RawMessage } from '@tm/tavern-helper';
import { chatStore, messageTimeStamp } from '../chat/store.svelte';

export type EventCall = [name: string, ...args: unknown[]];

export class ChatMirror {
  /** the array extensions hold: never replaced */
  readonly chat: ChatMessage[] = [];
  /** the store array `chat` was last filled from */
  private synced: readonly ChatMessage[] = [];
  private key: string | null = null;
  /** set by `forget`: the next `sync` counts as another chat */
  private stale = false;
  /** store row → the object extensions hold for it, where the two differ (after `refresh`) */
  private held = new WeakMap<ChatMessage, ChatMessage>();
  /** objects that came from the store; anything else found in `chat` was built by an extension */
  private readonly known = new WeakSet<ChatMessage>();

  /**
   * Take the store's messages (`key` names the chat; null when none is whole in memory).
   * Returns whether another chat is open now and, if not, the ST events the change stands for.
   */
  sync(
    key: string | null,
    messages: readonly ChatMessage[],
  ): { changed: boolean; events: EventCall[] } {
    const prev = this.synced;
    const changed = this.stale || key !== this.key;
    this.stale = false;
    // our own `save` / `refresh` coming back from the store
    if (!changed && messages === prev) return { changed, events: [] };
    this.key = key;
    if (changed) this.held = new WeakMap();
    this.fill(messages);
    if (changed) return { changed, events: [] };
    const splice = diffByReference(
      prev as readonly RawMessage[],
      messages as readonly RawMessage[],
    );
    if (!splice) return { changed, events: [] };
    const removed = prev.slice(splice.start, splice.start + splice.deleteCount);
    return { changed, events: deriveEvents(prev.length, removed as RawMessage[], splice) };
  }

  /**
   * ST `saveChat()`: the extension's array, with what it changed in place, becomes the chat.
   * False when there is no chat to save into.
   */
  save(): boolean {
    if (this.key === null) return false;
    for (const message of this.chat) {
      if (this.known.has(message)) continue;
      // built by the extension: make it a message the app can store
      message.send_date ??= messageTimeStamp();
      Object.assign(message, parseChatMessage(message));
    }
    this.held = new WeakMap();
    this.fill(chatStore.adoptChat(this.chat));
    return true;
  }

  /**
   * ST `updateMessageBlock()`: message `index` was changed in place, draw it again. The row gets
   * a copy (rows are keyed by reference) while extensions keep the object they have.
   */
  refresh(index: number): void {
    const message = this.chat[index];
    if (this.key === null || !message || !this.synced[index]) return;
    const copy = { ...message };
    this.held.set(copy, message);
    this.fill(chatStore.spliceMessages(index, 1, [copy]));
  }

  /** ST `reloadCurrentChat()`: whatever the store holds next is a chat opened anew. */
  forget(): void {
    this.stale = true;
  }

  /** Refill `chat`; adopting `messages` as the baseline keeps `sync` from echoing our own change. */
  private fill(messages: readonly ChatMessage[]): void {
    const { chat, held, known } = this;
    this.synced = messages;
    chat.length = messages.length;
    for (let i = 0; i < messages.length; i++) {
      const row = messages[i]!;
      known.add(row);
      chat[i] = held.get(row) ?? row;
    }
  }
}
