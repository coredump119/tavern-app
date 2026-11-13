// 核心引擎运行时状态快照：由宿主（app）在每次调用时组装，core 本身不持有全局状态。
// 字段命名尽量贴近 ST，便于对拍时对照 script.js / power-user.js。

export interface ChatMessageLike {
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  mes: string;
  send_date?: string | number;
  swipes?: string[];
  swipe_id?: number;
  [key: string]: unknown;
}

export interface CharacterLike {
  name: string;
  avatar: string;
  chat?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  mes_example?: string;
  first_mes?: string;
  /** 可能是字符串 "0.5"（ST 卡片怪癖） */
  talkativeness?: number | string;
  data?: {
    system_prompt?: string;
    post_history_instructions?: string;
    character_version?: string;
    creator_notes?: string;
    alternate_greetings?: string[];
    extensions?: { depth_prompt?: { prompt?: string; depth?: number; role?: string } } & Record<
      string,
      unknown
    >;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** ST group_generation_mode */
export const GROUP_GENERATION_MODE = { SWAP: 0, APPEND: 1, APPEND_DISABLED: 2 } as const;

/** ST group_activation_strategy */
export const GROUP_ACTIVATION_STRATEGY = { NATURAL: 0, LIST: 1, MANUAL: 2, POOLED: 3 } as const;

export interface GroupLike {
  id: string;
  chat_id?: string | undefined;
  members: string[];
  disabled_members?: string[] | undefined;
  activation_strategy?: number | undefined;
  allow_self_responses?: boolean | undefined;
  auto_mode_delay?: number | undefined;
  generation_mode?: number | undefined;
  generation_mode_join_prefix?: string | undefined;
  generation_mode_join_suffix?: string | undefined;
  [key: string]: unknown;
}

/** ST names_behavior_types */
export const NAMES_BEHAVIOR = { NONE: 'none', FORCE: 'force', ALWAYS: 'always' } as const;

export interface InstructSettings {
  enabled: boolean;
  wrap?: boolean;
  macro?: boolean;
  names_behavior?: string;
  skip_examples?: boolean;
  story_string_prefix?: string;
  story_string_suffix?: string;
  input_sequence?: string;
  input_suffix?: string;
  output_sequence?: string;
  output_suffix?: string;
  system_sequence?: string;
  system_suffix?: string;
  first_output_sequence?: string;
  last_output_sequence?: string;
  first_input_sequence?: string;
  last_input_sequence?: string;
  last_system_sequence?: string;
  stop_sequence?: string;
  user_alignment_message?: string;
  [key: string]: unknown;
}

export interface SyspromptSettings {
  enabled: boolean;
  content?: string;
  [key: string]: unknown;
}

export interface ContextSettings {
  story_string?: string;
  chat_start?: string;
  example_separator?: string;
  [key: string]: unknown;
}

/** 变量作用域 API，对应 SillyTavern.getContext().variables.local / .global */
export interface VariableScopeApi {
  get(name: string): string | number;
  set(name: string, value: unknown): unknown;
  del(name: string): string;
  add(name: string, value: unknown): unknown;
  inc(name: string): unknown;
  dec(name: string): unknown;
  has(name: string): boolean;
}

export interface TokenBudget {
  maxContext(): number;
  maxResponse(): number;
  maxPrompt(): number;
}

export interface CoreState {
  /** name1 / name2 */
  userName: string;
  charName: string;
  characters: readonly CharacterLike[];
  /** this_chid（characters 下标），无角色时 undefined */
  characterId?: number | undefined;
  groups: readonly GroupLike[];
  /** selected_group */
  selectedGroup?: string | null | undefined;
  chat: readonly ChatMessageLike[];
  /** chat_metadata，会被就地修改（chat_id_hash、variables 等） */
  chatMetadata: Record<string, unknown>;
  variables: { local: VariableScopeApi; global: VariableScopeApi };
  mainApi: string;
  /** 当前模型名（getGeneratingModel） */
  model: string;
  powerUser: {
    instruct: InstructSettings;
    sysprompt: SyspromptSettings;
    context: ContextSettings;
    prefer_character_prompt: boolean;
    prefer_character_jailbreak: boolean;
    collapse_newlines: boolean;
    persona_description: string;
    [key: string]: unknown;
  };
  tokens: TokenBudget;
  /** extension_prompts（outlet 宏读取 CUSTOM_WI_OUTLET 键） */
  extensionPrompts: Record<string, { value?: string; [key: string]: unknown }>;
  isMobile: boolean;
  lastGenerationType: string;
  hasExtension?: ((name: string) => boolean) | undefined;
  /** #send_textarea 当前内容 */
  input: string;
  firstDisplayedMessageId: number | null;
  /** textgenerationwebui_banned_in_macros 接收器 */
  bannedWords: string[];
  locale?: string | undefined;
  /** 测试用：固定当前时间 */
  now?: (() => Date | number) | undefined;
}

/** ST inject_ids.CUSTOM_WI_OUTLET(key) */
export function customWiOutletId(key: string): string {
  return `custom_wi_outlet_${key}`;
}

/** getCurrentChatId */
export function currentChatId(state: CoreState): string | undefined {
  if (state.selectedGroup) {
    return state.groups.find((g) => g.id === state.selectedGroup)?.chat_id;
  }
  if (state.characterId !== undefined) {
    return state.characters[state.characterId]?.chat;
  }
  return undefined;
}
