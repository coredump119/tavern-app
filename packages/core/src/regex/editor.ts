/**
 * ST extensions/regex/index.js editor-side data rules (DEV_NOTES §9.25): new-script defaults,
 * normalization from the form, settings migration, import / export, allow lists.
 */
import { uuidv4 } from '../tags/index.js';
import { RegexEngine } from './engine.js';
import {
  REGEX_PLACEMENT,
  REGEX_SCRIPT_TYPES,
  SUBSTITUTE_FIND_REGEX,
  type RegexScript,
} from './types.js';

export const REGEX_PLACEMENT_OPTIONS = [
  { value: REGEX_PLACEMENT.USER_INPUT, label: '用户输入' },
  { value: REGEX_PLACEMENT.AI_OUTPUT, label: 'AI 输出' },
  { value: REGEX_PLACEMENT.SLASH_COMMAND, label: '斜杠命令' },
  { value: REGEX_PLACEMENT.WORLD_INFO, label: '世界书' },
  { value: REGEX_PLACEMENT.REASONING, label: '推理' },
] as const;

export const REGEX_SUBSTITUTE_OPTIONS = [
  { value: SUBSTITUTE_FIND_REGEX.NONE, label: '不替换' },
  { value: SUBSTITUTE_FIND_REGEX.RAW, label: '原样' },
  { value: SUBSTITUTE_FIND_REGEX.ESCAPED, label: '转义' },
] as const;

export const REGEX_TYPE_LABELS: Record<number, string> = {
  [REGEX_SCRIPT_TYPES.GLOBAL]: '全局',
  [REGEX_SCRIPT_TYPES.PRESET]: '预设',
  [REGEX_SCRIPT_TYPES.SCOPED]: '角色',
};

/** A script with every field present (what the editor binds to). */
export interface RegexScriptFull {
  id: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  placement: number[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  substituteRegex: number;
  minDepth: number | null;
  maxDepth: number | null;
}

/** `onRegexEditorOpenClick` without an id: display-only + run on edit + USER_INPUT checked */
export function newRegexScript(uuid: () => string = uuidv4): RegexScriptFull {
  return {
    id: uuid(),
    scriptName: '',
    findRegex: '',
    replaceString: '',
    trimStrings: [],
    placement: [REGEX_PLACEMENT.USER_INPUT],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: SUBSTITUTE_FIND_REGEX.NONE,
    minDepth: null,
    maxDepth: null,
  };
}

const depth = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
};

/** Fill defaults for a stored script so the editor can bind to it. */
export function toFullScript(script: RegexScript, uuid: () => string = uuidv4): RegexScriptFull {
  return {
    id: script.id || uuid(),
    scriptName: script.scriptName ?? '',
    findRegex: script.findRegex ?? '',
    replaceString: script.replaceString ?? '',
    trimStrings: Array.isArray(script.trimStrings) ? [...script.trimStrings] : [],
    placement: Array.isArray(script.placement) ? [...script.placement] : [],
    disabled: !!script.disabled,
    markdownOnly: !!script.markdownOnly,
    promptOnly: !!script.promptOnly,
    runOnEdit: !!script.runOnEdit,
    substituteRegex:
      typeof script.substituteRegex === 'boolean'
        ? script.substituteRegex
          ? SUBSTITUTE_FIND_REGEX.RAW
          : SUBSTITUTE_FIND_REGEX.NONE
        : Number(script.substituteRegex ?? SUBSTITUTE_FIND_REGEX.NONE),
    minDepth: depth(script.minDepth),
    maxDepth: depth(script.maxDepth),
  };
}

export interface RegexSaveWarnings {
  /** empty name: ST refuses to save */
  nameMissing: boolean;
  /** ST saves but warns */
  findMissing: boolean;
  placementMissing: boolean;
}

/** What `saveRegexScript` would complain about. */
export function regexSaveWarnings(script: RegexScriptFull): RegexSaveWarnings {
  return {
    nameMissing: !script.scriptName.trim(),
    findMissing: script.findRegex.length === 0,
    placementMissing: script.placement.length === 0,
  };
}

/** The form → stored object (ST newRegexScript in the editor's save branch) */
export function normalizeRegexScript(script: RegexScriptFull): RegexScriptFull {
  return {
    ...script,
    scriptName: script.scriptName,
    trimStrings: script.trimStrings.map((s) => s).filter((s) => s.length !== 0),
    placement: [...new Set(script.placement.filter((p) => !Number.isNaN(p)))],
    substituteRegex: Number(script.substituteRegex),
    minDepth: depth(script.minDepth),
    maxDepth: depth(script.maxDepth),
  };
}

/** `migrateSettings` for the global list; returns true when something changed */
export function migrateRegexScripts(scripts: RegexScript[], uuid: () => string = uuidv4): boolean {
  let changed = false;
  for (const script of scripts) {
    if (!script.id) {
      script.id = uuid();
      changed = true;
    }
    if (!Array.isArray(script.placement)) {
      script.placement = [];
      changed = true;
    }
    if (script.placement.includes(REGEX_PLACEMENT.MD_DISPLAY)) {
      script.placement =
        script.placement.length === 1
          ? Object.values(REGEX_PLACEMENT).filter((e) => e !== REGEX_PLACEMENT.MD_DISPLAY)
          : script.placement.filter((e) => e !== REGEX_PLACEMENT.MD_DISPLAY);
      script.markdownOnly = true;
      script.promptOnly = true;
      changed = true;
    }
    if (script.placement.includes(4)) {
      script.placement =
        script.placement.length === 1
          ? [REGEX_PLACEMENT.SLASH_COMMAND]
          : script.placement.filter((e) => e !== 4);
      changed = true;
    }
  }
  return changed;
}

/** `onRegexImportFileChange`: one object or an array; every script needs a name; ids are renewed */
export function importRegexScripts(raw: unknown, uuid: () => string = uuidv4): RegexScript[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const out: RegexScript[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new Error('Invalid regex object.');
    const script = { ...(item as RegexScript) };
    if (!script.scriptName) throw new Error('No script name provided.');
    script.id = uuid();
    out.push(script);
  }
  return out;
}

/** Export file name for one script (ST: `${scriptName}.json`, sanitized by the browser) */
export function regexExportFileName(script: RegexScript): string {
  const base = (script.scriptName || 'regex').replace(/[\\/:*?"<>|]+/g, '-').trim();
  return `${base || 'regex'}.json`;
}

// ---- allow lists (extension_settings) ----
export function isScopedRegexAllowed(ext: Record<string, unknown>, avatar: string | null): boolean {
  const list = ext['character_allowed_regex'];
  return !!avatar && Array.isArray(list) && list.includes(avatar);
}
export function setScopedRegexAllowed(
  ext: Record<string, unknown>,
  avatar: string,
  allowed: boolean,
): void {
  const list = Array.isArray(ext['character_allowed_regex'])
    ? (ext['character_allowed_regex'] as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      )
    : [];
  ext['character_allowed_regex'] = allowed
    ? list.includes(avatar)
      ? list
      : [...list, avatar]
    : list.filter((a) => a !== avatar);
}
export function isPresetRegexAllowed(
  ext: Record<string, unknown>,
  api: string,
  presetName: string,
): boolean {
  if (!api || !presetName) return false;
  const map = ext['preset_allowed_regex'] as Record<string, unknown> | undefined;
  const list = map?.[api];
  return Array.isArray(list) && list.includes(presetName);
}
export function setPresetRegexAllowed(
  ext: Record<string, unknown>,
  api: string,
  presetName: string,
  allowed: boolean,
): void {
  if (!api || !presetName) return;
  const map =
    ext['preset_allowed_regex'] && typeof ext['preset_allowed_regex'] === 'object'
      ? (ext['preset_allowed_regex'] as Record<string, unknown>)
      : {};
  const list = Array.isArray(map[api])
    ? (map[api] as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  map[api] = allowed
    ? list.includes(presetName)
      ? list
      : [...list, presetName]
    : list.filter((n) => n !== presetName);
  ext['preset_allowed_regex'] = map;
}

/** The editor's live test: run the form's regex over sample text with gating flags off (ST updateTestResult) */
export function testRegexScript(
  engine: RegexEngine,
  script: RegexScriptFull,
  text: string,
): string {
  return engine.runRegexScript(
    {
      ...normalizeRegexScript(script),
      disabled: false,
      promptOnly: false,
      markdownOnly: false,
      runOnEdit: false,
      minDepth: null,
      maxDepth: null,
    },
    text,
  );
}
