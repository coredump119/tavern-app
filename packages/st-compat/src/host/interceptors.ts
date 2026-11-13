/** ST `runGenerationInterceptors` (extensions.js; DEV_NOTES §9.34 第 2 轮). */
import type { ExtensionManifest } from './manifest.js';

/**
 * Run each manifest's `generate_interceptor` (a global function name) over `chat`, in the order
 * given (load order). Resolves to whether one of them aborted the generation.
 */
export async function runGenerationInterceptors(
  manifests: readonly ExtensionManifest[],
  globals: Record<string, unknown>,
  chat: unknown[],
  contextSize: number,
  type: string,
): Promise<boolean> {
  let aborted = false;
  let exitImmediately = false;
  const abort = (immediately?: unknown) => {
    aborted = true;
    exitImmediately = !!immediately;
  };
  for (const manifest of manifests) {
    const key = manifest.generate_interceptor;
    if (!key) continue;
    const interceptor = globals[key];
    if (typeof interceptor === 'function') {
      try {
        await interceptor(chat, contextSize, abort, type);
      } catch (e) {
        console.error(`[ext] 生成拦截器 ${key} 出错`, e);
      }
    }
    if (exitImmediately) break;
  }
  return aborted;
}

/**
 * ST `MacrosParser.registerMacro` semantics for a legacy value: the text of `{{key}}`. A function
 * is called per evaluation with a nonce; anything else is stringified.
 */
export function legacyMacroValue(value: unknown, nonce: () => string): string {
  let stored = value;
  if (typeof stored === 'function') {
    try {
      stored = (stored as (nonce: string) => unknown)(nonce());
    } catch (e) {
      console.warn('[ext] 宏函数出错', e);
      stored = '';
    }
  }
  if (stored == null) return '';
  return typeof stored === 'object' ? JSON.stringify(stored) : String(stored);
}

/** ST's checks on a legacy macro key; returns the trimmed key */
export function legacyMacroKey(key: unknown): string {
  if (typeof key !== 'string') throw new Error('Macro key must be a string');
  const trimmed = key.trim();
  if (!trimmed) throw new Error('Macro key must not be empty or whitespace only');
  if (trimmed.startsWith('{{') || trimmed.endsWith('}}'))
    throw new Error('Macro key must not include the surrounding braces');
  return trimmed;
}
