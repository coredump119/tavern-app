/**
 * The shape of ST's `SillyTavern.getContext()` (st-context.js, 1.18.0; DEV_NOTES §9.34). The app
 * supplies what it implements; every other member still exists, so `const { x } = getContext()`
 * never throws on its own, and using a missing one fails loudly and lands in the coverage list.
 */
import { type Coverage, notImplemented } from './coverage.js';

/** Members that are functions, classes or fixed namespaces: the same object on every call. */
export const CONTEXT_STATIC = [
  'accountStorage',
  'getCurrentChatId',
  'getRequestHeaders',
  'reloadCurrentChat',
  'renameChat',
  'saveSettingsDebounced',
  'saveMetadataDebounced',
  'eventSource',
  'eventTypes',
  'addOneMessage',
  'deleteLastMessage',
  'deleteMessage',
  'generate',
  'sendStreamingRequest',
  'sendGenerationRequest',
  'stopGeneration',
  'tokenizers',
  'getTextTokens',
  'getTokenCount',
  'getTokenCountAsync',
  'setExtensionPrompt',
  'updateChatMetadata',
  'saveChat',
  'openCharacterChat',
  'openGroupChat',
  'saveMetadata',
  'sendSystemMessage',
  'activateSendButtons',
  'deactivateSendButtons',
  'saveReply',
  'substituteParams',
  'substituteParamsExtended',
  'SlashCommandParser',
  'SlashCommand',
  'SlashCommandArgument',
  'SlashCommandNamedArgument',
  'SlashCommandEnumValue',
  'ARGUMENT_TYPE',
  'executeSlashCommandsWithOptions',
  'registerSlashCommand',
  'executeSlashCommands',
  'timestampToMoment',
  'registerHelper',
  'registerMacro',
  'unregisterMacro',
  'registerFunctionTool',
  'unregisterFunctionTool',
  'isToolCallingSupported',
  'canPerformToolCalls',
  'ToolManager',
  'registerDebugFunction',
  'renderExtensionTemplate',
  'renderExtensionTemplateAsync',
  'registerDataBankScraper',
  'callPopup',
  'callGenericPopup',
  'showLoader',
  'hideLoader',
  'ModuleWorkerWrapper',
  'getTokenizerModel',
  'generateQuietPrompt',
  'generateRaw',
  'generateRawData',
  'writeExtensionField',
  'writeExtensionFieldBulk',
  'getThumbnailUrl',
  'selectCharacterById',
  'messageFormatting',
  'shouldSendOnEnter',
  'isMobile',
  't',
  'translate',
  'getCurrentLocale',
  'addLocaleData',
  'event_types',
  'Popup',
  'POPUP_TYPE',
  'POPUP_RESULT',
  'getCharacters',
  'getOneCharacter',
  'getCharacterCardFields',
  'getCharacterSource',
  'importFromExternalUrl',
  'importTags',
  'uuidv4',
  'humanizedDateTime',
  'updateMessageBlock',
  'appendMediaToMessage',
  'ensureMessageMediaIsArray',
  'getMediaDisplay',
  'getMediaIndex',
  'scrollChatToBottom',
  'scrollOnMediaLoad',
  'macros',
  'loader',
  'swipe',
  'variables',
  'loadWorldInfo',
  'saveWorldInfo',
  'reloadWorldInfoEditor',
  'updateWorldInfoList',
  'convertCharacterBook',
  'getWorldInfoPrompt',
  'getWorldInfoNames',
  'CONNECT_API_MAP',
  'getTextGenServer',
  'extractMessageFromData',
  'getPresetManager',
  'getChatCompletionModel',
  'printMessages',
  'clearChat',
  'ChatCompletionService',
  'TextCompletionService',
  'ConnectionManagerRequestService',
  'updateReasoningUI',
  'parseReasoningFromString',
  'getReasoningTemplateByName',
  'unshallowCharacter',
  'unshallowGroupMembers',
  'getExtensionManifest',
  'openThirdPartyExtensionMenu',
  'symbols',
  'constants',
] as const;

/** Members that are state: read again on every `getContext()` call, as ST does. */
export const CONTEXT_STATE = [
  'chat',
  'characters',
  'groups',
  'name1',
  'name2',
  'characterId',
  'groupId',
  'chatId',
  'onlineStatus',
  'maxContext',
  'chatMetadata',
  'streamingProcessor',
  'extensionPrompts',
  'mainApi',
  'extensionSettings',
  'tags',
  'tagMap',
  'menuType',
  'createCharacterData',
  'chatCompletionSettings',
  'textCompletionSettings',
  'powerUserSettings',
] as const;

export const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 } as const;

export const POPUP_RESULT = {
  AFFIRMATIVE: 1,
  NEGATIVE: 0,
  CANCELLED: null,
  CUSTOM1: 1001,
  CUSTOM2: 1002,
  CUSTOM3: 1003,
  CUSTOM4: 1004,
  CUSTOM5: 1005,
  CUSTOM6: 1006,
  CUSTOM7: 1007,
  CUSTOM8: 1008,
  CUSTOM9: 1009,
} as const;

export const ARGUMENT_TYPE = {
  STRING: 'string',
  NUMBER: 'number',
  RANGE: 'range',
  BOOLEAN: 'bool',
  VARIABLE_NAME: 'varname',
  CLOSURE: 'closure',
  SUBCOMMAND: 'subcommand',
  LIST: 'list',
  DICTIONARY: 'dictionary',
} as const;

/** `symbols.ignore` / `constants.unset`, the values ST uses (constants.js, extensions.js) */
export const IGNORE_SYMBOL = Symbol.for('ignore');
export const UNSET_VALUE = '__@@UNSET@@__';

export interface ContextSource {
  /** implemented static members, by ST name */
  statics: Readonly<Record<string, unknown>>;
  /** implemented state members as they are right now */
  state(): Record<string, unknown>;
}

/** properties a stand-in must not answer with another stand-in (thenable checks, coercion…) */
const PASS_THROUGH = new Set(['then', 'prototype', 'name', 'length', 'toJSON', 'constructor']);

/**
 * A stand-in for a member the app lacks: reading through it (`ctx.variables.local.get`) is free,
 * calling or constructing it records the miss and throws.
 */
export function missingMember(
  name: string,
  coverage: Coverage,
  kind: 'context' | 'global',
): unknown {
  const fail = (): never => {
    coverage.miss(kind, name);
    throw notImplemented(name);
  };
  const nested = new Map<string, unknown>();
  return new Proxy(function () {}, {
    get(target, key) {
      if (typeof key === 'symbol' || PASS_THROUGH.has(key)) return Reflect.get(target, key);
      let child = nested.get(key);
      if (!child) nested.set(key, (child = missingMember(`${name}.${key}`, coverage, kind)));
      return child;
    },
    apply: fail,
    construct: fail,
  });
}

/**
 * Returns ST's `getContext`. Each call gives a fresh plain object (extensions spread and
 * destructure it); the static part is prepared once.
 */
export function createGetContext(
  source: ContextSource,
  coverage: Coverage,
): () => Record<string, unknown> {
  const statics: Record<string, unknown> = {};
  for (const name of CONTEXT_STATIC) {
    statics[name] = Object.hasOwn(source.statics, name)
      ? source.statics[name]
      : missingMember(name, coverage, 'context');
  }
  // a state member the app has nothing for reads as undefined (never invented data) and is
  // recorded once
  let absent: string[] | undefined;
  return () => {
    const state = source.state();
    absent ??= CONTEXT_STATE.filter((name) => !Object.hasOwn(state, name));
    const context = { ...statics, ...state };
    for (const name of absent) {
      Object.defineProperty(context, name, {
        enumerable: false,
        configurable: true,
        get() {
          coverage.miss('context', name);
          return undefined;
        },
      });
    }
    return context;
  };
}
