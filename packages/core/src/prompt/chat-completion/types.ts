// Chat Completion（openai.js / PromptManager.js）常量、默认值与设置类型。

export const CHARACTER_NAMES_BEHAVIOR = {
  NONE: -1,
  DEFAULT: 0,
  COMPLETION: 1,
  CONTENT: 2,
} as const;
export const CONTINUE_POSTFIX_TYPES = {
  NONE: '',
  SPACE: ' ',
  NEWLINE: '\n',
  DOUBLE_NEWLINE: '\n\n',
} as const;
export const INJECTION_POSITION = { RELATIVE: 0, ABSOLUTE: 1 } as const;
export const CHAT_COMPLETION_SOURCES = {
  OPENAI: 'openai',
  CLAUDE: 'claude',
  OPENROUTER: 'openrouter',
  AI21: 'ai21',
  MAKERSUITE: 'makersuite',
  VERTEXAI: 'vertexai',
  MISTRALAI: 'mistralai',
  CUSTOM: 'custom',
  COHERE: 'cohere',
  PERPLEXITY: 'perplexity',
  GROQ: 'groq',
  ELECTRONHUB: 'electronhub',
  CHUTES: 'chutes',
  NANOGPT: 'nanogpt',
  DEEPSEEK: 'deepseek',
  AIMLAPI: 'aimlapi',
  XAI: 'xai',
  POLLINATIONS: 'pollinations',
  MOONSHOT: 'moonshot',
  FIREWORKS: 'fireworks',
  COMETAPI: 'cometapi',
  AZURE_OPENAI: 'azure_openai',
  ZAI: 'zai',
  SILICONFLOW: 'siliconflow',
  WORKERS_AI: 'workers_ai',
  MINIMAX: 'minimax',
} as const;

export const PROMPT_MANAGER_DUMMY_CHARACTER_ID = 100001;
export const DEFAULT_INJECTION_DEPTH = 4;
export const DEFAULT_INJECTION_ORDER = 100;

export const DEFAULT_MAIN_PROMPT =
  "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.";
export const DEFAULT_NSFW_PROMPT = '';
export const DEFAULT_JAILBREAK_PROMPT = '';
export const DEFAULT_IMPERSONATION_PROMPT =
  "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]";
export const DEFAULT_ENHANCE_DEFINITIONS_PROMPT =
  "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.";
export const DEFAULT_WI_FORMAT = '{0}';
export const DEFAULT_NEW_CHAT_PROMPT = '[Start a new Chat]';
export const DEFAULT_NEW_GROUP_CHAT_PROMPT = '[Start a new group chat. Group members: {{group}}]';
export const DEFAULT_NEW_EXAMPLE_CHAT_PROMPT = '[Example Chat]';
export const DEFAULT_CONTINUE_NUDGE_PROMPT =
  '[Continue your last message without repeating its original content.]';
export const DEFAULT_PERSONALITY_FORMAT = '{{personality}}';
export const DEFAULT_SCENARIO_FORMAT = '{{scenario}}';
export const DEFAULT_GROUP_NUDGE_PROMPT = '[Write the next reply only as {{char}}.]';

/** PromptManager 的 Prompt 字段（settings.prompts[]） */
export interface PromptDef {
  identifier: string;
  name?: string;
  role?: string;
  content?: string;
  system_prompt?: boolean;
  marker?: boolean;
  position?: string | number | false;
  injection_position?: number;
  injection_depth?: number;
  injection_order?: number;
  injection_trigger?: string[];
  forbid_overrides?: boolean;
  extension?: boolean;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface PromptOrderEntry {
  identifier: string;
  enabled: boolean;
}
export interface PromptOrder {
  character_id: number | string;
  order: PromptOrderEntry[];
}

/** oai_settings 中组装用到的子集（@tm/formats 的 ChatCompletionPreset 可直接传入） */
export interface ChatCompletionSettings {
  prompts: PromptDef[];
  prompt_order: PromptOrder[];
  openai_max_context: number;
  openai_max_tokens: number;
  chat_completion_source: string;
  names_behavior: number;
  send_if_empty: string;
  impersonation_prompt: string;
  new_chat_prompt: string;
  new_group_chat_prompt: string;
  new_example_chat_prompt: string;
  continue_nudge_prompt: string;
  group_nudge_prompt: string;
  wi_format: string;
  scenario_format: string;
  personality_format: string;
  squash_system_messages: boolean;
  continue_prefill: boolean;
  continue_postfix: string;
  assistant_prefill: string;
  [key: string]: unknown;
}

export const chatCompletionDefaultPrompts: PromptDef[] = [
  {
    name: 'Main Prompt',
    system_prompt: true,
    role: 'system',
    content: DEFAULT_MAIN_PROMPT,
    identifier: 'main',
  },
  {
    name: 'Auxiliary Prompt',
    system_prompt: true,
    role: 'system',
    content: '',
    identifier: 'nsfw',
  },
  { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
  {
    name: 'Post-History Instructions',
    system_prompt: true,
    role: 'system',
    content: '',
    identifier: 'jailbreak',
  },
  { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
  { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
  { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
  {
    identifier: 'enhanceDefinitions',
    role: 'system',
    name: 'Enhance Definitions',
    content: DEFAULT_ENHANCE_DEFINITIONS_PROMPT,
    system_prompt: true,
    marker: false,
  },
  { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
  { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
  { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
  {
    identifier: 'personaDescription',
    name: 'Persona Description',
    system_prompt: true,
    marker: true,
  },
];

export const promptManagerDefaultPromptOrder: PromptOrderEntry[] = [
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
  { identifier: 'chatHistory', enabled: true },
  { identifier: 'jailbreak', enabled: true },
];

/** 等价于 ST default_settings 中组装相关字段 + 全局策略下的默认 prompt_order */
export function defaultChatCompletionSettings(): ChatCompletionSettings {
  return {
    prompts: structuredClone(chatCompletionDefaultPrompts),
    prompt_order: [
      {
        character_id: PROMPT_MANAGER_DUMMY_CHARACTER_ID,
        order: structuredClone(promptManagerDefaultPromptOrder),
      },
    ],
    openai_max_context: 4095,
    openai_max_tokens: 300,
    chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI,
    names_behavior: CHARACTER_NAMES_BEHAVIOR.DEFAULT,
    send_if_empty: '',
    impersonation_prompt: DEFAULT_IMPERSONATION_PROMPT,
    new_chat_prompt: DEFAULT_NEW_CHAT_PROMPT,
    new_group_chat_prompt: DEFAULT_NEW_GROUP_CHAT_PROMPT,
    new_example_chat_prompt: DEFAULT_NEW_EXAMPLE_CHAT_PROMPT,
    continue_nudge_prompt: DEFAULT_CONTINUE_NUDGE_PROMPT,
    group_nudge_prompt: DEFAULT_GROUP_NUDGE_PROMPT,
    wi_format: DEFAULT_WI_FORMAT,
    scenario_format: DEFAULT_SCENARIO_FORMAT,
    personality_format: DEFAULT_PERSONALITY_FORMAT,
    squash_system_messages: false,
    continue_prefill: false,
    continue_postfix: CONTINUE_POSTFIX_TYPES.SPACE,
    assistant_prefill: '',
  };
}

/** 发送给 API 的消息（ChatCompletion.getChat 的元素） */
export interface ChatCompletionMessage {
  role: string;
  content: string | unknown[];
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  signature?: string;
  reasoning?: string;
}
