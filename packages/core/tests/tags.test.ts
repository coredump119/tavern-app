import { describe, expect, it } from 'vitest';
import {
  TAG_IMPORT_SETTING,
  addTagToMap,
  equalsIgnoreCaseAndAccents,
  getTag,
  importTags,
  newTag,
  planTagImport,
  removeTagFromMap,
  renameTagKey,
  tagStoreOf,
  tagsOfEntity,
  type TagStore,
} from '../src/index.js';

const deps = () => {
  let n = 0;
  return { uuid: () => `id-${++n}`, now: () => 1700000000000 };
};

describe('tags (ST tags.js)', () => {
  it('newTag shape and sort_order = max + 1', () => {
    const store: TagStore = { tags: [{ id: 'a', name: 'A', sort_order: 5 }], tag_map: {} };
    expect(newTag(store, 'B', deps())).toEqual({
      id: 'id-1',
      name: 'B',
      folder_type: 'NONE',
      filter_state: 'UNDEFINED',
      sort_order: 6,
      is_hidden_on_character_card: false,
      color: '',
      color2: '',
      create_date: 1700000000000,
    });
    expect(newTag({ tags: [], tag_map: {} }, 'X', deps()).sort_order).toBe(1);
  });

  it('getTag ignores case and accents; createNew pushes', () => {
    const store: TagStore = { tags: [{ id: 'a', name: 'Café' }], tag_map: {} };
    expect(equalsIgnoreCaseAndAccents('CAFE', 'café')).toBe(true);
    expect(getTag(store, 'cafe')?.id).toBe('a');
    expect(getTag(store, 'tea')).toBeUndefined();
    const t = getTag(store, 'tea', { createNew: true }, deps());
    expect(t?.name).toBe('tea');
    expect(store.tags).toHaveLength(2);
  });

  it('tag_map add / remove / dedupe', () => {
    const store: TagStore = { tags: [], tag_map: {} };
    expect(addTagToMap(store, 't1', 'a.png')).toBe(true);
    expect(addTagToMap(store, 't1', 'a.png')).toBe(false);
    expect(addTagToMap(store, 't2', 'a.png')).toBe(true);
    expect(store.tag_map['a.png']).toEqual(['t1', 't2']);
    expect(removeTagFromMap(store, 'nope', 'a.png')).toBe(false);
    expect(removeTagFromMap(store, 't1', 'a.png')).toBe(true);
    expect(store.tag_map['a.png']).toEqual(['t2']);
    expect(removeTagFromMap(store, 't1', 'b.png')).toBe(false);
    expect(store.tag_map['b.png']).toEqual([]);
    renameTagKey(store, 'a.png', 'c.png');
    expect(store.tag_map['c.png']).toEqual(['t2']);
    expect('a.png' in store.tag_map).toBe(false);
  });

  it('tagStoreOf creates missing keys on the settings object', () => {
    const settings: Record<string, unknown> = {};
    const store = tagStoreOf(settings);
    store.tags.push({ id: 'x', name: 'X' });
    expect(settings['tags']).toEqual([{ id: 'x', name: 'X' }]);
    expect(settings['tag_map']).toEqual({});
  });

  it('planTagImport: trims, excludes ROOT/TAVERN, skips already assigned, caps at 50', () => {
    const store: TagStore = {
      tags: [
        { id: 'a', name: 'Anime' },
        { id: 'f', name: 'Fantasy' },
      ],
      tag_map: { 'c.png': ['a'] },
    };
    const many = Array.from({ length: 60 }, (_, i) => `t${i}`);
    const plan = planTagImport(
      store,
      { avatar: 'c.png', tags: [' anime ', 'ROOT', 'fantasy', 'New One', '', ...many] },
      TAG_IMPORT_SETTING.ALL,
      deps(),
    );
    expect(plan.existing.map((t) => t.id)).toEqual(['f']);
    expect(plan.fresh[0]?.name).toBe('New One');
    expect(plan.fresh[0]?.sort_order).toBe(1);
    expect(plan.fresh[1]?.sort_order).toBe(2);
    expect(plan.names).toHaveLength(50);
    expect(plan.names?.[0]).toBe('Fantasy');
    expect(store.tags).toHaveLength(2); // nothing pushed yet
  });

  it('planTagImport honours the setting; ASK is null only when there is something to ask', () => {
    const store: TagStore = { tags: [{ id: 'f', name: 'Fantasy' }], tag_map: {} };
    const ch = { avatar: 'c.png', tags: ['fantasy', 'scifi'] };
    expect(planTagImport(store, ch, TAG_IMPORT_SETTING.ONLY_EXISTING).names).toEqual(['Fantasy']);
    expect(planTagImport(store, ch, TAG_IMPORT_SETTING.NONE).names).toEqual([]);
    expect(planTagImport(store, ch, TAG_IMPORT_SETTING.ASK).names).toBeNull();
    expect(planTagImport(store, ch, undefined).names).toBeNull();
    expect(planTagImport(store, ch, 99).names).toBeNull();
    expect(
      planTagImport(store, { avatar: 'c.png', tags: [] }, TAG_IMPORT_SETTING.ASK).names,
    ).toEqual([]);
  });

  it('importTags creates missing tags and assigns them', () => {
    const store: TagStore = { tags: [{ id: 'f', name: 'Fantasy' }], tag_map: {} };
    const added = importTags(store, 'c.png', ['fantasy', 'SciFi'], deps());
    expect(added.map((t) => t.name)).toEqual(['Fantasy', 'SciFi']);
    expect(store.tags.map((t) => t.name)).toEqual(['Fantasy', 'SciFi']);
    expect(store.tag_map['c.png']).toEqual(['f', 'id-1']);
    expect(tagsOfEntity(store, 'c.png').map((t) => t.name)).toEqual(['Fantasy', 'SciFi']);
    expect(importTags(store, 'c.png', [])).toEqual([]);
  });
});
