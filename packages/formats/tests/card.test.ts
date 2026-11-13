import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CharacterCardV3Schema,
  cardName,
  detectSpec,
  parseCard,
  parseCardJson,
  readCardJson,
  readChunks,
  readPngText,
  toV2,
  toV3,
  writeCardJson,
} from '../src/index.js';

const png = new Uint8Array(
  readFileSync(new URL('./fixtures/default_Seraphina.png', import.meta.url)),
);

describe('png-text', () => {
  it('finds chara and ccv3 chunks in an ST card', () => {
    const texts = readPngText(png);
    expect([...texts.keys()].sort()).toEqual(['ccv3', 'chara']);
  });
  it('prefers ccv3 and decodes UTF-8 JSON', () => {
    const json = JSON.parse(readCardJson(png)) as { spec: string; data: { name: string } };
    expect(json.spec).toBe('chara_card_v3');
    expect(json.data.name).toBe('Seraphina');
  });
  it('writes a card back and preserves every non-text chunk byte-for-byte', () => {
    const original = JSON.parse(readCardJson(png)) as Record<string, unknown>;
    original['spec'] = 'chara_card_v2';
    original['spec_version'] = '2.0';
    const out = writeCardJson(png, JSON.stringify(original));
    const before = readChunks(png).filter((c) => c.type !== 'tEXt');
    const after = readChunks(out).filter((c) => c.type !== 'tEXt');
    expect(after.map((c) => c.type)).toEqual(before.map((c) => c.type));
    after.forEach((c, i) =>
      expect(Buffer.from(c.data).equals(Buffer.from(before[i]!.data))).toBe(true),
    );
    const texts = readPngText(out);
    expect([...texts.keys()].sort()).toEqual(['ccv3', 'chara']);
    const v3 = JSON.parse(readCardJson(out)) as { spec: string; spec_version: string };
    expect(v3.spec).toBe('chara_card_v3');
    expect(v3.spec_version).toBe('3.0');
    // re-reading the fixture through our writer yields the same JSON ST shipped
    expect(JSON.parse(readCardJson(out))).toEqual(JSON.parse(readCardJson(png)));
  });
  it('rejects non-PNG input', () => {
    expect(() => readPngText(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
  });
});

describe('card schema', () => {
  const raw = JSON.parse(readCardJson(png)) as Record<string, unknown>;

  it('parses the ST V3 card losslessly (deep-equal round trip)', () => {
    const card = parseCard(raw);
    expect(detectSpec(raw)).toBe('chara_card_v3');
    expect(JSON.parse(JSON.stringify(card))).toEqual(raw);
    expect(cardName(card)).toBe('Seraphina');
  });
  it('keeps ST quirks: string talkativeness, legacy top-level fields, book entry extensions', () => {
    const card = CharacterCardV3Schema.parse(raw);
    expect(card.data.extensions?.talkativeness).toBe('0.5');
    expect(card.talkativeness).toBe('0.5');
    expect(typeof card.create_date).toBe('string');
    expect(card.data.character_book?.entries[0]?.extensions).toHaveProperty('selectiveLogic');
  });
  it('parses the chara (V2) chunk too', () => {
    const texts = readPngText(png);
    const v2 = parseCardJson(Buffer.from(texts.get('chara')!, 'base64').toString('utf8'));
    expect(detectSpec(v2)).toBe('chara_card_v2');
    expect(toV3(v2).spec).toBe('chara_card_v3');
    expect(toV3(v2).data.group_only_greetings).toEqual([]);
  });
  it('upgrades a V1 card like ST convertToV2 does', () => {
    const v1 = parseCard({
      name: 'Old',
      description: 'd',
      personality: 'p',
      scenario: 's',
      first_mes: 'hi',
      mes_example: '',
      tags: 'a, b,,c',
      fav: 'true',
      custom_key: 123,
    });
    const v2 = toV2(v1);
    expect(v2.spec).toBe('chara_card_v2');
    expect(v2.data.name).toBe('Old');
    expect(v2.data.tags).toEqual(['a', 'b', 'c']);
    expect(v2.data.extensions?.fav).toBe(true);
    expect(v2.data.extensions?.talkativeness).toBe(0.5);
    expect(v2.data.extensions?.depth_prompt).toEqual({ prompt: '', depth: 4, role: 'system' });
    expect((v2 as Record<string, unknown>)['custom_key']).toBe(123);
    expect(toV3(toV3(v1))).toEqual(toV3(v1));
  });
  it('rejects garbage with field paths', () => {
    expect(() => parseCard({})).toThrow(/not a character card/);
    const r = CharacterCardV3Schema.safeParse({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { name: 1 },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['data', 'name']);
  });
});
