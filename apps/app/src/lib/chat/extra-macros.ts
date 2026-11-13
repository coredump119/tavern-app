/**
 * Macros ST extensions registered (DEV_NOTES §9.34 第 2 轮). A chat context has its own macro
 * engine, so the definitions are kept here and put into each engine as it is made.
 */
import {
  MacroRegistry,
  consoleMacroLogger,
  type MacroDefinition,
  type MacroDefinitionOptions,
} from '@tm/core';

const extra = new Map<string, MacroDefinitionOptions>();
/** bumped on every change: a context derived from it is rebuilt, a cached one is dropped */
let version = 0;
/** checks a definition the way an engine's registry will, and gives ST's return value */
const scratch = new MacroRegistry(consoleMacroLogger);

const key = (name: unknown) => String(name ?? '').trim();

/** ST `MacroRegistry.registerMacro`: null when the definition is refused */
export function registerExtraMacro(
  name: string,
  options: MacroDefinitionOptions,
): MacroDefinition | null {
  const definition = scratch.registerMacro(name, options);
  if (!definition) return null;
  extra.set(key(name), options);
  version++;
  return definition;
}

export function unregisterExtraMacro(name: string): boolean {
  scratch.unregisterMacro(key(name));
  const had = extra.delete(key(name));
  if (had) version++;
  return had;
}

export const hasExtraMacro = (name: string): boolean => extra.has(key(name));

export const extraMacroVersion = (): number => version;

/** Put the extension macros into a new engine's registry */
export function applyExtraMacros(registry: MacroRegistry): void {
  if (version === 0) return;
  for (const [name, options] of extra) registry.registerMacro(name, options);
}
