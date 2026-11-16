/** Build the @tm/core CoreState snapshot from the open chat + settings.json (mirrors tools/st-oracle replay.ts). */
import {
  AMOUNT_GEN_DEFAULT,
  TC_MAX_CONTEXT_DEFAULT,
  createVariableScopes,
  getTextGenModel,
  loadTextgenSettings,
  type CharacterLike,
  type ChatMessageLike,
  type CoreState,
  type GroupLike,
} from '@tm/core';

/** Who the chat is with: one character, or a group (members = flattened cards of present members). */
export interface ChatSubject {
  character: CharacterLike | null;
  group?: GroupLike | null | undefined;
  members?: readonly CharacterLike[] | undefined;
  /** index into `members` of the member being generated; null / undefined when idle (ST name2 = '') */
  memberIndex?: number | null | undefined;
}

export interface CoreStateInput {
  userName: string;
  subject: ChatSubject;
  chat: ChatMessageLike[];
  chatMetadata: Record<string, unknown>;
  settings: Record<string, unknown>;
  isMobile?: boolean;
}

/** settings.json `main_api`; only Chat Completion and Text Completion (textgenerationwebui) are wired */
export function mainApiOf(settings: Record<string, unknown> | null | undefined): string {
  return String(settings?.['main_api'] ?? 'openai');
}

/** Context / response budget for the active API (ST: oai_settings vs top-level max_context / amount_gen). */
export function tokenBudgetOf(settings: Record<string, unknown>): {
  maxContext: number;
  maxResponse: number;
} {
  if (mainApiOf(settings) === 'openai') {
    const oai = (settings['oai_settings'] as Record<string, unknown> | undefined) ?? {};
    return {
      maxContext: Number(oai['openai_max_context'] ?? 4095),
      maxResponse: Number(oai['openai_max_tokens'] ?? 300),
    };
  }
  return {
    maxContext: Number(settings['max_context'] ?? TC_MAX_CONTEXT_DEFAULT),
    maxResponse: Number(settings['amount_gen'] ?? AMOUNT_GEN_DEFAULT),
  };
}

/** The character the prompt is built for (group: the drafted member), or null when idle in a group. */
export function activeCharacter(subject: ChatSubject): CharacterLike | null {
  if (subject.group) {
    const i = subject.memberIndex;
    return i === null || i === undefined ? null : (subject.members?.[i] ?? null);
  }
  return subject.character;
}

/** ST global variables (`extension_settings.variables.global`), read by `{{getglobalvar}}` */
function globalVariables(settings: Record<string, unknown>): Record<string, unknown> {
  const extensions = settings['extension_settings'] as
    { variables?: { global?: Record<string, unknown> } } | undefined;
  return extensions?.variables?.global ?? {};
}

export function buildCoreState(input: CoreStateInput): CoreState {
  const pu = (input.settings['power_user'] as Record<string, unknown> | undefined) ?? {};
  const oai = (input.settings['oai_settings'] as Record<string, unknown> | undefined) ?? {};
  const mainApi = mainApiOf(input.settings);
  const { maxContext, maxResponse } = tokenBudgetOf(input.settings);
  const model =
    mainApi === 'openai'
      ? String(oai['openai_model'] ?? '')
      : String(getTextGenModel(loadTextgenSettings(input.settings)) ?? '');
  const { subject } = input;
  const group = subject.group ?? null;
  const characters: CharacterLike[] = group
    ? [...(subject.members ?? [])]
    : subject.character
      ? [subject.character]
      : [];
  const characterId = group
    ? subject.memberIndex === null || subject.memberIndex === undefined
      ? undefined
      : subject.memberIndex
    : subject.character
      ? 0
      : undefined;
  const charName = characterId === undefined ? '' : (characters[characterId]?.name ?? '');
  return {
    userName: input.userName,
    charName,
    characters,
    characterId,
    groups: group ? [group] : [],
    selectedGroup: group ? group.id : null,
    chat: input.chat,
    chatMetadata: input.chatMetadata,
    variables: createVariableScopes(input.chatMetadata, globalVariables(input.settings)),
    mainApi,
    model,
    powerUser: {
      ...(pu as object),
      // a settings.json that never went through ST may lack these objects; the pipelines read into them
      instruct: (pu['instruct'] ?? {}) as CoreState['powerUser']['instruct'],
      sysprompt: (pu['sysprompt'] ?? {}) as CoreState['powerUser']['sysprompt'],
      context: (pu['context'] ?? {}) as CoreState['powerUser']['context'],
      prefer_character_prompt: !!pu['prefer_character_prompt'],
      prefer_character_jailbreak: !!pu['prefer_character_jailbreak'],
      collapse_newlines: !!pu['collapse_newlines'],
      persona_description: String(pu['persona_description'] ?? ''),
    } as CoreState['powerUser'],
    tokens: {
      maxContext: () => maxContext,
      maxResponse: () => maxResponse,
      maxPrompt: () => maxContext - maxResponse,
    },
    extensionPrompts: {},
    isMobile: !!input.isMobile,
    lastGenerationType: '',
    input: '',
    firstDisplayedMessageId: null,
    bannedWords: [],
  };
}
