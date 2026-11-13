// ST extensions/regex/engine.js 的枚举与脚本类型。

export const REGEX_PLACEMENT = {
  /** @deprecated */
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  // 4 - sendAs (legacy)
  WORLD_INFO: 5,
  REASONING: 6,
} as const;
export type RegexPlacementValue = (typeof REGEX_PLACEMENT)[keyof typeof REGEX_PLACEMENT];

export const SUBSTITUTE_FIND_REGEX = { NONE: 0, RAW: 1, ESCAPED: 2 } as const;

/** 顺序即优先级：Object.values → [GLOBAL, PRESET, SCOPED] */
export const REGEX_SCRIPT_TYPES = { GLOBAL: 0, PRESET: 2, SCOPED: 1 } as const;
export const REGEX_SCRIPT_TYPE_UNKNOWN = -1;

export interface RegexScript {
  id?: string;
  scriptName?: string;
  findRegex?: string;
  replaceString?: string;
  trimStrings?: string[];
  placement?: number[];
  disabled?: boolean;
  markdownOnly?: boolean;
  promptOnly?: boolean;
  runOnEdit?: boolean;
  substituteRegex?: number | boolean;
  minDepth?: number | null;
  maxDepth?: number | null;
  [key: string]: unknown;
}

export interface RegexParams {
  characterOverride?: string | undefined;
  isMarkdown?: boolean | undefined;
  isPrompt?: boolean | undefined;
  isEdit?: boolean | undefined;
  depth?: number | null | undefined;
}

/** 脚本来源（对应 extension_settings.regex / 角色卡 regex_scripts / 预设 extensions.regex_scripts） */
export interface RegexScriptSources {
  global?: readonly RegexScript[] | undefined;
  scoped?: readonly RegexScript[] | undefined;
  preset?: readonly RegexScript[] | undefined;
  /** extension_settings.character_allowed_regex.includes(avatar) */
  scopedAllowed?: boolean | undefined;
  /** extension_settings.preset_allowed_regex[apiId].includes(presetName) */
  presetAllowed?: boolean | undefined;
  /** extension_settings.disabledExtensions.includes('regex') */
  extensionDisabled?: boolean | undefined;
}
