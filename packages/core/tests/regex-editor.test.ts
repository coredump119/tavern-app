import { describe, expect, it } from 'vitest';
import {
  MacroEngine,
  REGEX_PLACEMENT,
  RegexEngine,
  importRegexScripts,
  isPresetRegexAllowed,
  isScopedRegexAllowed,
  migrateRegexScripts,
  newRegexScript,
  normalizeRegexScript,
  regexExportFileName,
  regexSaveWarnings,
  setPresetRegexAllowed,
  setScopedRegexAllowed,
  testRegexScript,
  toFullScript,
  type RegexScript,
} from '../src/index.js';

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

describe('regex editor data rules (ST extensions/regex)', () => {
  it('new script defaults match the ST editor', () => {
    const s = newRegexScript(() => 'u1');
    expect(s).toMatchObject({
      id: 'u1',
      markdownOnly: true,
      runOnEdit: true,
      promptOnly: false,
      disabled: false,
      placement: [REGEX_PLACEMENT.USER_INPUT],
      substituteRegex: 0,
      minDepth: null,
      maxDepth: null,
    });
    expect(regexSaveWarnings(s)).toEqual({
      nameMissing: true,
      findMissing: true,
      placementMissing: false,
    });
  });

  it('toFullScript fills defaults and maps legacy boolean substituteRegex / string depths', () => {
    const full = toFullScript({
      scriptName: 'x',
      substituteRegex: true,
      minDepth: '3' as unknown as number,
    });
    expect(full.id).toBeTruthy();
    expect(full.substituteRegex).toBe(1);
    expect(full.minDepth).toBe(3);
    expect(full.placement).toEqual([]);
    expect(full.trimStrings).toEqual([]);
  });

  it('normalize drops empty trim strings, NaN placements and turns blank depth into null', () => {
    const s = normalizeRegexScript({
      ...newRegexScript(() => 'u'),
      trimStrings: ['a', '', 'b'],
      placement: [1, NaN, 2, 1],
      minDepth: '' as unknown as number,
      maxDepth: 4,
      substituteRegex: '2' as unknown as number,
    });
    expect(s.trimStrings).toEqual(['a', 'b']);
    expect(s.placement).toEqual([1, 2]);
    expect(s.minDepth).toBeNull();
    expect(s.maxDepth).toBe(4);
    expect(s.substituteRegex).toBe(2);
  });

  it('migrates legacy MD_DISPLAY / sendAs placements and missing ids like ST', () => {
    const scripts: RegexScript[] = [
      { scriptName: 'md only', placement: [0] },
      { id: 'k', scriptName: 'md + ai', placement: [0, 2] },
      { id: 'j', scriptName: 'sendAs only', placement: [4] },
      { id: 'i', scriptName: 'ok', placement: [2] },
      { id: 'h', scriptName: 'no placement' },
    ];
    expect(migrateRegexScripts(scripts, ids())).toBe(true);
    expect(scripts[0]!.id).toBe('id-1');
    expect(scripts[0]!.placement).toEqual([1, 2, 3, 5, 6]);
    expect(scripts[0]).toMatchObject({ markdownOnly: true, promptOnly: true });
    expect(scripts[1]!.placement).toEqual([2]);
    expect(scripts[2]!.placement).toEqual([3]);
    expect(scripts[4]!.placement).toEqual([]);
    expect(migrateRegexScripts(scripts, ids())).toBe(false);
  });

  it('import accepts one object or an array, requires names and renews ids', () => {
    const out = importRegexScripts([{ id: 'old', scriptName: 'a' }, { scriptName: 'b' }], ids());
    expect(out.map((s) => s.id)).toEqual(['id-1', 'id-2']);
    expect(importRegexScripts({ scriptName: 'solo' }, ids())[0]!.scriptName).toBe('solo');
    expect(() => importRegexScripts({ findRegex: '/x/' })).toThrow('No script name');
    expect(() => importRegexScripts(['nope'])).toThrow('Invalid regex object');
    expect(regexExportFileName({ scriptName: 'a/b: c' })).toBe('a-b- c.json');
    expect(regexExportFileName({})).toBe('regex.json');
  });

  it('allow lists for scoped and preset scripts', () => {
    const ext: Record<string, unknown> = {};
    expect(isScopedRegexAllowed(ext, 'Sera.png')).toBe(false);
    setScopedRegexAllowed(ext, 'Sera.png', true);
    setScopedRegexAllowed(ext, 'Sera.png', true);
    expect(ext['character_allowed_regex']).toEqual(['Sera.png']);
    setScopedRegexAllowed(ext, 'Sera.png', false);
    expect(ext['character_allowed_regex']).toEqual([]);
    setPresetRegexAllowed(ext, 'openai', 'Default', true);
    expect(isPresetRegexAllowed(ext, 'openai', 'Default')).toBe(true);
    expect(isPresetRegexAllowed(ext, 'textgenerationwebui', 'Default')).toBe(false);
    setPresetRegexAllowed(ext, 'openai', 'Default', false);
    expect((ext['preset_allowed_regex'] as Record<string, string[]>)['openai']).toEqual([]);
    setPresetRegexAllowed(ext, '', 'x', true);
    expect(Object.keys(ext['preset_allowed_regex'] as object)).toEqual(['openai']);
  });

  it('testRegexScript runs the form regardless of disabled / display-only flags', () => {
    const macro = new MacroEngine();
    const engine = new RegexEngine({
      substitute: (t) => t,
      sources: () => ({}),
    });
    void macro;
    const script = {
      ...newRegexScript(() => 'u'),
      findRegex: '/(\\w+)@/g',
      replaceString: '[$1]',
      disabled: true,
    };
    expect(testRegexScript(engine, script, 'ping sera@ bob@')).toBe('ping [sera] [bob]');
  });
});
