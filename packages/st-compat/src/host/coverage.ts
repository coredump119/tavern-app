/**
 * What extensions asked for that the host does not have (DEV_NOTES §9.34): the list the
 * extensions page shows as 「缺的接口」 and the dev log prints as `[ext] 缺的接口 …`.
 */
export type CoverageKind = 'context' | 'module' | 'api' | 'global';

export interface CoverageEntry {
  kind: CoverageKind;
  /** `generateRaw`, `/script.js#saveChat`, `POST /api/images/upload` */
  name: string;
  count: number;
}

export class Coverage {
  private readonly entries = new Map<string, CoverageEntry>();
  /** called when a name is seen for the first time (not on every repeat) */
  onNew: ((entry: CoverageEntry) => void) | null = null;

  miss(kind: CoverageKind, name: string): void {
    const key = `${kind}:${name}`;
    const entry = this.entries.get(key);
    if (entry) {
      entry.count++;
      return;
    }
    const created = { kind, name, count: 1 };
    this.entries.set(key, created);
    this.onNew?.(created);
  }

  list(): CoverageEntry[] {
    return [...this.entries.values()].sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    );
  }
}

/** The error every unimplemented entry point throws: names the member so a bug report is useful. */
export function notImplemented(name: string): Error {
  return new Error(`${name} 尚未实现（Tavern Mobile 扩展兼容层）`);
}
