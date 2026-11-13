/**
 * ST's event emitter (`public/lib/eventemitter.js`), the object extensions get as `eventSource`
 * (DEV_NOTES §9.34). Semantics kept: listeners run in registration order and are awaited one
 * after another; a throwing listener is logged and the rest still run; the listener list is
 * snapshotted per emit; events named in `autoFireAfterEmit` replay their last arguments to a
 * listener that subscribes after the fact (`app_ready`). `emitLate` is ours: see there.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- extension listeners take whatever the event carries
export type StListener = (...args: any[]) => unknown;

export class StEventEmitter {
  private readonly events = new Map<string, StListener[]>();
  private readonly autoFireLastArgs = new Map<string, unknown[]>();
  private readonly autoFireAfterEmit: ReadonlySet<string>;
  /** arguments of an `emitLate` that the next emit of the event has not replaced yet */
  private readonly lateArgs = new Map<string, unknown[]>();

  constructor(autoFireAfterEmit: readonly string[] = []) {
    this.autoFireAfterEmit = new Set(autoFireAfterEmit);
  }

  on(event: string, listener: StListener): void {
    if (event === undefined) {
      console.warn('[ext] eventSource.on: undefined event name');
      return;
    }
    this.list(event).push(listener);
    this.replay(event, listener);
  }

  makeLast(event: string, listener: StListener): void {
    const list = this.list(event);
    const at = list.indexOf(listener);
    if (at > -1) list.splice(at, 1);
    list.push(listener);
    this.replay(event, listener);
  }

  makeFirst(event: string, listener: StListener): void {
    const list = this.list(event);
    const at = list.indexOf(listener);
    if (at > -1) list.splice(at, 1);
    list.unshift(listener);
    this.replay(event, listener);
  }

  removeListener(event: string, listener: StListener): void {
    const list = this.events.get(event);
    if (!list) return;
    const at = list.indexOf(listener);
    if (at > -1) list.splice(at, 1);
  }

  /** not in ST's emitter; extensions written against Node's EventEmitter call it */
  off(event: string, listener: StListener): void {
    this.removeListener(event, listener);
  }

  once(event: string, listener: StListener): void {
    const wrapper: StListener = (...args) => {
      this.removeListener(event, wrapper);
      return listener.apply(this, args);
    };
    this.on(event, wrapper);
  }

  async emit(event: string, ...args: unknown[]): Promise<void> {
    this.lateArgs.delete(event);
    const list = this.events.get(event);
    if (list) {
      for (const listener of [...list]) {
        try {
          await listener.apply(this, args);
        } catch (e) {
          console.error(`[ext] listener for "${event}" failed`, e);
        }
      }
    }
    if (this.autoFireAfterEmit.has(event)) this.autoFireLastArgs.set(event, args);
  }

  /**
   * `emit`, then once more for each listener that subscribes before the event's next emit. For
   * the chat that was open before the extensions were: ST opens its chat after they are up, so an
   * extension that subscribes at the end of an async start still hears `chat_id_changed` there.
   */
  async emitLate(event: string, ...args: unknown[]): Promise<void> {
    await this.emit(event, ...args);
    this.lateArgs.set(event, args);
  }

  /** Like `emit`, but does not wait for async listeners. */
  emitAndWait(event: string, ...args: unknown[]): void {
    this.lateArgs.delete(event);
    const list = this.events.get(event);
    if (list) {
      for (const listener of [...list]) {
        try {
          void listener.apply(this, args);
        } catch (e) {
          console.error(`[ext] listener for "${event}" failed`, e);
        }
      }
    }
    if (this.autoFireAfterEmit.has(event)) this.autoFireLastArgs.set(event, args);
  }

  /** Whether anything listens to `event`; lets the app skip work nobody would see. */
  has(event: string): boolean {
    return (this.events.get(event)?.length ?? 0) > 0;
  }

  private list(event: string): StListener[] {
    let list = this.events.get(event);
    if (!list) this.events.set(event, (list = []));
    return list;
  }

  private replay(event: string, listener: StListener): void {
    const args = this.autoFireLastArgs.get(event);
    if (args && this.autoFireAfterEmit.has(event)) void listener.apply(this, args);
    const late = this.lateArgs.get(event);
    if (late) {
      // after `on` returns, like an emit that came a moment later
      void Promise.resolve()
        .then(() => listener.apply(this, late))
        .catch((e: unknown) => console.error(`[ext] listener for "${event}" failed`, e));
    }
  }
}
