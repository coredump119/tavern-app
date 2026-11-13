// ST openai.js prepareOpenAIMessages 及其 populate* 子流程的移植。
import type { SubstituteOptions } from '../../macros/engine.js';
import type { ChatMessageLike, CoreState } from '../../state.js';
import {
  EXTENSION_PROMPT_ROLES,
  EXTENSION_PROMPT_TYPES,
  getExtensionPrompt,
  type ExtensionPrompts,
} from '../extension-prompts.js';
import { parseExampleIntoIndividual, type ExampleMessage } from '../examples.js';
import { PERSONA_DESCRIPTION_POSITIONS } from '../persona.js';
import {
  ChatCompletion,
  InvalidCharacterNameError,
  Message,
  MessageCollection,
  TokenBudgetExceededError,
  TokenHandler,
  type ToolInvocation,
} from './messages.js';
import { Prompt, PromptCollection, PromptManager, type PromptInput } from './prompt-manager.js';
import {
  MEDIA_DISPLAY,
  MEDIA_TYPE,
  ensureMessageMediaIsArray,
  getMediaDisplay,
  getMediaIndex,
  type InlineMediaDeps,
  type MediaAttachment,
} from './media.js';
import {
  CHARACTER_NAMES_BEHAVIOR,
  CHAT_COMPLETION_SOURCES,
  INJECTION_POSITION,
  type ChatCompletionMessage,
  type ChatCompletionSettings,
} from './types.js';

export const IGNORE_SYMBOL = Symbol.for('ignore');
export const SYSTEM_MESSAGE_TYPE_NARRATOR = 'narrator';

/** setOpenAIMessages 的输出元素 */
export interface OpenAIHistoryMessage {
  role: string;
  content: string;
  name?: string | undefined;
  injected?: boolean;
  signature?: string | null;
  reasoning?: string;
  /** DEV_NOTES §9.30: `extra.media` (after legacy migration), display mode and gallery index */
  media?: MediaAttachment[] | undefined;
  mediaDisplay?: string | undefined;
  mediaIndex?: number | undefined;
  /** `extra.tool_invocations` of a tool-call turn (DEV_NOTES §9.34 第 8 轮) */
  invocations?: ToolInvocation[] | undefined;
  [key: string]: unknown;
}

/** 组装所需的宿主能力 */
export interface ChatCompletionDeps {
  settings: ChatCompletionSettings;
  promptManager: PromptManager;
  tokenHandler: TokenHandler;
  substitute: (text: string, options?: SubstituteOptions) => string;
  /** power_user.pin_examples */
  pinExamples: boolean;
  /** power_user.persona_description / position（personaDescription 标记用） */
  persona: { persona_description: string; persona_description_position: number };
  /** selected_group 是否存在 */
  isGroup: boolean;
  /** set by the host when any of ST's `is*InliningSupported()` holds; attachments join the messages */
  inlineMedia?: InlineMediaDeps | undefined;
  /** ST `ToolManager.isToolCallingSupported()`: replay stored tool calls as tool messages */
  canUseTools?: boolean | undefined;
  log?: ((message: string) => void) | undefined;
}

/** ST setOpenAIMessages：chat → [{role, content, name, ...}]（按时间顺序） */
export function setOpenAIMessages(
  state: CoreState,
  settings: ChatCompletionSettings,
  chat: readonly ChatMessageLike[],
): OpenAIHistoryMessage[] {
  const messages: OpenAIHistoryMessage[] = [];
  let j = 0;
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[j]!;
    const extra = (m['extra'] ?? {}) as Record<string | symbol, unknown>;
    let role = m.is_user ? 'user' : 'assistant';
    let content = m.mes;
    if (extra[IGNORE_SYMBOL]) {
      j++;
      continue;
    }
    const isNarrator = extra['type'] === SYSTEM_MESSAGE_TYPE_NARRATOR;
    if (isNarrator) role = 'system';
    switch (settings.names_behavior) {
      case CHARACTER_NAMES_BEHAVIOR.DEFAULT:
        if (
          (state.selectedGroup && m.name !== state.userName) ||
          (m['force_avatar'] && m.name !== state.userName && !isNarrator)
        )
          content = `${m.name}: ${content}`;
        break;
      case CHARACTER_NAMES_BEHAVIOR.CONTENT:
        if (!isNarrator) content = `${m.name}: ${content}`;
        break;
      default:
        break;
    }
    content = content.replace(/\r/gm, '');
    const isOtherGroupMember = !!state.selectedGroup && m.name !== state.charName;
    const reasoning = isOtherGroupMember ? '' : String(extra['reasoning'] ?? '');
    // media: read through the legacy migration without mutating the stored message
    const mediaExtra = { ...(extra as Record<string, unknown>) };
    ensureMessageMediaIsArray(mediaExtra);
    const probe = { ...m, extra: mediaExtra } as ChatMessageLike;
    const media = Array.isArray(mediaExtra['media'])
      ? (mediaExtra['media'] as MediaAttachment[])
      : undefined;
    messages[i] = {
      role,
      content,
      name: m.name,
      signature: null,
      reasoning,
      ...(Array.isArray(extra['tool_invocations'])
        ? { invocations: (extra['tool_invocations'] as ToolInvocation[]).slice() }
        : {}),
      ...(media && media.length
        ? {
            media,
            mediaDisplay: getMediaDisplay(probe, state.powerUser['media_display']),
            mediaIndex: getMediaIndex(probe),
          }
        : {}),
    };
    j++;
  }
  return messages;
}

/** ST setOpenAIMessageExamples */
export function setOpenAIMessageExamples(
  state: CoreState,
  name1: string,
  name2: string,
  mesExamplesArray: readonly string[],
): ExampleMessage[][] {
  return mesExamplesArray.map((item) => {
    const replaced = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
    return parseExampleIntoIndividual(state, name1, name2, replaced, true);
  });
}

function stringFormat(format: string, ...args: string[]): string {
  return format.replace(/{(\d+)}/g, (match, number: string) =>
    typeof args[Number(number)] != 'undefined' ? args[Number(number)]! : match,
  );
}

export function formatWorldInfo(value: string, wiFormat: string): string {
  if (!value) return '';
  if (!wiFormat.trim()) return value;
  return stringFormat(wiFormat, value);
}

export function getPromptPosition(position: number): 'start' | 'end' | false {
  if (position == EXTENSION_PROMPT_TYPES.BEFORE_PROMPT) return 'start';
  if (position == EXTENSION_PROMPT_TYPES.IN_PROMPT) return 'end';
  return false;
}

export function getPromptRole(role: number | undefined): string {
  switch (role) {
    case EXTENSION_PROMPT_ROLES.USER:
      return 'user';
    case EXTENSION_PROMPT_ROLES.ASSISTANT:
      return 'assistant';
    default:
      return 'system';
  }
}

export interface PrepareOpenAIMessagesInput {
  name2: string;
  charDescription: string;
  charPersonality: string;
  scenario: string;
  worldInfoBefore: string;
  worldInfoAfter: string;
  bias: string;
  type: string;
  quietPrompt: string;
  extensionPrompts: ExtensionPrompts;
  cyclePrompt: string;
  systemPromptOverride: string;
  jailbreakPromptOverride: string;
  messages: OpenAIHistoryMessage[];
  messageExamples: ExampleMessage[][];
}

export async function preparePromptsForChatCompletion(
  input: PrepareOpenAIMessagesInput,
  deps: ChatCompletionDeps,
): Promise<PromptCollection> {
  const s = deps.settings;
  const pm = deps.promptManager;
  const sub = deps.substitute;
  const {
    scenario,
    charPersonality,
    worldInfoBefore,
    worldInfoAfter,
    charDescription,
    quietPrompt,
    bias,
    extensionPrompts,
    systemPromptOverride,
    jailbreakPromptOverride,
    type,
  } = input;

  const scenarioText = scenario && s.scenario_format ? sub(s.scenario_format) : scenario || '';
  const charPersonalityText =
    charPersonality && s.personality_format ? sub(s.personality_format) : charPersonality || '';
  const groupNudge = sub(s.group_nudge_prompt);
  const impersonationPrompt = s.impersonation_prompt ? sub(s.impersonation_prompt) : '';

  type SysPrompt = PromptInput & { identifier: string; role: string; content: string };
  const systemPrompts: SysPrompt[] = [
    {
      role: 'system',
      content: formatWorldInfo(worldInfoBefore, s.wi_format),
      identifier: 'worldInfoBefore',
    },
    {
      role: 'system',
      content: formatWorldInfo(worldInfoAfter, s.wi_format),
      identifier: 'worldInfoAfter',
    },
    { role: 'system', content: charDescription, identifier: 'charDescription' },
    { role: 'system', content: charPersonalityText, identifier: 'charPersonality' },
    { role: 'system', content: scenarioText, identifier: 'scenario' },
    { role: 'system', content: impersonationPrompt, identifier: 'impersonate' },
    { role: 'system', content: quietPrompt, identifier: 'quietPrompt' },
    { role: 'system', content: groupNudge, identifier: 'groupNudge' },
    { role: 'assistant', content: bias, identifier: 'bias' },
  ];

  const known: Array<[string, string, boolean]> = [
    ['1_memory', 'summary', true],
    ['2_floating_prompt', 'authorsNote', true],
    ['3_vectors', 'vectorsMemory', false],
    ['4_vectors_data_bank', 'vectorsDataBank', true],
    ['chromadb', 'smartContext', false],
  ];
  for (const [key, identifier, useRole] of known) {
    const p = extensionPrompts[key];
    if (p && p.value) {
      systemPrompts.push({
        role: useRole ? getPromptRole(p.role) : 'system',
        content: p.value,
        identifier,
        position: getPromptPosition(p.position),
      });
    }
  }

  if (
    deps.persona.persona_description &&
    deps.persona.persona_description_position === PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT
  ) {
    systemPrompts.push({
      role: 'system',
      content: deps.persona.persona_description,
      identifier: 'personaDescription',
    });
  }

  const knownExtensionPrompts = [
    '1_memory',
    '2_floating_prompt',
    '3_vectors',
    '4_vectors_data_bank',
    'chromadb',
    'PERSONA_DESCRIPTION',
    'QUIET_PROMPT',
    'DEPTH_PROMPT',
  ];
  for (const key of Object.keys(extensionPrompts)) {
    const prompt = extensionPrompts[key]!;
    if (knownExtensionPrompts.includes(key)) continue;
    if (!prompt.value) continue;
    if (
      ![EXTENSION_PROMPT_TYPES.BEFORE_PROMPT, EXTENSION_PROMPT_TYPES.IN_PROMPT].includes(
        prompt.position as 0 | 2,
      )
    )
      continue;
    if (typeof prompt.filter === 'function' && !(await prompt.filter())) continue;
    systemPrompts.push({
      identifier: key.replace(/\W/g, '_'),
      position: getPromptPosition(prompt.position),
      role: getPromptRole(prompt.role),
      content: prompt.value,
      extension: true,
    });
  }

  const prompts = pm.getPromptCollection(type);

  for (const prompt of systemPrompts) {
    const collectionPrompt = prompts.get(prompt.identifier);
    if (collectionPrompt) {
      prompt.injection_position = collectionPrompt.injection_position ?? prompt.injection_position;
      prompt.injection_depth = collectionPrompt.injection_depth ?? prompt.injection_depth;
      prompt.injection_order = collectionPrompt.injection_order ?? prompt.injection_order;
      prompt.role = collectionPrompt.role ?? prompt.role;
    }
    const newPrompt = pm.preparePrompt(prompt);
    const markerIndex = prompts.index(prompt.identifier);
    if (-1 !== markerIndex) prompts.collection[markerIndex] = newPrompt;
    else prompts.add(newPrompt);
  }

  const systemPrompt = prompts.get('main') ?? null;
  if (
    systemPromptOverride &&
    systemPrompt &&
    systemPrompt.forbid_overrides !== true &&
    !pm.isPromptDisabledForActiveCharacter('main')
  ) {
    const original = systemPrompt.content ?? '';
    systemPrompt.content = systemPromptOverride;
    prompts.override(pm.preparePrompt(systemPrompt, original), prompts.index('main'));
  }
  const jailbreakPrompt = prompts.get('jailbreak') ?? null;
  if (
    jailbreakPromptOverride &&
    jailbreakPrompt &&
    jailbreakPrompt.forbid_overrides !== true &&
    !pm.isPromptDisabledForActiveCharacter('jailbreak')
  ) {
    const original = jailbreakPrompt.content ?? '';
    jailbreakPrompt.content = jailbreakPromptOverride;
    prompts.override(pm.preparePrompt(jailbreakPrompt, original), prompts.index('jailbreak'));
  }
  return prompts;
}

/** ST populationInjectionPrompts：按深度把绝对定位的 prompt 与 IN_CHAT 扩展提示插进（逆序的）消息里，再反转为正序 */
export async function populationInjectionPrompts(
  prompts: Prompt[],
  messages: OpenAIHistoryMessage[],
  extensionPrompts: ExtensionPrompts,
  substitute: (t: string) => string,
): Promise<OpenAIHistoryMessage[]> {
  let totalInsertedMessages = 0;
  const roleTypes: Record<string, number> = {
    system: EXTENSION_PROMPT_ROLES.SYSTEM,
    user: EXTENSION_PROMPT_ROLES.USER,
    assistant: EXTENSION_PROMPT_ROLES.ASSISTANT,
  };
  const separator = '\n';
  const wrap = false;
  const extensionPromptsOrder = '100';

  // ST 遍历 0..MAX_INJECTION_DEPTH(10000)；只有存在内容的深度会产出消息，这里只枚举这些深度（结果一致）
  const depths = new Set<number>();
  for (const p of prompts)
    if (p.content && typeof p.injection_depth === 'number') depths.add(p.injection_depth);
  for (const ep of Object.values(extensionPrompts))
    if (ep.position == EXTENSION_PROMPT_TYPES.IN_CHAT && ep.value && typeof ep.depth === 'number')
      depths.add(ep.depth);

  for (const i of [...depths].filter((d) => d >= 0 && d <= 10000).sort((a, b) => a - b)) {
    const depthPrompts = prompts.filter((p) => p.injection_depth === i && p.content);
    const roleMessages: OpenAIHistoryMessage[] = [];
    const orderGroups: Record<string, Prompt[]> = { [extensionPromptsOrder]: [] };
    for (const prompt of depthPrompts) {
      const order = String(prompt.injection_order ?? 100);
      (orderGroups[order] ??= []).push(prompt);
    }
    const orders = Object.keys(orderGroups).sort((a, b) => +b - +a);
    for (const order of orders) {
      const orderPrompts = orderGroups[order]!;
      for (const role of ['system', 'user', 'assistant']) {
        const rolePrompts = orderPrompts
          .filter((p) => p.role === role)
          .map((x) => x.content ?? '')
          .join(separator);
        const extensionPrompt =
          order === extensionPromptsOrder
            ? await getExtensionPrompt(
                extensionPrompts,
                substitute,
                EXTENSION_PROMPT_TYPES.IN_CHAT,
                i,
                separator,
                roleTypes[role],
                wrap,
              )
            : '';
        const jointPrompt = [rolePrompts, extensionPrompt]
          .filter((x) => x)
          .map((x) => x.trim())
          .join(separator);
        if (jointPrompt && jointPrompt.length)
          roleMessages.push({ role, content: jointPrompt, injected: true });
      }
    }
    if (roleMessages.length) {
      const injectIdx = i + totalInsertedMessages;
      messages.splice(injectIdx, 0, ...roleMessages);
      totalInsertedMessages += roleMessages.length;
    }
  }
  return messages.reverse();
}

async function populateChatHistory(
  messages: OpenAIHistoryMessage[],
  prompts: PromptCollection,
  chatCompletion: ChatCompletion,
  deps: ChatCompletionDeps,
  type: string | null,
  cyclePrompt: string | null,
): Promise<void> {
  if (!prompts.has('chatHistory')) return;
  const s = deps.settings;
  const th = deps.tokenHandler;
  const pm = deps.promptManager;
  chatCompletion.add(new MessageCollection('chatHistory'), prompts.index('chatHistory'));

  const newChat = deps.isGroup ? s.new_group_chat_prompt : s.new_chat_prompt;
  const newChatMessage = await Message.createAsync(
    th,
    'system',
    deps.substitute(newChat),
    'newMainChat',
  );
  chatCompletion.reserveBudget(newChatMessage);

  let groupNudgeMessage: Message | null = null;
  if (deps.isGroup && prompts.has('groupNudge') && type !== 'impersonate') {
    groupNudgeMessage = await Message.fromPromptAsync(th, prompts.get('groupNudge')!);
    chatCompletion.reserveBudget(groupNudgeMessage);
  }

  let continueMessageCollection: MessageCollection | null = null;
  if (type === 'continue' && cyclePrompt && !s.continue_prefill) {
    const promptObject = {
      identifier: 'continueNudge',
      role: 'system',
      content: deps.substitute(s.continue_nudge_prompt, {
        dynamicMacros: { lastChatMessage: String(cyclePrompt).trim() },
      }),
      system_prompt: true,
    };
    continueMessageCollection = new MessageCollection('continueNudge');
    const continueMessageIndex = messages.findLastIndex((x) => !x.injected);
    if (continueMessageIndex >= 0) {
      const continueMessage = messages.splice(continueMessageIndex, 1)[0]!;
      const chatMessage = await Message.fromPromptAsync(
        th,
        pm.preparePrompt(new Prompt(continueMessage as PromptInput)),
      );
      continueMessageCollection.add(chatMessage);
    }
    continueMessageCollection.add(
      await Message.fromPromptAsync(th, pm.preparePrompt(new Prompt(promptObject))),
    );
    chatCompletion.reserveBudget(continueMessageCollection);
  }

  const lastChatPrompt = messages[messages.length - 1];
  const emptyMessage = await Message.createAsync(
    th,
    'user',
    s.send_if_empty,
    'emptyUserMessageReplacement',
  );
  if (
    lastChatPrompt &&
    lastChatPrompt.role === 'assistant' &&
    s.send_if_empty &&
    chatCompletion.canAfford(emptyMessage)
  ) {
    chatCompletion.insert(emptyMessage, 'chatHistory');
  }

  const chatPool = [...messages].reverse();
  for (let index = 0; index < chatPool.length; index++) {
    const chatPrompt = chatPool[index]!;
    const prompt = new Prompt(chatPrompt as PromptInput);
    prompt.identifier = `chatHistory-${messages.length - index}`;
    const chatMessage = await Message.fromPromptAsync(th, pm.preparePrompt(prompt));
    if (s.names_behavior === CHARACTER_NAMES_BEHAVIOR.COMPLETION && prompt.name) {
      const messageName = pm.isValidName(prompt.name) ? prompt.name : pm.sanitizeName(prompt.name);
      await chatMessage.setName(th, messageName);
    }
    // ST: a tool-call turn goes in as the assistant's `tool_calls` plus one `tool` message per result
    if (deps.canUseTools && Array.isArray(chatPrompt.invocations)) {
      const invocations = chatPrompt.invocations;
      const toolCallMessage = await Message.createAsync(
        th,
        chatMessage.role,
        undefined,
        `toolCall-${chatMessage.identifier}`,
      );
      const toolResultMessages = await Promise.all(
        invocations
          .slice()
          .reverse()
          .map((i) => Message.createAsync(th, 'tool', i.result || '[No content]', i.id)),
      );
      await toolCallMessage.setToolCalls(th, invocations);
      if (!chatCompletion.canAffordAll([toolCallMessage, ...toolResultMessages])) break;
      for (const resultMessage of toolResultMessages)
        chatCompletion.insertAtStart(resultMessage, 'chatHistory');
      chatCompletion.insertAtStart(toolCallMessage, 'chatHistory');
      continue;
    }
    // ST inlineMediaAttachment: list mode inlines every attachment, gallery only the selected one
    const inline = deps.inlineMedia;
    if (inline && Array.isArray(chatPrompt.media) && chatPrompt.media.length) {
      const list =
        chatPrompt.mediaDisplay === MEDIA_DISPLAY.GALLERY
          ? [chatPrompt.media[chatPrompt.mediaIndex ?? 0]]
          : chatPrompt.media;
      for (const media of list) {
        if (!media?.url) continue;
        const type = media.type || MEDIA_TYPE.IMAGE;
        if (inline.image && type === MEDIA_TYPE.IMAGE)
          await chatMessage.addImage(inline, media.url);
        if (inline.video && type === MEDIA_TYPE.VIDEO)
          await chatMessage.addVideo(inline, media.url);
        if (inline.audio && type === MEDIA_TYPE.AUDIO)
          await chatMessage.addAudio(inline, media.url);
      }
    }
    if (chatCompletion.canAfford(chatMessage))
      chatCompletion.insertAtStart(chatMessage, 'chatHistory');
    else break;
  }

  chatCompletion.freeBudget(newChatMessage);
  chatCompletion.insertAtStart(newChatMessage, 'chatHistory');

  if (deps.isGroup && groupNudgeMessage) {
    chatCompletion.freeBudget(groupNudgeMessage);
    chatCompletion.insertAtEnd(groupNudgeMessage, 'chatHistory');
  }
  if (type === 'continue' && continueMessageCollection) {
    chatCompletion.freeBudget(continueMessageCollection);
    chatCompletion.add(continueMessageCollection, -1);
  }
}

async function populateDialogueExamples(
  prompts: PromptCollection,
  chatCompletion: ChatCompletion,
  deps: ChatCompletionDeps,
  messageExamples: ExampleMessage[][],
): Promise<void> {
  if (!prompts.has('dialogueExamples')) return;
  const th = deps.tokenHandler;
  chatCompletion.add(new MessageCollection('dialogueExamples'), prompts.index('dialogueExamples'));
  if (Array.isArray(messageExamples) && messageExamples.length) {
    const newExampleChat = await Message.createAsync(
      th,
      'system',
      deps.substitute(deps.settings.new_example_chat_prompt),
      'newChat',
    );
    for (const [dialogueIndex, dialogue] of messageExamples.entries()) {
      const chatMessages: Message[] = [];
      for (let promptIndex = 0; promptIndex < dialogue.length; promptIndex++) {
        const prompt = dialogue[promptIndex]!;
        const chatMessage = await Message.createAsync(
          th,
          'system',
          prompt.content || '',
          `dialogueExamples ${dialogueIndex}-${promptIndex}`,
        );
        await chatMessage.setName(th, prompt.name);
        chatMessages.push(chatMessage);
      }
      if (!chatCompletion.canAffordAll([newExampleChat, ...chatMessages])) break;
      chatCompletion.insert(newExampleChat, 'dialogueExamples');
      for (const m of chatMessages) chatCompletion.insert(m, 'dialogueExamples');
    }
  }
}

async function populateChatCompletion(
  prompts: PromptCollection,
  chatCompletion: ChatCompletion,
  deps: ChatCompletionDeps,
  {
    bias,
    type,
    cyclePrompt,
    messages,
    messageExamples,
    extensionPrompts,
  }: {
    bias: string;
    type: string;
    cyclePrompt: string;
    messages: OpenAIHistoryMessage[];
    messageExamples: ExampleMessage[][];
    extensionPrompts: ExtensionPrompts;
  },
): Promise<void> {
  const th = deps.tokenHandler;
  const pm = deps.promptManager;
  const s = deps.settings;

  const addToChatCompletion = async (source: string, target: string | null = null) => {
    if (!prompts.has(source)) return;
    if (pm.isPromptDisabledForActiveCharacter(source) && source !== 'main') return;
    const prompt = prompts.get(source)!;
    if (prompt.injection_position === INJECTION_POSITION.ABSOLUTE) return;
    const index = target ? prompts.index(target) : prompts.index(source);
    const collection = new MessageCollection(source);
    collection.add(await Message.fromPromptAsync(th, prompt));
    chatCompletion.add(collection, index);
  };

  chatCompletion.reserveBudget(3);
  await addToChatCompletion('worldInfoBefore');
  await addToChatCompletion('main');
  await addToChatCompletion('worldInfoAfter');
  await addToChatCompletion('charDescription');
  await addToChatCompletion('charPersonality');
  await addToChatCompletion('scenario');
  await addToChatCompletion('personaDescription');

  chatCompletion.setOverriddenPrompts(prompts.overriddenPrompts);
  const controlPrompts = new MessageCollection('controlPrompts');

  const impersonatePrompt = prompts.get('impersonate');
  if (type === 'impersonate' && impersonatePrompt)
    controlPrompts.add(await Message.fromPromptAsync(th, impersonatePrompt));

  const quietPromptDef = prompts.get('quietPrompt');
  const quietPromptMessage = quietPromptDef
    ? await Message.fromPromptAsync(th, quietPromptDef)
    : null;
  if (quietPromptMessage && quietPromptMessage.content) controlPrompts.add(quietPromptMessage);

  chatCompletion.reserveBudget(controlPrompts);

  const systemPrompts = ['nsfw', 'jailbreak'];
  const userRelativePrompts = prompts.collection
    .filter(
      (p) => p.system_prompt === false && p.injection_position !== INJECTION_POSITION.ABSOLUTE,
    )
    .map((p) => p.identifier);
  const absolutePrompts = prompts.collection.filter(
    (p) => p.injection_position === INJECTION_POSITION.ABSOLUTE,
  );

  for (const identifier of [...systemPrompts, ...userRelativePrompts])
    await addToChatCompletion(identifier);
  if (prompts.has('enhanceDefinitions')) await addToChatCompletion('enhanceDefinitions');
  if (bias && bias.trim().length) await addToChatCompletion('bias');

  const injectToMain = async (prompt: Prompt, position: string | number) => {
    if (chatCompletion.has('main')) {
      chatCompletion.insert(await Message.fromPromptAsync(th, prompt), 'main', position);
    } else {
      const indexOfMain = absolutePrompts.findIndex((p) => p.identifier === 'main');
      if (indexOfMain >= 0) {
        const main = absolutePrompts[indexOfMain]!;
        const promptCopy = new Prompt(prompt);
        promptCopy.role = main.role;
        promptCopy.injection_position = main.injection_position;
        promptCopy.injection_depth = main.injection_depth;
        promptCopy.injection_order = main.injection_order;
        absolutePrompts.splice(position === 'end' ? indexOfMain + 1 : indexOfMain, 0, promptCopy);
      }
    }
  };

  for (const key of [
    'summary',
    'authorsNote',
    'vectorsMemory',
    'vectorsDataBank',
    'smartContext',
  ]) {
    if (prompts.has(key)) {
      const prompt = prompts.get(key)!;
      if (prompt.position) await injectToMain(prompt, prompt.position);
    }
  }
  for (const prompt of prompts.collection.filter((p) => p.extension && p.position))
    await injectToMain(prompt, prompt.position as string);

  if (type === 'continue' && s.continue_prefill && messages.length) {
    const chatMessage = messages.shift()!;
    const isAssistantRole = chatMessage.role === 'assistant';
    const supportsAssistantPrefill = s.chat_completion_source === CHAT_COMPLETION_SOURCES.CLAUDE;
    const namesInCompletion = s.names_behavior === CHARACTER_NAMES_BEHAVIOR.COMPLETION;
    const assistantPrefill =
      isAssistantRole && supportsAssistantPrefill ? deps.substitute(s.assistant_prefill) : '';
    const messageContent = [assistantPrefill, chatMessage.content].filter((x) => x).join('\n\n');
    const continueMessage = await Message.createAsync(
      th,
      chatMessage.role,
      messageContent,
      'continuePrefill',
    );
    if (chatMessage.name && namesInCompletion)
      await continueMessage.setName(th, pm.sanitizeName(chatMessage.name));
    controlPrompts.add(continueMessage);
    chatCompletion.reserveBudget(continueMessage);
  }

  messages = await populationInjectionPrompts(absolutePrompts, messages, extensionPrompts, (t) =>
    deps.substitute(t),
  );

  if (deps.pinExamples) {
    await populateDialogueExamples(prompts, chatCompletion, deps, messageExamples);
    await populateChatHistory(messages, prompts, chatCompletion, deps, type, cyclePrompt);
  } else {
    await populateChatHistory(messages, prompts, chatCompletion, deps, type, cyclePrompt);
    await populateDialogueExamples(prompts, chatCompletion, deps, messageExamples);
  }

  chatCompletion.freeBudget(controlPrompts);
  if (controlPrompts.collection.length) chatCompletion.add(controlPrompts);
}

export interface PrepareOpenAIMessagesResult {
  chat: ChatCompletionMessage[];
  counts: Record<string, number>;
  chatCompletion: ChatCompletion;
  /** 预算不足等错误（ST 里只 toast，不抛出） */
  error: Error | null;
  /** 不含 tool_calls 的 user/assistant/tool 消息数（openai_messages_count） */
  messagesCount: number;
}

/** ST prepareOpenAIMessages */
export async function prepareOpenAIMessages(
  input: PrepareOpenAIMessagesInput,
  deps: ChatCompletionDeps,
  dryRun = false,
): Promise<PrepareOpenAIMessagesResult> {
  const s = deps.settings;
  const chatCompletion = new ChatCompletion(deps.log);
  chatCompletion.setTokenBudget(s.openai_max_context, s.openai_max_tokens);
  let error: Error | null = null;
  try {
    const prompts = await preparePromptsForChatCompletion(input, deps);
    const { bias, type, cyclePrompt, messages, messageExamples, extensionPrompts } = input;
    await populateChatCompletion(prompts, chatCompletion, deps, {
      bias,
      type,
      cyclePrompt,
      messages,
      messageExamples,
      extensionPrompts,
    });
  } catch (e) {
    error = e as Error;
    if (e instanceof TokenBudgetExceededError)
      chatCompletion.log('Mandatory prompts exceed the context size.');
    else if (e instanceof InvalidCharacterNameError) chatCompletion.log('Invalid character name');
    else chatCompletion.log(`Unexpected error while preparing prompts: ${String(e)}`);
  } finally {
    if (s.squash_system_messages && dryRun == false)
      await chatCompletion.squashSystemMessages(deps.tokenHandler);
  }
  const chat = chatCompletion.getChat();
  const messagesCount =
    chat.filter((x) => !x?.tool_calls && ['user', 'assistant', 'tool'].includes(x?.role)).length ||
    0;
  return { chat, counts: deps.tokenHandler.counts, chatCompletion, error, messagesCount };
}
