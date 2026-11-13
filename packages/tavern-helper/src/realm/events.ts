/**
 * Event bus shared by every card frame (TavernHelper `eventOn` family). Listeners run in
 * registration order, awaited one after another like ST's event emitter; one throwing listener
 * does not stop the rest. Each listener is tagged with the frame that registered it so a frame
 * that goes away takes its listeners with it.
 */
import type { ChatSplice, RawMessage } from '../protocol.js';

export type Listener = (...args: never[]) => unknown;

interface Entry {
  owner: object;
  fn: Listener;
  once: boolean;
}

export interface EventSubscription {
  stop: () => void;
}

export class EventBus {
  private readonly events = new Map<string, Entry[]>();

  /** `position`: where to put the listener; an already registered one is moved, never doubled */
  on(
    owner: object,
    name: string,
    fn: Listener,
    options: { once?: boolean; position?: 'first' | 'last' | 'keep' } = {},
  ): EventSubscription {
    const { once = false, position = 'keep' } = options;
    let list = this.events.get(name);
    if (!list) this.events.set(name, (list = []));
    const at = list.findIndex((e) => e.owner === owner && e.fn === fn);
    if (at >= 0 && position === 'keep') {
      list[at]!.once = once;
    } else {
      if (at >= 0) list.splice(at, 1);
      const entry = { owner, fn, once };
      if (position === 'first') list.unshift(entry);
      else list.push(entry);
    }
    return { stop: () => this.off(owner, name, fn) };
  }

  off(owner: object, name: string, fn: Listener): void {
    this.filter(name, (e) => e.owner !== owner || e.fn !== fn);
  }

  /** Drop every listener `owner` has on `name`. */
  clearEvent(owner: object, name: string): void {
    this.filter(name, (e) => e.owner !== owner);
  }

  /** Drop `fn` from every event `owner` registered it on. */
  clearListener(owner: object, fn: Listener): void {
    for (const name of [...this.events.keys()]) this.off(owner, name, fn);
  }

  /** Drop everything `owner` registered (its frame is gone, or it called `eventClearAll`). */
  clearOwner(owner: object): void {
    for (const name of [...this.events.keys()]) this.clearEvent(owner, name);
  }

  count(name: string): number {
    return this.events.get(name)?.length ?? 0;
  }

  async emit(name: string, args: readonly unknown[]): Promise<void> {
    const list = this.events.get(name);
    if (!list || list.length === 0) return;
    // a snapshot: listeners may subscribe or unsubscribe while the event is being delivered
    for (const entry of [...list]) {
      if (entry.once) this.off(entry.owner, name, entry.fn);
      try {
        await (entry.fn as (...a: unknown[]) => unknown)(...args);
      } catch (e) {
        console.error(`[TavernHelper] listener for "${name}" failed`, e);
      }
    }
  }

  private filter(name: string, keep: (entry: Entry) => boolean): void {
    const list = this.events.get(name);
    if (!list) return;
    const next = list.filter(keep);
    if (next.length === 0) this.events.delete(name);
    else if (next.length !== list.length) this.events.set(name, next);
  }
}

/** ST `event_types` a script can listen to in this round (values are ST's own event names) */
export const tavern_events = {
  APP_READY: 'app_ready',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_UPDATED: 'message_updated',
  CHAT_CHANGED: 'chat_id_changed',
  GENERATION_STARTED: 'generation_started',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_ENDED: 'generation_ended',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
} as const;

/** TavernHelper's own events */
export const iframe_events = {
  MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
  MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
  GENERATION_REQUESTED: 'js_generation_requested',
  GENERATION_STARTED: 'js_generation_started',
  STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
  STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
  GENERATION_ENDED: 'js_generation_ended',
} as const;

type EventCall = [name: string, ...args: unknown[]];

/**
 * The ST events a change made by the app stands for. `removed` are the messages the splice took
 * out, `before` the chat length before it.
 */
export function deriveEvents(
  before: number,
  removed: readonly RawMessage[],
  splice: ChatSplice,
): EventCall[] {
  const { start, messages } = splice;
  const out: EventCall[] = [];
  if (removed.length === 0 && start === before) {
    messages.forEach((message, i) => {
      const id = start + i;
      if (message.is_user) {
        out.push([tavern_events.MESSAGE_SENT, id], [tavern_events.USER_MESSAGE_RENDERED, id]);
      } else if (!Array.isArray(message.extra?.['tool_invocations'])) {
        // the record of a tool-call turn is not a reply (ST announces it with TOOL_CALLS_PERFORMED)
        out.push(
          [tavern_events.MESSAGE_RECEIVED, id, 'normal'],
          [tavern_events.CHARACTER_MESSAGE_RENDERED, id, 'normal'],
        );
      }
    });
  } else if (removed.length === messages.length) {
    messages.forEach((message, i) => {
      const id = start + i;
      const old = removed[i]!;
      if ((old.swipe_id ?? 0) !== (message.swipe_id ?? 0)) {
        if ((message.swipes?.length ?? 1) > (old.swipes?.length ?? 1)) {
          out.push(
            [tavern_events.MESSAGE_RECEIVED, id, 'swipe'],
            [tavern_events.CHARACTER_MESSAGE_RENDERED, id, 'swipe'],
          );
        } else out.push([tavern_events.MESSAGE_SWIPED, id]);
      } else if (old.mes !== message.mes) {
        out.push([tavern_events.MESSAGE_EDITED, id], [tavern_events.MESSAGE_UPDATED, id]);
      }
    });
  } else if (messages.length < removed.length) {
    out.push([tavern_events.MESSAGE_DELETED, before - removed.length + messages.length]);
  }
  return out;
}
