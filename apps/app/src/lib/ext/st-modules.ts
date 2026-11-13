/**
 * Exports of ST's own modules that need nothing from the running app (DEV_NOTES §9.34, 第 10 轮):
 * constants, enums, classes and pure functions ported from ST 1.18.0, keyed by the stand-in module
 * path extensions import them from. What reads app state lives in `st-modules-app.ts`.
 */
import {
  ChatCompletion,
  DEFAULT_DEPTH,
  DEFAULT_WEIGHT,
  MAX_INJECTION_DEPTH,
  Message,
  MessageCollection,
  PERSONA_DESCRIPTION_POSITIONS,
  Prompt,
  PromptCollection,
  REGEX_PLACEMENT,
  WI_ANCHOR_POSITION,
  WORLD_INFO_LOGIC,
  WORLD_INFO_METADATA_KEY,
  WORLD_INFO_POSITION,
  getStringHash,
  newWorldInfoEntryTemplate,
  parseRegexFromString,
  sanitizeFilename,
} from '@tm/core';
import type { ModuleTable } from '@tm/st-compat';

type Obj = Record<string, unknown>;
/** provider response bodies are read the way ST reads them: untyped, optional all the way down */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** ST scripts/system-messages.js `system_message_types` */
export const SYSTEM_MESSAGE_TYPES = {
  HELP: 'help',
  WELCOME: 'welcome',
  EMPTY: 'empty',
  GENERIC: 'generic',
  NARRATOR: 'narrator',
  COMMENT: 'comment',
  SLASH_COMMANDS: 'slash_commands',
  FORMATTING: 'formatting',
  HOTKEYS: 'hotkeys',
  MACROS: 'macros',
  WELCOME_PROMPT: 'welcome_prompt',
  ASSISTANT_NOTE: 'assistant_note',
  ASSISTANT_MESSAGE: 'assistant_message',
} as const;

export const EXTENSION_PROMPT_ROLES = { SYSTEM: 0, USER: 1, ASSISTANT: 2 } as const;

/** ST `getExtensionPromptRoleByName()` */
export function getExtensionPromptRoleByName(roleName: unknown): number {
  const roles: readonly number[] = Object.values(EXTENSION_PROMPT_ROLES);
  if (typeof roleName === 'number' && roles.includes(roleName)) return roleName;
  if (roleName === 'user') return EXTENSION_PROMPT_ROLES.USER;
  if (roleName === 'assistant') return EXTENSION_PROMPT_ROLES.ASSISTANT;
  return EXTENSION_PROMPT_ROLES.SYSTEM;
}

/** ST utils.js `countOccurrences()` */
export function countOccurrences(string: string, character: string): number {
  let count = 0;
  for (let i = 0; i < string.length; i++) {
    if (string.substring(i, i + character.length) === character) count++;
  }
  return count;
}

const DATA_URL =
  /^data:([a-z]+\/[a-z0-9-+.]+(;[a-z-]+=[a-z0-9-]+)*;?)?(base64)?,([a-z0-9!$&',()*+;=\-_%.~:@/?#]+)?$/i;

/** ST utils.js `isDataURL()` */
export const isDataURL = (str: unknown): boolean => typeof str === 'string' && DATA_URL.test(str);

/** ST utils.js `Stopwatch` */
export class Stopwatch {
  interval: number;
  lastAction = Date.now();

  constructor(interval: number) {
    this.interval = Number.isFinite(interval) && interval > 0 ? interval : 1;
  }

  async tick(action: () => unknown): Promise<void> {
    if (Date.now() - this.lastAction < this.interval) return;
    await action();
    this.lastAction = Date.now();
  }
}

/** ST slash-commands/SlashCommandEnumValue.js `enumTypes` */
export const enumTypes = {
  enum: 'enum',
  command: 'command',
  namedArgument: 'namedArgument',
  variable: 'variable',
  qr: 'qr',
  macro: 'macro',
  number: 'number',
  name: 'name',
  getBasedOnIndex(index: number | null | undefined): unknown {
    const keys = Object.keys(this) as (keyof typeof this)[];
    return this[keys[(index ?? 0) % keys.length]!];
  },
};

/** ST slash-commands/SlashCommandEnumValue.js `SlashCommandEnumValue` */
export class SlashCommandEnumValue {
  type: string;

  constructor(
    public value: string,
    public description: string | null = null,
    type: string | null = 'enum',
    public typeIcon = '◊',
    public matchProvider: unknown = null,
    public valueProvider: unknown = null,
    public makeSelectable = false,
  ) {
    this.type = type ?? 'enum';
  }

  toString(): string {
    return this.value;
  }
}

/** ST slash-commands/SlashCommandCommonEnumsProvider.js `enumIcons` */
export const enumIcons = {
  default: '◊',
  variable: '𝑥',
  localVariable: 'L',
  globalVariable: 'G',
  scopeVariable: 'S',
  character: '👤',
  group: '🧑‍🤝‍🧑',
  persona: '🧙‍♂️',
  qr: 'QR',
  closure: '𝑓',
  macro: '{{',
  tag: '🏷️',
  world: '🌐',
  preset: '⚙️',
  file: '📄',
  message: '💬',
  reasoning: '💡',
  voice: '🎤',
  server: '🖥️',
  popup: '🗔',
  image: '🖼️',
  video: '🎥',
  key: '🔑',
  spinner: '♻️',
  stop: '🛑',
  true: '✔️',
  false: '❌',
  null: '🚫',
  undefined: '❓',
  boolean: '🔲',
  string: '📝',
  number: '1️⃣',
  array: '[]',
  enum: '📚',
  dictionary: '{}',
  system: '⚙️',
  user: '👤',
  assistant: '🤖',
  constant: '🔵',
  normal: '🟢',
  disabled: '❌',
  vectorized: '🔗',
  /** ST `enumIcons.getStateIcon()` */
  getStateIcon(state: unknown): string {
    return state ? '✔️' : '❌';
  },
};

/** what the slash-command enum providers list from the app */
export interface EnumSources {
  characters(): readonly { name?: unknown; avatar?: unknown }[];
  groups(): readonly { name?: unknown; id?: unknown }[];
  /** `power_user.personas`: avatar file → persona name */
  personas(): Record<string, unknown>;
  worldNames(): readonly string[];
  messageCount(): number;
}

const enumValue = (value: unknown, description: string | null, type: string, icon: string) =>
  new SlashCommandEnumValue(String(value ?? ''), description, type, icon);

/** ST `commonEnumProviders`: the lists the autocomplete shows; the app has no autocomplete, the data is real */
export function createCommonEnumProviders(sources: EnumSources) {
  const characters = () =>
    sources
      .characters()
      .map((c) => enumValue(c.name, String(c.avatar ?? ''), enumTypes.name, enumIcons.character));
  const groups = () =>
    sources
      .groups()
      .map((g) => enumValue(g.name, String(g.id ?? ''), enumTypes.qr, enumIcons.group));
  const none = (): SlashCommandEnumValue[] => [];
  return {
    boolean:
      (mode = 'trueFalse') =>
      (): SlashCommandEnumValue[] => {
        const on = enumValue('on', null, 'on', enumIcons.true);
        const off = enumValue('off', null, 'off', enumIcons.false);
        if (mode === 'onOff') return [on, off];
        if (mode === 'onOffToggle')
          return [on, off, enumValue('toggle', null, 'toggle', enumIcons.boolean)];
        return [
          enumValue('true', null, 'true', enumIcons.true),
          enumValue('false', null, 'false', enumIcons.false),
        ];
      },
    variables: () => none,
    numbersAndVariables: none,
    characters:
      (mode = 'all') =>
      (): SlashCommandEnumValue[] => [
        ...(mode === 'group' ? [] : characters()),
        ...(mode === 'character' ? [] : groups()),
      ],
    groupMembers: () => none,
    personas: () => (): SlashCommandEnumValue[] =>
      Object.entries(sources.personas()).map(([key, name]) =>
        enumValue(name, key, enumTypes.name, enumIcons.persona),
      ),
    tags: () => none,
    tagsForChar: () => none,
    messages: () => (): SlashCommandEnumValue[] =>
      Array.from({ length: sources.messageCount() }, (_, id) =>
        enumValue(id, null, enumTypes.number, enumIcons.message),
      ),
    messageMedia: () => none,
    messageNames: none,
    worlds: (): SlashCommandEnumValue[] =>
      sources.worldNames().map((name) => enumValue(name, null, enumTypes.name, enumIcons.world)),
    injects: none,
    types: (): SlashCommandEnumValue[] =>
      ['string', 'number', 'boolean', 'array', 'object', 'null', 'undefined'].map((type) =>
        enumValue(type, null, enumTypes.enum, enumIcons.default),
      ),
    messageRoles: (): SlashCommandEnumValue[] =>
      (['system', 'user', 'assistant'] as const).map((role) =>
        enumValue(role, null, enumTypes.enum, enumIcons[role]),
      ),
    backgrounds: none,
    connectionProfiles: () => none,
    folderEnum: none,
  };
}

/** the live settings a response is read against */
export interface ReplySettings {
  mainApi: string;
  /** `oai_settings.chat_completion_source` */
  source: string;
  /** `oai_settings.show_thoughts` */
  showThoughts: boolean;
  /** `textgenerationwebui_settings.type` */
  textGenType: string;
}

/** sources that answer in the OpenAI shape and may carry `reasoning_content` */
const OPENAI_SHAPED = new Set([
  'custom',
  'pollinations',
  'aimlapi',
  'moonshot',
  'cometapi',
  'electronhub',
  'nanogpt',
  'zai',
  'siliconflow',
  'chutes',
  'workers_ai',
]);

const joined = (parts: unknown): string =>
  Array.isArray(parts) ? parts.filter((x) => x).join('\n\n') : '';

/** ST reasoning.js `extractReasoningFromData()` */
export function extractReasoningFromData(
  data: Loose,
  options: {
    mainApi?: string | null;
    ignoreShowThoughts?: boolean;
    textGenType?: string | null;
    chatCompletionSource?: string | null;
  } = {},
  live: ReplySettings,
): string {
  const message = data?.choices?.[0]?.message;
  switch (options.mainApi ?? live.mainApi) {
    case 'textgenerationwebui':
      switch (options.textGenType ?? live.textGenType) {
        case 'openrouter':
          return data?.choices?.[0]?.reasoning ?? '';
        case 'ollama':
          return data?.thinking ?? '';
      }
      break;
    case 'openai': {
      if (!options.ignoreShowThoughts && !live.showThoughts) break;
      const source = options.chatCompletionSource ?? live.source;
      if (source === 'deepseek' || source === 'xai') return message?.reasoning_content ?? '';
      if (source === 'openrouter') return message?.reasoning ?? message?.reasoning_content ?? '';
      if (source === 'makersuite' || source === 'vertexai')
        return joined(
          data?.responseContent?.parts?.filter((p: Loose) => p.thought)?.map((p: Loose) => p.text),
        );
      if (source === 'claude')
        return joined(
          data?.content?.filter((p: Loose) => p.type === 'thinking')?.map((p: Loose) => p.thinking),
        );
      if (source === 'mistralai')
        return joined(message?.content?.[0]?.thinking?.map((p: Loose) => p.text));
      if (OPENAI_SHAPED.has(source)) return message?.reasoning_content ?? message?.reasoning ?? '';
      break;
    }
  }
  return '';
}

/** ST openai.js `getStreamingReply()`: the text of one stream chunk; reasoning and images go to `state` */
export function getStreamingReply(
  data: Loose,
  state: Loose,
  options: { chatCompletionSource?: string | null; overrideShowThoughts?: boolean | null } = {},
  live: ReplySettings,
): string {
  const source = options.chatCompletionSource ?? live.source;
  const thoughts = options.overrideShowThoughts ?? live.showThoughts;
  const choices: Loose[] | undefined = data?.choices;
  const first = (pick: (choice: Loose) => unknown): unknown => {
    for (const choice of choices ?? []) {
      const value = pick(choice);
      if (value) return value;
    }
    return undefined;
  };
  const openAiText = (): Loose =>
    choices?.[0]?.delta?.content ?? choices?.[0]?.message?.content ?? choices?.[0]?.text ?? '';

  if (source === 'claude') {
    if (thoughts) state.reasoning += data?.delta?.thinking || '';
    return data?.delta?.text || '';
  }
  if (source === 'makersuite' || source === 'vertexai') {
    const parts: Loose[] = data?.candidates?.[0]?.content?.parts || [];
    const images = parts
      .filter((x) => x.inlineData && !x.thought)
      .map((x) => `data:${x.inlineData.mimeType};base64,${x.inlineData.data}`)
      .filter(isDataURL);
    if (images.length > 0) state.images.push(...images);
    if (thoughts) state.reasoning += parts.filter((x) => x.thought).map((x) => x.text)[0] || '';
    for (const part of parts) {
      if (part.thoughtSignature && typeof part.text === 'string')
        state.signature = part.thoughtSignature;
    }
    return parts.filter((x) => !x.thought).map((x) => x.text)[0] || '';
  }
  if (source === 'cohere')
    return data?.delta?.message?.content?.text || data?.delta?.message?.tool_plan || '';
  if (source === 'deepseek' || source === 'xai') {
    if (thoughts) state.reasoning += first((c) => c?.delta?.reasoning_content) || '';
    return choices?.[0]?.delta?.content || '';
  }
  if (source === 'openrouter') {
    const urls: unknown[] =
      choices?.[0]?.delta?.images
        ?.filter((x: Loose) => x.type === 'image_url')
        ?.map((x: Loose) => x?.image_url?.url) || [];
    if (urls.length > 0) state.images.push(...urls.filter(isDataURL));
    if (thoughts)
      state.reasoning +=
        first((c) => c?.delta?.reasoning) ??
        first((c) => c?.delta?.reasoning_content) ??
        first((c) => c?.message?.reasoning) ??
        first((c) => c?.message?.reasoning_content) ??
        '';
    const details: Loose[] = [
      ...(choices?.[0]?.delta?.reasoning_details || []),
      ...(choices?.[0]?.message?.reasoning_details || []),
    ];
    for (const detail of details) {
      if (detail.type !== 'reasoning.encrypted' || !detail.data) continue;
      const hasId = typeof detail.id === 'string' && detail.id.length > 0;
      if (hasId) state.toolSignatures[detail.id] = detail.data;
      if (!hasId || !/^(tool_|call_)/.test(detail.id)) state.signature = detail.data;
    }
    return openAiText();
  }
  if (OPENAI_SHAPED.has(source)) {
    if (thoughts)
      state.reasoning +=
        first((c) => c?.delta?.reasoning_content) ?? first((c) => c?.delta?.reasoning) ?? '';
    return openAiText();
  }
  if (source === 'mistralai') {
    if (thoughts)
      state.reasoning += (first((c) => c?.delta?.content?.[0]?.thinking) as Loose)?.[0]?.text || '';
    const content = openAiText();
    return Array.isArray(content)
      ? content
          .map((x: Loose) => x.text)
          .filter((x: unknown) => x)
          .join('')
      : content;
  }
  return openAiText();
}

/**
 * ST openai.js `tryParseStreamingError()`: as in ST the error it throws is swallowed again, so all
 * it does is tell the user. Returns the message it reported (for tests).
 */
export function tryParseStreamingError(
  response: { statusText?: string } | null | undefined,
  decoded: string,
  { quiet = false } = {},
  report: (message: string) => void = () => {},
): string | null {
  let data: Loose;
  try {
    data = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!data) return null;
  const status = response?.statusText || '';
  const message = data.error
    ? data.error.message || status
    : data.message
      ? data.message
      : data.detail
        ? data.detail?.error?.message || status
        : null;
  if (message === null) return null;
  if (!quiet) report(String(message));
  return String(message);
}

/** ST sse-stream.js `EventSourceStream`: bytes in, one `MessageEvent` per server-sent event out */
export class EventSourceStream {
  readonly readable: ReadableStream<MessageEvent>;
  readonly writable: WritableStream<BufferSource>;

  constructor() {
    const decoder = new TextDecoderStream('utf-8');
    let buffer = '';
    let lastEventId = '';
    const sse = new TransformStream<string, MessageEvent>({
      transform(chunk, controller) {
        buffer += chunk;
        const events = buffer.split(/\r\n\r\n|\r\r|\n\n/g);
        buffer = events.pop() ?? '';
        for (const eventChunk of events) {
          let type = '';
          let data = '';
          for (const line of eventChunk.split(/\n|\r|\r\n/g)) {
            const match = /([^:]+)(?:: ?(.*))?/.exec(line);
            if (!match) continue;
            const value = match[2] || '';
            if (match[1] === 'event') type = value;
            else if (match[1] === 'data') data += value + '\n';
            else if (match[1] === 'id' && !value.includes('\0')) lastEventId = value;
          }
          if (data === '') continue;
          controller.enqueue(
            new MessageEvent(type || 'message', { data: data.slice(0, -1), lastEventId }),
          );
        }
      },
    });
    void decoder.readable.pipeTo(sse.writable).catch(() => {});
    this.readable = sse.readable;
    this.writable = decoder.writable;
  }
}

/** ST macros.js `getLastMessageId()` */
export function lastMessageId(
  chat: readonly { swipes?: unknown[] | undefined; swipe_id?: number | undefined }[],
  {
    exclude_swipe_in_propress = true,
    filter = null,
  }: { exclude_swipe_in_propress?: boolean; filter?: ((message: unknown) => boolean) | null } = {},
): number | null {
  for (let i = chat.length - 1; i >= 0; i--) {
    const message = chat[i]!;
    const swiping = message.swipes && (message.swipe_id ?? 0) >= message.swipes.length;
    if (exclude_swipe_in_propress && swiping) continue;
    if (!filter || filter(message)) return i;
  }
  return null;
}

/** ST utils.js `download()` */
function download(content: BlobPart, fileName: string, contentType: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: contentType }));
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** ST utils.js `getBase64Async()` */
function getBase64Async(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读不了这个文件'));
    reader.readAsDataURL(file);
  });
}

/** ST utils.js `getImageSizeFromDataURL()` */
function getImageSizeFromDataURL(dataUrl: string): Promise<{ width: number; height: number }> {
  const image = new Image();
  image.src = dataUrl;
  return new Promise((resolve, reject) => {
    image.onload = () => resolve({ width: image.width, height: image.height });
    image.onerror = () => reject(new Error('Failed to load image'));
  });
}

/** Module path → exports. One object per call: the host adds the app-wired names to it. */
export function pureModules(): ModuleTable {
  return {
    '/script.js': {
      MAX_INJECTION_DEPTH,
      countOccurrences,
      default_avatar: 'img/ai4.png',
      default_user_avatar: 'img/user-default.png',
      system_avatar: 'img/five.png',
      getExtensionPromptRoleByName,
      isOdd: (number: number) => number % 2 !== 0,
      system_message_types: SYSTEM_MESSAGE_TYPES,
    },
    '/scripts/PromptManager.js': { Prompt, PromptCollection },
    '/scripts/authors-note.js': {
      NOTE_MODULE_NAME: '2_floating_prompt',
      metadata_keys: {
        prompt: 'note_prompt',
        interval: 'note_interval',
        depth: 'note_depth',
        position: 'note_position',
        role: 'note_role',
      },
    },
    '/scripts/extensions/regex/engine.js': { regex_placement: REGEX_PLACEMENT },
    '/scripts/openai.js': { ChatCompletion, Message, MessageCollection, proxies: [] },
    '/scripts/personas.js': {},
    '/scripts/power-user.js': { persona_description_positions: PERSONA_DESCRIPTION_POSITIONS },
    '/scripts/slash-commands/SlashCommandCommonEnumsProvider.js': { enumIcons },
    '/scripts/slash-commands/SlashCommandEnumValue.js': { SlashCommandEnumValue, enumTypes },
    '/scripts/sse-stream.js': { EventSourceStream },
    '/scripts/utils.js': {
      Stopwatch,
      download,
      getBase64Async,
      getImageSizeFromDataURL,
      // ST asks its server; the rule is the same sanitize-filename one
      getSanitizedFilename: async (fileName: string) => sanitizeFilename(String(fileName ?? '')),
      getStringHash,
      isDataURL,
    },
    '/scripts/world-info.js': {
      DEFAULT_DEPTH,
      DEFAULT_WEIGHT,
      METADATA_KEY: WORLD_INFO_METADATA_KEY,
      newWorldInfoEntryTemplate: newWorldInfoEntryTemplate() as Obj,
      parseRegexFromString,
      wi_anchor_position: WI_ANCHOR_POSITION,
      world_info_logic: WORLD_INFO_LOGIC,
      world_info_position: WORLD_INFO_POSITION,
    },
  };
}
