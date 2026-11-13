import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  characterFormFromCard,
  deepMerge,
  formatCharacterData,
  humanizedDateTime,
  readCardJson,
} from '../src/index.js';

const png = new Uint8Array(
  readFileSync(new URL('./fixtures/default_Seraphina.png', import.meta.url)),
);
const seraphina = JSON.parse(readCardJson(png)) as Record<string, unknown>;
const now = () => '2026-11-2@9h5m7s';

describe('formatCharacterData (ST charaFormatData + /edit)', () => {
  const base = characterFormFromCard(seraphina);

  it('keeps every key ST does not touch and forces spec v2', () => {
    const out = formatCharacterData(
      { ...base, ch_name: 'Sera' },
      { existing: seraphina, chat: 'Sera - old', create_date: '2024-01-01', now },
    );
    expect(out['spec']).toBe('chara_card_v2');
    expect(out['spec_version']).toBe('2.0');
    expect(out['name']).toBe('Sera');
    const data = out['data'] as Record<string, unknown>;
    expect(data['name']).toBe('Sera');
    // V3-only keys and foreign extension keys survive (lodash _.set semantics)
    const srcData = seraphina['data'] as Record<string, unknown>;
    for (const k of ['group_only_greetings', 'creation_date', 'modification_date', 'source'])
      if (k in srcData) expect(data[k]).toEqual(srcData[k]);
    const srcExt = srcData['extensions'] as Record<string, unknown>;
    const ext = data['extensions'] as Record<string, unknown>;
    for (const k of Object.keys(srcExt))
      if (!['talkativeness', 'fav', 'world', 'depth_prompt'].includes(k))
        expect(ext[k]).toEqual(srcExt[k]);
    expect(out['chat']).toBe('Sera - old');
    expect(out['create_date']).toBe('2024-01-01');
    expect(out['avatar']).toBe('none');
    expect(out['json_data']).toBeUndefined();
    // the fixture's own text fields come back unchanged
    expect(data['description']).toBe(srcData['description']);
    expect(data['first_mes']).toBe(srcData['first_mes']);
    expect(data['alternate_greetings']).toEqual(srcData['alternate_greetings'] ?? []);
  });

  it('applies ST coercions: string talkativeness, fav == "true", comma tags, depth Number()', () => {
    const out = formatCharacterData(
      {
        ch_name: 'A',
        talkativeness: '0.7',
        fav: 'true',
        tags: ' x, y ,,z ',
        depth_prompt_depth: '',
        alternate_greetings: 'only one',
      },
      { now },
    );
    const data = out['data'] as Record<string, unknown>;
    const ext = data['extensions'] as Record<string, unknown>;
    expect(out['talkativeness']).toBe('0.7');
    expect(ext['talkativeness']).toBe('0.7');
    expect(out['fav']).toBe(true);
    expect(ext['fav']).toBe(true);
    expect(out['tags']).toEqual(['x', 'y', 'z']);
    expect(data['tags']).toEqual(['x', 'y', 'z']);
    expect((ext['depth_prompt'] as Record<string, unknown>)['depth']).toBe(0);
    expect(data['alternate_greetings']).toEqual(['only one']);
    expect(data['description']).toBe('');
    expect(ext['world']).toBe('');
    // no hidden fields ⇒ no chat / create_date keys at all
    expect('chat' in out).toBe(false);
    expect('create_date' in out).toBe(false);
  });

  it('uses ST defaults: talkativeness 0.5 for empty / 0, depth 4 for NaN, role system, fav false', () => {
    const a = formatCharacterData({ ch_name: 'A', talkativeness: '', fav: true }, { now });
    expect(a['talkativeness']).toBe(0.5);
    expect(a['fav']).toBe(true);
    const b = formatCharacterData({ ch_name: 'B', talkativeness: 0, fav: false }, { now });
    expect(b['talkativeness']).toBe(0.5);
    expect(b['fav']).toBe(false);
    const dp = ((b['data'] as Record<string, unknown>)['extensions'] as Record<string, unknown>)[
      'depth_prompt'
    ] as Record<string, unknown>;
    expect(dp).toEqual({ prompt: '', depth: 4, role: 'system' });
    // "0" is a non-empty string: kept as-is (ST quirk)
    const c = formatCharacterData({ ch_name: 'C', talkativeness: '0' }, { now });
    expect(c['talkativeness']).toBe('0');
    expect(c['chat']).toBeUndefined();
  });

  it('embeds the character book only when a world is set and supplied', () => {
    const book = { name: 'W', entries: [] };
    const none = formatCharacterData({ ch_name: 'A', world: '' }, { characterBook: book, now });
    expect((none['data'] as Record<string, unknown>)['character_book']).toBeUndefined();
    const some = formatCharacterData({ ch_name: 'A', world: 'W' }, { characterBook: book, now });
    expect((some['data'] as Record<string, unknown>)['character_book']).toEqual(book);
    const ext = (
      (some['data'] as Record<string, unknown>)['extensions'] as Record<string, unknown>
    )['world'];
    expect(ext).toBe('W');
  });

  it('deep-merges the extensions field like ST deepMerge', () => {
    const out = formatCharacterData(
      { ch_name: 'A', extensions: { foo: { a: 1 }, depth_prompt: { depth: 9 } } },
      { existing: { data: { extensions: { foo: { b: 2 }, keep: true } } }, now },
    );
    const ext = (out['data'] as Record<string, unknown>)['extensions'] as Record<string, unknown>;
    expect(ext['foo']).toEqual({ b: 2, a: 1 });
    expect(ext['keep']).toBe(true);
    expect(ext['depth_prompt']).toEqual({ prompt: '', depth: 9, role: 'system' });
    expect(deepMerge({ a: { x: 1 } }, { a: { y: 2 }, b: [1] })).toEqual({
      a: { x: 1, y: 2 },
      b: [1],
    });
    expect(deepMerge(undefined, { a: 1 })).toEqual({});
  });

  it('form ⇄ card round trip is stable', () => {
    const out = formatCharacterData(base, { existing: seraphina, now });
    expect(characterFormFromCard(out)).toEqual(base);
  });

  it('humanizedDateTime matches ST', () => {
    expect(humanizedDateTime(new Date(2026, 10, 2, 9, 5, 7))).toBe('2026-11-2@9h5m7s');
  });
});
