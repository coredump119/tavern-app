// 世界书扫描的类型与枚举，命名对齐 ST world-info.js。

export const WORLD_INFO_INSERTION_STRATEGY = {
  evenly: 0,
  character_first: 1,
  global_first: 2,
} as const;
export const WORLD_INFO_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 } as const;
export const SCAN_STATE = { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 } as const;
export type ScanState = (typeof SCAN_STATE)[keyof typeof SCAN_STATE];
export const WORLD_INFO_POSITION = {
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7,
} as const;
export const WI_ANCHOR_POSITION = { before: 0, after: 1 } as const;
export const EXTENSION_PROMPT_ROLES = { SYSTEM: 0, USER: 1, ASSISTANT: 2 } as const;
export const DEFAULT_DEPTH = 4;
export const DEFAULT_WEIGHT = 100;
export const MAX_SCAN_DEPTH = 1000;
export const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'] as const;
export const GENERATION_TYPE_TRIGGERS = [
  'normal',
  'continue',
  'impersonate',
  'swipe',
  'regenerate',
  'quiet',
] as const;
export const WORLD_INFO_METADATA_KEY = 'world_info';

/** 世界书条目（宽松：ST 文件里字段会缺失或为 null） */
export interface WIEntry {
  uid: number;
  /** 所属世界书名（加载时注入） */
  world?: string;
  key?: string[];
  keysecondary?: string[];
  comment?: string;
  content?: string;
  constant?: boolean;
  vectorized?: boolean;
  selective?: boolean;
  selectiveLogic?: number;
  order?: number;
  position?: number;
  disable?: boolean;
  ignoreBudget?: boolean;
  excludeRecursion?: boolean;
  preventRecursion?: boolean;
  matchPersonaDescription?: boolean;
  matchCharacterDescription?: boolean;
  matchCharacterPersonality?: boolean;
  matchCharacterDepthPrompt?: boolean;
  matchScenario?: boolean;
  matchCreatorNotes?: boolean;
  delayUntilRecursion?: number | boolean;
  probability?: number;
  useProbability?: boolean;
  depth?: number;
  outletName?: string;
  group?: string;
  groupOverride?: boolean;
  groupWeight?: number;
  scanDepth?: number | null;
  caseSensitive?: boolean | null;
  matchWholeWords?: boolean | null;
  useGroupScoring?: boolean | null;
  role?: number | null;
  sticky?: number | null;
  cooldown?: number | null;
  delay?: number | null;
  characterFilter?: { names?: string[]; tags?: string[]; isExclude?: boolean } | null;
  triggers?: string[];
  /** getSortedEntries 注入 */
  decorators?: string[];
  hash?: number;
  [key: string]: unknown;
}

export interface WIBook {
  entries: Record<string, WIEntry>;
  [key: string]: unknown;
}

/** getWorldInfoSettings() 的字段 */
export interface WorldInfoSettings {
  world_info_depth: number;
  world_info_min_activations: number;
  world_info_min_activations_depth_max: number;
  world_info_budget: number;
  world_info_include_names: boolean;
  world_info_recursive: boolean;
  world_info_overflow_alert: boolean;
  world_info_case_sensitive: boolean;
  world_info_match_whole_words: boolean;
  world_info_character_strategy: number;
  world_info_budget_cap: number;
  world_info_use_group_scoring: boolean;
  world_info_max_recursion_steps: number;
}

export const DEFAULT_WORLD_INFO_SETTINGS: WorldInfoSettings = {
  world_info_depth: 2,
  world_info_min_activations: 0,
  world_info_min_activations_depth_max: 0,
  world_info_budget: 25,
  world_info_include_names: true,
  world_info_recursive: false,
  world_info_overflow_alert: false,
  world_info_case_sensitive: false,
  world_info_match_whole_words: false,
  world_info_character_strategy: WORLD_INFO_INSERTION_STRATEGY.character_first,
  world_info_budget_cap: 0,
  world_info_use_group_scoring: false,
  world_info_max_recursion_steps: 0,
};

export interface WIGlobalScanData {
  trigger: string;
  personaDescription: string;
  characterDescription: string;
  characterPersonality: string;
  characterDepthPrompt: string;
  scenario: string;
  creatorNotes: string;
}

export const DEFAULT_GLOBAL_SCAN_DATA: Readonly<WIGlobalScanData> = Object.freeze({
  trigger: 'normal',
  personaDescription: '',
  characterDescription: '',
  characterPersonality: '',
  characterDepthPrompt: '',
  scenario: '',
  creatorNotes: '',
});

export interface WITimedEffect {
  hash: number;
  start: number;
  end: number;
  protected: boolean;
}
export type TimedEffectType = 'sticky' | 'cooldown' | 'delay';

export interface WIDepthEntry {
  depth: number | undefined;
  entries: string[];
  role: number;
}
export interface WIAnchoredEntry {
  position: number;
  content: string;
}

export interface WIActivated {
  worldInfoBefore: string;
  worldInfoAfter: string;
  EMEntries: WIAnchoredEntry[];
  WIDepthEntries: WIDepthEntry[];
  ANBeforeEntries: string[];
  ANAfterEntries: string[];
  outletEntries: Record<string, string[]>;
  allActivatedEntries: Set<WIEntry>;
  /**
   * Set when the token budget ran out and entries were left out. Not in ST's result (ST only logs
   * it, or toasts with `world_info_overflow_alert`); the app tells the user every time.
   */
  budgetOverflow?: { budget: number; activated: number; firstSkipped: string } | undefined;
}

export interface WIPromptResult {
  worldInfoString: string;
  worldInfoBefore: string;
  worldInfoAfter: string;
  worldInfoExamples: WIAnchoredEntry[];
  worldInfoDepth: WIDepthEntry[];
  anBefore: string[];
  anAfter: string[];
  outletEntries: Record<string, string[]>;
  allActivatedEntries: WIEntry[];
}
