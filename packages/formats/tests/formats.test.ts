import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  characterBookToWorldInfo,
  orderedPrompts,
  parsePreset,
  parseQuickReplySet,
  parseRegexScripts,
  parseWorldInfo,
  PRESET_FOLDERS,
  QuickReplySetSchema,
  REGEX_PLACEMENT,
  upgradeQuickReplySet,
  WI_POSITION,
  worldInfoEntries,
  worldInfoToCharacterBook,
  type ChatCompletionPreset,
  type PresetKind,
  type QuickReplySetV1,
} from '../src/index.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
const roundTrip = (parsed: unknown, raw: unknown) =>
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(raw);

describe('world info', () => {
  const raw = fixture('world-eldoria.json');
  it('parses ST world file losslessly', () => {
    const book = parseWorldInfo(raw);
    roundTrip(book, raw);
    const entries = worldInfoEntries(book);
    expect(entries.length).toBeGreaterThan(3);
    expect(entries[0]?.uid).toBeDefined();
    expect(entries.every((e) => Array.isArray(e.key))).toBe(true);
  });
  it('converts to a V2 character_book and back without losing ST fields', () => {
    const book = parseWorldInfo(raw);
    const cb = worldInfoToCharacterBook('Eldoria', book);
    expect(cb.name).toBe('Eldoria');
    expect(cb.entries).toHaveLength(Object.keys(book.entries).length);
    const first = cb.entries[0]!;
    expect(first.position === 'before_char' || first.position === 'after_char').toBe(true);
    expect(first.extensions).toHaveProperty('selectiveLogic');
    expect(first.use_regex).toBe(true);
    const back = characterBookToWorldInfo(cb);
    for (const [uid, e] of Object.entries(book.entries)) {
      const r = back.entries[uid]!;
      expect(r.key).toEqual(e.key);
      expect(r.content).toBe(e.content);
      expect(r.order).toBe(e.order);
      expect(r.position).toBe(e.position);
      expect(r.disable).toBe(e.disable ?? false);
      expect(r.depth).toBe(e.depth);
      expect(r.probability).toBe(e.probability);
      expect(r.group).toBe(e.group ?? '');
      expect(r.sticky).toBe(e.sticky ?? null);
    }
    expect(WI_POSITION.AT_DEPTH).toBe(4);
  });
  it('accepts wild-type quirks (null role, boolean delayUntilRecursion) and flags bad keys', () => {
    const ok = parseWorldInfo({
      entries: { '0': { uid: 0, key: ['a'], content: 'x', role: null, delayUntilRecursion: true } },
    });
    expect(ok.entries['0']?.role).toBeNull();
    expect(() => parseWorldInfo({ entries: { '0': { key: 'a', content: 'x' } } })).toThrow();
  });
});

describe('presets', () => {
  const files: Record<PresetKind, string> = {
    openai: 'presets/openai-Default.json',
    textgenerationwebui: 'presets/textgen-Default.json',
    kobold: 'presets/kobold-Deterministic.json',
    koboldhorde: 'presets/kobold-Deterministic.json',
    novel: 'presets/novel-Asper-Kayra.json',
    instruct: 'presets/instruct-ChatML.json',
    context: 'presets/context-ChatML.json',
    sysprompt: 'presets/sysprompt-Actor.json',
    reasoning: 'presets/reasoning-Blank.json',
  };
  for (const kind of Object.keys(files) as PresetKind[]) {
    it(`${kind}: ST default parses losslessly (folder ${PRESET_FOLDERS[kind]})`, () => {
      const raw = fixture(files[kind]);
      roundTrip(parsePreset(kind, raw), raw);
    });
  }
  it('chat completion prompt manager resolves the default order', () => {
    const preset = parsePreset(
      'openai',
      fixture('presets/openai-Default.json'),
    ) as ChatCompletionPreset;
    const ordered = orderedPrompts(preset);
    expect(ordered.length).toBeGreaterThan(5);
    expect(ordered[0]?.identifier).toBe('main');
    expect(ordered.map((p) => p.identifier)).toContain('chatHistory');
    expect(preset.prompts?.find((p) => p.identifier === 'chatHistory')?.marker).toBe(true);
  });
  it('instruct/context templates keep the sequences', () => {
    const inst = parsePreset('instruct', fixture('presets/instruct-ChatML.json'));
    expect(inst.input_sequence).toContain('<|im_start|>');
    const ctx = parsePreset('context', fixture('presets/context-ChatML.json'));
    expect(ctx.story_string).toContain('{{#if system}}');
  });
});

describe('regex scripts', () => {
  it('parses a list and exposes placement enums', () => {
    const scripts = parseRegexScripts([
      {
        id: 'a',
        scriptName: 's',
        findRegex: '/x/g',
        replaceString: '',
        trimStrings: [],
        placement: [REGEX_PLACEMENT.AI_OUTPUT],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
        extra: 1,
      },
    ]);
    expect(scripts[0]?.placement).toEqual([2]);
    expect((scripts[0] as Record<string, unknown>)['extra']).toBe(1);
  });
});

describe('quick replies', () => {
  it('parses the v1 default shipped by ST and upgrades it to v2', () => {
    const raw = fixture('presets/quick-replies-Default-v1.json');
    const v1 = parseQuickReplySet(raw) as QuickReplySetV1;
    roundTrip(v1, raw);
    expect(v1.quickReplySlots.length).toBeGreaterThan(0);
    const v2 = upgradeQuickReplySet(v1);
    expect(QuickReplySetSchema.safeParse(v2).success).toBe(true);
    expect(v2.qrList[0]?.message).toBe(v1.quickReplySlots[0]?.mes);
    expect(v2.idIndex).toBe(v2.qrList.length);
  });
  it('parses a v2 set losslessly', () => {
    const raw = {
      version: 2,
      name: 'Set',
      disableSend: false,
      placeBeforeInput: false,
      injectInput: false,
      color: 'rgba(0, 0, 0, 0)',
      onlyBorderColor: false,
      qrList: [
        {
          id: 1,
          showLabel: false,
          label: 'Hi',
          title: '',
          message: '/echo hi',
          contextList: [{ set: 'Other', isChained: true }],
          preventAutoExecute: true,
          isHidden: false,
          executeOnStartup: false,
          executeOnUser: false,
          executeOnAi: false,
          executeOnChatChange: false,
          executeOnGroupMemberDraft: false,
          executeOnNewChat: false,
          executeBeforeGeneration: false,
          automationId: '',
        },
      ],
      idIndex: 1,
    };
    roundTrip(parseQuickReplySet(raw), raw);
  });
});
