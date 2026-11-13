/**
 * ST tags (public/scripts/tags.js) — the `tags` / `tag_map` objects stored in settings.json,
 * ported 1:1 (DEV_NOTES §9.17). Pure functions over a `TagStore`; the host persists it.
 */

export const TAG_IMPORT_SETTING = { ASK: 1, NONE: 2, ALL: 3, ONLY_EXISTING: 4 } as const;
export type TagImportSetting = (typeof TAG_IMPORT_SETTING)[keyof typeof TAG_IMPORT_SETTING];

export const TAG_FOLDER_DEFAULT_TYPE = 'NONE';
/** filters.js FILTER_STATES.UNDEFINED.key */
export const DEFAULT_FILTER_STATE = 'UNDEFINED';
export const IMPORT_EXCLUDED_TAGS = ['ROOT', 'TAVERN'];
export const ANTI_TROLL_MAX_TAGS = 50;

export interface Tag {
  id: string;
  name: string;
  folder_type?: string;
  filter_state?: string;
  sort_order?: number;
  is_hidden_on_character_card?: boolean;
  color?: string;
  color2?: string;
  create_date?: number;
  [key: string]: unknown;
}

/** Live references into settings.json (`tags`, `tag_map`); mutated in place like ST does. */
export interface TagStore {
  tags: Tag[];
  tag_map: Record<string, string[]>;
}

export interface TagDeps {
  uuid?: () => string;
  now?: () => number;
}

export function uuidv4(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** utils.js compareIgnoreCaseAndAccents with `===` */
export function equalsIgnoreCaseAndAccents(a: string, b: string): boolean {
  if (!a || !b) return a === b;
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return norm(a) === norm(b);
}

/** Read `tags` / `tag_map` out of a settings object, creating them when missing. */
export function tagStoreOf(settings: Record<string, unknown>): TagStore {
  if (!Array.isArray(settings['tags'])) settings['tags'] = [];
  const tm = settings['tag_map'];
  if (!tm || typeof tm !== 'object' || Array.isArray(tm)) settings['tag_map'] = {};
  return {
    tags: settings['tags'] as Tag[],
    tag_map: settings['tag_map'] as Record<string, string[]>,
  };
}

export function newTag(store: TagStore, tagName: string, deps: TagDeps = {}): Tag {
  return {
    id: (deps.uuid ?? uuidv4)(),
    name: tagName,
    folder_type: TAG_FOLDER_DEFAULT_TYPE,
    filter_state: DEFAULT_FILTER_STATE,
    sort_order: Math.max(0, ...store.tags.map((t) => t.sort_order ?? 0)) + 1,
    is_hidden_on_character_card: false,
    color: '',
    color2: '',
    create_date: (deps.now ?? Date.now)(),
  };
}

/** `getTag(name, {createNew})`: accent- and case-insensitive lookup; optionally creates and pushes. */
export function getTag(
  store: TagStore,
  tagName: string,
  { createNew = false }: { createNew?: boolean } = {},
  deps: TagDeps = {},
): Tag | undefined {
  let tag = store.tags.find((t) => equalsIgnoreCaseAndAccents(t.name, tagName));
  if (!tag && createNew) {
    tag = newTag(store, tagName, deps);
    store.tags.push(tag);
  }
  return tag;
}

export function addTagToMap(store: TagStore, tagId: string, key: string): boolean {
  if (!key) return false;
  const list = store.tag_map[key];
  if (!Array.isArray(list)) {
    store.tag_map[key] = [tagId];
    return true;
  }
  if (list.includes(tagId)) return false;
  list.push(tagId);
  store.tag_map[key] = list.filter((v, i, a) => a.indexOf(v) === i);
  return true;
}

export function removeTagFromMap(store: TagStore, tagId: string, key: string): boolean {
  if (!key) return false;
  const list = store.tag_map[key];
  if (!Array.isArray(list)) {
    store.tag_map[key] = [];
    return false;
  }
  const i = list.indexOf(tagId);
  // ST splices at -1 here (dropping the last tag) when the id is missing; that is a bug, not a contract.
  if (i === -1) return false;
  list.splice(i, 1);
  return true;
}

export function addTagsToEntity(
  store: TagStore,
  tags: Tag | Tag[],
  keys: string | string[],
): boolean {
  const ts = Array.isArray(tags) ? tags : [tags];
  const ks = Array.isArray(keys) ? keys : [keys];
  let result = false;
  for (const k of ks) for (const t of ts) result = addTagToMap(store, t.id, k) || result;
  return result;
}

/** Tags assigned to an entity (character avatar / group id), in tag_map order; dangling ids dropped. */
export function tagsOfEntity(store: TagStore, key: string): Tag[] {
  const ids = store.tag_map[key] ?? [];
  return ids.map((id) => store.tags.find((t) => t.id === id)).filter((t): t is Tag => !!t);
}

/** Drop an entity's tag_map row (character deleted) or move it (character renamed). */
export function renameTagKey(store: TagStore, oldKey: string, newKey: string): void {
  if (oldKey === newKey || !(oldKey in store.tag_map)) return;
  store.tag_map[newKey] = store.tag_map[oldKey]!;
  delete store.tag_map[oldKey];
}
export function deleteTagKey(store: TagStore, key: string): void {
  delete store.tag_map[key];
}

export interface TagImportPlan {
  /** card tags that already exist as tags (and are not yet assigned) */
  existing: Tag[];
  /** card tags that would be created (not pushed to the store yet) */
  fresh: Tag[];
  /** names to import, or null when the setting is ASK and there is something to ask about */
  names: string[] | null;
}

/**
 * `handleTagImport`: which of a card's `data.tags` to attach to `avatar`, per
 * `power_user.tag_import_setting`. Folder tags (bogus folders) are not implemented ⇒ none.
 */
export function planTagImport(
  store: TagStore,
  character: { avatar: string; tags: readonly string[] },
  setting: number | undefined,
  deps: TagDeps = {},
): TagImportPlan {
  const alreadyAssigned = store.tag_map[character.avatar] ?? [];
  const importTags = character.tags
    .map((t) => t.trim())
    .filter((t) => t)
    .filter((t) => !IMPORT_EXCLUDED_TAGS.includes(t))
    .filter((t) => {
      const existingTag = getTag(store, t);
      return !existingTag || !alreadyAssigned.includes(existingTag.id);
    })
    .slice(0, ANTI_TROLL_MAX_TAGS);
  const existing = importTags.map((t) => getTag(store, t)).filter((t): t is Tag => !!t);
  // ST: getExistingTags per name, then newTag for the rest (sort_order from the live store)
  const fresh: Tag[] = [];
  for (const t of importTags) {
    if (existing.some((e) => e.name.toLowerCase() === t.toLowerCase())) continue;
    fresh.push(newTag({ tags: [...store.tags, ...fresh], tag_map: store.tag_map }, t, deps));
  }
  const resolved =
    Object.values(TAG_IMPORT_SETTING).find((s) => s === setting) ?? TAG_IMPORT_SETTING.ASK;
  let names: string[] | null;
  switch (resolved) {
    case TAG_IMPORT_SETTING.ALL:
      names = [...existing, ...fresh].map((t) => t.name);
      break;
    case TAG_IMPORT_SETTING.ONLY_EXISTING:
      names = existing.map((t) => t.name);
      break;
    case TAG_IMPORT_SETTING.NONE:
      names = [];
      break;
    default:
      names = !existing.length && !fresh.length ? [] : null;
  }
  return { existing, fresh, names };
}

/** `importTags` once the names are decided: creates missing tags and assigns them. Returns the tags. */
export function importTags(
  store: TagStore,
  avatar: string,
  names: readonly string[],
  deps: TagDeps = {},
): Tag[] {
  if (!names.length) return [];
  const tags = names.map((n) => getTag(store, n, { createNew: true }, deps)!);
  addTagsToEntity(store, tags, avatar);
  return tags;
}
