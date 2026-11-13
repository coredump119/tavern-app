/**
 * 对拍场景：同一份数据既写进真实 ST 的 data 目录，又喂给 @tm/core 回放。
 * 所有字段都是 ST 的原生格式（角色卡 V2、chat jsonl 消息、worlds/*.json 条目、oai_settings、power_user）。
 */

export interface ScenarioCharacter {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  creator_notes?: string;
  alternate_greetings?: string[];
  tags?: string[];
  /** data.extensions.world：角色绑定的世界书名 */
  world?: string;
  depth_prompt?: { prompt: string; depth: number; role: string };
  talkativeness?: number;
}

export interface ScenarioMessage {
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  mes: string;
  send_date?: string;
  extra?: Record<string, unknown>;
  swipes?: string[];
  swipe_id?: number;
  original_avatar?: string;
  [key: string]: unknown;
}

export type ScenarioWiEntry = Record<string, unknown> & { key?: string[]; content?: string };

export interface Scenario {
  name: string;
  /** 默认 'User' */
  userName?: string;
  character: ScenarioCharacter;
  /** 聊天记录（不含新输入）；至少一条，避免 ST 自动生成开场白 */
  chat: ScenarioMessage[];
  /** chat 文件头里的 chat_metadata（作者注释等） */
  chatMetadata?: Record<string, unknown>;
  /** worlds/<name>.json，entries 由模板补全 */
  worlds?: Record<string, ScenarioWiEntry[]>;
  /** world_info.globalSelect */
  globalBooks?: string[];
  worldInfoSettings?: Record<string, unknown>;
  /** oai_settings 覆盖（预设参数、prompts/prompt_order 等） */
  oai?: Record<string, unknown>;
  /** power_user 覆盖（persona、pin/strip examples、custom_stopping_strings…） */
  powerUser?: Record<string, unknown>;
  /** extension_settings.note 覆盖 */
  note?: Record<string, unknown>;
  /** extension_settings.regex（全局正则脚本） */
  regex?: unknown[];
  /** 新输入（#send_textarea） */
  input: string;
  /** Generate 类型；默认 normal */
  type?: 'normal' | 'continue' | 'impersonate' | 'regenerate' | 'swipe' | 'quiet';
  /** type 为 quiet 时的 quiet_prompt */
  quietPrompt?: string;
}

/** ST world-info.js newWorldInfoEntryTemplate（DEFAULT_DEPTH 4、DEFAULT_WEIGHT 100、AND_ANY 0） */
export const WI_ENTRY_TEMPLATE = {
  key: [],
  keysecondary: [],
  comment: '',
  content: '',
  constant: false,
  vectorized: false,
  selective: true,
  selectiveLogic: 0,
  addMemo: false,
  order: 100,
  position: 0,
  disable: false,
  ignoreBudget: false,
  excludeRecursion: false,
  preventRecursion: false,
  matchPersonaDescription: false,
  matchCharacterDescription: false,
  matchCharacterPersonality: false,
  matchCharacterDepthPrompt: false,
  matchScenario: false,
  matchCreatorNotes: false,
  delayUntilRecursion: 0,
  probability: 100,
  useProbability: true,
  depth: 4,
  outletName: '',
  group: '',
  groupOverride: false,
  groupWeight: 100,
  scanDepth: null,
  caseSensitive: null,
  matchWholeWords: null,
  useGroupScoring: null,
  automationId: '',
  role: 0,
  sticky: null,
  cooldown: null,
  delay: null,
  characterFilter: { isExclude: false, names: [], tags: [] },
  triggers: [],
} as const;

export function wiBook(entries: ScenarioWiEntry[]): {
  entries: Record<string, Record<string, unknown>>;
} {
  const out: Record<string, Record<string, unknown>> = {};
  entries.forEach((e, i) => {
    out[String(i)] = { uid: i, ...structuredClone(WI_ENTRY_TEMPLATE), ...e };
  });
  return { entries: out };
}

/**
 * ST openai.js default_settings 中组装/请求相关字段（default/content/settings.json 里缺的由前端补默认值，
 * 这里显式写全，让两边读到同一份）。
 */
export const ORACLE_OAI_DEFAULTS: Record<string, unknown> = {
  temp_openai: 1.0,
  freq_pen_openai: 0,
  pres_pen_openai: 0,
  top_p_openai: 1.0,
  top_k_openai: 0,
  min_p_openai: 0,
  top_a_openai: 0,
  repetition_penalty_openai: 1,
  stream_openai: false,
  openai_max_context: 4095,
  openai_max_tokens: 300,
  send_if_empty: '',
  group_nudge_prompt: '[Write the next reply only as {{char}}.]',
  scenario_format: '[Circumstances and context of the dialogue: {{scenario}}]',
  personality_format: "[{{char}}'s personality: {{personality}}]",
  wi_format: '{0}',
  openai_model: 'gpt-4-turbo',
  chat_completion_source: 'openai',
  max_context_unlocked: false,
  show_external_models: false,
  assistant_prefill: '',
  assistant_impersonation: '',
  use_sysprompt: false,
  squash_system_messages: false,
  media_inlining: true,
  bypass_status_check: false,
  continue_prefill: false,
  function_calling: false,
  names_behavior: 0,
  continue_postfix: ' ',
  custom_prompt_post_processing: '',
  show_thoughts: true,
  reasoning_effort: 'auto',
  verbosity: 'auto',
  enable_web_search: false,
  request_images: false,
  request_image_aspect_ratio: '',
  request_image_resolution: '',
  seed: -1,
  n: 1,
  bind_preset_to_connection: true,
};

export const ORACLE_USER_AVATAR = 'user-default.png';
export const ORACLE_CHAT_NAME = 'oracle';
export const ORACLE_PROXY_PASSWORD = 'oracle';

export function avatarFor(sc: Scenario): string {
  return `oracle_${sc.name.replace(/[^a-z0-9]+/gi, '_')}.png`;
}
