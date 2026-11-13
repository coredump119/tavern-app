/**
 * What the data API modules share (DEV_NOTES §9.5 第 3 轮 → 数据接口): small readers for the
 * catalog, and the cache behind the synchronous reads of things the catalog does not carry.
 */
import type { CatalogPart } from '../../protocol.js';
import type { Hub } from '../hub.js';
import { isRecord } from '../util.js';

export type Dict = Record<string, unknown>;

export const record = (value: unknown): Dict => (isRecord(value) ? value : {});
export const records = (value: unknown): Dict[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** An interface that exists upstream and is not built here: calling it says so */
export const unsupported = (name: string) => (): never => {
  throw new Error(`${name} 尚未支持`);
};

/** {@link unsupported} for an interface that returns a promise: it rejects instead of throwing */
export const unsupportedAsync = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`${name} 尚未支持`));

/** An upstream member that does nothing here; the first call says so in the console */
export function inert<T>(name: string, result: T): () => T {
  let warned = false;
  return () => {
    if (!warned) console.warn(`[TavernHelper] ${name} 在这里是空操作`);
    warned = true;
    return result;
  };
}

/** Change some keys of one catalog part now, ahead of the snapshot the app sends after a write */
export function patchPart(hub: Hub, part: CatalogPart, patch: Dict): void {
  hub.catalog[part] = { ...hub.part(part), ...patch };
}

/**
 * Things read from the app by name (card files, preset files). Upstream reads them synchronously
 * because it shares a page with ST; here the asynchronous interfaces always fetch, and the
 * synchronous ones answer from what was fetched before.
 */
export class Fetched<T> {
  private readonly values = new Map<string, T>();
  private readonly loading = new Map<string, Promise<T>>();

  constructor(
    /** how the thing is called in the error of a synchronous read that came too early */
    private readonly what: string,
    private readonly load: (key: string) => Promise<T>,
  ) {}

  /** Always asks the app; concurrent calls for one key share the request */
  get(key: string): Promise<T> {
    const running = this.loading.get(key);
    if (running) return running;
    const request = this.load(key).then(
      (value) => {
        this.loading.delete(key);
        this.values.set(key, value);
        return value;
      },
      (error: unknown) => {
        this.loading.delete(key);
        throw error;
      },
    );
    this.loading.set(key, request);
    return request;
  }

  /** The copy fetched earlier. Without one it starts the fetch and throws, so a retry succeeds. */
  peek(key: string): T {
    const value = this.values.get(key);
    if (value !== undefined) return value;
    this.get(key).catch(() => undefined);
    throw new Error(
      `${this.what}「${key}」的内容还没有取到：同步接口只能读已经取过的内容，稍后再调用一次，或改用异步接口`,
    );
  }

  set(key: string, value: T): void {
    this.values.set(key, value);
  }

  drop(key: string): void {
    this.values.delete(key);
  }
}

/** The caches the modules share: one card or preset is fetched once whoever asks */
export interface Stores {
  /** card JSON by avatar file name */
  cards: Fetched<Dict>;
  /** Chat Completion preset by name */
  presets: Fetched<Dict>;
}

export function createStores(hub: Hub): Stores {
  return {
    cards: new Fetched('角色卡', (avatar) => hub.call<Dict>('character.read', [avatar])),
    presets: new Fetched('预设', (name) => hub.call<Dict>('preset.read', [name])),
  };
}

export interface CharacterRow {
  avatar: string;
  name: string;
}

export const characterRows = (hub: Hub): CharacterRow[] =>
  records(hub.catalog.characters).map((row) => ({
    avatar: text(row['avatar']),
    name: text(row['name']),
  }));

/** The open character's avatar file name; null in a group chat or with nothing open */
export function currentAvatar(hub: Hub): string | null {
  return text(record(hub.part('session')['character'])['avatar']) || null;
}

/**
 * Which card a script means: `'current'` (or nothing) is the open one; otherwise an avatar file
 * name first, then a character name. Null when there is none.
 */
export function findAvatar(hub: Hub, nameOrId: unknown = 'current'): string | null {
  if (nameOrId === 'current' || nameOrId === undefined || nameOrId === null)
    return currentAvatar(hub);
  const wanted = String(nameOrId);
  const rows = characterRows(hub);
  return (
    rows.find((row) => row.avatar === wanted)?.avatar ??
    rows.find((row) => row.name === wanted)?.avatar ??
    null
  );
}

/** {@link findAvatar}, or upstream's error for a card that does not exist */
export function requireAvatar(hub: Hub, nameOrId: unknown = 'current'): string {
  const avatar = findAvatar(hub, nameOrId);
  if (avatar) return avatar;
  throw new Error(
    nameOrId === 'current' || nameOrId === undefined
      ? '当前没有打开角色卡'
      : `角色卡 '${String(nameOrId)}' 不存在`,
  );
}

/** The V2 `data` of a card, or the card itself for a V1 one */
export const cardData = (card: unknown): Dict => {
  const data = record(card)['data'];
  return isRecord(data) ? data : record(card);
};
