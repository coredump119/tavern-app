import type { ExtensionPrompts } from '@tm/core';

type Obj = Record<string, unknown>;

/**
 * What a generation takes from ST `extension_prompts`: entries with text and a usable position
 * (ST skips empty values when it collects them).
 */
export function activePrompts(prompts: Obj): ExtensionPrompts {
  const out: ExtensionPrompts = {};
  for (const [key, entry] of Object.entries(prompts)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { value, position, depth, scan, role, filter } = entry as Obj;
    if (typeof value !== 'string' || !value || !Number.isFinite(position)) continue;
    out[key] = {
      value,
      position: position as number,
      depth: Number(depth) || 0,
      scan: !!scan,
      role: Number(role) || 0,
      filter: typeof filter === 'function' ? (filter as () => boolean) : null,
    };
  }
  return out;
}
