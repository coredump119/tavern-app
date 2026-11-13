import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRESET,
  fromPreset,
  fromTavernRegex,
  isPresetNormalPrompt,
  isPresetPlaceholderPrompt,
  isPresetSystemPrompt,
  PRESET_ST_KEYS,
  toPreset,
  toTavernRegex,
  type Preset,
  type PresetPrompt,
} from '../src/convert/preset.js';

type Dict = Record<string, unknown>;

const marker = (identifier: string, name: string): Dict => ({
  identifier,
  name,
  system_prompt: true,
  marker: true,
});

/** A compact preset file in ST's shape: the stock prompts, two custom ones, one left out of the order */
const stPreset = (): Dict => ({
  chat_completion_source: 'openai',
  openai_model: 'gpt-4-turbo',
  reverse_proxy: '',
  temperature: 0.8,
  frequency_penalty: 0.1,
  presence_penalty: 0.2,
  top_p: 0.9,
  top_k: 40,
  top_a: 0.3,
  min_p: 0.05,
  repetition_penalty: 1.1,
  openai_max_context: 8192,
  openai_max_tokens: 512,
  names_behavior: 2,
  send_if_empty: '',
  new_chat_prompt: '[Start a new Chat]',
  max_context_unlocked: false,
  wi_format: '{0}',
  stream_openai: true,
  squash_system_messages: true,
  media_inlining: true,
  inline_image_quality: 'high',
  function_calling: true,
  show_thoughts: false,
  reasoning_effort: 'medium',
  enable_web_search: true,
  request_images: true,
  seed: 42,
  n: 2,
  some_future_key: { nested: [1, 2, 3] },
  prompts: [
    {
      identifier: 'main',
      name: 'Main Prompt',
      system_prompt: true,
      role: 'system',
      content: 'Write the next reply.',
    },
    {
      identifier: 'nsfw',
      name: 'Auxiliary Prompt',
      system_prompt: true,
      role: 'system',
      content: '',
    },
    marker('dialogueExamples', 'Chat Examples'),
    {
      identifier: 'jailbreak',
      name: 'Post-History Instructions',
      system_prompt: true,
      role: 'user',
      content: 'Stay in character.',
      injection_trigger: ['continue'],
    },
    marker('chatHistory', 'Chat History'),
    marker('worldInfoAfter', 'World Info (after)'),
    marker('worldInfoBefore', 'World Info (before)'),
    {
      identifier: 'enhanceDefinitions',
      name: 'Enhance Definitions',
      system_prompt: true,
      marker: false,
      role: 'system',
      content: 'Enhance.',
    },
    { ...marker('charDescription', 'Char Description'), injection_position: 1, injection_depth: 2 },
    marker('charPersonality', 'Char Personality'),
    marker('scenario', 'Scenario'),
    marker('personaDescription', 'Persona Description'),
    {
      identifier: 'cot',
      name: 'COT',
      system_prompt: false,
      marker: false,
      role: 'assistant',
      content: 'Think step by step.',
      injection_position: 1,
      injection_depth: 0,
      injection_order: 50,
      forbid_overrides: true,
      injection_trigger: ['normal'],
      extra: { author: 'someone', tags: ['a'] },
    },
    {
      identifier: 'spare',
      name: 'Spare',
      system_prompt: false,
      role: 'user',
      content: 'Not in the list.',
      injection_position: 0,
      injection_depth: 7,
      injection_order: 30,
      enabled: false,
    },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
      ],
    },
    {
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'worldInfoBefore', enabled: true },
        { identifier: 'personaDescription', enabled: true },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'charPersonality', enabled: true },
        { identifier: 'scenario', enabled: true },
        { identifier: 'enhanceDefinitions', enabled: false },
        { identifier: 'nsfw', enabled: true },
        { identifier: 'worldInfoAfter', enabled: true },
        { identifier: 'dialogueExamples', enabled: true },
        { identifier: 'cot', enabled: false },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: true },
        { identifier: 'ghost', enabled: true },
      ],
    },
  ],
  extensions: {
    regex_scripts: [
      {
        id: 'r1',
        scriptName: 'Hide tags',
        findRegex: '/<x>.*?<\\/x>/g',
        replaceString: '',
        trimStrings: ['x'],
        placement: [2, 6],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 2,
        minDepth: null,
        maxDepth: 3,
      },
    ],
    tavern_helper: { scripts: [{ type: 'script', id: 's1', name: 'Demo' }], variables: { hp: 3 } },
    other_extension: { on: true },
  },
});

const byId = (prompts: readonly PresetPrompt[], id: string): PresetPrompt => {
  const found = prompts.find((prompt) => prompt.id === id);
  if (!found) throw new Error(`no prompt ${id}`);
  return found;
};
const stPrompt = (st: Dict, identifier: string): Dict => {
  const found = (st['prompts'] as Dict[]).find((prompt) => prompt['identifier'] === identifier);
  if (!found) throw new Error(`no prompt ${identifier}`);
  return found;
};
const globalOrder = (st: Dict): Dict[] => {
  const lists = st['prompt_order'] as Array<{ character_id: unknown; order: Dict[] }>;
  return lists.find((list) => String(list.character_id) === '100001')?.order ?? [];
};

describe('toPreset', () => {
  it('maps the flat settings of a preset file', () => {
    expect(toPreset(stPreset()).settings).toEqual({
      max_context: 8192,
      max_completion_tokens: 512,
      reply_count: 2,
      should_stream: true,
      temperature: 0.8,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      repetition_penalty: 1.1,
      top_p: 0.9,
      min_p: 0.05,
      top_k: 40,
      top_a: 0.3,
      seed: 42,
      squash_system_messages: true,
      reasoning_effort: 'medium',
      request_thoughts: false,
      request_images: true,
      enable_function_calling: true,
      enable_web_search: true,
      allow_sending_images: 'high',
      allow_sending_videos: true,
      character_name_prefix: 'content',
      wrap_user_messages_in_quotes: false,
    });
  });

  it('reads the samplers of live oai_settings from their *_openai keys', () => {
    const live = { temp_openai: 0.3, freq_pen_openai: 0.4, top_k_openai: '12', stream_openai: 1 };
    const { settings } = toPreset(live);
    expect(settings.temperature).toBe(0.3);
    expect(settings.frequency_penalty).toBe(0.4);
    expect(settings.top_k).toBe(12);
    expect(settings.should_stream).toBe(true);
    // a file that carries both spellings is read by its file key
    expect(toPreset({ temperature: 0.9, temp_openai: 0.3 }).settings.temperature).toBe(0.9);
  });

  it('maps names_behavior and the media switch, including the keys older ST wrote', () => {
    const prefix = (st: Dict) => toPreset(st).settings.character_name_prefix;
    expect(prefix({ names_behavior: -1 })).toBe('none');
    expect(prefix({ names_behavior: 0 })).toBe('default');
    expect(prefix({ names_behavior: 1 })).toBe('completion');
    expect(prefix({ names_behavior: 2 })).toBe('content');
    expect(prefix({ names_behavior: 0, names_in_completion: true })).toBe('completion');

    const media = (st: Dict) => {
      const { allow_sending_images, allow_sending_videos } = toPreset(st).settings;
      return [allow_sending_images, allow_sending_videos];
    };
    expect(media({ media_inlining: false, inline_image_quality: 'low' })).toEqual([
      'disabled',
      false,
    ]);
    expect(media({ media_inlining: true, inline_image_quality: 'low' })).toEqual(['low', true]);
    expect(media({ media_inlining: true, image_inlining: false })).toEqual(['disabled', false]);
    expect(media({ image_inlining: false, video_inlining: true })).toEqual(['auto', true]);
  });

  it('splits prompts by the global order and takes enabled from it', () => {
    const preset = toPreset(stPreset());
    expect(preset.prompts.map((prompt) => prompt.id)).toEqual([
      'main',
      'worldInfoBefore',
      'personaDescription',
      'charDescription',
      'charPersonality',
      'scenario',
      'enhanceDefinitions',
      'nsfw',
      'worldInfoAfter',
      'dialogueExamples',
      'cot',
      'chatHistory',
      'jailbreak',
    ]);
    expect(preset.prompts_unused.map((prompt) => prompt.id)).toEqual(['spare']);
    expect(byId(preset.prompts, 'enhanceDefinitions').enabled).toBe(false);
    expect(byId(preset.prompts, 'cot').enabled).toBe(false);
    expect(byId(preset.prompts, 'main').enabled).toBe(true);
    // outside the order the prompt's own flag is all there is
    expect(byId(preset.prompts_unused, 'spare').enabled).toBe(false);
  });

  it('shapes system, placeholder and normal prompts differently', () => {
    const preset = toPreset(stPreset());
    expect(byId(preset.prompts, 'jailbreak')).toEqual({
      id: 'jailbreak',
      name: 'Post-History Instructions',
      enabled: true,
      role: 'user',
      content: 'Stay in character.',
    });
    expect(byId(preset.prompts, 'chatHistory')).toEqual({
      id: 'chatHistory',
      name: 'Chat History',
      enabled: true,
      position: { type: 'relative' },
      role: 'system',
    });
    expect(byId(preset.prompts, 'charDescription').position).toEqual({
      type: 'in_chat',
      depth: 2,
      order: 100,
    });
    expect(byId(preset.prompts, 'cot')).toEqual({
      id: 'cot',
      name: 'COT',
      enabled: false,
      position: { type: 'in_chat', depth: 0, order: 50 },
      role: 'assistant',
      content: 'Think step by step.',
      extra: { author: 'someone', tags: ['a'] },
    });
    expect(byId(preset.prompts_unused, 'spare').position).toEqual({ type: 'relative' });
  });

  it('classifies prompts by id, which ST and TavernHelper spell the same way', () => {
    const preset = toPreset(stPreset());
    const all = [...preset.prompts, ...preset.prompts_unused];
    expect(all.filter(isPresetSystemPrompt).map((prompt) => prompt.id)).toEqual([
      'main',
      'enhanceDefinitions',
      'nsfw',
      'jailbreak',
    ]);
    expect(all.filter(isPresetPlaceholderPrompt).map((prompt) => prompt.id)).toEqual([
      'worldInfoBefore',
      'personaDescription',
      'charDescription',
      'charPersonality',
      'scenario',
      'worldInfoAfter',
      'dialogueExamples',
      'chatHistory',
    ]);
    expect(all.filter(isPresetNormalPrompt).map((prompt) => prompt.id)).toEqual(['cot', 'spare']);
    // the snake_case names in the upstream docs are prose, not ids
    const legacy: PresetPrompt = { id: 'chat_history', name: '', enabled: true, role: 'system' };
    expect(isPresetNormalPrompt(legacy)).toBe(true);
    expect(isPresetPlaceholderPrompt(legacy)).toBe(false);
  });

  it('converts preset regex scripts and guarantees the tavern_helper field', () => {
    const { extensions } = toPreset(stPreset());
    expect(extensions['regex_scripts']).toEqual([
      {
        id: 'r1',
        script_name: 'Hide tags',
        enabled: true,
        find_regex: '/<x>.*?<\\/x>/g',
        trim_strings: ['x'],
        replace_string: '',
        source: {
          user_input: false,
          ai_output: true,
          slash_command: false,
          world_info: false,
          reasoning: true,
        },
        destination: { display: true, prompt: false },
        run_on_edit: true,
        min_depth: null,
        max_depth: 3,
      },
    ]);
    expect(extensions['tavern_helper']).toEqual({
      scripts: [{ type: 'script', id: 's1', name: 'Demo' }],
      variables: { hp: 3 },
    });
    expect(extensions['other_extension']).toEqual({ on: true });

    expect(
      toPreset({ extensions: { tavern_helper: [['variables', { a: 1 }]] } }).extensions,
    ).toEqual({ regex_scripts: [], tavern_helper: { scripts: [], variables: { a: 1 } } });
  });

  it('does not share anything with its input', () => {
    const raw = stPreset();
    const preset = toPreset(raw);
    (byId(preset.prompts, 'cot').extra as Dict)['author'] = 'changed';
    (preset.extensions['other_extension'] as Dict)['on'] = false;
    expect(raw).toEqual(stPreset());
  });

  it('reads garbage as an untouched ST install', () => {
    for (const garbage of [undefined, null, 42, 'preset', [], { prompts: 'x', prompt_order: 7 }]) {
      const preset = toPreset(garbage);
      expect(preset.settings).toMatchObject({
        max_context: 4095,
        max_completion_tokens: 300,
        temperature: 1,
        request_thoughts: true,
        allow_sending_images: 'auto',
        character_name_prefix: 'default',
      });
      expect(preset.prompts.map((prompt) => prompt.id)).toEqual([
        'main',
        'worldInfoBefore',
        'personaDescription',
        'charDescription',
        'charPersonality',
        'scenario',
        'enhanceDefinitions',
        'nsfw',
        'worldInfoAfter',
        'dialogueExamples',
        'chatHistory',
        'jailbreak',
      ]);
      expect(byId(preset.prompts, 'enhanceDefinitions').enabled).toBe(false);
      expect(preset.prompts_unused).toEqual([]);
      expect(preset.extensions).toEqual({
        regex_scripts: [],
        tavern_helper: { scripts: [], variables: {} },
      });
    }
  });

  it('fills in stock prompts a preset refers to but does not define', () => {
    const preset = toPreset({
      prompts: [
        { identifier: 'main', name: 'Main', system_prompt: true, content: 'Hi', role: 'bogus' },
        { identifier: 'main', name: 'Duplicate', system_prompt: true, content: 'ignored' },
        { name: 'No identifier', content: 'x' },
        'junk',
      ],
      prompt_order: [
        {
          character_id: '100001',
          order: [
            { identifier: 'personaDescription', enabled: true },
            { identifier: 'main' },
            { identifier: 'main', enabled: false },
          ],
        },
      ],
    });
    expect(preset.prompts).toEqual([
      {
        id: 'personaDescription',
        name: 'Persona Description',
        enabled: true,
        position: { type: 'relative' },
        role: 'system',
      },
      { id: 'main', name: 'Main', enabled: true, role: 'system', content: 'Hi' },
    ]);
    const unused = preset.prompts_unused.map((prompt) => prompt.name);
    expect(unused).toContain('No identifier');
    expect(unused).not.toContain('Duplicate');
    expect(unused).toHaveLength(1 + 10);
  });
});

describe('fromPreset', () => {
  const preset = (): Preset => ({
    settings: {
      ...DEFAULT_PRESET.settings,
      max_context: 100000,
      max_completion_tokens: 2048,
      reply_count: 3,
      should_stream: true,
      temperature: 0.6,
      top_k: 20,
      seed: 7,
      reasoning_effort: 'high',
      request_thoughts: true,
      enable_function_calling: true,
      allow_sending_images: 'low',
      allow_sending_videos: true,
      character_name_prefix: 'completion',
      wrap_user_messages_in_quotes: true,
    },
    prompts: [
      { id: 'main', name: 'Main', enabled: true, role: 'system', content: 'Be brief.' },
      {
        id: 'chatHistory',
        name: 'Chat History',
        enabled: true,
        position: { type: 'in_chat', depth: 1, order: 1 },
        role: 'system',
      },
      {
        id: 'note',
        name: 'Note',
        enabled: false,
        position: { type: 'in_chat', depth: 3, order: 20 },
        role: 'user',
        content: 'Remember.',
        extra: { pinned: true },
      },
      {
        id: 'scenario',
        name: 'Scenario',
        enabled: true,
        position: { type: 'relative' },
        role: 'system',
      },
    ],
    prompts_unused: [
      {
        id: 'idle',
        name: 'Idle',
        enabled: true,
        position: { type: 'relative' },
        role: 'assistant',
        content: 'Unused.',
      },
    ],
    extensions: { tavern_helper: { scripts: [], variables: { a: 1 } } },
  });

  it('writes the flat settings under ST file keys', () => {
    expect(fromPreset(preset())).toMatchObject({
      openai_max_context: 100000,
      openai_max_tokens: 2048,
      n: 3,
      stream_openai: true,
      temperature: 0.6,
      frequency_penalty: 0,
      presence_penalty: 0,
      repetition_penalty: 1,
      top_p: 1,
      min_p: 0,
      top_k: 20,
      top_a: 0,
      seed: 7,
      squash_system_messages: false,
      reasoning_effort: 'high',
      show_thoughts: true,
      request_images: false,
      function_calling: true,
      enable_web_search: false,
      media_inlining: true,
      inline_image_quality: 'low',
      names_behavior: 1,
      wrap_in_quotes: true,
      max_context_unlocked: true,
      extensions: { tavern_helper: { scripts: [], variables: { a: 1 } } },
    });
    expect(fromPreset(preset())).not.toHaveProperty('temp_openai');
  });

  it('only writes keys it declares as owned', () => {
    expect(
      Object.keys(fromPreset(preset())).filter((key) => !PRESET_ST_KEYS.includes(key)),
    ).toEqual([]);
    for (const key of ['prompts', 'prompt_order', 'extensions', 'temperature', 'temp_openai']) {
      expect(PRESET_ST_KEYS).toContain(key);
    }
    expect(Object.isFrozen(PRESET_ST_KEYS)).toBe(true);
  });

  it('updates live oai_settings under the spelling they use', () => {
    const live = { temp_openai: 1, freq_pen_openai: 0, top_k_openai: 0, custom_url: 'http://x' };
    const next = fromPreset(preset(), live);
    expect(next).toMatchObject({ temp_openai: 0.6, top_k_openai: 20, custom_url: 'http://x' });
    expect(next).not.toHaveProperty('temperature');
    expect(next).not.toHaveProperty('top_k');
    // a sampler the live object did not have yet falls back to the file spelling
    expect(next).toMatchObject({ top_p: 1 });
    expect(toPreset(next).settings.temperature).toBe(0.6);
  });

  it('builds ST prompts, with the list first and the global order from it', () => {
    const st = fromPreset(preset());
    expect((st['prompts'] as Dict[]).map((prompt) => prompt['identifier'])).toEqual([
      'main',
      'chatHistory',
      'note',
      'scenario',
      'idle',
    ]);
    expect(st['prompt_order']).toEqual([
      {
        character_id: 100001,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'note', enabled: false },
          { identifier: 'scenario', enabled: true },
        ],
      },
    ]);
    expect(stPrompt(st, 'main')).toEqual({
      identifier: 'main',
      name: 'Main',
      enabled: true,
      role: 'system',
      content: 'Be brief.',
      system_prompt: true,
      marker: false,
      forbid_overrides: false,
    });
    expect(stPrompt(st, 'note')).toEqual({
      identifier: 'note',
      name: 'Note',
      enabled: false,
      injection_position: 1,
      injection_depth: 3,
      injection_order: 20,
      role: 'user',
      content: 'Remember.',
      system_prompt: false,
      marker: false,
      forbid_overrides: false,
      extra: { pinned: true },
    });
    expect(stPrompt(st, 'scenario')).toEqual({
      identifier: 'scenario',
      name: 'Scenario',
      enabled: true,
      injection_position: 0,
      injection_depth: 4,
      injection_order: 100,
      role: 'system',
      system_prompt: true,
      marker: true,
      forbid_overrides: false,
    });
    expect(stPrompt(st, 'idle')).toMatchObject({ injection_position: 0, role: 'assistant' });
    // chat history and examples cannot be injected in chat
    expect(stPrompt(st, 'chatHistory')).not.toHaveProperty('injection_position');
  });

  it('keeps what the TavernHelper shape does not describe', () => {
    const previous = stPreset();
    const input = toPreset(previous);
    input.settings.temperature = 0.25;
    input.prompts = input.prompts.filter((prompt) => prompt.id !== 'nsfw');
    byId(input.prompts, 'cot').position = { type: 'relative' };
    delete byId(input.prompts, 'cot').extra;
    byId(input.prompts, 'jailbreak').content = 'New.';
    input.prompts.push(byId(input.prompts_unused, 'spare'));
    input.prompts_unused = [];
    const st = fromPreset(input, previous);

    for (const key of Object.keys(previous).filter((k) => !PRESET_ST_KEYS.includes(k))) {
      expect(st[key], key).toEqual(previous[key]);
    }
    expect(st['temperature']).toBe(0.25);
    expect(st).not.toHaveProperty('temp_openai');

    // per-prompt fields survive while the id does
    expect(stPrompt(st, 'jailbreak')).toMatchObject({
      content: 'New.',
      role: 'user',
      injection_trigger: ['continue'],
      system_prompt: true,
    });
    const cot = stPrompt(st, 'cot');
    expect(cot).toMatchObject({
      injection_position: 0,
      injection_depth: 0,
      injection_order: 50,
      forbid_overrides: true,
      injection_trigger: ['normal'],
    });
    expect(cot).not.toHaveProperty('extra');
    expect((st['prompts'] as Dict[]).some((prompt) => prompt['identifier'] === 'nsfw')).toBe(false);

    // other characters' orders are untouched, the global one is rebuilt
    const lists = st['prompt_order'] as Dict[];
    expect(lists).toHaveLength(2);
    expect(lists[0]).toEqual((previous['prompt_order'] as Dict[])[0]);
    const order = globalOrder(st);
    expect(order.map((entry) => entry['identifier'])).not.toContain('nsfw');
    expect(order.at(-1)).toEqual({ identifier: 'spare', enabled: false });

    // fields TavernRegex has no word for come from the script being replaced
    const regex = (record(st['extensions'])['regex_scripts'] as Dict[])[0];
    expect(regex).toEqual((record(previous['extensions'])['regex_scripts'] as Dict[])[0]);

    expect(previous).toEqual(stPreset());
  });

  it('maps the two media switches onto the one ST has', () => {
    const media = (images: string, videos: boolean, previous?: Dict) => {
      const st = fromPreset(
        { settings: { allow_sending_images: images, allow_sending_videos: videos } },
        previous,
      );
      return [st['media_inlining'], st['inline_image_quality']];
    };
    // a new preset: either switch turns it on
    expect(media('disabled', false)).toEqual([false, 'auto']);
    expect(media('high', false)).toEqual([true, 'high']);
    expect(media('disabled', true)).toEqual([true, 'auto']);
    // it was on: turning either switch off turns it off, and the stored quality stays
    const on = { media_inlining: true, inline_image_quality: 'low' };
    expect(media('low', true, on)).toEqual([true, 'low']);
    expect(media('disabled', true, on)).toEqual([false, 'low']);
    expect(media('low', false, on)).toEqual([false, 'low']);
    // it was off: turning either on turns it on
    expect(media('auto', false, { media_inlining: false })).toEqual([true, 'auto']);

    // keys ST would migrate over the new value are dropped
    const st = fromPreset(
      { settings: { allow_sending_images: 'disabled', character_name_prefix: 'none' } },
      { image_inlining: true, video_inlining: true, names_in_completion: true, keep: 1 },
    );
    expect(st).toMatchObject({ media_inlining: false, names_behavior: -1, keep: 1 });
    expect(st).not.toHaveProperty('image_inlining');
    expect(st).not.toHaveProperty('video_inlining');
    expect(st).not.toHaveProperty('names_in_completion');
  });

  it('maps every character_name_prefix', () => {
    const behavior = (prefix: string) =>
      fromPreset({ settings: { character_name_prefix: prefix } })['names_behavior'];
    expect(['none', 'default', 'content', 'completion', 'bogus'].map(behavior)).toEqual([
      -1, 0, 2, 1, -1,
    ]);
  });

  it('fills a nearly empty preset from DEFAULT_PRESET', () => {
    const st = fromPreset({ settings: { should_stream: true, temperature: 'hot' } });
    expect(st).toEqual(
      fromPreset({
        ...structuredClone(DEFAULT_PRESET),
        settings: { ...DEFAULT_PRESET.settings, should_stream: true },
      }),
    );
    expect(st).toMatchObject({
      stream_openai: true,
      temperature: 1,
      openai_max_context: 2000000,
      media_inlining: false,
      names_behavior: -1,
      extensions: { tavern_helper: { scripts: [], variables: {} } },
    });
    expect(globalOrder(st).map((entry) => entry['identifier'])).toEqual(
      DEFAULT_PRESET.prompts.map((prompt) => prompt.id),
    );
    expect(toPreset(st)).toMatchObject({
      settings: { ...DEFAULT_PRESET.settings, should_stream: true },
      prompts: DEFAULT_PRESET.prompts,
    });
  });

  it('survives garbage', () => {
    const blank = fromPreset(undefined);
    for (const garbage of [null, 42, 'preset', [], { settings: 3, prompts: 'x', extensions: [] }]) {
      expect(fromPreset(garbage)).toEqual(blank);
      // a `previous` that is not an object has nothing to carry over
      if (typeof garbage !== 'object' || garbage === null || Array.isArray(garbage)) {
        expect(fromPreset(garbage, garbage)).toEqual(blank);
      }
    }
    expect(fromPreset(undefined, { prompts: 'x', prompt_order: 7, extensions: 'y' })).toEqual(
      blank,
    );
    const st = fromPreset({
      prompts: [null, 7, { name: 'No id', content: 5, role: 'narrator', position: 'top' }],
      prompts_unused: [{ id: 'main' }],
    });
    const prompts = st['prompts'] as Dict[];
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatchObject({
      name: 'No id',
      enabled: true,
      role: 'system',
      content: '',
      injection_position: 0,
      system_prompt: false,
    });
    expect(prompts[0]?.['identifier']).toMatch(/^[0-9a-f-]{36}$/);
    expect(prompts[1]).toMatchObject({ identifier: 'main', name: 'unnamed', content: '' });
  });

  it('renames a repeated normal id and rejects a repeated system or placeholder id', () => {
    const prompt = (id: string): PresetPrompt => ({ id, name: id, enabled: true, role: 'system' });
    const st = fromPreset({ prompts: [prompt('twin')], prompts_unused: [prompt('twin')] });
    const ids = (st['prompts'] as Dict[]).map((p) => p['identifier']);
    expect(ids[0]).toBe('twin');
    expect(ids[1]).not.toBe('twin');
    expect(globalOrder(st)).toEqual([{ identifier: 'twin', enabled: true }]);

    expect(() => fromPreset({ prompts: [prompt('main'), prompt('main')] })).toThrow(/main/);
    expect(() =>
      fromPreset({ prompts: [prompt('chatHistory')], prompts_unused: [prompt('chatHistory')] }),
    ).toThrow(/chatHistory/);
  });
});

describe('round trip', () => {
  it('is stable through ST and back', () => {
    const raw = stPreset();
    const preset = toPreset(raw);
    const st = fromPreset(preset, raw);
    expect(toPreset(st)).toEqual(preset);
    expect(toPreset(fromPreset(preset))).toEqual(preset);
    for (const key of Object.keys(raw).filter((k) => !PRESET_ST_KEYS.includes(k))) {
      expect(st[key], key).toEqual(raw[key]);
    }
  });

  it('is stable for live oai_settings', () => {
    const { temperature, top_k, ...rest } = stPreset();
    const live = { ...rest, temp_openai: temperature, top_k_openai: top_k };
    const preset = toPreset(live);
    expect(preset.settings.temperature).toBe(0.8);
    expect(toPreset(fromPreset(preset, live))).toEqual(preset);
  });

  it('is stable for DEFAULT_PRESET', () => {
    const back = toPreset(fromPreset(DEFAULT_PRESET));
    expect(back.settings).toEqual(DEFAULT_PRESET.settings);
    expect(back.prompts).toEqual(DEFAULT_PRESET.prompts);
    // ST re-adds its four system prompts to any preset that lacks them
    expect(back.prompts_unused.map((prompt) => prompt.id)).toEqual([
      'main',
      'nsfw',
      'jailbreak',
      'enhanceDefinitions',
    ]);
    expect(back.extensions).toEqual({ ...DEFAULT_PRESET.extensions, regex_scripts: [] });
  });
});

describe('DEFAULT_PRESET', () => {
  it('cannot be corrupted by a caller', () => {
    expect(() => {
      DEFAULT_PRESET.settings.temperature = 2;
    }).toThrow(TypeError);
    expect(() => {
      DEFAULT_PRESET.prompts.push({ id: 'x', name: 'x', enabled: true, role: 'user' });
    }).toThrow(TypeError);
    expect(Object.isFrozen(DEFAULT_PRESET.extensions['tavern_helper'])).toBe(true);
    const copy = structuredClone(DEFAULT_PRESET);
    copy.settings.temperature = 2;
    expect(DEFAULT_PRESET.settings.temperature).toBe(1);
    expect(DEFAULT_PRESET.prompts.every(isPresetPlaceholderPrompt)).toBe(true);
  });
});

describe('tavern regex', () => {
  it('round-trips a script and keeps ST-only fields from the one it replaces', () => {
    const st = {
      id: 'r',
      scriptName: 'S',
      findRegex: 'a',
      replaceString: 'b',
      trimStrings: [],
      placement: [1, 3, 5],
      disabled: true,
      markdownOnly: false,
      promptOnly: true,
      runOnEdit: false,
      substituteRegex: 1,
      minDepth: 0,
      maxDepth: null,
    };
    const regex = toTavernRegex(st);
    expect(regex).toMatchObject({
      enabled: false,
      source: { user_input: true, ai_output: false, slash_command: true, world_info: true },
      destination: { display: false, prompt: true },
      min_depth: 0,
      max_depth: null,
    });
    expect(fromTavernRegex(regex, st)).toEqual(st);
    expect(fromTavernRegex(regex)).toEqual({ ...st, substituteRegex: 0 });
  });

  it('lets a script that is still in ST shape through fromPreset', () => {
    const stShaped = { id: 'r', scriptName: 'S', placement: [2] };
    const st = fromPreset({ extensions: { regex_scripts: [stShaped] } });
    expect(record(st['extensions'])['regex_scripts']).toEqual([stShaped]);
  });
});

function record(value: unknown): Dict {
  return typeof value === 'object' && value !== null ? (value as Dict) : {};
}
