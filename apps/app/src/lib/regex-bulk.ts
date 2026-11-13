/**
 * Bulk operations on the three regex lists (ST regex extension `#bulk_*` — DEV_NOTES §9.36).
 * Pure list math; the page persists whatever lists come back.
 */
import type { RegexScript } from '@tm/core';
import type { RegexScope } from './regex';

export type RegexLists = Record<RegexScope, RegexScript[]>;
export type RegexBulkOp =
  { kind: 'enable' } | { kind: 'disable' } | { kind: 'delete' } | { kind: 'move'; to: RegexScope };

export const REGEX_SCOPES: readonly RegexScope[] = ['global', 'preset', 'scoped'];
export const regexBulkKey = (scope: RegexScope, id: string): string => `${scope}:${id}`;

const isPicked = (picked: ReadonlySet<string>, scope: RegexScope, s: RegexScript) =>
  !!s.id && picked.has(regexBulkKey(scope, s.id));

/** every selectable key, in list order */
export function allRegexBulkKeys(lists: RegexLists): string[] {
  return REGEX_SCOPES.flatMap((scope) =>
    lists[scope].flatMap((s) => (s.id ? [regexBulkKey(scope, s.id)] : [])),
  );
}

/** the picked scripts: global, then preset, then scoped, each in list order */
export function pickedRegexScripts(lists: RegexLists, picked: ReadonlySet<string>): RegexScript[] {
  return REGEX_SCOPES.flatMap((scope) => lists[scope].filter((s) => isPicked(picked, scope, s)));
}

/** Apply `op` to the picked scripts; returns only the lists that changed. */
export function applyRegexBulk(
  lists: RegexLists,
  picked: ReadonlySet<string>,
  op: RegexBulkOp,
): Partial<RegexLists> {
  const out: Partial<RegexLists> = {};
  const moved: RegexScript[] = [];
  for (const scope of REGEX_SCOPES) {
    const list = lists[scope];
    if (!list.some((s) => isPicked(picked, scope, s))) continue;
    if (op.kind === 'enable' || op.kind === 'disable') {
      const disabled = op.kind === 'disable';
      if (list.every((s) => !isPicked(picked, scope, s) || !!s.disabled === disabled)) continue;
      out[scope] = list.map((s) => (isPicked(picked, scope, s) ? { ...s, disabled } : s));
    } else if (op.kind === 'delete') {
      out[scope] = list.filter((s) => !isPicked(picked, scope, s));
    } else if (scope !== op.to) {
      moved.push(...list.filter((s) => isPicked(picked, scope, s)));
      out[scope] = list.filter((s) => !isPicked(picked, scope, s));
    }
  }
  // ST moveRegexScript: removed from the old list, appended to the target
  if (op.kind === 'move' && moved.length) out[op.to] = [...lists[op.to], ...moved];
  return out;
}

/** ST bulk export file name (`regex-<ISO time>.json`, with `:` made file-system safe) */
export function regexBulkExportFileName(now: Date): string {
  return `regex-${now.toISOString().replace(/:/g, '-')}.json`;
}
