import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockFs, ipcModule } from './ipc-mock';

const fs = createMockFs();
vi.mock('../src/lib/ipc', () => ({
  ...ipcModule(fs),
  fileUrl: (p: string) => `asset://${p}`,
  userAvatarUpload: vi.fn(async () => '1700.png'),
  userAvatarCopy: vi.fn(async () => undefined),
  userAvatarSeedDefault: vi.fn(async () => true),
}));

const { personaFileFromForceAvatar, userForceAvatar, listUserAvatars } =
  await import('../src/lib/personas');
const {
  regexPresetContext,
  setPresetRegexScripts,
  setScopedRegexScripts,
  presetRegexScripts,
  scopedRegexScripts,
} = await import('../src/lib/regex');
const ROOT = '/data';

describe('lib/personas', () => {
  beforeEach(() => fs.files.clear());
  it('user messages pin the persona avatar only when the avatar has a persona entry', () => {
    expect(
      userForceAvatar({ user_avatar: 'a.png', power_user: { personas: { 'a.png': 'A' } } }),
    ).toBe('/thumbnail?type=persona&file=a.png');
    expect(
      userForceAvatar({ user_avatar: 'plain.png', power_user: { personas: {} } }),
    ).toBeUndefined();
    expect(userForceAvatar(null)).toBeUndefined();
  });
  it('reads the persona file back from ST thumbnail urls and legacy paths', () => {
    expect(personaFileFromForceAvatar('/thumbnail?type=persona&file=my%20face.png')).toBe(
      'my face.png',
    );
    expect(personaFileFromForceAvatar('User Avatars/old.png')).toBe('old.png');
    expect(personaFileFromForceAvatar('/thumbnail?type=avatar&file=Sera.png')).toBeNull();
    expect(personaFileFromForceAvatar(undefined)).toBeNull();
  });
  it('lists only png files, sorted', async () => {
    fs.files.set(`${ROOT}/User Avatars/b.png`, 'x');
    fs.files.set(`${ROOT}/User Avatars/a.png`, 'x');
    fs.files.set(`${ROOT}/User Avatars/notes.txt`, 'x');
    expect(await listUserAvatars(ROOT)).toEqual(['a.png', 'b.png']);
  });
});

describe('lib/regex storage', () => {
  beforeEach(() => fs.files.clear());
  it('preset context follows main_api', () => {
    expect(
      regexPresetContext({
        main_api: 'openai',
        oai_settings: { preset_settings_openai: 'Default' },
      }),
    ).toMatchObject({
      api: 'openai',
      presetName: 'Default',
      presetDir: 'OpenAI Settings',
    });
    expect(
      regexPresetContext({
        main_api: 'textgenerationwebui',
        textgenerationwebui_settings: { preset: 'Mirostat' },
      }),
    ).toMatchObject({
      api: 'textgenerationwebui',
      presetName: 'Mirostat',
      bucketKey: 'textgenerationwebui_settings',
    });
  });
  it('preset scripts go to the settings bucket, the preset file and the allow list', async () => {
    fs.files.set(
      `${ROOT}/OpenAI Settings/Default.json`,
      JSON.stringify({ temperature: 1, extensions: { other: 1 } }),
    );
    const settings: Record<string, unknown> = {
      main_api: 'openai',
      oai_settings: { preset_settings_openai: 'Default', extensions: {} },
    };
    const scripts = [{ id: 'p1', scriptName: 'p', findRegex: '/a/', placement: [2] }];
    await setPresetRegexScripts(ROOT, settings, scripts);
    expect(presetRegexScripts(settings)).toEqual(scripts);
    const file = JSON.parse(fs.files.get(`${ROOT}/OpenAI Settings/Default.json`)!);
    expect(file.extensions).toEqual({ other: 1, regex_scripts: scripts });
    expect(file.temperature).toBe(1);
    const ext = settings['extension_settings'] as {
      preset_allowed_regex: Record<string, string[]>;
    };
    expect(ext.preset_allowed_regex['openai']).toEqual(['Default']);
    // no preset file: bucket still updated, nothing thrown
    const s2: Record<string, unknown> = {
      main_api: 'openai',
      oai_settings: { preset_settings_openai: 'Ghost' },
    };
    await setPresetRegexScripts(ROOT, s2, scripts);
    expect(presetRegexScripts(s2)).toEqual(scripts);
  });
  it('scoped scripts rewrite only data.extensions.regex_scripts on the card and allow the avatar', async () => {
    fs.files.set(
      `${ROOT}/characters/Sera.png`,
      JSON.stringify({
        name: 'Sera',
        data: { name: 'Sera', extensions: { world: 'E', regex_scripts: [] } },
      }),
    );
    const settings: Record<string, unknown> = {};
    const scripts = [{ id: 's1', scriptName: 's', findRegex: '/b/', placement: [1] }];
    await setScopedRegexScripts(ROOT, settings, 'Sera.png', scripts);
    const card = JSON.parse(fs.files.get(`${ROOT}/characters/Sera.png`)!);
    expect(card.data.extensions).toEqual({ world: 'E', regex_scripts: scripts });
    expect(card.name).toBe('Sera');
    expect(await scopedRegexScripts(ROOT, 'Sera.png')).toEqual(scripts);
    expect(
      (settings['extension_settings'] as { character_allowed_regex: string[] })
        .character_allowed_regex,
    ).toEqual(['Sera.png']);
  });
});
