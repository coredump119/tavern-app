import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockFs, ipcModule } from './ipc-mock';
import { fakeEnv, slashRunner, type FakeEnv } from './slash-env';

const fs = createMockFs();
vi.mock('../src/lib/ipc', () => ipcModule(fs));

const { worldCommands } = await import('../src/lib/slash/world');

const book = (name: string) => JSON.parse(fs.files.get(`/data/worlds/${name}.json`)!);
const putBook = (name: string, data: unknown = { entries: {} }) =>
  fs.files.set(`/data/worlds/${name}.json`, JSON.stringify(data));
const selected = (env: FakeEnv) =>
  (env.state.settings['world_info_settings'] as { world_info: { globalSelect: string[] } })
    .world_info.globalSelect;

let env: FakeEnv;
let run: (text: string) => Promise<unknown>;
function setup(initial: Parameters<typeof fakeEnv>[0] = {}) {
  env = fakeEnv(initial);
  run = slashRunner(env, worldCommands);
}

beforeEach(() => {
  fs.files.clear();
  putBook('Eldoria');
  putBook('Harbor Town');
  setup();
});

describe('/world', () => {
  it('activates books by name, whatever the case, and only once', async () => {
    expect(await run('/world eldoria, HARBOR TOWN')).toBe('');
    await run('/world state=on Eldoria');
    expect(selected(env)).toEqual(['Eldoria', 'Harbor Town']);
    expect(await run('/getglobalbooks')).toBe('["Eldoria","Harbor Town"]');
  });

  it('turns books off, toggles them, and clears the list without a name', async () => {
    await run('/world Eldoria,Harbor Town');
    await run('/world state=off Eldoria');
    expect(selected(env)).toEqual(['Harbor Town']);
    await run('/world state=toggle Eldoria,Harbor Town');
    expect(selected(env)).toEqual(['Eldoria']);
    await run('/world');
    expect(selected(env)).toEqual([]);
  });

  it('tells the user about an unknown book unless silent', async () => {
    await run('/world silent=true Nowhere');
    expect(env.state.notes).toEqual([]);
    await run('/world Nowhere');
    expect(env.state.notes).toHaveLength(1);
    expect(selected(env)).toEqual([]);
  });
});

describe('/getchatbook', () => {
  it('creates a book named after the chat and binds it', async () => {
    const name = await run('/getchatbook');
    expect(name).toBe('Chat Book Ada - 2026-01-02_03h04m05s');
    expect(book(name as string)).toEqual({ entries: {} });
    expect(env.state.metadata['world_info']).toBe(name);
    // the bound book is returned from then on
    expect(await run('/getchatbook')).toBe(name);
    expect(fs.files.size).toBe(3);
  });

  it('does not create with create=false, and has nothing without a chat', async () => {
    expect(await run('/getchatbook create=false')).toBe('');
    setup({ chat: null });
    expect(await run('/getchatbook')).toBe('');
    expect(fs.files.size).toBe(2);
  });

  it('takes the wanted name, and refuses one that is in use', async () => {
    expect(await run('/getchatbook name="Side Notes"')).toBe('Side Notes');
    setup();
    await expect(run('/getchatbook name=eldoria')).rejects.toThrow();
  });

  it('replaces a binding to a book that is gone, numbering a taken name', async () => {
    putBook('Chat Book Ada - 2026-01-02_03h04m05s');
    setup({ metadata: { world_info: 'Deleted Book' } });
    expect(await run('/getchatbook')).toBe('Chat Book Ada - 2026-01-02_03h04m05s (1)');
  });
});

describe('/getpersonabook', () => {
  it('returns the bound book, or creates one for the persona on request', async () => {
    setup({ settings: { user_avatar: 'me.png', power_user: { personas: { 'me.png': 'Mira' } } } });
    env.state.userName = 'Mira';
    expect(await run('/getpersonabook')).toBe('');
    expect(await run('/getpersonabook create=true')).toBe('Persona Book Mira');
    const power = env.state.settings['power_user'] as Record<string, unknown>;
    expect(power['persona_description_lorebook']).toBe('Persona Book Mira');
    const descriptors = power['persona_descriptions'] as Record<string, { lorebook: string }>;
    expect(descriptors['me.png']!.lorebook).toBe('Persona Book Mira');
    expect(await run('/getpersonabook')).toBe('Persona Book Mira');
  });
});

describe('/getcharbook', () => {
  const cast = {
    characters: [
      { avatar: 'ada.png', name: 'Ada' },
      { avatar: 'bo.png', name: 'Bo' },
    ],
    current: ['ada.png'],
    worlds: { 'ada.png': 'Eldoria' },
    settings: {
      world_info_settings: {
        world_info: { charLore: [{ name: 'ada', extraBooks: ['Harbor Town', 'Harbor Town'] }] },
      },
    },
  };

  it('reads the primary book, the additional ones, or both', async () => {
    setup(structuredClone(cast));
    expect(await run('/getcharbook')).toBe('Eldoria');
    expect(await run('/getcharbook type=additional')).toBe('["Harbor Town"]');
    expect(await run('/getcharbook type=all')).toBe('["Eldoria","Harbor Town"]');
    expect(await run('/getcharbook Bo')).toBe('');
    expect(await run('/getcharbook type=all bo.png')).toBe('[]');
    expect(await run('/getcharbook Nobody')).toBe('');
  });

  it('creates and binds a missing book: primary by default, additional when asked', async () => {
    setup(structuredClone(cast));
    expect(await run('/getcharbook create=true Bo')).toBe('Character Book Bo');
    expect(env.state.worlds['bo.png']).toBe('Character Book Bo');
    expect(await run('/getcharbook type=additional create=true name=Extras Bo')).toBe('["Extras"]');
    const lore = (
      env.state.settings['world_info_settings'] as { world_info: { charLore: unknown[] } }
    ).world_info.charLore;
    expect(lore).toContainEqual({ name: 'bo', extraBooks: ['Extras'] });
    expect(lore).toHaveLength(2);
  });

  it('needs a name inside a group', async () => {
    setup({ ...structuredClone(cast), group: true });
    await expect(run('/getcharbook')).rejects.toThrow();
    expect(await run('/getcharbook Ada')).toBe('Eldoria');
  });
});

describe('entry commands', () => {
  it('creates an entry with a key and content', async () => {
    expect(await run('/createentry file=Eldoria key=dragon Dragons sleep under the hill.')).toBe(
      '0',
    );
    expect(await run('/createentry file=Eldoria')).toBe('1');
    const entry = book('Eldoria').entries[0];
    expect(entry).toMatchObject({
      uid: 0,
      key: ['dragon'],
      comment: 'dragon',
      addMemo: true,
      content: 'Dragons sleep under the hill.',
    });
    expect(book('Eldoria').entries[1]).toMatchObject({ uid: 1, key: [], content: '' });
  });

  it('reads fields as text, lists as JSON, with macros filled in', async () => {
    putBook('Eldoria', {
      entries: { 3: { uid: 3, key: ['a', '{{user}}'], content: 'Hi {{user}}', order: 50 } },
    });
    expect(await run('/getentryfield file=Eldoria 3')).toBe('Hi User');
    expect(await run('/getentryfield file=Eldoria field=key 3')).toBe('["a","User"]');
    expect(await run('/getentryfield file=Eldoria field=order 3')).toBe('50');
    // a field the entry does not carry reads as its default
    expect(await run('/getentryfield file=Eldoria field=depth 3')).toBe('4');
    expect(await run('/getentryfield file=Eldoria field=nonsense 3')).toBe('');
    expect(await run('/getentryfield file=Eldoria 9')).toBe('');
    expect(await run('/getentryfield file=Nowhere 3')).toBe('');
    expect(env.state.notes).toHaveLength(3);
  });

  it('writes fields in the type the entry keeps them in', async () => {
    await run('/createentry file=Eldoria key=dragon text');
    await run('/setentryfield file=Eldoria uid=0 field=key dragon, wyrm');
    await run('/setentryfield file=Eldoria uid=0 field=keysecondary ["hill","cave, deep"]');
    await run('/setentryfield file=Eldoria uid=0 field=constant on');
    await run('/setentryfield file=Eldoria uid=0 field=order 7');
    await run('/setentryfield file=Eldoria uid=0 field=sticky 2');
    await run('/setentryfield file=Eldoria uid=0 field=triggers normal,bogus,swipe');
    await run('/setentryfield file=Eldoria uid=0 a \\{\\{char\\}\\} b');
    expect(book('Eldoria').entries[0]).toMatchObject({
      key: ['dragon', 'wyrm'],
      keysecondary: ['hill', 'cave, deep'],
      constant: true,
      order: 7,
      sticky: 2,
      triggers: ['normal', 'swipe'],
      content: 'a {{char}} b',
    });
  });

  it('refuses an unknown file, uid or field and leaves the book alone', async () => {
    await run('/createentry file=Eldoria text');
    const before = fs.files.get('/data/worlds/Eldoria.json');
    await run('/setentryfield file=Nowhere uid=0 x');
    await run('/setentryfield file=Eldoria uid=5 x');
    await run('/setentryfield file=Eldoria x');
    await run('/setentryfield file=Eldoria uid=0 field=nonsense x');
    expect(env.state.notes).toHaveLength(4);
    expect(fs.files.get('/data/worlds/Eldoria.json')).toBe(before);
  });

  it('mirrors a change into the embedded card book', async () => {
    putBook('Eldoria', {
      entries: { 0: { uid: 0, key: ['a'], content: 'old', disable: false } },
      originalData: { entries: [{ uid: 0, keys: ['a'], content: 'old', enabled: true }] },
    });
    await run('/setentryfield file=Eldoria uid=0 new');
    await run('/setentryfield file=Eldoria uid=0 field=disable true');
    expect(book('Eldoria').originalData.entries[0]).toMatchObject({
      content: 'new',
      enabled: false,
    });
  });

  it('keeps the character filter as file stems and tag ids, and reads it back as names', async () => {
    setup({
      characters: [
        { avatar: 'ada.png', name: 'Ada' },
        { avatar: 'bo.png', name: 'Bo' },
      ],
      settings: {
        tags: [
          { id: 't1', name: 'elf' },
          { id: 't2', name: 'mage' },
        ],
      },
    });
    await run('/createentry file=Eldoria text');
    await run('/setentryfield file=Eldoria uid=0 field=characterFilterNames Ada, bo.png, Nobody');
    await run('/setentryfield file=Eldoria uid=0 field=characterFilterTags ["mage","unknown"]');
    await run('/setentryfield file=Eldoria uid=0 field=characterFilterExclude true');
    expect(book('Eldoria').entries[0].characterFilter).toEqual({
      isExclude: true,
      names: ['ada', 'bo'],
      tags: ['t2'],
    });
    expect(await run('/getentryfield file=Eldoria field=characterFilterNames 0')).toBe(
      '["ada","bo"]',
    );
    expect(await run('/getentryfield file=Eldoria field=characterFilterTags 0')).toBe('["mage"]');
    expect(await run('/getentryfield file=Eldoria field=characterFilterExclude 0')).toBe('true');
  });

  it('finds an entry by a field: an equal value first, then one that contains the text', async () => {
    putBook('Eldoria', {
      entries: {
        0: { uid: 0, key: ['dragonfly'], comment: 'Insects', constant: false },
        1: { uid: 1, key: ['Dragon'], comment: 'Great wyrms', constant: true },
      },
    });
    expect(await run('/findentry file=Eldoria dragon')).toBe('1');
    expect(await run('/findentry file=Eldoria fly')).toBe('0');
    expect(await run('/findentry file=Eldoria field=comment wyrm')).toBe('1');
    expect(await run('/findentry file=Eldoria field=constant on')).toBe('1');
    expect(await run('/findentry file=Eldoria griffin')).toBe('');
    expect(await run('/findentry file=Harbor Town dragon')).toBe('');
  });
});
