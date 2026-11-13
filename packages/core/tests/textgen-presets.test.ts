import { describe, expect, it } from 'vitest';
import {
  AMOUNT_GEN_DEFAULT,
  applyContextTemplate,
  applyInstructTemplate,
  applySystemPromptTemplate,
  applyTextgenPreset,
  autoFixStoryString,
  createMessageCleaner,
  getTextgenPreset,
  loadTextgenSettings,
  migrateInstructModeSettings,
  textCompletionAuthHeader,
  textgenModelKey,
  textgenSecretKey,
  trimToEndSentence,
  OOBA_DEFAULT_ORDER,
} from '../src/index.js';

describe('textgen settings / presets (ST textgen-settings.js)', () => {
  it('loads over defaults, keeps unknown keys, migrates the legacy server', () => {
    const s = loadTextgenSettings({
      textgenerationwebui_settings: { temp: 1.1, type: 'llamacpp', foo: 1 },
      api_server_textgenerationwebui: 'http://127.0.0.1:5000',
    });
    expect(s.temp).toBe(1.1);
    expect(s.type).toBe('llamacpp');
    expect(s['foo']).toBe(1);
    expect(s.top_k).toBe(40);
    expect(s.server_urls['ooba']).toBe('http://127.0.0.1:5000');
    expect(s.server_urls['llamacpp']).toBe('http://127.0.0.1:5000');
    expect(loadTextgenSettings({}).type).toBe('ooba');
  });

  it('preset body drops filtered keys and adds genamt / max_length', () => {
    const s = loadTextgenSettings({
      textgenerationwebui_settings: { type: 'tabby', tabby_model: 'x', seed: 7 },
    });
    const p = getTextgenPreset(s, 300, 4096);
    expect(p['genamt']).toBe(300);
    expect(p['max_length']).toBe(4096);
    for (const k of ['type', 'server_urls', 'tabby_model', 'seed', 'streaming', 'preset', 'n'])
      expect(k in p).toBe(false);
    expect(p['temp']).toBe(0.7);
  });

  it('selectPreset: only setting_names, null skipped, arrays repaired, extensions replaced', () => {
    const s = loadTextgenSettings({
      textgenerationwebui_settings: { extensions: { a: 1 }, temp: 2 },
    });
    const r = applyTextgenPreset(
      s,
      {
        temp: 0.9,
        top_k: null,
        not_a_setting: 5,
        sampler_priority: ['min_p'],
        logit_bias: 'bad',
        genamt: 400,
        max_length: 16384,
      },
      'P',
      { amountGen: 80, maxContext: 2048 },
    );
    expect(s['preset']).toBe('P');
    expect(s.temp).toBe(0.9);
    expect(s.top_k).toBe(40);
    expect('not_a_setting' in s).toBe(false);
    expect(s.sampler_priority[0]).toBe('min_p');
    expect(s.sampler_priority.length).toBe(new Set([...OOBA_DEFAULT_ORDER, 'min_p']).size);
    expect(s.logit_bias).toEqual([]);
    expect(s['extensions']).toEqual({});
    expect(s.json_schema).toBeNull();
    expect(r).toEqual({ amountGen: 400, maxContext: 16384, maxContextUnlocked: true });
    const r2 = applyTextgenPreset(s, {}, 'Q', { amountGen: AMOUNT_GEN_DEFAULT, maxContext: 2048 });
    expect(r2).toEqual({ amountGen: undefined, maxContext: undefined, maxContextUnlocked: false });
  });

  it('connection helpers', () => {
    expect(textgenSecretKey('ollama')).toBeNull();
    expect(textgenSecretKey('tabby')).toBe('api_key_tabby');
    expect(textCompletionAuthHeader('mancer')).toBe('X-API-KEY,bearer');
    expect(textCompletionAuthHeader('tabby')).toBe('x-api-key,bearer');
    expect(textCompletionAuthHeader('llamacpp')).toBeUndefined();
    expect(textgenModelKey('ooba')).toBe('custom_model');
    expect(textgenModelKey('koboldcpp')).toBeNull();
    expect(textgenModelKey('ollama')).toBe('ollama_model');
  });
});

describe('formatting templates', () => {
  it('instruct migration + apply + bind_to_context', () => {
    const m = migrateInstructModeSettings({
      separator_sequence: '\n',
      names: false,
      names_force_groups: true,
    });
    expect(m['output_suffix']).toBe('\n');
    expect(m['names_behavior']).toBe('force');
    expect(m['sequences_as_stop_strings']).toBe(true);
    expect('names' in m).toBe(false);
    const pu: Record<string, unknown> = {
      instruct: { enabled: false, bind_to_context: true, extra: 1 },
    };
    const bound = applyInstructTemplate(
      pu,
      { name: 'ChatML', input_sequence: '<|im_start|>user', wrap: true },
      'ChatML',
    );
    expect(bound).toBe('ChatML');
    const ins = pu['instruct'] as Record<string, unknown>;
    expect(ins['preset']).toBe('ChatML');
    expect(ins['input_sequence']).toBe('<|im_start|>user');
    expect(ins['enabled']).toBe(false); // the template does not carry `enabled`
    expect(ins['extra']).toBe(1);
    expect('name' in ins).toBe(false);
  });

  it('context apply writes globals and defaults; autoFix adds anchors to old templates', () => {
    const pu: Record<string, unknown> = { context: {}, instruct: {} };
    expect(
      applyContextTemplate(pu, { story_string: '{{description}}', chat_start: '***' }, 'X'),
    ).toBeNull();
    const ctx = pu['context'] as Record<string, unknown>;
    expect(ctx['story_string']).toBe(
      '{{#if anchorBefore}}{{anchorBefore}}\n{{/if}}{{description}}{{#if anchorAfter}}{{anchorAfter}}\n{{/if}}',
    );
    expect(ctx['names_as_stop_strings']).toBe(true);
    expect(ctx['story_string_position']).toBe(0);
    expect(pu['always_force_name2']).toBe(true);
    expect(pu['single_line']).toBe(false);
    const already = autoFixStoryString({ story_string: 'x', story_string_position: 1 });
    expect(already['story_string']).toBe('x');
  });

  it('sysprompt apply enables and copies content', () => {
    const pu: Record<string, unknown> = { sysprompt: { enabled: false } };
    applySystemPromptTemplate(pu, { name: 'Neutral', content: 'c', post_history: 'p' }, 'Neutral');
    expect(pu['sysprompt']).toEqual({
      enabled: true,
      name: 'Neutral',
      content: 'c',
      post_history: 'p',
    });
  });
});

describe('cleanUpMessage', () => {
  const make = (pu: Record<string, unknown> = {}, isInstruct = false) =>
    createMessageCleaner({
      name1: 'Yun',
      name2: 'Sera',
      isInstruct,
      powerUser: { trim_spaces: true, ...pu },
      substitute: (t) => t,
      regex: (t) => t,
    });

  it('cuts a partial stopping string at the end and trims', () => {
    expect(make()('Hello there.\nYu', { stoppingStrings: ['\nYun:'] })).toBe('Hello there.');
  });
  it('drops text after the user name and strips the char name prefix', () => {
    expect(make()('Sera: hi\nYun: no', { stoppingStrings: [] })).toBe('hi');
    expect(make()('Yun: me', { stoppingStrings: [] })).toBe('');
    expect(
      make({ allow_name2_display: true, allow_name1_display: true })('Sera: hi', {
        stoppingStrings: [],
      }),
    ).toBe('Sera: hi');
  });
  it('instruct leaks and stop sequence', () => {
    const c = make(
      {
        instruct: {
          stop_sequence: '</s>',
          input_sequence: '### Instruction:',
          output_sequence: '### Response:',
          sequences_as_stop_strings: true,
        },
      },
      true,
    );
    expect(c('### Response:\nok</s>junk', { stoppingStrings: [] })).toBe('ok');
    expect(c('fine ### Instruction: more', { stoppingStrings: [] })).toBe('fine');
  });
  it('user bias, trim_sentences, endoftext', () => {
    expect(make({ user_prompt_bias: 'B ' })('x', { stoppingStrings: [] })).toBe('B x');
    expect(make({ user_prompt_bias: 'B ' })('x', { stoppingStrings: [], isContinue: true })).toBe(
      'x',
    );
    expect(make({ trim_sentences: true })('One. Two', { stoppingStrings: [] })).toBe('One.');
    expect(make()('a<|endoftext|>b', { stoppingStrings: [] })).toBe('a');
    expect(trimToEndSentence('hi 😀 there')).toBe('hi 😀');
    expect(trimToEndSentence('no punct  ')).toBe('no punct');
  });
});
