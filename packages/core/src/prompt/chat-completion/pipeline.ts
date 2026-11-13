// script.js Generate() 中 Chat Completion 路径的编排：coreChat → 角色卡字段 → 深度提示 / 作者注释 / 世界书 / persona → prepareOpenAIMessages。
import { prepareCoreChat, type ApplyRegex } from '../core-chat.js';
import type { MacroEngine } from '../../macros/engine.js';
import type { CoreState } from '../../state.js';
import { getCharacterCardFields, baseChatReplace } from '../character-fields.js';
import { parseMesExamples } from '../examples.js';
import {
  ensureNoteDefaults,
  injectWorldInfoIntoAuthorsNote,
  setFloatingPrompt,
  type NoteSettings,
} from '../authors-note.js';
import { applyDepthPrompts } from '../depth-prompts.js';
import {
  EXTENSION_PROMPT_TYPES,
  INJECT_IDS,
  flushWIInjections,
  setExtensionPrompt,
  type ExtensionPrompts,
} from '../extension-prompts.js';
import { addPersonaDescriptionExtensionPrompt, type PersonaSettings } from '../persona.js';
import {
  DEFAULT_REASONING_SETTINGS,
  PromptReasoning,
  type ReasoningSettings,
} from '../reasoning.js';
import {
  GENERATION_TYPE_TRIGGERS,
  WI_ANCHOR_POSITION,
  checkWorldInfo,
  type WIActivated,
  type WIEntry,
  type WorldInfoScanDeps,
  type WorldInfoSettings,
} from '../../world-info/index.js';
import {
  prepareOpenAIMessages,
  setOpenAIMessageExamples,
  setOpenAIMessages,
  type ChatCompletionDeps,
  type PrepareOpenAIMessagesResult,
} from './assemble.js';
import type { InlineMediaDeps } from './media.js';
import { TokenHandler, createOpenAITokenCounter, type CountMessagesTokens } from './messages.js';
import { PromptManager, type ActiveCharacter } from './prompt-manager.js';
import type { ChatCompletionSettings } from './types.js';

export type GenerationType =
  'normal' | 'continue' | 'impersonate' | 'swipe' | 'regenerate' | 'quiet';

export interface ChatCompletionPipelineDeps {
  engine: MacroEngine;
  settings: ChatCompletionSettings;
  /** 文本 token 计数（Rust 分词器）；用于 ST 的 OpenAI 计费方案 */
  countText: (text: string) => Promise<number> | number;
  /** 覆盖整条消息计数（默认由 countText 派生） */
  countMessages?: CountMessagesTokens | undefined;
  tokenizerModel?: string | undefined;
  worldInfo: {
    settings: WorldInfoSettings;
    sortedEntries: WIEntry[];
    externalActivations?: Map<string, WIEntry> | undefined;
    random?: (() => number) | undefined;
    characterTags?: readonly string[] | undefined;
  };
  /** extension_settings.note */
  note: NoteSettings;
  /** power_user 的相关子集 */
  powerUser: PersonaSettings & {
    pin_examples: boolean;
    strip_examples: boolean;
    user_prompt_bias?: string | undefined;
    reasoning?: ReasoningSettings | undefined;
  };
  /** 正则脚本：placement 'user'|'ai'|'reasoning'|'world_info'（正则项完成前恒等） */
  applyRegex?:
    | ((
        text: string,
        placement: 'user' | 'ai' | 'reasoning' | 'world_info',
        options: { isPrompt: boolean; depth: number | null },
      ) => string)
    | undefined;
  /** 持久化的 extension_prompts（会被就地修改）；缺省新建 */
  extensionPrompts?: ExtensionPrompts | undefined;
  activeCharacter?: ActiveCharacter | null | undefined;
  /** DEV_NOTES §9.30: present only when the host found media inlining supported */
  inlineMedia?: InlineMediaDeps | undefined;
  /** tool calling is on for this request (ST `ToolManager.isToolCallingSupported()`) */
  canUseTools?: boolean | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface ChatCompletionPipelineInput {
  type?: GenerationType | undefined;
  quietPrompt?: string | undefined;
  /** 用户刚输入的文本（仅用于 bias 提取；消息本体由宿主先追加进 chat） */
  textareaText?: string | undefined;
  dryRun?: boolean | undefined;
  skipWIAN?: boolean | undefined;
}

export interface ChatCompletionPipelineResult extends PrepareOpenAIMessagesResult {
  worldInfo: WIActivated;
  mesExamples: string[];
  bias: { messageBias: string; promptBias: string; isUserPromptBias: boolean };
  cyclePrompt: string;
  extensionPrompts: ExtensionPrompts;
  maxContext: number;
}

/** getBiasStrings：{{bias "text"}} 提取 */
export function extractMessageBias(message: string): string {
  if (!message) return '';
  const matches: string[] = [];
  const re = /{{\s*bias\s+(?:"([^"]*)"|'([^']*)'|([^\s}]+))\s*}}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message))) matches.push(m[1] ?? m[2] ?? m[3] ?? '');
  return matches.length ? ` ${matches.join(' ')}` : '';
}
export function removeMacros(str: string): string {
  return (str ?? '').replace(/\{\{[\s\S]*?\}\}/gm, '').trim();
}

export function getBiasStrings(
  state: CoreState,
  substitute: (t: string) => string,
  userPromptBias: string,
  textareaText: string,
  type: string,
) {
  if (type == 'impersonate' || type == 'continue')
    return { messageBias: '', promptBias: '', isUserPromptBias: false };
  let promptBias = '';
  let messageBias = extractMessageBias(textareaText);
  if (!textareaText) {
    for (let i = state.chat.length - 1; i >= 0; i--) {
      const mes = state.chat[i]!;
      if (type === 'swipe' && state.chat.length - 1 === i) continue;
      const extra = (mes['extra'] ?? {}) as Record<string, unknown>;
      if (mes && (mes.is_user || mes.is_system || extra['type'] === 'narrator')) {
        const b = extra['bias'];
        if (typeof b === 'string' && b.trim().length > 0) promptBias = b;
        break;
      }
    }
  }
  promptBias = messageBias || promptBias || userPromptBias || '';
  const isUserPromptBias = promptBias === userPromptBias;
  return {
    messageBias: substitute(messageBias),
    promptBias: substitute(promptBias),
    isUserPromptBias,
  };
}

export async function buildChatCompletionPrompt(
  state: CoreState,
  deps: ChatCompletionPipelineDeps,
  input: ChatCompletionPipelineInput = {},
): Promise<ChatCompletionPipelineResult> {
  const type = input.type ?? 'normal';
  const dryRun = input.dryRun ?? false;
  const isContinue = type === 'continue';
  const engine = deps.engine;
  const sub = (text: string, options?: Parameters<MacroEngine['substituteParams']>[2]) =>
    engine.substituteParams(text, state, options);
  const baseSub = (value: string, n1: string | null, n2: string | null) =>
    sub(value, { name1Override: n1, name2Override: n2, replaceCharacterCard: false });
  const extensionPrompts = deps.extensionPrompts ?? {};
  const applyRegex = deps.applyRegex ?? ((t: string) => t);
  const isGroup = !!state.selectedGroup;
  const inChat = isGroup || state.characterId !== undefined;

  // quiet prompt
  const quietPrompt = input.quietPrompt ? sub(input.quietPrompt) : '';

  // bias
  const bias = getBiasStrings(
    state,
    (t) => sub(t),
    deps.powerUser.user_prompt_bias ?? '',
    input.textareaText ?? '',
    type,
  );

  // 角色卡字段
  const fields = getCharacterCardFields(state, baseSub);

  // 深度提示（Character's Note）
  applyDepthPrompts(
    state,
    baseSub,
    extensionPrompts,
    fields.charDepthPrompt,
    !!deps.note.allowWIScan,
  );

  const coreChat = prepareCoreChat(state, {
    type,
    canUseTools: deps.canUseTools,
    applyRegex: deps.applyRegex,
    reasoning: deps.powerUser.reasoning,
    substitute: (t) => sub(t),
  });

  const maxContext = deps.settings.openai_max_context - deps.settings.openai_max_tokens;

  // 示例对话（CC 不走 instruct）
  let mesExamplesArray = parseMesExamples(state, (t) => sub(t), fields.mesExamples, false);

  // 作者注释
  ensureNoteDefaults(state.chatMetadata, deps.note);
  const characterFilename =
    !isGroup && state.characterId !== undefined
      ? (state.characters[state.characterId]?.avatar ?? '').replace(/\.[^/.]+$/, '')
      : null;
  const shouldWIAddPrompt = setFloatingPrompt({
    chat: state.chat,
    chatMetadata: state.chatMetadata,
    note: deps.note,
    extensionPrompts,
    inChat,
    characterFilename,
  });

  // 世界书扫描（quiet prompt 临时加入可扫描注入）
  setExtensionPrompt(
    extensionPrompts,
    INJECT_IDS.QUIET_PROMPT,
    quietPrompt || '',
    EXTENSION_PROMPT_TYPES.IN_PROMPT,
    0,
    true,
  );
  const chatForWI = coreChat
    .map((x) => (deps.worldInfo.settings.world_info_include_names ? `${x.name}: ${x.mes}` : x.mes))
    .reverse();
  const scanInjects: string[] = [];
  for (const key of Object.keys(extensionPrompts).sort()) {
    const p = extensionPrompts[key]!;
    if (p.scan && p.value && !(typeof p.filter === 'function' && !(await p.filter())))
      scanInjects.push(sub(p.value));
  }
  const wiDeps: WorldInfoScanDeps = {
    settings: deps.worldInfo.settings,
    chatMetadata: state.chatMetadata,
    substitute: (t) => sub(t),
    countTokens: (t) => deps.countText(t),
    applyRegex: (content, depth) => applyRegex(content, 'world_info', { isPrompt: true, depth }),
    scanInjects,
    characterFilename,
    characterTags: deps.worldInfo.characterTags,
    externalActivations: deps.worldInfo.externalActivations,
    random: deps.worldInfo.random,
    log: deps.log,
  };
  const worldInfo = await checkWorldInfo(
    {
      chat: chatForWI,
      maxContext,
      isDryRun: dryRun,
      sortedEntries: deps.worldInfo.sortedEntries,
      globalScanData: {
        personaDescription: fields.persona,
        characterDescription: fields.description,
        characterPersonality: fields.personality,
        characterDepthPrompt: fields.charDepthPrompt,
        scenario: fields.scenario,
        creatorNotes: fields.creatorNotes,
        trigger: (GENERATION_TYPE_TRIGGERS as readonly string[]).includes(type) ? type : 'normal',
      },
    },
    wiDeps,
  );
  setExtensionPrompt(
    extensionPrompts,
    INJECT_IDS.QUIET_PROMPT,
    '',
    EXTENSION_PROMPT_TYPES.IN_PROMPT,
    0,
    true,
  );

  // 世界书：AN 顶/底并入作者注释（checkWorldInfo 末尾）
  if (shouldWIAddPrompt)
    injectWorldInfoIntoAuthorsNote(
      extensionPrompts,
      state.chatMetadata,
      deps.note,
      worldInfo.ANBeforeEntries,
      worldInfo.ANAfterEntries,
    );

  // 世界书示例消息
  for (const example of worldInfo.EMEntries) {
    if (example.content.length === 0) continue;
    const cleaned = parseMesExamples(
      state,
      (t) => sub(t),
      baseChatReplace(state, baseSub, example.content),
      false,
    );
    if (example.position === WI_ANCHOR_POSITION.before) mesExamplesArray.unshift(...cleaned);
    else mesExamplesArray.push(...cleaned);
  }

  // 世界书深度 / outlet 注入
  if (input.skipWIAN !== true) {
    flushWIInjections(extensionPrompts);
    for (const e of worldInfo.WIDepthEntries) {
      setExtensionPrompt(
        extensionPrompts,
        INJECT_IDS.CUSTOM_WI_DEPTH_ROLE(e.depth, e.role),
        e.entries.join('\n'),
        EXTENSION_PROMPT_TYPES.IN_CHAT,
        e.depth,
        false,
        e.role,
      );
    }
    for (const [key, value] of Object.entries(worldInfo.outletEntries)) {
      setExtensionPrompt(
        extensionPrompts,
        INJECT_IDS.CUSTOM_WI_OUTLET(key),
        value.join('\n'),
        EXTENSION_PROMPT_TYPES.NONE,
        0,
      );
    }
  }

  // persona
  addPersonaDescriptionExtensionPrompt(
    extensionPrompts,
    state.chatMetadata,
    deps.note,
    deps.powerUser,
    shouldWIAddPrompt,
  );

  if (deps.powerUser.strip_examples) mesExamplesArray = [];

  // continue：最后一条消息作为 cyclePrompt
  let cyclePrompt = '';
  if (isContinue && coreChat.length) {
    cyclePrompt = coreChat[coreChat.length - 1]!.mes;
    if (!cyclePrompt.endsWith(' ')) cyclePrompt += deps.settings.continue_postfix;
  }

  const oaiMessages = setOpenAIMessages(state, deps.settings, coreChat);
  const oaiMessageExamples = setOpenAIMessageExamples(
    state,
    state.userName,
    state.charName,
    mesExamplesArray,
  );

  const tokenHandler = new TokenHandler(
    deps.countMessages ??
      createOpenAITokenCounter(deps.countText, { model: deps.tokenizerModel ?? 'gpt-4' }),
  );
  const promptManager = new PromptManager({
    settings: deps.settings,
    substitute: sub,
    activeCharacter: deps.activeCharacter,
  });
  const ccDeps: ChatCompletionDeps = {
    settings: deps.settings,
    promptManager,
    tokenHandler,
    substitute: sub,
    pinExamples: deps.powerUser.pin_examples,
    persona: deps.powerUser,
    isGroup,
    inlineMedia: deps.inlineMedia,
    canUseTools: deps.canUseTools,
    log: deps.log,
  };

  const result = await prepareOpenAIMessages(
    {
      name2: state.charName,
      charDescription: fields.description,
      charPersonality: fields.personality,
      scenario: fields.scenario,
      worldInfoBefore: worldInfo.worldInfoBefore,
      worldInfoAfter: worldInfo.worldInfoAfter,
      extensionPrompts,
      bias: bias.promptBias,
      type,
      quietPrompt,
      cyclePrompt,
      systemPromptOverride: fields.system,
      jailbreakPromptOverride: fields.jailbreak,
      messages: oaiMessages,
      messageExamples: oaiMessageExamples,
    },
    ccDeps,
    dryRun,
  );

  return {
    ...result,
    worldInfo,
    mesExamples: mesExamplesArray,
    bias,
    cyclePrompt,
    extensionPrompts,
    maxContext,
  };
}
