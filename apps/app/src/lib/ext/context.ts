/**
 * What ST extensions reach the app through (DEV_NOTES §9.34): the members of
 * `SillyTavern.getContext()`, the page globals, and the exports of the stand-in host modules
 * (`/script.js`, `/scripts/extensions.js`…). Everything here maps an ST name onto the app's own
 * state; a name that is absent is reported by `@tm/st-compat` instead of being faked.
 */
import {
  MacroCategory,
  MacroValueType,
  isWorldInfoBook,
  worldInfoPromptOf,
  type WIBookData,
} from '@tm/core';
import {
  ARGUMENT_TYPE,
  IGNORE_SYMBOL,
  POPUP_RESULT,
  POPUP_TYPE,
  SlashCommandArgument,
  SlashCommandNamedArgument,
  StSlashCommand,
  UNSET_VALUE,
  createSlashCommandParser,
  createSwipeMember,
  createVariablesMember,
  event_types,
  extensionPath,
  legacyMacroKey,
  legacyMacroValue,
  missingMember,
  shouldSendOnEnter,
  type ContextSource,
  type Coverage,
  type ExtensionManifest,
  type Mirror,
  type ModuleTable,
  type StEventEmitter,
} from '@tm/st-compat';
import { hasExtraMacro, registerExtraMacro, unregisterExtraMacro } from '../chat/extra-macros';
import { chatPageIfOpen } from '../chat/page-actions';
import { countTokens } from '../chat/pipeline';
import { plainChat } from '../chat/plain.svelte';
import { chatStore, humanizedDateTime } from '../chat/store.svelte';
import { quietGenerate, rawGenerate, scanOpenChatWorldInfo } from '../helper/generate.svelte';
import { fileUrl } from '../ipc';
import { userAvatarUrl } from '../personas';
import { extensionCommands } from '../slash/extra';
import { createSlashHost, substitute, variables as slashVariables } from '../slash/host.svelte';
import { toasts, type ToastKind } from '../toast.svelte';
import { knownWorldNames, listWorldNames, readWorld, writeWorld } from '../worlds';
import type { ChatMirror } from './chat-mirror';
import { Popup, callGenericPopup, callPopup } from './popup';
import { extState } from './state.svelte';
import { pureModules } from './st-modules';
import { APP_LIVE_EXPORTS, appModules, syncWorldNames } from './st-modules-app';
import { ToolManager, toolCallingSupported, toolCallsAllowed, toolRegistry } from './tools';

type Obj = Record<string, unknown>;

/** the libraries ST bundles that the host carries too (ST `lib.js`) */
export interface HostLibs {
  lodash: typeof import('lodash');
  DOMPurify: typeof import('dompurify').default;
  moment: typeof import('moment');
  Handlebars: typeof import('handlebars');
  hljs: typeof import('highlight.js/lib/common').default;
  Popper: typeof import('@popperjs/core');
  Fuse: typeof import('fuse.js').default;
  localforage: typeof import('localforage');
  DiffMatchPatch: typeof import('diff-match-patch').diff_match_patch;
  droll: unknown;
  showdown: typeof import('showdown');
  yaml: typeof import('yaml');
}

/** ST's other `lib.js` names: listed so that reaching for one is reported, not a silent undefined */
const OTHER_LIBS = [
  'css',
  'Bowser',
  'Readability',
  'isProbablyReaderable',
  'SVGInject',
  'seedrandom',
  'morphdom',
  'slideToggle',
  'chalk',
  'chevrotain',
] as const;

export interface ContextDeps {
  emitter: StEventEmitter;
  chat: ChatMirror;
  /** `chat_metadata` of the open chat */
  metadata: Mirror;
  /** `extension_settings` */
  settings: Mirror;
  coverage: Coverage;
  libs: HostLibs;
  /** the `tmext` origin extension files are read from */
  base: string;
  /** manifests of the loaded extensions by ST id (`third-party/<name>`) */
  manifests: ReadonlyMap<string, ExtensionManifest>;
  /** ST `reloadCurrentChat()` */
  reloadChat(): Promise<void>;
}

/** ST's `debounce_timeout.relaxed`: how long its settings / metadata saves wait */
const SAVE_DELAY = 1000;

/** ST `debounce` (utils.js) */
function debounce<A extends unknown[]>(fn: (...args: A) => void, timeout = 300) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A): void => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), timeout);
  };
}

const escapeRegex = (text: string) => text.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');

const TEMPLATE_TAG = /\{\{(\{?)\s*([^{}]*?)\s*\}?\}\}/g;
const TEMPLATE_PATH = /^[\w$-]+(?:\.[\w$-]+)*$/;

/**
 * A Handlebars template without shipping Handlebars for it: `{{name}}` escaped, `{{{name}}}` raw, dotted paths, `{{! comments }}`. Null when the
 * template needs more than that.
 */
function fillTemplate(source: string, data: Obj, escape: (text: string) => string): string | null {
  if (!source.includes('{{')) return source;
  let plain = true;
  const out = source.replace(TEMPLATE_TAG, (_tag, raw: string, path: string) => {
    if (path.startsWith('!')) return '';
    if (!TEMPLATE_PATH.test(path)) {
      plain = false;
      return '';
    }
    let value: unknown = data;
    for (const key of path.split('.')) value = (value as Obj | null | undefined)?.[key];
    const text = value == null || value === false ? '' : String(value);
    return raw ? text : escape(text);
  });
  return plain ? out : null;
}

/** ST `extension_prompt_types` / `extension_prompt_roles` (script.js) */
const EXTENSION_PROMPT_TYPES = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 } as const;
const EXTENSION_PROMPT_ROLES = { SYSTEM: 0, USER: 1, ASSISTANT: 2 } as const;

/** ST `getRequestHeaders()`; there is no server, so the CSRF token is empty */
function getRequestHeaders({ omitContentType = false } = {}): Record<string, string> {
  return omitContentType
    ? { 'X-CSRF-Token': '' }
    : { 'Content-Type': 'application/json', 'X-CSRF-Token': '' };
}

/** ST `t`: a tagged template; there is no locale table for extensions, the source text stands */
function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce(
    (out, part, i) => out + part + (i < values.length ? String(values[i]) : ''),
    '',
  );
}

/**
 * `toastr` as extensions call it, shown by the app's own toasts. Messages are shown as text
 * (toastr takes HTML); the return value is the toast's id, accepted by `clear`.
 */
export function createToastr(libs: HostLibs) {
  const plain = (message: unknown): string => {
    const text = message == null ? '' : String(message);
    if (!text.includes('<')) return text;
    const holder = document.createElement('div');
    holder.innerHTML = libs.DOMPurify.sanitize(text);
    return holder.textContent ?? '';
  };
  const show =
    (kind: ToastKind) =>
    (message?: unknown, title?: unknown, options?: { timeOut?: number }): number =>
      toasts.show(kind, plain(message), plain(title), options?.timeOut);
  const clear = (id?: unknown) => (typeof id === 'number' ? toasts.dismiss(id) : toasts.clear());
  return {
    options: {} as Obj,
    info: show('info'),
    success: show('success'),
    warning: show('warning'),
    error: show('error'),
    clear,
    remove: clear,
  };
}

/** `SillyTavern.libs` */
export function createLibs(libs: HostLibs, coverage: Coverage): Obj {
  const out: Obj = { ...libs };
  for (const name of OTHER_LIBS) {
    Object.defineProperty(out, name, {
      enumerable: false,
      configurable: true,
      get: () => missingMember(`libs.${name}`, coverage, 'global'),
    });
  }
  return out;
}

/** The functions and tables behind both `getContext()` and the module stand-ins. */
function createApi(deps: ContextDeps) {
  const { emitter, chat, metadata, settings, libs, base } = deps;
  /** ST `extension_prompts`, as extensions set it; `activePrompts` is what a generation takes */
  const extensionPrompts: Obj = {};
  /** ST's static `SlashCommandParser`: registered commands run in every slash host */
  const slashParser = createSlashCommandParser(extensionCommands);
  let runSlash: ((command: string) => Promise<string>) | undefined;

  const saveMetadata = async (): Promise<void> => {
    const change = metadata.push();
    // an extension outliving its chat has nothing to write to
    if (change && chatStore.chatPath && chatStore.header) {
      chatStore.patchChatMetadata(change.set, change.removed);
    }
  };
  const saveSettings = (): void => {
    const change = settings.push();
    if (!change || !chatStore.settings) return;
    chatStore.mutateSettings((all) => {
      all['extension_settings'] ??= {};
      const target = all['extension_settings'] as Obj;
      for (const key of change.removed) delete target[key];
      Object.assign(target, change.set);
    });
  };
  const saveChat = async (): Promise<void> => {
    if (!chat.save())
      console.warn('[ext] saveChat: 没有可以保存的聊天（聊天未打开或没有整段载入）');
  };

  /**
   * ST `saveChat(options)` as `/script.js` exports it: without a name it writes the open chat.
   * Saving the content under another chat file (`chatName` / `chatData`, or the old positional
   * name) is not supported and writes nothing.
   */
  const saveChatAs = async (options?: unknown): Promise<void> => {
    const record = typeof options === 'object' && options !== null;
    const other = record
      ? ((options as Record<string, unknown>)['chatName'] ??
        (options as Record<string, unknown>)['chatData'])
      : options;
    if (other != null) {
      console.warn('[ext] saveChat: 不支持另存成别的聊天文件（chatName / chatData），没有写入');
      return;
    }
    await saveChat();
  };

  /** ST `substituteParams`: `additionalMacro`, then the app's macros (registered ones included) */
  const substituteParams = (
    content: unknown,
    _name1?: unknown,
    _name2?: unknown,
    _original?: unknown,
    _group?: unknown,
    _replaceCharacterCard?: unknown,
    additionalMacro: Obj = {},
    postProcess: (value: string) => unknown = (value) => value,
  ): string => {
    let text = content == null ? '' : String(content);
    if (!text.includes('{{')) return text;
    const apply = (key: string, value: unknown) => {
      const token = `{{${key}}}`;
      if (!text.toLowerCase().includes(token.toLowerCase())) return;
      const result =
        typeof value === 'function' ? (value as (nonce: string) => unknown)('') : value;
      const filled = String(postProcess(String(result ?? '')) ?? '');
      text = text.replace(new RegExp(escapeRegex(token), 'gi'), () => filled);
    };
    for (const [key, value] of Object.entries(additionalMacro ?? {})) apply(key, value);
    return substitute(text);
  };

  /** ST `substituteParamsExtended`: `postProcessFn` runs on the `additionalMacro` values */
  const substituteParamsExtended = (
    content: unknown,
    additionalMacro: Obj = {},
    postProcessFn?: (value: string) => unknown,
  ): string =>
    substituteParams(
      content,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      additionalMacro,
      postProcessFn,
    );

  /** ST `updateChatMetadata`: on the object extensions hold; `saveMetadata()` writes it */
  const updateChatMetadata = (newValues: Obj, reset = false): void => {
    if (reset) for (const key of Object.keys(metadata.value)) delete metadata.value[key];
    Object.assign(metadata.value, newValues);
  };

  /** ST `stopGeneration()`: true when there was a reply to stop */
  const stopGeneration = (): boolean => {
    const page = chatPageIfOpen();
    if (!page?.busy()) return false;
    page.stop();
    return true;
  };

  /** ST `swipe`: left / right / to a given message and swipe (DEV_NOTES §9.34 第 8 轮) */
  const swipe = createSwipeMember({
    chat: () => chat.chat,
    busy: () => chatPageIfOpen()?.busy() ?? true,
    pristine: () => !plainChat.chatMetadata['tainted'],
    load: async (index, swipeId) => chatPageIfOpen()?.loadSwipe(index, swipeId),
    regenerate: async () => chatPageIfOpen()?.generate('swipe'),
    setHidden: (hidden) => void document.body.classList.toggle('hideAllSwipeButtons', hidden),
  });

  /** ST `updateWorldInfoList()`: list `worlds/` again */
  const updateWorldInfoList = async (): Promise<void> => {
    if (chatStore.root) await listWorldNames(chatStore.root);
    syncWorldNames();
  };
  /** ST `loadWorldInfo(name)`: the file's `{entries}`; null when it cannot be read */
  const loadWorldInfo = async (name: unknown): Promise<WIBookData | null | undefined> => {
    const root = chatStore.root;
    if (!name || !root) return undefined;
    try {
      return await readWorld(root, String(name));
    } catch {
      return null;
    }
  };
  /** ST `saveWorldInfo(name, data)`: written at once, then `WORLDINFO_UPDATED` */
  const saveWorldInfo = async (name: unknown, data: unknown): Promise<void> => {
    const root = chatStore.root;
    if (!name || !data || !root) return;
    if (!isWorldInfoBook(data)) throw new Error('saveWorldInfo：data 不是世界书（没有 entries）');
    const book = String(name);
    await writeWorld(root, book, data);
    if (!knownWorldNames().includes(book)) await listWorldNames(root);
    await emitter.emit(event_types.WORLDINFO_UPDATED, book, data);
  };

  /** ST `MacrosParser.registerMacro`: `{{key}}` reads `value` (a function is called each time) */
  const registerMacro = (key: unknown, value: unknown, description: unknown = ''): void => {
    const name = legacyMacroKey(key);
    if (hasExtraMacro(name)) console.warn(`[ext] 宏 ${name} 重复注册，以后注册的为准`);
    registerExtraMacro(name, {
      category: MacroCategory.UNCATEGORIZED,
      description: String(description || '扩展注册的宏'),
      handler: () => legacyMacroValue(value, () => crypto.randomUUID()),
    });
  };
  const unregisterMacro = (key: unknown): void => void unregisterExtraMacro(legacyMacroKey(key));
  /** ST `macros` (macro-system.js), as far as registering goes */
  const macroSystem = {
    registry: {
      registerMacro: registerExtraMacro,
      unregisterMacro: unregisterExtraMacro,
      hasMacro: hasExtraMacro,
    },
    category: MacroCategory,
    register: registerExtraMacro,
  };

  const isOptions = (value: unknown): value is Obj =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  /** a `prompt` given as chat messages goes out as their text */
  const promptText = (prompt: unknown): string =>
    Array.isArray(prompt)
      ? prompt
          .map((part: unknown) => (isOptions(part) ? String(part['content'] ?? '') : String(part)))
          .join('\n')
      : String(prompt ?? '');
  /** ST `generateRaw`: an options object, or ST's older positional form (5th = systemPrompt) */
  const generateRaw = (first: unknown, ...rest: unknown[]): Promise<string> => {
    const options = isOptions(first) ? first : { prompt: first, systemPrompt: rest[3] };
    return rawGenerate(promptText(options['prompt']), String(options['systemPrompt'] ?? ''));
  };
  /** ST `generateQuietPrompt`: over the open chat, the reply is not written to it */
  const generateQuietPrompt = (first: unknown): Promise<string> =>
    quietGenerate(String((isOptions(first) ? first['quietPrompt'] : first) ?? ''));

  /** ST `checkWorldInfo(chat, maxContext, isDryRun, globalScanData)` (world-info.js) */
  const checkWorldInfo = (texts: unknown, maxContext: unknown, isDryRun: unknown, scan: unknown) =>
    scanOpenChatWorldInfo({
      chat: Array.isArray(texts) ? texts.map(String) : [],
      maxContext: Number(maxContext) || 0,
      isDryRun: !!isDryRun,
      globalScanData: isOptions(scan) ? scan : undefined,
    });
  /** ST `getWorldInfoPrompt`: the same scan as prompt strings; a real run announces what activated */
  const getWorldInfoPrompt = async (...args: Parameters<typeof checkWorldInfo>) => {
    const activated = await checkWorldInfo(...args);
    if (!args[2] && activated.allActivatedEntries.size > 0)
      await emitter.emit(event_types.WORLD_INFO_ACTIVATED, [...activated.allActivatedEntries]);
    return worldInfoPromptOf(activated);
  };

  const executeSlashCommandsWithOptions = async (text: unknown) => {
    // ext-run commands emit nothing themselves: message events come from the chat diff
    runSlash ??= createSlashHost({ emit: () => {} });
    const pipe = await runSlash(String(text ?? ''));
    return {
      pipe,
      isBreak: false,
      isAborted: false,
      isQuietlyAborted: false,
      abortReason: '',
      isError: false,
      errorMessage: '',
    };
  };

  /** ST `renderExtensionTemplateAsync`: `<extension>/<template>.html`, filled by `fillTemplate` */
  const renderExtensionTemplateAsync = async (
    extensionName: string,
    templateId: string,
    templateData: Obj = {},
    sanitize = true,
  ): Promise<string> => {
    const url = `${base}/scripts/extensions/${extensionName}/${templateId}.html`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`模板读取失败：${extensionName}/${templateId}.html`);
    const html = fillTemplate(
      await response.text(),
      templateData,
      libs.Handlebars.escapeExpression,
    );
    if (html === null) {
      deps.coverage.miss('context', 'renderExtensionTemplateAsync（块助手模板）');
      throw new Error(
        `模板 ${extensionName}/${templateId}.html 用了块助手，本应用的 CSP 不允许编译模板`,
      );
    }
    return sanitize ? libs.DOMPurify.sanitize(html) : html;
  };

  /** ST `getThumbnailUrl(type, file)`: the files themselves, there is no thumbnail server */
  const getThumbnailUrl = (type: string, file: string): string => {
    const root = chatStore.root;
    if (!root) return '';
    if (type === 'persona') return userAvatarUrl(root, file);
    return fileUrl(`${root}/${type === 'bg' ? 'backgrounds' : 'characters'}/${file}`);
  };

  return {
    extensionPrompts,
    getRequestHeaders,
    getCurrentChatId: () => extState.chatId,
    saveChat,
    saveChatAs,
    saveMetadata,
    saveMetadataDebounced: debounce(() => void saveMetadata(), SAVE_DELAY),
    saveSettings,
    saveSettingsDebounced: debounce(saveSettings, SAVE_DELAY),
    reloadCurrentChat: deps.reloadChat,
    substituteParams,
    substituteParamsExtended,
    updateChatMetadata,
    stopGeneration,
    swipe,
    variables: createVariablesMember(slashVariables),
    updateWorldInfoList,
    loadWorldInfo,
    saveWorldInfo,
    /** ST `setExtensionPrompt(key, value, position, depth, scan, role, filter)` */
    setExtensionPrompt: (
      key: string,
      value: unknown,
      position: unknown,
      depth: unknown,
      scan = false,
      role: unknown = EXTENSION_PROMPT_ROLES.SYSTEM,
      filter: unknown = null,
    ): void => {
      extensionPrompts[key] = {
        value: String(value ?? ''),
        position: Number(position),
        depth: Number(depth),
        scan: !!scan,
        role: Number(role ?? EXTENSION_PROMPT_ROLES.SYSTEM),
        filter,
      };
    },
    executeSlashCommandsWithOptions,
    getTokenCountAsync: async (text: unknown, padding = 0): Promise<number> => {
      const all = plainChat.settings;
      return (all ? await countTokens(all, String(text ?? '')) : 0) + padding;
    },
    uuidv4: () => crypto.randomUUID(),
    renderExtensionTemplateAsync,
    slashParser,
    generateRaw,
    generateQuietPrompt,
    checkWorldInfo,
    getWorldInfoPrompt,
    macroSystem,
    registerMacro,
    unregisterMacro,
    /** ST `updateMessageBlock(messageId, message)`: `message` is `chat[messageId]`, changed in place */
    updateMessageBlock: (messageId: unknown): void => chat.refresh(Number(messageId)),
    getThumbnailUrl,
    getExtensionManifest: (id: string): ExtensionManifest | undefined => {
      const manifest = deps.manifests.get(id);
      return manifest && structuredClone(manifest);
    },
    emitter,
  };
}

export interface HostSurface {
  source: ContextSource;
  /** exports of the stand-in host modules, by URL path */
  modules: ModuleTable;
  /** ST `extension_prompts`, live: read through `activePrompts` */
  extensionPrompts: Obj;
}

/** Build the context source and the module table. Call once per host start. */
export function createSurface(deps: ContextDeps): HostSurface {
  const api = createApi(deps);
  const { emitter, chat, metadata, settings } = deps;

  const statics: Obj = {
    getCurrentChatId: api.getCurrentChatId,
    getRequestHeaders: api.getRequestHeaders,
    reloadCurrentChat: api.reloadCurrentChat,
    saveSettingsDebounced: api.saveSettingsDebounced,
    saveMetadataDebounced: api.saveMetadataDebounced,
    eventSource: emitter,
    eventTypes: event_types,
    event_types,
    getTokenCountAsync: api.getTokenCountAsync,
    setExtensionPrompt: api.setExtensionPrompt,
    saveChat: api.saveChat,
    saveMetadata: api.saveMetadata,
    substituteParams: api.substituteParams,
    ARGUMENT_TYPE,
    executeSlashCommandsWithOptions: api.executeSlashCommandsWithOptions,
    executeSlashCommands: api.executeSlashCommandsWithOptions,
    registerMacro: api.registerMacro,
    SlashCommandParser: api.slashParser,
    SlashCommand: StSlashCommand,
    SlashCommandArgument,
    SlashCommandNamedArgument,
    registerSlashCommand: api.slashParser.addCommand,
    generateRaw: api.generateRaw,
    generateQuietPrompt: api.generateQuietPrompt,
    getWorldInfoPrompt: api.getWorldInfoPrompt,
    unregisterMacro: api.unregisterMacro,
    renderExtensionTemplateAsync: api.renderExtensionTemplateAsync,
    callPopup,
    callGenericPopup,
    getThumbnailUrl: api.getThumbnailUrl,
    isMobile: () => true,
    t,
    translate: (text: string) => text,
    getCurrentLocale: () => 'zh-cn',
    // accepted and unused: `t` / `translate` return the source text
    addLocaleData: () => {},
    Popup,
    POPUP_TYPE,
    POPUP_RESULT,
    uuidv4: api.uuidv4,
    humanizedDateTime,
    updateMessageBlock: api.updateMessageBlock,
    getExtensionManifest: api.getExtensionManifest,
    macros: api.macroSystem,
    swipe: api.swipe,
    stopGeneration: api.stopGeneration,
    variables: api.variables,
    getWorldInfoNames: () => [...knownWorldNames()],
    updateWorldInfoList: api.updateWorldInfoList,
    loadWorldInfo: api.loadWorldInfo,
    saveWorldInfo: api.saveWorldInfo,
    updateChatMetadata: api.updateChatMetadata,
    substituteParamsExtended: api.substituteParamsExtended,
    shouldSendOnEnter: () => shouldSendOnEnter(extState.powerUserSettings),
    registerFunctionTool: toolRegistry.register,
    unregisterFunctionTool: toolRegistry.unregister,
    isToolCallingSupported: toolCallingSupported,
    canPerformToolCalls: toolCallsAllowed,
    ToolManager,
    symbols: { ignore: IGNORE_SYMBOL },
    constants: { unset: UNSET_VALUE },
  };

  const state = (): Obj => ({
    chat: chat.chat,
    characters: extState.characters,
    groups: extState.groups,
    name1: chatStore.userName,
    name2: chatStore.displayName,
    characterId: extState.characterId,
    groupId: extState.groupId,
    chatId: extState.chatId,
    onlineStatus: extState.onlineStatus,
    maxContext: extState.maxContext,
    chatMetadata: metadata.value,
    streamingProcessor: null,
    extensionPrompts: api.extensionPrompts,
    mainApi: extState.mainApi,
    extensionSettings: settings.value,
    tags: extState.tags,
    tagMap: extState.tagMap,
    menuType: '',
    createCharacterData: {},
    chatCompletionSettings: extState.chatCompletionSettings,
    textCompletionSettings: extState.textCompletionSettings,
    powerUserSettings: extState.powerUserSettings,
  });

  // `getContext` (extensions.js, st-context.js) is added by the host once `createGetContext` has
  // wrapped the source
  const modules: ModuleTable = {
    '/script.js': {
      eventSource: emitter,
      event_types,
      chat: chat.chat,
      chat_metadata: metadata.value,
      extension_prompts: api.extensionPrompts,
      extension_prompt_types: EXTENSION_PROMPT_TYPES,
      extension_prompt_roles: EXTENSION_PROMPT_ROLES,
      getRequestHeaders: api.getRequestHeaders,
      getCurrentChatId: api.getCurrentChatId,
      saveSettingsDebounced: api.saveSettingsDebounced,
      saveChat: api.saveChatAs,
      saveChatConditional: api.saveChat,
      saveChatDebounced: debounce(() => void api.saveChat(), SAVE_DELAY),
      saveMetadata: api.saveMetadata,
      reloadCurrentChat: api.reloadCurrentChat,
      substituteParams: api.substituteParams,
      substituteParamsExtended: api.substituteParamsExtended,
      updateChatMetadata: api.updateChatMetadata,
      stopGeneration: api.stopGeneration,
      setExtensionPrompt: api.setExtensionPrompt,
      generateRaw: api.generateRaw,
      generateQuietPrompt: api.generateQuietPrompt,
      updateMessageBlock: api.updateMessageBlock,
      getThumbnailUrl: api.getThumbnailUrl,
    },
    '/scripts/extensions.js': {
      extension_settings: settings.value,
      saveMetadataDebounced: api.saveMetadataDebounced,
      renderExtensionTemplateAsync: api.renderExtensionTemplateAsync,
    },
    '/scripts/tool-calling.js': { ToolManager },
    '/scripts/utils.js': {
      uuidv4: api.uuidv4,
      delay: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
      debounce,
      escapeRegex,
      isTrueBoolean: (value: unknown) =>
        ['on', 'true', '1'].includes(
          String(value ?? '')
            .trim()
            .toLowerCase(),
        ),
      isFalseBoolean: (value: unknown) =>
        ['off', 'false', '0'].includes(
          String(value ?? '')
            .trim()
            .toLowerCase(),
        ),
    },
    '/scripts/popup.js': { Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup },
    '/scripts/power-user.js': {},
    '/scripts/i18n.js': {
      t,
      translate: statics['translate'],
      getCurrentLocale: statics['getCurrentLocale'],
    },
    '/scripts/slash-commands.js': {
      executeSlashCommandsWithOptions: api.executeSlashCommandsWithOptions,
      registerSlashCommand: api.slashParser.addCommand,
    },
    '/scripts/slash-commands/SlashCommandParser.js': { SlashCommandParser: api.slashParser },
    '/scripts/slash-commands/SlashCommand.js': { SlashCommand: StSlashCommand },
    '/scripts/slash-commands/SlashCommandArgument.js': {
      ARGUMENT_TYPE,
      SlashCommandArgument,
      SlashCommandNamedArgument,
    },
    '/scripts/macros/macro-system.js': { macros: api.macroSystem, MacroCategory, MacroValueType },
    '/scripts/macros.js': {
      MacrosParser: { registerMacro: api.registerMacro, unregisterMacro: api.unregisterMacro },
    },
    '/scripts/group-chats.js': {},
    '/scripts/tokenizers.js': { getTokenCountAsync: api.getTokenCountAsync },
    '/scripts/st-context.js': {},
    '/scripts/world-info.js': {
      checkWorldInfo: api.checkWorldInfo,
      getWorldInfoPrompt: api.getWorldInfoPrompt,
      loadWorldInfo: api.loadWorldInfo,
      saveWorldInfo: api.saveWorldInfo,
      updateWorldInfoList: api.updateWorldInfoList,
    },
    '/lib.js': { ...deps.libs },
  };
  const report = createToastr(deps.libs).error;
  const app = appModules({
    chat: deps.chat,
    coverage: deps.coverage,
    manifests: deps.manifests,
    generateRaw: api.generateRaw,
    saveSettings: api.saveSettings,
    report: (message) => void report(message, 'Chat Completion API'),
  });
  // ST's own exports the table above does not name: pure ones, then the app-wired ones
  for (const extra of [pureModules(), app]) {
    for (const [path, exports] of Object.entries(extra)) {
      modules[path] = { ...exports, ...modules[path] };
    }
  }
  for (const [path, name, read] of LIVE_EXPORTS) modules[path]![name] = read();
  return { source: { statics, state }, modules, extensionPrompts: api.extensionPrompts };
}

/**
 * `[module path, export name, read]` for every export ST reassigns (`export let`). Each `read` is
 * reactive: the host re-reads it in an effect so loaded stand-ins keep up.
 */
export const LIVE_EXPORTS: readonly (readonly [path: string, name: string, read: () => unknown])[] =
  [
    ['/script.js', 'characters', () => extState.characters],
    ['/script.js', 'this_chid', () => extState.characterId],
    ['/script.js', 'name1', () => chatStore.userName],
    ['/script.js', 'name2', () => chatStore.displayName],
    ['/script.js', 'main_api', () => extState.mainApi],
    ['/script.js', 'online_status', () => extState.onlineStatus],
    ['/script.js', 'max_context', () => extState.maxContext],
    ['/scripts/power-user.js', 'power_user', () => extState.powerUserSettings],
    ['/scripts/group-chats.js', 'selected_group', () => extState.groupId],
    ['/scripts/group-chats.js', 'groups', () => extState.groups],
    ...APP_LIVE_EXPORTS,
  ];

/** URL of a file inside an installed extension */
export const extensionFileUrl = (base: string, name: string, file: string) =>
  base + extensionPath(name, file);
