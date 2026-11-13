/**
 * Plain-object mirrors of app state that extensions mutate in place (`chatMetadata`,
 * `extensionSettings`; DEV_NOTES §9.34). The app's store and the extension both change the same
 * record, so each sync is a three-way merge per top-level key against what was last agreed.
 */
type Obj = Record<string, unknown>;

const json = (value: unknown): string | undefined => JSON.stringify(value);

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export class Mirror {
  /** the object extensions hold; never replaced */
  readonly value: Obj = {};
  /** JSON of each key when the two sides last agreed */
  private base = new Map<string, string>();

  /** Start over from `source` (another chat was opened): the extension's unsaved edits are dropped. */
  reset(source: Obj): void {
    for (const key of Object.keys(this.value)) delete this.value[key];
    this.base = new Map();
    for (const [key, value] of Object.entries(source)) {
      const text = json(value);
      if (text === undefined) continue;
      this.value[key] = JSON.parse(text) as unknown;
      this.base.set(key, text);
    }
  }

  /**
   * Take the app's current record. A key the app changed since the last sync overwrites the
   * mirror; a key only the extension changed is left for it to save.
   */
  pull(source: Obj): void {
    const seen = new Set<string>();
    for (const [key, value] of Object.entries(source)) {
      const text = json(value);
      if (text === undefined) continue;
      seen.add(key);
      if (this.base.get(key) === text) continue;
      this.value[key] = JSON.parse(text) as unknown;
      this.base.set(key, text);
    }
    for (const key of [...this.base.keys()]) {
      if (seen.has(key)) continue;
      // the app removed it; an extension's own edit to that key survives as a new key
      if (json(this.value[key]) === this.base.get(key)) delete this.value[key];
      this.base.delete(key);
    }
  }

  /**
   * What the extension changed since the last sync: values to set and keys it deleted. Null when
   * nothing changed. The result is a copy, safe to hand to the store; the changes count as agreed.
   */
  push(): { set: Obj; removed: string[] } | null {
    const set: Obj = {};
    const removed: string[] = [];
    for (const [key, value] of Object.entries(this.value)) {
      const text = json(value);
      if (text === undefined || this.base.get(key) === text) continue;
      set[key] = JSON.parse(text) as unknown;
      this.base.set(key, text);
    }
    for (const key of [...this.base.keys()]) {
      if (Object.hasOwn(this.value, key)) continue;
      removed.push(key);
      this.base.delete(key);
    }
    return Object.keys(set).length > 0 || removed.length > 0 ? { set, removed } : null;
  }
}

/** A deep copy with the named keys blanked wherever they appear (connection secrets, §9.4). */
export function redactedCopy<T>(value: T, secretKeys: ReadonlySet<string>): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== 'object' || node === null) return node;
    const out: Obj = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = secretKeys.has(key) ? blank(child) : walk(child);
    }
    return out;
  };
  return walk(clone(value)) as T;
}

function blank(value: unknown): unknown {
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) return [];
  if (typeof value === 'object' && value !== null) return {};
  return value;
}
