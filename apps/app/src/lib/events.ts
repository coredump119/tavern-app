/**
 * App events that have no store change behind them (generation start / end / stop), under their ST
 * names. The chat page emits here; the TavernHelper bridge and the ST extension host listen
 * (DEV_NOTES §9.5, §9.34). Message events are not sent this way: both listeners derive them from
 * the chat itself.
 *
 * No imports on purpose: the page and both listeners depend on this file, never on each other.
 */
type Sink = (name: string, ...args: unknown[]) => void;

const sinks = new Set<Sink>();

/** Listen to every app event. Returns the unsubscribe function. */
export function onAppEvent(sink: Sink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

export function emitAppEvent(name: string, ...args: unknown[]): void {
  for (const sink of sinks) sink(name, ...args);
}
