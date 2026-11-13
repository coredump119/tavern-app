// script.js Generate() 的 Text Completion 分支（kobold / textgenerationwebui / novel 共用的纯文本 prompt 组装）。
import type { MacroEngine } from '../../macros/engine.js';
import type { ChatMessageLike, CoreState } from '../../state.js';
import { baseChatReplace, getCharacterCardFields } from '../character-fields.js';
import { formatInstructModeExamples, parseMesExamples } from '../examples.js';
import {
  ensureNoteDefaults,
  injectWorldInfoIntoAuthorsNote,
  setFloatingPrompt,
  type NoteSettings,
} from '../authors-note.js';
import { prepareCoreChat, type ApplyRegex, type CoreChatMessage } from '../core-chat.js';
import { applyDepthPrompts } from '../depth-prompts.js';
import {
  EXTENSION_PROMPT_ROLES,
  EXTENSION_PROMPT_TYPES,
  INJECT_IDS,
  flushWIInjections,
  getExtensionPrompt,
  setExtensionPrompt,
  type ExtensionPrompts,
} from '../extension-prompts.js';
import {
  PERSONA_DESCRIPTION_POSITIONS,
  addPersonaDescriptionExtensionPrompt,
  type PersonaSettings,
} from '../persona.js';
import type { ReasoningSettings } from '../reasoning.js';
import {
  GENERATION_TYPE_TRIGGERS,
  WI_ANCHOR_POSITION,
  checkWorldInfo,
  type WIActivated,
  type WIEntry,
  type WorldInfoScanDeps,
  type WorldInfoSettings,
} from '../../world-info/index.js';
import { getBiasStrings, type GenerationType } from '../chat-completion/pipeline.js';
import { collapseNewlines } from '../character-fields.js';
import {
  FORCE_OUTPUT_SEQUENCE,
  formatInstructModeChat,
  formatInstructModePrompt,
  formatInstructModeStoryString,
  type Substitute,
} from './instruct.js';
import { renderStoryString, type StoryStringParams } from './story-string.js';
import { getStoppingStrings } from './stopping-strings.js';

export interface TextCompletionPipelineDeps {
  engine: MacroEngine;
  /** 文本 token 计数（Rust 分词器） */
  countText: (text: string) => Promise<number> | number;
  worldInfo: {
    settings: WorldInfoSettings;
    sortedEntries: WIEntry[];
    externalActivations?: Map<string, WIEntry> | undefined;
    random?: (() => number) | undefined;
    characterTags?: readonly string[] | undefined;
  };
  note: NoteSettings;
  powerUser: PersonaSettings & {
    pin_examples: boolean;
    strip_examples: boolean;
    user_prompt_bias?: string | undefined;
    always_force_name2?: boolean | undefined;
    token_padding?: number | undefined;
    collapse_newlines?: boolean | undefined;
    reasoning?: ReasoningSettings | undefined;
  };
  /** NovelAI preamble（仅 main_api === 'novel'） */
  naiPreamble?: string | undefined;
  applyRegex?: ApplyRegex | undefined;
  extensionPrompts?: ExtensionPrompts | undefined;
  ephemeralStoppingStrings?: string[] | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface TextCompletionPipelineInput {
  type?: GenerationType | undefined;
  quietPrompt?: string | undefined;
  quietToLoud?: boolean | undefined;
  quietName?: string | null | undefined;
  textareaText?: string | undefined;
  dryRun?: boolean | undefined;
  skipWIAN?: boolean | undefined;
}

export interface MesSendItem {
  message: string;
  extensionPrompts: string[];
  injected?: boolean;
}

export interface TextCompletionPipelineResult {
  prompt: string;
  stoppingStrings: string[];
  storyString: string;
  combinedStoryString: string;
  mesExmString: string;
  mesSendString: string;
  mesSend: MesSendItem[];
  generatedPromptCache: string;
  continueMag: string;
  injectedIndices: number[];
  worldInfo: WIActivated;
  mesExamples: string[];
  bias: { messageBias: string; promptBias: string; isUserPromptBias: boolean };
  system: string;
  jailbreak: string;
  extensionPrompts: ExtensionPrompts;
  maxContext: number;
  /** 进入上下文的历史消息数（不含注入） */
  inContextMessages: number;
}

const IGNORE_SYMBOL = Symbol.for('ignore');

export async function buildTextCompletionPrompt(
  state: CoreState,
  deps: TextCompletionPipelineDeps,
  input: TextCompletionPipelineInput = {},
): Promise<TextCompletionPipelineResult> {
  const type = input.type ?? 'normal';
  const dryRun = input.dryRun ?? false;
  const isContinue = type === 'continue';
  const isImpersonate = type === 'impersonate';
  const quietToLoud = input.quietToLoud ?? false;
  const engine = deps.engine;
  const sub: Substitute = (text, options) => engine.substituteParams(text, state, options);
  const baseSub = (value: string, n1: string | null, n2: string | null) =>
    sub(value, { name1Override: n1, name2Override: n2, replaceCharacterCard: false } as never);
  const extensionPrompts = deps.extensionPrompts ?? {};
  const applyRegex = deps.applyRegex ?? ((t: string) => t);
  const isGroup = !!state.selectedGroup;
  const inChat = isGroup || state.characterId !== undefined;
  const name1 = state.userName;
  const name2 = state.charName;
  const isInstruct = !!state.powerUser.instruct.enabled && state.mainApi !== 'openai';
  const mainApi = state.mainApi;
  const tokenPadding = deps.powerUser.token_padding ?? 64;
  const countTokens = async (str: string, padding = 0) =>
    typeof str !== 'string' || !str.length ? 0 : (await deps.countText(str)) + padding;

  let quietPrompt = input.quietPrompt ? sub(input.quietPrompt) : '';

  const bias = getBiasStrings(
    state,
    (t) => sub(t),
    deps.powerUser.user_prompt_bias ?? '',
    input.textareaText ?? '',
    type,
  );
  const promptBias = bias.promptBias;

  const fields = getCharacterCardFields(state, baseSub);
  let system = fields.system;
  let jailbreak = fields.jailbreak;

  applyDepthPrompts(
    state,
    baseSub,
    extensionPrompts,
    fields.charDepthPrompt,
    !!deps.note.allowWIScan,
  );

  let coreChat: CoreChatMessage[] = prepareCoreChat(state, {
    type,
    applyRegex: deps.applyRegex,
    reasoning: deps.powerUser.reasoning,
    substitute: (t) => sub(t),
  });

  const maxContext = state.tokens.maxPrompt();

  let forceName2 =
    (!!promptBias && !bias.isUserPromptBias) ||
    !!deps.powerUser.always_force_name2 ||
    mainApi == 'novel';
  if (isImpersonate) forceName2 = false;

  let mesExamplesArray = parseMesExamples(state, (t) => sub(t), fields.mesExamples, isInstruct);

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

  // 世界书
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
  if (shouldWIAddPrompt)
    injectWorldInfoIntoAuthorsNote(
      extensionPrompts,
      state.chatMetadata,
      deps.note,
      worldInfo.ANBeforeEntries,
      worldInfo.ANAfterEntries,
    );

  for (const example of worldInfo.EMEntries) {
    if (example.content.length === 0) continue;
    const cleaned = parseMesExamples(
      state,
      (t) => sub(t),
      baseChatReplace(state, baseSub, example.content),
      isInstruct,
    );
    if (example.position === WI_ANCHOR_POSITION.before) mesExamplesArray.unshift(...cleaned);
    else mesExamplesArray.push(...cleaned);
  }
  const mesExamplesRawArray = [...mesExamplesArray];
  if (mesExamplesArray && isInstruct)
    mesExamplesArray = formatInstructModeExamples(
      state,
      (t, names) =>
        names ? sub(t, { name1Override: names.name1, name2Override: names.name2 }) : sub(t),
      mesExamplesArray,
      name1,
      name2,
    );

  if (input.skipWIAN !== true) {
    flushWIInjections(extensionPrompts);
    for (const e of worldInfo.WIDepthEntries)
      setExtensionPrompt(
        extensionPrompts,
        INJECT_IDS.CUSTOM_WI_DEPTH_ROLE(e.depth, e.role),
        e.entries.join('\n'),
        EXTENSION_PROMPT_TYPES.IN_CHAT,
        e.depth,
        false,
        e.role,
      );
    for (const [key, value] of Object.entries(worldInfo.outletEntries))
      setExtensionPrompt(
        extensionPrompts,
        INJECT_IDS.CUSTOM_WI_OUTLET(key),
        value.join('\n'),
        EXTENSION_PROMPT_TYPES.NONE,
        0,
      );
  }

  addPersonaDescriptionExtensionPrompt(
    extensionPrompts,
    state.chatMetadata,
    deps.note,
    deps.powerUser,
    shouldWIAddPrompt,
  );

  // 系统提示（TC）
  if (state.powerUser.sysprompt.enabled) {
    const content = state.powerUser.sysprompt.content ?? '';
    system =
      state.powerUser.prefer_character_prompt && system
        ? sub(system, { original: content })
        : baseChatReplace(state, baseSub, content);
    system = isInstruct ? sub(system, { original: content }) : system;
  } else {
    system = '';
  }

  const beforeScenarioAnchor = await getExtensionPrompt(
    extensionPrompts,
    (t) => sub(t),
    EXTENSION_PROMPT_TYPES.BEFORE_PROMPT,
  );
  const afterScenarioAnchor = await getExtensionPrompt(
    extensionPrompts,
    (t) => sub(t),
    EXTENSION_PROMPT_TYPES.IN_PROMPT,
  );

  const storyStringParams: StoryStringParams = {
    description: fields.description,
    personality: fields.personality,
    persona:
      deps.powerUser.persona_description_position == PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT
        ? fields.persona
        : '',
    scenario: fields.scenario,
    system,
    char: name2,
    user: name1,
    wiBefore: worldInfo.worldInfoBefore,
    wiAfter: worldInfo.worldInfoAfter,
    loreBefore: worldInfo.worldInfoBefore,
    loreAfter: worldInfo.worldInfoAfter,
    anchorBefore: beforeScenarioAnchor.trim(),
    anchorAfter: afterScenarioAnchor.trim(),
    mesExamples: mesExamplesArray.join(''),
    mesExamplesRaw: mesExamplesRawArray.join(''),
  };
  const storyString = renderStoryString(engine, state, storyStringParams);
  let combinedStoryString = isInstruct
    ? formatInstructModeStoryString(state, sub, storyString)
    : storyString;

  const ctx = state.powerUser.context;
  const applyStoryStringInject = ctx['story_string_position'] === EXTENSION_PROMPT_TYPES.IN_CHAT;
  if (applyStoryStringInject) {
    setExtensionPrompt(
      extensionPrompts,
      INJECT_IDS.STORY_STRING,
      combinedStoryString,
      EXTENSION_PROMPT_TYPES.IN_CHAT,
      (ctx['story_string_depth'] as number | undefined) ?? 1,
      false,
      (ctx['story_string_role'] as number | undefined) ?? EXTENSION_PROMPT_ROLES.SYSTEM,
    );
    combinedStoryString = '';
  } else {
    setExtensionPrompt(
      extensionPrompts,
      INJECT_IDS.STORY_STRING,
      '',
      EXTENSION_PROMPT_TYPES.IN_CHAT,
      0,
    );
  }

  if (deps.powerUser.strip_examples) mesExamplesArray = [];

  // 深度注入（TC 在这里做）
  let injectedIndices = await doChatInject(
    coreChat,
    isContinue,
    extensionPrompts,
    (t) => sub(t),
    name1,
    name2,
  );

  // 后置历史指令（PHI / jailbreak）
  if (state.powerUser.sysprompt.enabled) {
    const postHistory = (state.powerUser.sysprompt['post_history'] as string | undefined) ?? '';
    jailbreak =
      state.powerUser.prefer_character_jailbreak && jailbreak
        ? sub(jailbreak, { original: postHistory })
        : baseChatReplace(state, baseSub, postHistory);
    if (jailbreak) {
      if (isContinue) {
        coreChat.splice(coreChat.length - 1, 0, { mes: jailbreak, is_user: true, index: -1 });
      } else {
        coreChat.push({ mes: jailbreak, is_user: true, index: -1 });
        injectedIndices = injectedIndices.map((x) => x + 1);
      }
    }
  }

  // chat2：逆序格式化
  const chat2: string[] = [];
  let continueMag = '';
  let userMessageIndices: number[] = [];
  const lastUserMessageIndex = coreChat.findLastIndex((x) => x.is_user);
  const fmt = (item: ChatMessageLike, force: number | false) =>
    formatMessageHistoryItem(state, sub, item, isInstruct, force, name1, name2);

  for (let i = coreChat.length - 1, j = 0; i >= 0; i--, j++) {
    const item = coreChat[j]!;
    chat2[i] = fmt(item, false);
    if (j === 0 && isInstruct) chat2[i] = fmt(item, FORCE_OUTPUT_SEQUENCE.FIRST);
    if (lastUserMessageIndex >= 0 && j === lastUserMessageIndex && isInstruct && !isImpersonate)
      chat2[i] = fmt(item, FORCE_OUTPUT_SEQUENCE.LAST);
    if (i === 0 && isContinue) {
      const FORMAT_TOKEN = '\u0000￼\u0000�';
      if (isInstruct) {
        const originalMessage = String(item.mes ?? '');
        chat2[i] = fmt(
          { ...item, mes: originalMessage.replaceAll(FORMAT_TOKEN, '') + FORMAT_TOKEN },
          FORCE_OUTPUT_SEQUENCE.LAST,
        );
      }
      const line = chat2[i]!;
      chat2[i] = line.includes(FORMAT_TOKEN)
        ? line.slice(0, line.lastIndexOf(FORMAT_TOKEN))
        : line.slice(0, line.lastIndexOf(item.mes) + item.mes.length);
      continueMag = item.mes;
    }
    if (item.is_user) userMessageIndices.push(i);
  }

  const addUserAlignment = isInstruct && !!state.powerUser.instruct.user_alignment_message;
  let userAlignmentMessage = '';
  if (addUserAlignment) {
    userAlignmentMessage = fmt(
      {
        name: name1,
        mes: sub(state.powerUser.instruct.user_alignment_message ?? ''),
        is_user: true,
      },
      FORCE_OUTPUT_SEQUENCE.FIRST,
    );
  }

  if (chat2.length == 0) chat2.push('');

  let examplesString = '';
  let chatString = addChatsPreamble(addChatsSeparator(''));
  let cyclePrompt = '';

  function addChatsPreamble(s: string) {
    return mainApi === 'novel' ? sub(deps.naiPreamble ?? '') + '\n' + s : s;
  }
  function addChatsSeparator(s: string) {
    return ctx.chat_start ? sub(ctx.chat_start + '\n') + s : s;
  }

  const getMessagesTokenCount = () =>
    countTokens(
      [
        combinedStoryString,
        examplesString,
        userAlignmentMessage,
        chatString,
        modifyLastPromptLine(''),
        cyclePrompt,
      ]
        .join('')
        .replace(/\r/gm, ''),
      tokenPadding,
    );

  let pinExmString: string | undefined;
  if (deps.powerUser.pin_examples) pinExmString = examplesString = mesExamplesArray.join('');

  if (isContinue && chat2.length > 1) {
    cyclePrompt = chat2.shift()!;
    injectedIndices = injectedIndices.map((x) => x - 1).filter((x) => x >= 0);
    userMessageIndices = userMessageIndices.map((x) => x - 1).filter((x) => x >= 0);
  }

  let arrMes: (string | undefined)[] = new Array<string | undefined>(chat2.length);
  let tokenCount = await getMessagesTokenCount();
  let lastAddedIndex = 0;

  for (const index of injectedIndices) {
    const item = chat2[index];
    if (typeof item !== 'string') continue;
    tokenCount += await countTokens(item.replace(/\r/gm, ''));
    if (tokenCount < maxContext) {
      chatString = chatString + item;
      arrMes[index] = item;
      lastAddedIndex = Math.max(lastAddedIndex, index);
    } else break;
  }
  for (let i = 0; i < chat2.length; i++) {
    if (arrMes[i] !== undefined) continue;
    const item = chat2[i];
    if (typeof item !== 'string') continue;
    tokenCount += await countTokens(item.replace(/\r/gm, ''));
    if (tokenCount < maxContext) {
      chatString = chatString + item;
      arrMes[i] = item;
      lastAddedIndex = Math.max(lastAddedIndex, i);
    } else break;
  }

  const stoppedAtUser = userMessageIndices.includes(lastAddedIndex);
  if (addUserAlignment && !stoppedAtUser) {
    tokenCount += await countTokens(userAlignmentMessage.replace(/\r/gm, ''));
    chatString = userAlignmentMessage + chatString;
    arrMes.push(userAlignmentMessage);
    injectedIndices.push(arrMes.length - 1);
  }

  const newArrMes: string[] = [];
  const newInjectedIndices: number[] = [];
  for (let i = 0; i < arrMes.length; i++) {
    if (arrMes[i] !== undefined) {
      newArrMes.push(arrMes[i]!);
      if (injectedIndices.includes(i)) newInjectedIndices.push(newArrMes.length - 1);
    }
  }
  let arrMesFinal = newArrMes;
  injectedIndices = newInjectedIndices;
  const inContextMessages = arrMesFinal.length - injectedIndices.length;

  tokenCount = await getMessagesTokenCount();
  let countExmAdd = 0;
  if (!deps.powerUser.pin_examples) {
    for (const example of mesExamplesArray) {
      tokenCount += await countTokens(example.replace(/\r/gm, ''));
      examplesString += example;
      if (tokenCount < maxContext) countExmAdd++;
      else break;
    }
  }

  let mesSend: MesSendItem[] = [];
  const generatedPromptCache = cyclePrompt || '';
  if (generatedPromptCache.length == 0 || type === 'continue') {
    chatString = '';
    arrMesFinal = arrMesFinal.reverse();
    arrMesFinal.forEach((item, i, arr) => {
      if (i === arr.length - 1 && type !== 'continue') {
        if (!isInstruct || (state.powerUser.instruct.wrap && type !== 'quiet'))
          item = item.replace(/\n?$/, '');
      }
      mesSend[mesSend.length] = { message: item, extensionPrompts: [] };
    });
  }

  let mesExmString = '';
  function setPromptString() {
    mesExmString = pinExmString ?? mesExamplesArray.slice(0, countExmAdd).join('');
    if (mesSend.length)
      mesSend[mesSend.length - 1]!.message = modifyLastPromptLine(
        mesSend[mesSend.length - 1]!.message,
      );
  }

  function modifyLastPromptLine(lastMesString: string): string {
    if (quietPrompt && quietPrompt.length) {
      const name = name1;
      const quietAppend = isInstruct
        ? formatInstructModeChat(
            state,
            sub,
            name,
            quietPrompt,
            false,
            true,
            '',
            name1,
            name2,
            false,
          )
        : `\n${quietPrompt}`;
      lastMesString += quietAppend;
      if (!isInstruct && !quietToLoud) return lastMesString;
    }
    if (isInstruct && !isContinue) {
      const name =
        quietPrompt && !quietToLoud && !isImpersonate
          ? (input.quietName ?? 'System')
          : isImpersonate
            ? name1
            : name2;
      const isQuiet = !!quietPrompt && type == 'quiet';
      lastMesString += formatInstructModePrompt(
        state,
        sub,
        name,
        isImpersonate,
        promptBias,
        name1,
        name2,
        isQuiet,
        quietToLoud,
      );
    }
    if (!isInstruct && isImpersonate && !isContinue) {
      if (!lastMesString.endsWith('\n')) lastMesString += '\n';
      lastMesString += name1 + ':';
    }
    const isContinuingOnFirstMessage = state.chat.length === 1 && isContinue;
    if (!isInstruct && forceName2 && !isContinuingOnFirstMessage) {
      if (!lastMesString.endsWith('\n')) lastMesString += '\n';
      if (!isContinue || !state.chat[state.chat.length - 1]?.is_user) lastMesString += `${name2}:`;
    }
    return lastMesString;
  }

  async function checkPromptSize(): Promise<void> {
    setPromptString();
    const jointMessages = mesSend.map((e) => `${e.extensionPrompts.join('')}${e.message}`).join('');
    const prompt = [
      combinedStoryString,
      mesExmString,
      addChatsPreamble(addChatsSeparator(jointMessages)),
      '\n',
      modifyLastPromptLine(''),
      generatedPromptCache,
    ]
      .join('')
      .replace(/\r/gm, '');
    const size = await countTokens(prompt, tokenPadding);
    if (size > maxContext) {
      if (countExmAdd > 0) {
        countExmAdd--;
        await checkPromptSize();
      } else if (mesSend.length > 0) {
        mesSend.shift();
        await checkPromptSize();
      }
    }
  }

  if (generatedPromptCache.length > 0) await checkPromptSize();
  else setPromptString();

  // 合并
  const finalMesSend: MesSendItem[] = structuredClone(mesSend);
  if (!isInstruct && !isImpersonate && promptBias.trim().length !== 0 && finalMesSend.length) {
    const last = finalMesSend[finalMesSend.length - 1]!;
    last.message += /\s/.test(last.message.slice(-1))
      ? promptBias.trimStart()
      : ` ${promptBias.trimStart()}`;
  }
  finalMesSend.forEach((item, i) => {
    item.injected = injectedIndices.includes(finalMesSend.length - i - 1);
  });
  let mesSendString = finalMesSend
    .map((e) => `${e.extensionPrompts.join('')}${e.message}`)
    .join('');
  mesSendString = addChatsPreamble(addChatsSeparator(mesSendString));
  let prompt = [combinedStoryString, mesExmString, mesSendString, generatedPromptCache]
    .join('')
    .replace(/\r/gm, '');
  if (deps.powerUser.collapse_newlines) prompt = collapseNewlines(prompt);

  // continue 的 OAI 空格补丁只对 openai 生效，TC 不加 postfix
  void continueMag;

  const stoppingStrings = getStoppingStrings(state, sub, isImpersonate, isContinue, {
    ephemeral: deps.ephemeralStoppingStrings ?? [],
  });

  return {
    prompt,
    stoppingStrings,
    storyString,
    combinedStoryString,
    mesExmString,
    mesSendString,
    mesSend: finalMesSend,
    generatedPromptCache,
    continueMag,
    injectedIndices,
    worldInfo,
    mesExamples: mesExamplesArray,
    bias,
    system,
    jailbreak,
    extensionPrompts,
    maxContext,
    inContextMessages,
  };
}

/** script.js formatMessageHistoryItem */
export function formatMessageHistoryItem(
  state: CoreState,
  substitute: Substitute,
  chatItem: ChatMessageLike,
  isInstruct: boolean,
  forceOutputSequence: number | false,
  name1: string,
  name2: string,
): string {
  const extra = (chatItem['extra'] ?? {}) as Record<string | symbol, unknown>;
  const isNarratorType = extra['type'] === 'narrator';
  const characterName = chatItem?.name ? chatItem.name : name2;
  const itemName = chatItem.is_user ? (chatItem.name ?? '') : characterName;
  if (extra[IGNORE_SYMBOL]) return '';
  let textResult =
    chatItem?.name && !isNarratorType ? `${itemName}: ${chatItem.mes}\n` : `${chatItem.mes}\n`;
  if (isInstruct)
    textResult = formatInstructModeChat(
      state,
      substitute,
      itemName,
      chatItem.mes,
      !!chatItem.is_user,
      isNarratorType,
      chatItem['force_avatar'],
      name1,
      name2,
      forceOutputSequence,
    );
  return textResult;
}

/** script.js doChatInject：把 IN_CHAT 扩展提示按深度插进 coreChat（就地修改），返回注入消息的下标 */
export async function doChatInject(
  messages: CoreChatMessage[],
  isContinue: boolean,
  extensionPrompts: ExtensionPrompts,
  substitute: (t: string) => string,
  name1: string,
  name2: string,
): Promise<number[]> {
  const injected: CoreChatMessage[] = [];
  let totalInserted = 0;
  messages.reverse();
  const depths = new Set<number>();
  for (const ep of Object.values(extensionPrompts))
    if (
      ep.position == EXTENSION_PROMPT_TYPES.IN_CHAT &&
      ep.value &&
      typeof ep.depth === 'number' &&
      ep.depth >= 0 &&
      ep.depth <= 10000
    )
      depths.add(ep.depth);
  const roles = [
    EXTENSION_PROMPT_ROLES.SYSTEM,
    EXTENSION_PROMPT_ROLES.USER,
    EXTENSION_PROMPT_ROLES.ASSISTANT,
  ] as const;
  const names: Record<number, string> = {
    [EXTENSION_PROMPT_ROLES.SYSTEM]: '',
    [EXTENSION_PROMPT_ROLES.USER]: name1,
    [EXTENSION_PROMPT_ROLES.ASSISTANT]: name2,
  };
  for (const i of [...depths].sort((a, b) => a - b)) {
    const roleMessages: CoreChatMessage[] = [];
    for (const role of roles) {
      const prompt = String(
        await getExtensionPrompt(
          extensionPrompts,
          substitute,
          EXTENSION_PROMPT_TYPES.IN_CHAT,
          i,
          '\n',
          role,
          false,
        ),
      ).trimStart();
      if (prompt) {
        roleMessages.push({
          name: names[role]!,
          is_user: role === EXTENSION_PROMPT_ROLES.USER,
          mes: prompt,
          extra: { type: role === EXTENSION_PROMPT_ROLES.SYSTEM ? 'narrator' : null },
          index: -1,
        });
      }
    }
    if (roleMessages.length) {
      const depth = isContinue && i === 0 ? 1 : i;
      const injectIdx = Math.min(depth + totalInserted, messages.length);
      messages.splice(injectIdx, 0, ...roleMessages);
      totalInserted += roleMessages.length;
      injected.push(...roleMessages);
    }
  }
  const indices = injected.map((m) => messages.indexOf(m));
  messages.reverse();
  return indices;
}
