/** TavernHelper variable semantics (DEV_NOTES §9.5); pure, the hub decides where values live. */
import _ from 'lodash';
import type { RawMessage, Variables } from '../protocol.js';

export type VariableType =
  'message' | 'chat' | 'character' | 'preset' | 'global' | 'script' | 'extension';

export interface VariableOption {
  type?: VariableType;
  /** `type: 'message'` only: 楼层号 (negatives from the end) or `'latest'` */
  message_id?: number | 'latest';
  script_id?: string;
  extension_id?: string;
}

const isPlain = (v: unknown): v is Variables => _.isPlainObject(v);

/** `insertOrAssignVariables`: deep merge where an incoming array replaces the old one. */
export function mergeAssign(target: Variables, patch: Variables): Variables {
  return _.mergeWith(target, patch, (_old: unknown, incoming: unknown) =>
    Array.isArray(incoming) ? incoming : undefined,
  );
}

/** `insertVariables`: only fills what is missing. */
export function insertMissing(target: Variables, patch: Variables): Variables {
  return _.defaultsDeep(target, patch) as Variables;
}

/** `deleteVariable`: lodash path; reports whether something was there to delete. */
export function deletePath(target: Variables, path: string): boolean {
  return _.has(target, path) && _.unset(target, path);
}

/**
 * A message's `variables` as one object per swipe. Stored data is an array, or an object keyed by
 * swipe index; an object with other keys is read as the variables of the swipe being shown.
 */
export function swipeVariables(message: RawMessage): Variables[] {
  const current = message.swipe_id ?? 0;
  const count = Math.max(message.swipes?.length ?? 1, current + 1);
  const raw = message.variables;
  let source: Record<number, unknown> = {};
  if (Array.isArray(raw)) source = raw;
  else if (isPlain(raw)) {
    source = Object.keys(raw).every((k) => /^\d+$/.test(k)) ? raw : { [current]: raw };
  }
  return Array.from({ length: count }, (_unused, i) => {
    const item = source[i];
    return isPlain(item) ? item : {};
  });
}

/** The variables of the swipe a message currently shows. */
export function messageVariables(message: RawMessage): Variables {
  return swipeVariables(message)[message.swipe_id ?? 0] ?? {};
}

/** `message.variables` with the current swipe's object replaced by `value`. */
export function withMessageVariables(message: RawMessage, value: Variables): Variables[] {
  const all = swipeVariables(message);
  all[message.swipe_id ?? 0] = value;
  return all;
}
