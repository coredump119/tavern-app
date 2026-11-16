/**
 * Generate() for the chat page: @tm/core builds the byte-exact upstream request from settings.json +
 * character + chat (same path tools/st-oracle/src/replay.ts verifies against real ST), Rust sends it.
 * Chat Completion (main_api 'openai') and Text Completion (main_api 'textgenerationwebui', §9.19).
 */
import {
  DEFAULT_WORLD_INFO_SETTINGS,
  MacroEngine,
  OPENAI_MAX_STOP_STRINGS,
  RegexEngine,
  TOKENIZERS,
  buildChatCompletionPrompt,
  buildTextCompletionPrompt,
  buildUpstreamRequest,
  createMessageCleaner,
  createRawTextPrompt,
  createTextGenGenerationData,
  formatRawTextMessage,
  getStoppingStrings,
  getTextGenModel,
  getTextGenServer,
  loadTextgenSettings,
  textCompletionAuthHeader,
  textCompletionHeaders,
  textgenSecretKey,
  toTextCompletionUpstream,
  collectLore,
  createApplyRegex,
  createCapturingLogger,
  createGenerationParameters,
  createTokenCounter,
  extractMessageBias,
  getCharacterCardFields,
  getChatCompletionModel,
  getCustomStoppingStrings,
  getGroupNames,
  checkWorldInfo,
  getSortedEntries,
  getTokenizerModel,
  charLoreOf,
  mediaOf,
  removeMacros,
  resolveChatCompletionEndpoint,
  resolveServerTokenizerModel,
  secretRefFor,
  REGEX_PLACEMENT,
  DEFAULT_REASONING_SETTINGS,
  REASONING_TYPE,
  parseReasoningFromString,
  prepareCoreChat,
  type ApplyRegex,
  type CharacterLike,
  type ChatCompletionMessage,
  type ChatCompletionPipelineDeps,
  type ChatCompletionPipelineResult,
  type ChatCompletionSettings,
  type ChatMessageLike,
  type CoreState,
  type ExtensionPrompts,
  type GenerationSettings,
  type RegexScript,
  type RegexScriptSources,
  type TextCompletionPipelineDeps,
  type TokenCounter,
  type TokenizerBackend,
  type WIActivated,
  type WIBook,
  type WIGlobalScanData,
  type WorldInfoSettings,
  type InlineMediaDeps,
} from '@tm/core';
import { applyExtraMacros } from './extra-macros';
import { chatCompletionLogitBias } from './logit-bias';
import { withFileTexts } from './media';
import type { ChatMessage } from '@tm/formats';
import {
  dataReadText,
  tokenizerCount,
  tokenizerCountOpenAI,
  type GenerateRequest,
  type SecretRef,
  type TokenizerName,
} from '../ipc';
import {
  activeCharacter,
  buildCoreState,
  mainApiOf,
  tokenBudgetOf,
  type ChatSubject,
} from './core-state';
export type { ChatSubject } from './core-state';

export type GenType = 'normal' | 'continue' | 'regenerate' | 'swipe' | 'impersonate';

/** The parts of a prompt a script can order by name in `generateRaw` (DEV_NOTES §9.5) */
export const RAW_BUILTIN_PROMPTS = [
  'world_info_before',
  'persona_description',
  'char_description',
  'char_personality',
  'scenario',
  'world_info_after',
  'dialogue_examples',
  'chat_history',
  'user_input',
] as const;
export type RawBuiltinPrompt = (typeof RAW_BUILTIN_PROMPTS)[number];
export interface RawRolePrompt {
  role: 'system' | 'assistant' | 'user';
  content: string;
}
/** `generateRaw`: the preset's prompt order is replaced by this one */
export interface RawPromptPlan {
  order: readonly (RawBuiltinPrompt | RawRolePrompt)[];
  /** the last message of `chat` is the script's `user_input`, not chat history */
  hasUserInput: boolean;
}

export interface PipelineInput {
  root: string;
  settings: Record<string, unknown>;
  /** single character, or group + members + the drafted member */
  subject: ChatSubject;
  userName: string;
  chat: ChatMessage[];
  chatMetadata: Record<string, unknown>;
  /** `quiet`: a background generation (ST generateQuietPrompt); never streams in Chat Completion */
  type: GenType | 'quiet';
  /** Already-sent user text for `normal` (the message is in `chat`); kept for send_if_empty parity */
  textareaText: string;
  /** the instruction of a `quiet` generation */
  quietPrompt?: string | undefined;
  /** ST extension_prompts for this one request (script `injects`) */
  extensionPrompts?: ExtensionPrompts | undefined;
  /** `generateRaw`: messages on Chat Completion, one instruct-formatted text on Text Completion */
  raw?: RawPromptPlan | undefined;
  /** Chat Completion only: function tools the model may call (the app never runs them) */
  tools?: unknown[] | undefined;
  toolChoice?: string | Record<string, unknown> | undefined;
  /** Chat Completion only: structured output, `{ name, value, strict?, description? }` */
  jsonSchema?: Record<string, unknown> | undefined;
  /** DEV_NOTES §9.30: set when the current model accepts images / video / audio (`inlineMediaDeps`) */
  inlineMedia?: InlineMediaDeps | undefined;
  /** tool calling is on (DEV_NOTES §9.34 第 8 轮): stored tool calls are replayed in the history */
  canUseTools?: boolean | undefined;
  /**
   * Chat Completion only: the assembled messages, before the request is built from them. What
   * the callback changes in place is what gets sent (ST `CHAT_COMPLETION_PROMPT_READY`).
   */
  onPrompt?: ((messages: unknown[]) => Promise<void>) | undefined;
}

export interface PreparedGeneration {
  request: GenerateRequest;
  secret: SecretRef;
  source: string;
  model: string;
  warnings: string[];
  /** getStoppingStrings(isImpersonate, isContinue) for cleanUpMessage */
  stoppingStrings: string[];
}

/** Shared macro/regex context for one chat (also used by the renderer and by sendMessageAsUser). */
export interface ChatContext {
  state: CoreState;
  engine: MacroEngine;
  substitute: (t: string, charName?: string) => string;
  regex: RegexEngine;
  applyRegex: ApplyRegex;
  regexUserInput: (t: string) => string;
  regexAiOutput: (t: string) => string;
  /** ST cleanUpMessage for the active API (streaming display and the saved reply) */
  cleanUp: (
    text: string,
    opts: {
      isImpersonate?: boolean;
      isContinue?: boolean;
      displayIncompleteSentences?: boolean;
      stoppingStrings: readonly string[];
    },
  ) => string;
}

/**
 * ST regex engine `getScriptsByType` sources (DEV_NOTES §9.22): global extension scripts, the active
 * preset's `extensions.regex_scripts` (allowed per API + preset name) and the character card's
 * `data.extensions.regex_scripts` (allowed per avatar).
 */
export function regexSourcesFor(
  settings: Record<string, unknown>,
  character: CharacterLike | null,
): RegexScriptSources {
  const ext = (settings['extension_settings'] as Record<string, unknown> | undefined) ?? {};
  const api = mainApiOf(settings);
  const bucket =
    api === 'openai'
      ? ((settings['oai_settings'] as Record<string, unknown> | undefined) ?? {})
      : ((settings['textgenerationwebui_settings'] as Record<string, unknown> | undefined) ?? {});
  const presetName = String(
    api === 'openai' ? (bucket['preset_settings_openai'] ?? '') : (bucket['preset'] ?? ''),
  );
  const presetExt = (bucket['extensions'] as Record<string, unknown> | undefined) ?? {};
  const allowedPresets = (ext['preset_allowed_regex'] as Record<string, unknown> | undefined) ?? {};
  const presetAllowedList = allowedPresets[api];
  const cardExt =
    ((character?.data as Record<string, unknown> | undefined)?.['extensions'] as
      Record<string, unknown> | undefined) ?? {};
  const allowedChars = ext['character_allowed_regex'];
  const disabled = ext['disabledExtensions'];
  return {
    global: (ext['regex'] as RegexScript[] | undefined) ?? [],
    preset: Array.isArray(presetExt['regex_scripts'])
      ? (presetExt['regex_scripts'] as RegexScript[])
      : [],
    presetAllowed: Array.isArray(presetAllowedList) && presetAllowedList.includes(presetName),
    scoped: Array.isArray(cardExt['regex_scripts'])
      ? (cardExt['regex_scripts'] as RegexScript[])
      : [],
    scopedAllowed:
      !!character && Array.isArray(allowedChars) && allowedChars.includes(character.avatar),
    extensionDisabled: Array.isArray(disabled) && disabled.includes('regex'),
  };
}

export function createChatContext(
  settings: Record<string, unknown>,
  subject: ChatSubject,
  userName: string,
  chatInput: readonly ChatMessage[],
  chatMetadata: Record<string, unknown>,
): ChatContext {
  const chat = chatInput as unknown as ChatMessageLike[];
  const pu = (settings['power_user'] as Record<string, unknown> | undefined) ?? {};
  const logs: never[] = [];
  const engine = new MacroEngine({ logger: createCapturingLogger(logs) });
  applyExtraMacros(engine.registry);
  const state = buildCoreState({
    userName,
    subject,
    chat,
    chatMetadata,
    settings,
    isMobile: typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0,
  });
  const substitute = (t: string, charName?: string) =>
    charName
      ? engine.substituteParams(t, { ...state, charName })
      : engine.substituteParams(t, state);
  const sources = regexSourcesFor(settings, activeCharacter(subject));
  const regex = new RegexEngine({
    substitute: (t, opts) => engine.substituteParams(t, state, opts),
    sources: () => sources,
  });
  const applyRegex = createApplyRegex(regex);
  return {
    state,
    engine,
    substitute,
    regex,
    applyRegex,
    regexUserInput: (t) => regex.getRegexedString(t, REGEX_PLACEMENT.USER_INPUT, {}),
    regexAiOutput: (t) => regex.getRegexedString(t, REGEX_PLACEMENT.AI_OUTPUT, {}),
    cleanUp: createMessageCleaner({
      name1: userName,
      name2: state.charName,
      isInstruct:
        !!(pu['instruct'] as { enabled?: boolean } | undefined)?.enabled &&
        mainApiOf(settings) !== 'openai',
      powerUser: pu as Parameters<typeof createMessageCleaner>[0]['powerUser'],
      substitute,
      regex: (t, isImpersonate) =>
        regex.getRegexedString(
          t,
          isImpersonate ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
          {},
        ),
    }),
  };
}

/** ST sendMessageAsUser(): regex → macros → bias extraction. Returns the message to append. */
export function buildUserMessage(
  ctx: ChatContext,
  userName: string,
  text: string,
  forceAvatar?: string,
): ChatMessage {
  const bias = ctx.substitute(extractMessageBias(text));
  let mes = ctx.substitute(ctx.regexUserInput(text));
  const extra: Record<string, unknown> = { bias: bias || null, isSmallSys: false };
  if (bias) mes = removeMacros(mes);
  return {
    name: userName,
    is_user: true,
    is_system: false,
    send_date: new Date().toISOString(),
    mes,
    extra,
    // ST sendMessageAsUser: a persona avatar is pinned on the message
    ...(forceAvatar ? { force_avatar: forceAvatar } : {}),
  };
}

/** ST updateMessage(): regex (isEdit) → trim → bias → macros → swipes[swipe_id] kept in sync. */
export function applyEdit(
  ctx: ChatContext,
  message: ChatMessage,
  text: string,
  trimSpaces: boolean,
): ChatMessage {
  const narrator = message.extra?.type === 'narrator';
  const placement = message.is_user
    ? REGEX_PLACEMENT.USER_INPUT
    : narrator
      ? REGEX_PLACEMENT.SLASH_COMMAND
      : REGEX_PLACEMENT.AI_OUTPUT;
  let mes = ctx.regex.getRegexedString(text, placement, {
    characterOverride: narrator ? undefined : message.name,
    isEdit: true,
  });
  if (trimSpaces) mes = mes.trim();
  const bias = ctx.substitute(extractMessageBias(mes));
  mes = ctx.substitute(mes);
  if (bias) mes = removeMacros(mes);
  const extra: Record<string, unknown> = { ...(message.extra ?? {}) };
  extra['bias'] = message.is_system || message.is_user || narrator ? bias || null : null;
  const next: ChatMessage = { ...message, mes, extra: extra as ChatMessage['extra'] };
  if (typeof message.swipe_id === 'number') {
    const swipes = [...(message.swipes ?? [message.mes])];
    swipes[message.swipe_id] = mes;
    next.swipes = swipes;
  }
  return next;
}

/** ST reasoning auto-parse (MESSAGE_RECEIVED / MESSAGE_UPDATED): split a `<think>` block out of the text. */
export function autoParseReasoning(
  ctx: ChatContext,
  settings: Record<string, unknown>,
  message: ChatMessage,
): ChatMessage {
  const pu = (settings['power_user'] as Record<string, unknown> | undefined) ?? {};
  // ST ships settings.json without `reasoning`; code defaults (<think>…</think>) fill the gaps
  const r = {
    ...DEFAULT_REASONING_SETTINGS,
    ...((pu['reasoning'] as Record<string, unknown> | undefined) ?? {}),
  };
  if (!r['auto_parse']) return message;
  if (!message.mes || message.mes === '...') return message;
  if (message.extra?.reasoning) return message;
  const parsed = parseReasoningFromString(
    message.mes,
    { prefix: String(r['prefix'] ?? ''), suffix: String(r['suffix'] ?? '') },
    { trimSpaces: pu['trim_spaces'] !== false },
  );
  if (!parsed) return message;
  const changed = !!parsed.reasoning || parsed.content !== message.mes;
  if (!changed) return message;
  const extra: Record<string, unknown> = { ...(message.extra ?? {}) };
  if (parsed.reasoning) {
    extra['reasoning'] = ctx.regex.getRegexedString(
      parsed.reasoning,
      REGEX_PLACEMENT.REASONING,
      {},
    );
    extra['reasoning_type'] = REASONING_TYPE.PARSED;
  }
  const next: ChatMessage = {
    ...message,
    mes: parsed.content,
    extra: extra as ChatMessage['extra'],
  };
  // syncMesToSwipe
  if (typeof message.swipe_id === 'number' && message.swipes) {
    const swipes = [...message.swipes];
    swipes[message.swipe_id] = parsed.content;
    next.swipes = swipes;
    if (message.swipe_info?.[message.swipe_id]) {
      const info = [...message.swipe_info];
      const cur = info[message.swipe_id]!;
      info[message.swipe_id] = { ...cur, extra: { ...(cur.extra ?? {}), ...extra } };
      next.swipe_info = info;
    }
  }
  return next;
}

function tokenizerBackend(): TokenizerBackend {
  return {
    count: (name, text, model) => tokenizerCount(name as TokenizerName, text, model),
    countOpenAI: (model, messages) => tokenizerCountOpenAI(model, messages),
  };
}

type Settings = Record<string, unknown>;

function ccTokenizerModel(oai: Settings): string {
  return getTokenizerModel({
    mainApi: 'openai',
    source: String(oai['chat_completion_source']),
    openaiModel: String(oai['openai_model'] ?? ''),
    customModel: String(oai['custom_model'] ?? ''),
  });
}

function ccTokenCounter(pu: Settings, tokenizerModel: string): TokenCounter {
  return createTokenCounter(tokenizerBackend(), {
    tokenizer: Number(pu['tokenizer'] ?? TOKENIZERS.BEST_MATCH) as 99,
    tokenPadding: Number(pu['token_padding'] ?? 64),
    mainApi: 'openai',
    openaiModel: tokenizerModel,
    bestMatch: { api: 'openai' },
  });
}

function tcTokenCounter(pu: Settings, textgenType: string, model: string): TokenCounter {
  return createTokenCounter(tokenizerBackend(), {
    tokenizer: Number(pu['tokenizer'] ?? TOKENIZERS.BEST_MATCH) as 99,
    tokenPadding: Number(pu['token_padding'] ?? 64),
    mainApi: 'textgenerationwebui',
    openaiModel: '',
    // remote tokenization is not wired: best match falls back to the local heuristics (§9.19)
    bestMatch: {
      api: 'textgenerationwebui',
      textgenType,
      textgenModel: model,
      onlineStatus: 'no_connection',
    },
    textgenModelKey: model,
  });
}

/** ST getTokenCountAsync(): `text` counted with the tokenizer the selected API uses, no padding */
export function countTokens(settings: Settings, text: string): Promise<number> {
  const pu = (settings['power_user'] as Settings | undefined) ?? {};
  if (mainApiOf(settings) === 'textgenerationwebui') {
    const tg = loadTextgenSettings(settings);
    return tcTokenCounter(pu, tg.type, String(getTextGenModel(tg) ?? '')).countText(text, 0);
  }
  const oai = (settings['oai_settings'] as Settings | undefined) ?? {};
  return ccTokenCounter(pu, ccTokenizerModel(oai)).countText(text, 0);
}

/** the arguments of ST `checkWorldInfo(chat, maxContext, isDryRun, globalScanData)` */
export interface WorldInfoScanRequest {
  /** message texts, newest first (ST `chatForWI`) */
  chat: readonly string[];
  maxContext: number;
  isDryRun: boolean;
  globalScanData?: Partial<WIGlobalScanData> | undefined;
}

/**
 * ST `checkWorldInfo` over the lorebooks of `input`'s chat (DEV_NOTES §9.34 第 5 轮): the scan a
 * generation runs, without building a prompt. It works on a copy of the chat metadata, so timed
 * effects (sticky / cooldown) are never written back from here.
 */
export async function scanWorldInfo(
  input: PipelineInput,
  request: WorldInfoScanRequest,
): Promise<WIActivated> {
  const character = activeCharacter(input.subject);
  if (!character) throw new Error('没有可扫描的角色（群聊需要先选出发言成员）');
  const { state, substitute, applyRegex } = createChatContext(
    input.settings,
    input.subject,
    input.userName,
    structuredClone(input.chat),
    structuredClone(input.chatMetadata),
  );
  const warnings: string[] = [];
  const { wiSettings, sortedEntries } = await loadWorldInfo(input, character, warnings);
  for (const warning of warnings) console.warn(warning);
  const scanInjects: string[] = [];
  for (const prompt of Object.values(input.extensionPrompts ?? {})) {
    if (!prompt.scan || !prompt.value) continue;
    if (typeof prompt.filter === 'function' && !(await prompt.filter())) continue;
    scanInjects.push(substitute(prompt.value));
  }
  return checkWorldInfo(
    { ...request, sortedEntries },
    {
      settings: wiSettings,
      chatMetadata: state.chatMetadata,
      substitute: (t) => substitute(t),
      countTokens: (t) => countTokens(input.settings, t),
      applyRegex: (content, depth) => applyRegex(content, 'world_info', { isPrompt: true, depth }),
      scanInjects,
      characterFilename: input.subject.group ? null : character.avatar.replace(/\.[^/.]+$/, ''),
    },
  );
}

/** The lorebook names ST `getSortedEntries` gathers, before any file is read (DEV_NOTES §9.22). */
export interface LoreBookNames {
  globalBooks: string[];
  characterBook: string | null;
  characterExtraBooks: string[];
  chatBook: string | null;
  personaBook: string | null;
}

/**
 * World info sources exactly as ST gathers them: global `globalSelect`, the character's
 * `data.extensions.world`, its `charLore` extra books (keyed by file stem), the chat's
 * `chat_metadata.world_info` and the persona's `persona_description_lorebook`.
 */
export function loreBookNamesFor(
  settings: Record<string, unknown>,
  character: CharacterLike,
  chatMetadata: Record<string, unknown>,
): LoreBookNames {
  const wiRaw = (settings['world_info_settings'] as Record<string, unknown> | undefined) ?? {};
  const pu = (settings['power_user'] as Record<string, unknown> | undefined) ?? {};
  const wiObj = (wiRaw['world_info'] as Record<string, unknown> | undefined) ?? {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const globalBooks = Array.isArray(wiObj['globalSelect'])
    ? (wiObj['globalSelect'] as unknown[]).filter((n): n is string => typeof n === 'string')
    : [];
  const charExt =
    ((character.data as Record<string, unknown> | undefined)?.['extensions'] as
      Record<string, unknown> | undefined) ?? {};
  const fileName = character.avatar.replace(/\.[^/.]+$/, '');
  return {
    globalBooks,
    characterBook: str(charExt['world']),
    characterExtraBooks: charLoreOf(settings, fileName),
    chatBook: str(chatMetadata['world_info']),
    personaBook: str(pu['persona_description_lorebook']),
  };
}

async function loadWorldInfo(
  input: PipelineInput,
  character: CharacterLike,
  warnings: string[],
): Promise<{ wiSettings: WorldInfoSettings; sortedEntries: ReturnType<typeof getSortedEntries> }> {
  const wiRaw =
    (input.settings['world_info_settings'] as Record<string, unknown> | undefined) ?? {};
  const wiSettings: WorldInfoSettings = {
    ...DEFAULT_WORLD_INFO_SETTINGS,
    ...(wiRaw as Partial<WorldInfoSettings>),
  };
  const names = loreBookNamesFor(input.settings, character, input.chatMetadata);
  const { globalBooks: globalSelect, characterBook: charBook, characterExtraBooks } = names;
  const { chatBook, personaBook } = names;
  const bookNames = new Set<string>([
    ...globalSelect,
    ...(charBook ? [charBook] : []),
    ...characterExtraBooks,
    ...(chatBook ? [chatBook] : []),
    ...(personaBook ? [personaBook] : []),
  ]);
  const worlds = new Map<string, WIBook>();
  for (const name of bookNames) {
    try {
      worlds.set(name, JSON.parse(await dataReadText(input.root, `worlds/${name}.json`)) as WIBook);
    } catch (e) {
      warnings.push(`世界书 ${name} 读取失败：${String(e)}`);
    }
  }
  const has = (n: string | null): n is string => !!n && worlds.has(n);
  const lore = collectLore(
    {
      globalBooks: globalSelect.filter((n) => worlds.has(n)),
      characterBook: has(charBook) ? charBook : null,
      characterExtraBooks: characterExtraBooks.filter((n) => worlds.has(n)),
      chatBook: has(chatBook) ? chatBook : null,
      personaBook: has(personaBook) ? personaBook : null,
    },
    (name) => worlds.get(name),
  );
  return {
    wiSettings,
    sortedEntries: getSortedEntries(lore, Number(wiSettings.world_info_character_strategy)),
  };
}

/**
 * Entries left out because the world-info budget ran out are the usual reason a reply "ignores the
 * world book" (the default context is 4095 tokens, a quarter of it for world info). ST only logs
 * this; here it becomes a warning the chat page shows (DEV_NOTES §9.44).
 */
function noteBudgetOverflow(
  warnings: string[],
  worldInfo: {
    budgetOverflow?: { budget: number; activated: number; firstSkipped: string } | undefined;
  },
  wiSettings: WorldInfoSettings,
  maxContext: number,
): void {
  const over = worldInfo.budgetOverflow;
  if (!over) return;
  const from = over.firstSkipped ? `从「${over.firstSkipped}」起` : '后面';
  warnings.push(
    `世界书太长，只发出了 ${over.activated} 条，${from}的条目没有发给 AI。` +
      `世界书最多占上下文长度（${maxContext}）的 ${wiSettings.world_info_budget}%，也就是 ${over.budget} 个 token。` +
      `到「预设 / 采样」把上下文长度调大，或到「世界书」的设置里把占比调高。`,
  );
}

/** Persona / example / bias settings both pipelines read from power_user. */
function powerUserDeps(pu: Record<string, unknown>) {
  return {
    persona_description: String(pu['persona_description'] ?? ''),
    persona_description_position: Number(pu['persona_description_position'] ?? 0),
    persona_description_role: Number(pu['persona_description_role'] ?? 0),
    persona_description_depth: Number(pu['persona_description_depth'] ?? 2),
    pin_examples: !!pu['pin_examples'],
    strip_examples: !!pu['strip_examples'],
    user_prompt_bias: String(pu['user_prompt_bias'] ?? ''),
    reasoning: pu['reasoning'] as ChatCompletionPipelineDeps['powerUser']['reasoning'],
  };
}

interface RawParts {
  /** one slot per entry of the script's order; `null` marks where the chat history goes */
  slots: (RawRolePrompt | null)[];
  /** the slot of the script's `user_input`, and the images that came with it */
  userSlot: RawRolePrompt;
  userImages: string[];
  /** oldest first, not yet cut to the token budget */
  history: RawRolePrompt[];
}

/**
 * The parts of a `generateRaw` prompt. World info and examples come from the normal build
 * (`built`), so activation is unchanged.
 */
function rawParts(
  ctx: ChatContext,
  deps: Pick<ChatCompletionPipelineDeps, 'applyRegex'> & {
    powerUser: Pick<ChatCompletionPipelineDeps['powerUser'], 'reasoning'>;
  },
  built: Pick<ChatCompletionPipelineResult, 'worldInfo' | 'mesExamples'>,
  plan: RawPromptPlan,
): RawParts {
  const { state, engine } = ctx;
  const fields = getCharacterCardFields(state, (value, name1Override, name2Override) =>
    engine.substituteParams(value, state, {
      name1Override,
      name2Override,
      replaceCharacterCard: false,
    }),
  );
  const coreChat = prepareCoreChat(state, {
    type: 'normal',
    applyRegex: deps.applyRegex,
    reasoning: deps.powerUser.reasoning,
    substitute: ctx.substitute,
  });
  const last = plan.hasUserInput ? coreChat.pop() : undefined;
  const userSlot: RawRolePrompt = { role: 'user', content: last?.mes ?? '' };
  const userImages = last
    ? mediaOf(last)
        .filter((m) => (m.type ?? 'image') === 'image' && !!m.url)
        .map((m) => m.url)
    : [];
  const builtin: Record<Exclude<RawBuiltinPrompt, 'chat_history' | 'user_input'>, string> = {
    world_info_before: built.worldInfo.worldInfoBefore,
    persona_description: fields.persona,
    char_description: fields.description,
    char_personality: fields.personality,
    scenario: fields.scenario,
    world_info_after: built.worldInfo.worldInfoAfter,
    dialogue_examples: built.mesExamples.join('\n'),
  };
  const slots = plan.order.map((item): RawRolePrompt | null => {
    if (item === 'chat_history') return null;
    if (item === 'user_input') return userSlot;
    if (typeof item === 'string') return { role: 'system', content: builtin[item] };
    return { role: item.role, content: ctx.substitute(item.content) };
  });
  const history = coreChat.map((item): RawRolePrompt => {
    const narrator = (item['extra'] as { type?: unknown } | undefined)?.type === 'narrator';
    return { role: item.is_user ? 'user' : narrator ? 'system' : 'assistant', content: item.mes };
  });
  return { slots, userSlot, userImages, history };
}

/** The newest messages of `history` that fit `room` tokens, oldest first */
async function fitRawHistory(
  history: readonly RawRolePrompt[],
  room: number,
  cost: (message: RawRolePrompt) => Promise<number> | number,
): Promise<RawRolePrompt[]> {
  const kept: RawRolePrompt[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    used += await cost(history[i]!);
    if (used > room) break;
    kept.push(history[i]!);
  }
  return kept.reverse();
}

/** `image_url` parts for the images of a raw `user_input`: one that cannot go out fails the request */
async function rawImageParts(
  urls: readonly string[],
  inline: InlineMediaDeps | undefined,
): Promise<unknown[]> {
  if (urls.length === 0) return [];
  if (!inline?.image) throw new Error('当前模型不支持图片输入，无法发送 image');
  const parts: unknown[] = [];
  for (const url of urls) {
    const resolved = await inline.resolve(url, 'image');
    if (!resolved) throw new Error('image 无法读取');
    parts.push({ type: 'image_url', image_url: { url: resolved.dataUrl, detail: inline.quality } });
  }
  return parts;
}

/**
 * The messages of a Chat Completion `generateRaw` request: the named parts in the script's order,
 * each one message. Chat history is cut from the old end until the whole prompt fits `budget`.
 */
async function assembleRawPrompt(
  ctx: ChatContext,
  deps: ChatCompletionPipelineDeps,
  result: ChatCompletionPipelineResult,
  plan: RawPromptPlan,
  budget: number,
  countTokens: (messages: ChatCompletionMessage | ChatCompletionMessage[]) => Promise<number>,
): Promise<ChatCompletionMessage[]> {
  const parts = rawParts(ctx, deps, result, plan);
  const images = await rawImageParts(parts.userImages, deps.inlineMedia);
  const hasImages = (m: RawRolePrompt) => m === parts.userSlot && images.length > 0;
  const kept = (m: RawRolePrompt) => m.content !== '' || hasImages(m);
  const fixed = parts.slots.filter((m): m is RawRolePrompt => !!m && kept(m));
  // the normal build has counted the history messages already, so most counts are cached
  const history = parts.slots.includes(null)
    ? await fitRawHistory(
        parts.history,
        budget - (fixed.length > 0 ? await countTokens(fixed) : 0),
        countTokens,
      )
    : [];
  // images are attached after counting: a data URL must not be counted as text
  const toMessage = (m: RawRolePrompt): ChatCompletionMessage =>
    hasImages(m)
      ? {
          role: m.role,
          content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...images],
        }
      : { ...m };
  return parts.slots.flatMap((m) => (m === null ? history : kept(m) ? [toMessage(m)] : []));
}

/**
 * Text Completion `generateRaw` (ST createRawPrompt): the same parts as one text, formatted with
 * the active instruct template and ending in the line that asks for the reply.
 */
async function assembleRawText(
  ctx: ChatContext,
  parts: RawParts,
  budget: number,
  countText: (text: string) => Promise<number> | number,
): Promise<string> {
  const { state } = ctx;
  const sub = (t: string) => ctx.substitute(t);
  const fixed = parts.slots.filter((m): m is RawRolePrompt => !!m && m.content !== '');
  const history = parts.slots.includes(null)
    ? await fitRawHistory(
        parts.history,
        budget - (await countText(createRawTextPrompt(state, sub, fixed))),
        (m) => countText(formatRawTextMessage(state, sub, m)),
      )
    : [];
  const messages = parts.slots.flatMap((m) => (m === null ? history : m.content ? [m] : []));
  return createRawTextPrompt(state, sub, messages);
}

/** ST Generate(): dispatch on `main_api` (DEV_NOTES §9.19). */
export async function prepareGeneration(raw: PipelineInput): Promise<PreparedGeneration> {
  // ST appendFileContent reads Data Bank files at generation time; core only sees `file.text`
  const input = { ...raw, chat: await withFileTexts(raw.root, raw.chat) };
  const api = mainApiOf(input.settings);
  if (api === 'openai') return prepareChatCompletion(input);
  if (input.tools?.length || input.toolChoice !== undefined || input.jsonSchema)
    throw new Error('tools / tool_choice / json_schema 只支持 Chat Completion');
  if (api === 'textgenerationwebui') return prepareTextCompletion(input);
  throw new Error(`暂不支持 main_api=${api}（目前只接了 Chat Completion 与 Text Completion）`);
}

async function prepareChatCompletion(input: PipelineInput): Promise<PreparedGeneration> {
  const { settings } = input;
  const pu = (settings['power_user'] as Record<string, unknown> | undefined) ?? {};
  const oai = settings['oai_settings'] as Record<string, unknown> | undefined;
  const ext = (settings['extension_settings'] as Record<string, unknown> | undefined) ?? {};
  if (!oai) throw new Error('settings.json 里没有 oai_settings');

  const character = activeCharacter(input.subject);
  if (!character) throw new Error('没有可生成的角色（群聊需要先选出发言成员）');
  const chat = structuredClone(input.chat);
  const ctx = createChatContext(
    settings,
    input.subject,
    input.userName,
    chat,
    structuredClone(input.chatMetadata),
  );
  const { state, substitute: sub, applyRegex } = ctx;
  const type = input.type;
  const warnings: string[] = [];
  const { wiSettings, sortedEntries } = await loadWorldInfo(input, character, warnings);

  const ccSource = String(oai['chat_completion_source']);
  const ccModel = getChatCompletionModel(oai as unknown as GenerationSettings);
  const clientTokenizerModel = ccTokenizerModel(oai);
  const counter = ccTokenCounter(pu, clientTokenizerModel);

  const ccSettings = oai as unknown as ChatCompletionSettings & GenerationSettings;
  const deps: ChatCompletionPipelineDeps = {
    engine: ctx.engine,
    settings: ccSettings,
    countText: (t) => counter.countText(t),
    countMessages: (msgs, full) =>
      counter.countOpenAIMessages(msgs as Record<string, unknown>[], full),
    tokenizerModel: resolveServerTokenizerModel(clientTokenizerModel),
    worldInfo: { settings: wiSettings, sortedEntries, random: () => Math.random() },
    note: (ext['note'] as ChatCompletionPipelineDeps['note']) ?? { allowWIScan: false },
    powerUser: powerUserDeps(pu),
    applyRegex,
    inlineMedia: input.inlineMedia,
    canUseTools: input.canUseTools,
    extensionPrompts: input.extensionPrompts,
  };

  const result = await buildChatCompletionPrompt(state, deps, {
    type,
    textareaText: input.textareaText,
    quietPrompt: input.quietPrompt,
  });
  if (result.error) throw result.error;
  const budget = tokenBudgetOf(settings);
  noteBudgetOverflow(warnings, result.worldInfo, wiSettings, budget.maxContext);
  const messages = input.raw
    ? await assembleRawPrompt(
        ctx,
        deps,
        result,
        input.raw,
        budget.maxContext - budget.maxResponse,
        (m) => counter.countOpenAIMessages(m as unknown as Record<string, unknown>[], true),
      )
    : result.chat;
  if (input.onPrompt) await input.onPrompt(messages);

  const { generate_data } = createGenerationParameters({
    settings: ccSettings,
    model: ccModel,
    type,
    messages,
    userName: state.userName,
    charName: state.charName,
    groupNames: getGroupNames(state),
    customStoppingStrings: getCustomStoppingStrings(state, (t) => sub(t), {
      limit: OPENAI_MAX_STOP_STRINGS,
    }),
    requestTokenProbabilities: !!pu['request_token_probabilities'],
    allCustomStoppingStrings: getCustomStoppingStrings(state, (t) => sub(t)),
    substitute: (t) => sub(t),
    tools: input.tools,
    logitBias: await chatCompletionLogitBias(oai, clientTokenizerModel),
    toolChoice: input.toolChoice,
    jsonSchema: input.jsonSchema ?? null,
  });
  const upstream = buildUpstreamRequest(generate_data);
  const endpoint = resolveChatCompletionEndpoint(oai as unknown as GenerationSettings);
  const selectedProxy = settings['selected_proxy'] as { name?: string } | string | null | undefined;
  const proxyName =
    typeof selectedProxy === 'string' ? selectedProxy : (selectedProxy?.name ?? null);
  const secret = secretRefFor(endpoint, proxyName) as SecretRef;
  // what the body says: quiet generations and some models never stream, whatever the setting
  const stream = generate_data['stream'] === true;

  return {
    request: {
      url: upstream.url,
      headers: upstream.headers,
      auth_header: upstream.authHeader ?? null,
      body: upstream.body,
      stream,
      format: { kind: 'chat_completion', source: ccSource },
      timeout_ms: null,
    },
    secret,
    source: ccSource,
    model: ccModel,
    warnings,
    stoppingStrings: getStoppingStrings(
      state,
      (t) => sub(t),
      type === 'impersonate',
      type === 'continue',
    ),
  };
}

/** Generate() textgenerationwebui branch → getTextGenGenerationData → server /generate (§9.19). */
async function prepareTextCompletion(input: PipelineInput): Promise<PreparedGeneration> {
  const { settings } = input;
  const pu = (settings['power_user'] as Record<string, unknown> | undefined) ?? {};
  const ext = (settings['extension_settings'] as Record<string, unknown> | undefined) ?? {};
  const tg = loadTextgenSettings(settings);
  const { maxContext, maxResponse } = tokenBudgetOf(settings);
  const server = getTextGenServer(tg);
  if (!server) throw new Error('还没有填 Text Completion 服务器地址（API 连接页）');
  const model = getTextGenModel(tg);
  if (tg.type === 'ollama' && !model) throw new Error('Ollama 需要先选择模型（API 连接页）');

  const character = activeCharacter(input.subject);
  if (!character) throw new Error('没有可生成的角色（群聊需要先选出发言成员）');
  const chat = structuredClone(input.chat);
  const ctx = createChatContext(
    settings,
    input.subject,
    input.userName,
    chat,
    structuredClone(input.chatMetadata),
  );
  const { state, substitute: sub, applyRegex } = ctx;
  const type = input.type;
  const warnings: string[] = [];
  const { wiSettings, sortedEntries } = await loadWorldInfo(input, character, warnings);

  const counter = tcTokenCounter(pu, tg.type, String(model ?? ''));
  const deps: TextCompletionPipelineDeps = {
    engine: ctx.engine,
    countText: (t) => counter.countText(t),
    worldInfo: { settings: wiSettings, sortedEntries, random: () => Math.random() },
    note: (ext['note'] as TextCompletionPipelineDeps['note']) ?? { allowWIScan: false },
    powerUser: {
      ...powerUserDeps(pu),
      always_force_name2: !!pu['always_force_name2'],
      token_padding: Number(pu['token_padding'] ?? 64),
      collapse_newlines: !!pu['collapse_newlines'],
    },
    applyRegex,
    extensionPrompts: input.extensionPrompts,
  };
  const result = await buildTextCompletionPrompt(state, deps, {
    type,
    textareaText: input.textareaText,
    quietPrompt: input.quietPrompt,
  });
  let prompt = result.prompt;
  let stoppingStrings = result.stoppingStrings;
  noteBudgetOverflow(warnings, result.worldInfo, wiSettings, maxContext);
  if (input.raw) {
    const parts = rawParts(ctx, deps, result, input.raw);
    if (parts.userImages.length > 0) throw new Error('Text Completion 不支持图片输入');
    prompt = await assembleRawText(ctx, parts, maxContext - maxResponse, deps.countText);
    stoppingStrings = getStoppingStrings(state, (t) => sub(t), false, false);
  }

  const params = createTextGenGenerationData({
    settings: tg,
    model,
    prompt,
    maxTokens: maxResponse,
    maxContext,
    isImpersonate: type === 'impersonate',
    isContinue: type === 'continue',
    // ST generateRawData asks for a raw text the way a quiet generation does
    type: input.raw ? 'quiet' : type,
    stoppingStrings,
    substitute: (t) => sub(t),
    requestTokenProbabilities: !!pu['request_token_probabilities'],
  });
  // generateTextGenWithStreaming sets `stream: true`; the non-streaming path sends no `stream` key
  const stream = !!tg.streaming;
  if (stream) params['stream'] = true;
  const upstream = toTextCompletionUpstream(params);
  const key = textgenSecretKey(tg.type);
  const secret: SecretRef = key ? { kind: 'keyring', key } : { kind: 'none' };

  return {
    request: {
      url: upstream.url,
      headers: textCompletionHeaders(tg.type, null),
      auth_header: textCompletionAuthHeader(tg.type) ?? null,
      body: upstream.body,
      stream,
      stream_format: upstream.streamFormat,
      format: { kind: 'text_completion', api_type: tg.type },
      timeout_ms: null,
    },
    secret,
    source: tg.type,
    model: String(model ?? ''),
    warnings,
    stoppingStrings,
  };
}
