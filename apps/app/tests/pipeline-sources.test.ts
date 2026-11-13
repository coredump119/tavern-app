import { describe, expect, it, vi } from 'vitest';
import { createMockFs, ipcModule } from './ipc-mock';

const seraBook = {
  entries: {
    '0': {
      uid: 0,
      key: ['dragon'],
      keysecondary: [],
      content: 'Dragons are real.',
      order: 100,
      position: 0,
    },
    '1': {
      uid: 1,
      key: ['castle'],
      keysecondary: [],
      content: 'The castle fell.',
      order: 90,
      position: 0,
    },
  },
};
vi.mock('../src/lib/ipc', () => ({
  ...ipcModule(createMockFs({ 'root/worlds/SeraBook.json': JSON.stringify(seraBook) })),
  tokenizerCount: vi.fn(async () => 1),
  tokenizerCountOpenAI: vi.fn(async () => 1),
}));

const { loreBookNamesFor, regexSourcesFor, scanWorldInfo } =
  await import('../src/lib/chat/pipeline');
const { activeCharacter, buildCoreState } = await import('../src/lib/chat/core-state');

const sera = {
  name: 'Sera',
  avatar: 'Sera.png',
  data: {
    extensions: {
      world: 'SeraBook',
      regex_scripts: [{ id: 's1', scriptName: 'scoped', findRegex: '/a/', replaceString: 'b' }],
    },
  },
};
const other = { name: 'Other', avatar: 'Other.png', data: {} };

describe('loreBookNamesFor (ST getSortedEntries sources)', () => {
  it('collects global, character, charLore extra (by file stem), chat and persona books', () => {
    const names = loreBookNamesFor(
      {
        world_info_settings: {
          world_info: {
            globalSelect: ['G1', 'G2', 7],
            charLore: [
              { name: 'Other', extraBooks: ['X'] },
              { name: 'Sera', extraBooks: ['E1', 'E2'] },
            ],
          },
        },
        power_user: { persona_description_lorebook: 'Persona' },
      },
      sera,
      { world_info: 'ChatBook' },
    );
    expect(names).toEqual({
      globalBooks: ['G1', 'G2'],
      characterBook: 'SeraBook',
      characterExtraBooks: ['E1', 'E2'],
      chatBook: 'ChatBook',
      personaBook: 'Persona',
    });
  });
  it('treats empty strings and missing settings as no book', () => {
    expect(loreBookNamesFor({}, other, { world_info: '' })).toEqual({
      globalBooks: [],
      characterBook: null,
      characterExtraBooks: [],
      chatBook: null,
      personaBook: null,
    });
  });
});

describe('regexSourcesFor (ST getScriptsByType)', () => {
  const preset = [{ id: 'p1', scriptName: 'preset', findRegex: '/x/', replaceString: 'y' }];
  const base = {
    main_api: 'openai',
    oai_settings: { preset_settings_openai: 'Default', extensions: { regex_scripts: preset } },
    textgenerationwebui_settings: { preset: 'TG', extensions: { regex_scripts: [] } },
    extension_settings: {
      regex: [{ id: 'g1', scriptName: 'global', findRegex: '/g/', replaceString: 'h' }],
      preset_allowed_regex: { openai: ['Default'], textgenerationwebui: [] },
      character_allowed_regex: ['Sera.png'],
      disabledExtensions: [],
    },
  };
  it('preset scripts follow the active API preset and its allow-list', () => {
    const cc = regexSourcesFor(base, sera);
    expect(cc.global).toHaveLength(1);
    expect(cc.preset).toBe(preset);
    expect(cc.presetAllowed).toBe(true);
    expect(cc.scoped).toHaveLength(1);
    expect(cc.scopedAllowed).toBe(true);
    expect(cc.extensionDisabled).toBe(false);
    const tc = regexSourcesFor({ ...base, main_api: 'textgenerationwebui' }, sera);
    expect(tc.preset).toEqual([]);
    expect(tc.presetAllowed).toBe(false);
  });
  it('scoped scripts are only allowed for listed avatars; no character means none', () => {
    expect(regexSourcesFor(base, other).scopedAllowed).toBe(false);
    expect(regexSourcesFor(base, other).scoped).toEqual([]);
    expect(regexSourcesFor(base, null).scopedAllowed).toBe(false);
    const off = regexSourcesFor(
      {
        ...base,
        extension_settings: { ...base.extension_settings, disabledExtensions: ['regex'] },
      },
      sera,
    );
    expect(off.extensionDisabled).toBe(true);
  });
});

describe('buildCoreState subject (DEV_NOTES §9.21)', () => {
  const settings = { main_api: 'openai', oai_settings: { openai_model: 'm' } };
  it('single character: characters=[c], characterId=0', () => {
    const st = buildCoreState({
      userName: 'U',
      subject: { character: sera },
      chat: [],
      chatMetadata: {},
      settings,
    });
    expect(st.characterId).toBe(0);
    expect(st.charName).toBe('Sera');
    expect(st.groups).toEqual([]);
    expect(st.selectedGroup).toBeNull();
  });
  it('group idle: members as characters, no characterId, empty charName, selectedGroup set', () => {
    const group = { id: '1', members: ['Sera.png', 'Other.png'] };
    const idle = buildCoreState({
      userName: 'U',
      subject: { character: null, group, members: [sera, other], memberIndex: null },
      chat: [],
      chatMetadata: {},
      settings,
    });
    expect(idle.characters).toHaveLength(2);
    expect(idle.characterId).toBeUndefined();
    expect(idle.charName).toBe('');
    expect(idle.selectedGroup).toBe('1');
    expect(idle.groups[0]).toBe(group);
    expect(
      activeCharacter({ character: null, group, members: [sera, other], memberIndex: null }),
    ).toBeNull();
  });
  it('group generating: characterId / charName follow the drafted member', () => {
    const group = { id: '1', members: ['Sera.png', 'Other.png'] };
    const st = buildCoreState({
      userName: 'U',
      subject: { character: null, group, members: [sera, other], memberIndex: 1 },
      chat: [],
      chatMetadata: {},
      settings,
    });
    expect(st.characterId).toBe(1);
    expect(st.charName).toBe('Other');
    expect(
      activeCharacter({ character: null, group, members: [sera, other], memberIndex: 1 }),
    ).toBe(other);
  });
});

describe("scanWorldInfo (ST checkWorldInfo over a chat's lorebooks)", () => {
  const input = (chatMetadata: Record<string, unknown> = {}) => ({
    root: 'root',
    settings: { main_api: 'openai', oai_settings: {}, power_user: {} },
    subject: { character: sera, group: null, members: [], memberIndex: null },
    userName: 'U',
    chat: [],
    chatMetadata,
    type: 'normal' as const,
    textareaText: '',
  });
  it('activates the character book entries whose keys are in the given texts', async () => {
    const found = await scanWorldInfo(input(), {
      chat: ['I saw a dragon today'],
      maxContext: 4096,
      isDryRun: true,
    });
    expect([...found.allActivatedEntries].map((e) => e.content)).toEqual(['Dragons are real.']);
    expect(found.worldInfoBefore).toBe('Dragons are real.');
  });
  it('nothing matches: empty result; a missing book is skipped, not thrown', async () => {
    const found = await scanWorldInfo(input({ world_info: 'Gone' }), {
      chat: ['hello'],
      maxContext: 4096,
      isDryRun: true,
    });
    expect(found.allActivatedEntries.size).toBe(0);
    expect(found.worldInfoBefore + found.worldInfoAfter).toBe('');
  });
});
