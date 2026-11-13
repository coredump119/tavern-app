import { describe, expect, it } from 'vitest';
import {
  API_SOURCE_CONFIG,
  CC_PRESET_FIELDS,
  CHAT_COMPLETION_SOURCES,
  applyChatCompletionPreset,
  canConnectWithoutKey,
  defaultOaiSettings,
  deleteProxyPreset,
  getChatCompletionPreset,
  loadOaiSettings,
  loadProxyPresets,
  maxContextFor,
  migrateChatCompletionSettings,
  modelSettingKey,
  sanitizeFilename,
  setProxyPreset,
} from '../src/index.js';

describe('oai settings / presets (ST openai.js)', () => {
  it('default settings carry every settingsToUpdate key', () => {
    const d = defaultOaiSettings();
    for (const [, settingsKey] of CC_PRESET_FIELDS) expect(settingsKey in d).toBe(true);
    expect(d['openai_max_context']).toBe(4095);
    expect(d['prompt_order']).toEqual([]);
    expect((d['prompts'] as unknown[]).length).toBe(12);
  });

  it('loadOaiSettings fills defaults, migrates and drops unknown keys', () => {
    const s = loadOaiSettings({
      temp_openai: 0.7,
      names_in_completion: true,
      chat_completion_source: 'palm',
      openrouter_sort_models: 'context_length',
      foo: 1,
    });
    expect(s['temp_openai']).toBe(0.7);
    expect(s['names_behavior']).toBe(1);
    expect(s['chat_completion_source']).toBe('makersuite');
    // ST quirk: the first (non-matching) openrouter_sort_models rule deletes the old key, so the
    // 'context_length' rule never sees it and sort_models stays at its default
    expect(s['sort_models']).toBe('alphabetically');
    expect('foo' in s).toBe(false);
    expect('openrouter_sort_models' in s).toBe(false);
    expect(s['openai_model']).toBe('gpt-4-turbo');
  });

  it('migration handles regex rules and renames', () => {
    const m = migrateChatCompletionSettings({
      ai21_model: 'j2-ultra',
      mistralai_model: 'mistral-medium',
      image_inlining: false,
    });
    expect(m['ai21_model']).toBe('jamba-large');
    expect(m['mistralai_model']).toBe('mistral-medium-latest');
    expect(m['media_inlining']).toBe(false);
    expect('image_inlining' in m).toBe(false);
  });

  it('getChatCompletionPreset uses preset keys; apply respects bind_preset_to_connection', () => {
    const s = defaultOaiSettings();
    s['temp_openai'] = 0.3;
    s['openai_model'] = 'gpt-4o';
    const body = getChatCompletionPreset(s);
    expect(body['temperature']).toBe(0.3);
    expect(body['openai_model']).toBe('gpt-4o');
    expect('temp_openai' in body).toBe(false);

    const target = defaultOaiSettings();
    target['bind_preset_to_connection'] = false;
    target['extensions'] = { keep: 1 };
    applyChatCompletionPreset(
      target,
      { temperature: 1.5, openai_model: 'gpt-4o', names_in_completion: true },
      'P',
    );
    expect(target['temp_openai']).toBe(1.5);
    expect(target['openai_model']).toBe('gpt-4-turbo'); // connection key skipped
    expect(target['names_behavior']).toBe(1); // preset body migrated
    expect(target['extensions']).toEqual({}); // always replaced
    expect(target['preset_settings_openai']).toBe('P');

    target['bind_preset_to_connection'] = true;
    applyChatCompletionPreset(target, { openai_model: 'gpt-4o', extensions: { a: 1 } }, 'Q');
    expect(target['openai_model']).toBe('gpt-4o');
    expect(target['extensions']).toEqual({ a: 1 });
    expect(target['temp_openai']).toBe(1.5); // untouched when the preset lacks the key
  });

  it('source helpers', () => {
    expect(modelSettingKey('makersuite')).toBe('google_model');
    expect(modelSettingKey('claude')).toBe('claude_model');
    expect(API_SOURCE_CONFIG[CHAT_COMPLETION_SOURCES.CUSTOM]?.keyless).toBe(true);
    expect(canConnectWithoutKey('custom', '')).toBe(true);
    expect(canConnectWithoutKey('openai', '')).toBe(false);
    expect(canConnectWithoutKey('openai', 'http://x/v1')).toBe(true);
    expect(canConnectWithoutKey('groq', 'http://x/v1')).toBe(false);
    expect(maxContextFor('openai', false)).toBe(128000);
    expect(maxContextFor('openai', true)).toBe(2000000);
    expect(maxContextFor('claude', false)).toBe(200000);
  });

  it('proxy presets: load / set / delete like ST', () => {
    const empty = loadProxyPresets({});
    expect(empty.proxies).toEqual([{ name: 'None', url: '', password: '' }]);
    expect(empty.selected.name).toBe('None');
    const loaded = loadProxyPresets({
      proxies: [
        { name: 'None', url: '' },
        { name: 'Mine', url: 'http://p/v1', password: 'x' },
      ],
      selected_proxy: { name: 'Mine' },
    });
    expect(loaded.selected.url).toBe('http://p/v1');
    const sel = setProxyPreset(loaded.proxies, 'Other', 'http://o/v1');
    expect(sel.name).toBe('Other');
    expect(loaded.proxies).toHaveLength(3);
    setProxyPreset(loaded.proxies, 'Other', 'http://o2/v1');
    expect(loaded.proxies[2]?.url).toBe('http://o2/v1');
    expect(deleteProxyPreset(loaded.proxies, 'Other')?.name).toBe('Mine');
    expect(deleteProxyPreset(loaded.proxies, 'nope')).toBeNull();
    expect(deleteProxyPreset(loaded.proxies, 'None')?.name).toBe('Mine');
    expect(deleteProxyPreset(loaded.proxies, 'Mine')).toEqual({
      name: 'None',
      url: '',
      password: '',
    });
  });

  it('sanitizeFilename matches the npm package', () => {
    expect(sanitizeFilename('A/B:C')).toBe('ABC');
    expect(sanitizeFilename('con')).toBe('');
    expect(sanitizeFilename('name. ')).toBe('name');
    expect(sanitizeFilename('字'.repeat(100)).length).toBe(85);
  });
});
