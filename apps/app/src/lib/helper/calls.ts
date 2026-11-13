/**
 * What scripts may ask the app to do through the bridge's `call` request (DEV_NOTES §9.5 第 3 轮):
 * a fixed table of names. A name that is not in the table is refused, so the realm can reach
 * nothing the app did not list here.
 */
import { dataCalls } from './calls-data.svelte';
import { pageCalls } from './calls-page';

/** `args` come straight from a script: every handler checks what it is given */
export type CallHandler = (args: readonly unknown[], from: string) => unknown;
export type CallTable = Readonly<Record<string, CallHandler>>;

const CALLS: CallTable = { ...dataCalls, ...pageCalls };

export async function runCall(
  name: string,
  args: readonly unknown[],
  from: string,
): Promise<unknown> {
  const handler = Object.hasOwn(CALLS, name) ? CALLS[name] : undefined;
  if (!handler) throw new Error(`未知的调用：${name}`);
  return handler(args, from);
}
