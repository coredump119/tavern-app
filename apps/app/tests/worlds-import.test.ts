import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockFs, ipcModule } from './ipc-mock';

const fs = createMockFs();
vi.mock('../src/lib/ipc', () => ipcModule(fs));

const { embeddedWorldName, importEmbeddedWorld, importWorldBook, worldBookFromImport } =
  await import('../src/lib/worlds');
const ROOT = '/data';
const stored = (name: string) =>
  JSON.parse(fs.files.get(`${ROOT}/worlds/${name}.json`) ?? 'null') as {
    entries: Record<string, { key: string[]; content: string; comment: string }>;
  } | null;

const characterBook = {
  name: 'Forest Notes',
  entries: [
    {
      keys: ['glade'],
      content: 'A quiet glade.',
      extensions: {},
      enabled: true,
      insertion_order: 5,
    },
    {
      keys: ['river'],
      content: 'A cold river.',
      extensions: {},
      enabled: false,
      insertion_order: 7,
    },
  ],
};

describe('world book import (DEV_NOTES §9.35)', () => {
  beforeEach(() => fs.files.clear());

  it('names the book after the file and replaces a book of that name', async () => {
    fs.files.set(`${ROOT}/worlds/Atlas.json`, '{"entries":{"0":{"uid":0}}}');
    const name = await importWorldBook(ROOT, 'Atlas.json', {
      entries: { '3': { uid: 3, key: ['a'], content: 'x', comment: '' } },
      extra: 1,
    });
    expect(name).toBe('Atlas');
    expect(Object.keys(stored('Atlas')!.entries)).toEqual(['3']);
    expect(fs.files.get(`${ROOT}/worlds/Atlas.json`)).toContain('\n    "entries"');
  });

  it('drops the last extension whichever it is, like ST', async () => {
    const raw = { entries: {} };
    expect(await importWorldBook(ROOT, 'Atlas.png', raw)).toBe('Atlas');
    expect(await importWorldBook(ROOT, 'Atlas.v2.JSON', raw)).toBe('Atlas.v2');
    expect(await importWorldBook(ROOT, 'Atlas', raw)).toBe('Atlas');
  });

  it('reads an entries array as a character_book', () => {
    const book = worldBookFromImport(characterBook) as unknown as {
      entries: Record<string, { key: string[]; disable: boolean; order: number }>;
    };
    expect(Object.values(book.entries).map((e) => e.key)).toEqual([['glade'], ['river']]);
    expect(Object.values(book.entries).map((e) => e.disable)).toEqual([false, true]);
    expect(Object.values(book.entries).map((e) => e.order)).toEqual([5, 7]);
  });

  it('converts NovelAI / Agnai / RisuAI lorebooks', () => {
    const keys = (raw: unknown) =>
      Object.values(worldBookFromImport(raw).entries).map((e) => e['key']);
    expect(
      keys({ lorebookVersion: 5, entries: [{ keys: ['glade'], text: 'x', enabled: true }] }),
    ).toEqual([['glade']]);
    expect(
      keys({ kind: 'memory', entries: [{ name: 'n', entry: 'x', keywords: ['river'] }] }),
    ).toEqual([['river']]);
    expect(keys({ type: 'risu', data: [{ key: 'a, b', content: 'x' }] })).toEqual([['a', 'b']]);
  });

  it('rejects non-books with a reason', () => {
    expect(() => worldBookFromImport({ name: 'x' })).toThrow('entries');
    expect(() => worldBookFromImport([1])).toThrow();
  });
});

describe('embedded character book (ST importEmbeddedWorldInfo)', () => {
  beforeEach(() => fs.files.clear());

  it('uses the book name, else "<character>\'s Lorebook"; null without a book', () => {
    expect(embeddedWorldName({ data: { name: 'Mira', character_book: characterBook } })).toBe(
      'Forest Notes',
    );
    expect(embeddedWorldName({ data: { name: 'Mira', character_book: { entries: [] } } })).toBe(
      "Mira's Lorebook",
    );
    expect(embeddedWorldName({ data: { name: 'Mira' } })).toBeNull();
    expect(embeddedWorldName({ name: 'Mira' })).toBeNull();
  });

  it('writes the converted book under that name', async () => {
    const name = await importEmbeddedWorld(ROOT, {
      data: { name: 'Mira', character_book: characterBook },
    });
    expect(name).toBe('Forest Notes');
    expect(Object.values(stored(name)!.entries).map((e) => e.content)).toEqual([
      'A quiet glade.',
      'A cold river.',
    ]);
    await expect(importEmbeddedWorld(ROOT, { data: { name: 'Mira' } })).rejects.toThrow();
  });
});
