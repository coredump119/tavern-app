/**
 * The table behind the stand-in host modules (DEV_NOTES §9.34). The `tmext` protocol answers
 * `/script.js`, `/scripts/utils.js`… with a generated module whose exports read
 * `globalThis.__tmStModules[path][name]`; this file is the app's side of that table.
 */
import type { Coverage } from './coverage.js';

/** called by a loaded stand-in when one of its exports changes */
type LiveUpdate = (name: string, value: unknown) => void;

export type HostModule = Record<string, unknown> & { __live?: LiveUpdate[] };
export type ModuleTable = Record<string, HostModule>;

/** the global the stand-ins read */
export const MODULES_GLOBAL = '__tmStModules';

/** a stand-in with no registered export calls this global with its path (`shim_source` in `ext_host.rs`) */
export const MODULE_LOAD_HOOK = '__tmStModuleLoad';

/** host module path → imported names, as `extension_list` scans them per extension */
export type ImportMap = Readonly<Record<string, readonly string[]>>;

/**
 * The export names to register per module: what the app implements plus what the installed
 * extensions import by name (a static import of a name the module lacks is a load-time
 * SyntaxError, so every requested name must exist, as `undefined` if need be).
 */
export function shimNames(
  implemented: ModuleTable,
  requested: readonly ImportMap[],
): Record<string, string[]> {
  const out = new Map<string, Set<string>>();
  const names = (path: string) => {
    let set = out.get(path);
    if (!set) out.set(path, (set = new Set()));
    return set;
  };
  for (const [path, module] of Object.entries(implemented)) {
    const set = names(path);
    for (const name of Object.keys(module)) if (name !== '__live') set.add(name);
  }
  for (const map of requested) {
    for (const [path, wanted] of Object.entries(map)) {
      const set = names(path);
      for (const name of wanted) set.add(name);
    }
  }
  return Object.fromEntries([...out].map(([path, set]) => [path, [...set].sort()]));
}

/** Record every statically imported name the app has nothing for. Returns how many there are. */
export function reportMissingImports(
  implemented: ModuleTable,
  requested: readonly ImportMap[],
  coverage: Coverage,
): number {
  let missing = 0;
  for (const map of requested) {
    for (const [path, wanted] of Object.entries(map)) {
      const module = implemented[path];
      for (const name of wanted) {
        if (module && Object.hasOwn(module, name)) continue;
        coverage.miss('module', `${path}#${name}`);
        missing++;
      }
    }
  }
  return missing;
}

/** Change one export; stand-ins already loaded see the new value (ST's `export let` bindings). */
export function setExport(table: ModuleTable, path: string, name: string, value: unknown): void {
  const module = (table[path] ??= {});
  if (module[name] === value) return;
  module[name] = value;
  if (module.__live) for (const update of module.__live) update(name, value);
}
