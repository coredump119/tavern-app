/**
 * Exports of ST's own modules that read or drive the running app (DEV_NOTES §9.34, 第 10 轮).
 * Things ST only does to its own page (hotswap bar, send-button states, prompt-manager UI…) are
 * no-ops that still show up under 「缺的接口」 the first time an extension calls them.
 */
import {
  baseChatReplace,
  getBiasStrings,
  getCharacterCardFields,
  applyChatCompletionPreset,
  getChatCompletionModel,
  isImageInliningSupported,
  parseMesExamples,
  type GenerationSettings,
} from '@tm/core';
import { CharacterBookSchema, characterBookToWorldInfo, type ChatMessage } from '@tm/formats';
import type { Coverage, ExtensionManifest, ModuleTable } from '@tm/st-compat';
import { chatPageIfOpen } from '../chat/page-actions';
import { createChatContext, type ChatContext, type GenType } from '../chat/pipeline';
import { plainChat } from '../chat/plain.svelte';
import { MessageRenderer, formatPowerUserFrom } from '../chat/render';
import { chatStore } from '../chat/store.svelte';
import { withoutConnection } from '../helper/calls-data.svelte';
import { quietGenerate } from '../helper/generate.svelte';
import { deleteCcPreset, listCcPresets, oaiOf, readCcPreset, writeCcPreset } from '../oai.svelte';
import { listUserAvatars, userAvatarUrl } from '../personas';
import { createWorld, deleteWorld, knownWorldNames, listWorldNames } from '../worlds';
import { PresetManagerStandIn, type PresetIo } from './preset-manager';
import { extState } from './state.svelte';
import {
  EventSourceStream,
  createCommonEnumProviders,
  extractReasoningFromData,
  getStreamingReply,
  lastMessageId,
  tryParseStreamingError,
  type ReplySettings,
} from './st-modules';

type Obj = Record<string, unknown>;

export interface AppModuleDeps {
  /** the `chat` array extensions hold */
  chat: { readonly chat: ChatMessage[]; save(): boolean };
  coverage: Coverage;
  manifests: ReadonlyMap<string, ExtensionManifest>;
  /** ST `generateRaw` over the main connection */
  generateRaw(options: Obj): Promise<string>;
  /** write `extension_settings` back */
  saveSettings(): void;
  /** tell the user (ST toastr.error) */
  report(message: string): void;
}

const GEN_TYPES: ReadonlySet<unknown> = new Set<GenType>([
  'normal',
  'continue',
  'regenerate',
  'swipe',
  'impersonate',
]);

const section = (settings: Obj | null, key: string): Obj =>
  (settings?.[key] as Obj | undefined) ?? {};

/** ST `world_names`: one array, refilled in place, so a holder of it keeps up */
const worldNames: string[] = [];
export function syncWorldNames(): void {
  worldNames.splice(0, worldNames.length, ...knownWorldNames());
}

const replySettings = (): ReplySettings => ({
  mainApi: extState.mainApi,
  source: String(extState.chatCompletionSettings['chat_completion_source'] ?? ''),
  showThoughts: !!extState.chatCompletionSettings['show_thoughts'],
  textGenType: String(extState.textCompletionSettings['type'] ?? ''),
});

/** Chat Completion presets for the preset-manager stand-in: connection fields never cross it */
function presetIo(): PresetIo {
  const root = (): string => {
    if (!chatStore.root) throw new Error('数据目录还没准备好');
    return chatStore.root;
  };
  let select: HTMLSelectElement | undefined;
  return {
    list: () => listCcPresets(root()),
    read: async (name) => withoutConnection(await readCcPreset(root(), name)),
    write: async (name, body) => {
      const existing = (await listCcPresets(root())).includes(name)
        ? await readCcPreset(root(), name)
        : {};
      return writeCcPreset(root(), name, { ...existing, ...withoutConnection(body) });
    },
    remove: (name) => deleteCcPreset(root(), name),
    selected: () => String(extState.chatCompletionSettings['preset_settings_openai'] ?? ''),
    current: () => withoutConnection(structuredClone(extState.chatCompletionSettings)),
    apply: async (name, body) => {
      const settings = plainChat.settings && structuredClone(plainChat.settings);
      if (!settings) return;
      settings['oai_settings'] = applyChatCompletionPreset(
        oaiOf(settings),
        withoutConnection(body),
        name,
      );
      await chatStore.saveSettings(settings);
    },
    select: () => {
      select ??= document.createElement('select');
      const jq = (globalThis as { jQuery?: (element: Element) => unknown }).jQuery;
      return jq ? jq(select) : select;
    },
  };
}

export function appModules(deps: AppModuleDeps): ModuleTable {
  const { chat } = deps.chat;

  /** a UI-only ST function: does nothing here, and says so once under 「缺的接口」 */
  const uiOnly =
    <T>(path: string, name: string, value?: T) =>
    (): T | undefined => {
      deps.coverage.miss('module', `${path}#${name}`);
      return value;
    };

  // macro / regex context of the open chat; rebuilt only when what it was built from changes
  let built: { key: readonly unknown[]; context: ChatContext; renderer?: MessageRenderer } | null =
    null;
  const open = () => {
    const { settings, character, group, members, chatMetadata } = plainChat;
    if (!settings) return null;
    const key = [settings, character, group, members, chatMetadata, chatStore.userName];
    if (built && key.every((part, i) => part === built!.key[i])) return built;
    const context = createChatContext(
      settings,
      { character, group, members, memberIndex: null },
      chatStore.userName,
      chat,
      structuredClone(chatMetadata),
    );
    return (built = { key, context });
  };
  const substitute = (value: string, _name1: string | null, name2: string | null) =>
    open()?.context.substitute(value, name2 ?? undefined) ?? value;

  const worldSettings = () => section(plainChat.settings, 'world_info_settings');
  const refreshWorlds = async (): Promise<void> => {
    if (chatStore.root) await listWorldNames(chatStore.root);
    syncWorldNames();
  };
  void refreshWorlds();

  const presets = new PresetManagerStandIn(presetIo());
  const PROMPTS = '/scripts/PromptManager.js';
  const SCRIPT = '/script.js';
  const OPENAI = '/scripts/openai.js';
  const WORLD = '/scripts/world-info.js';
  return {
    [SCRIPT]: {
      /** ST `Generate(type, options)`: a quiet prompt answers in text, the rest runs the chat page */
      Generate: async (type: unknown, options: Obj = {}): Promise<unknown> => {
        const quiet = options?.['quiet_prompt'];
        if (type === 'quiet' || quiet) return quietGenerate(String(quiet ?? ''));
        await chatPageIfOpen()?.generate(GEN_TYPES.has(type) ? (type as GenType) : 'normal');
        return undefined;
      },
      // the app draws `chat` itself: taking the extension's array is the redraw
      addOneMessage: (message: ChatMessage): void => {
        if (chat.includes(message)) deps.chat.save();
      },
      printMessages: async (): Promise<void> => void deps.chat.save(),
      clearChat: async ({ clearData = false } = {}): Promise<void> => {
        if (clearData) chat.length = 0;
      },
      baseChatReplace: (
        value: unknown,
        name1: string | null = null,
        name2: string | null = null,
      ) => {
        const context = open()?.context;
        if (!context || typeof value !== 'string') return value;
        return baseChatReplace(context.state, substitute, value, name1, name2);
      },
      cleanUpMessage: (options: Obj = {}): string => {
        const text = String(options['getMessage'] ?? '');
        const stops = options['stoppingStrings'];
        return (
          open()?.context.cleanUp(text, {
            isImpersonate: !!options['isImpersonate'],
            isContinue: !!options['isContinue'],
            displayIncompleteSentences: !!options['displayIncompleteSentences'],
            stoppingStrings: Array.isArray(stops) ? stops.map(String) : [],
          }) ?? text
        );
      },
      getBiasStrings: (textareaText: unknown, type: unknown) => {
        const context = open()?.context;
        const bias = String(section(plainChat.settings, 'power_user')['user_prompt_bias'] ?? '');
        return context
          ? getBiasStrings(
              context.state,
              context.substitute,
              bias,
              String(textareaText ?? ''),
              String(type ?? ''),
            )
          : { messageBias: '', promptBias: '', isUserPromptBias: false };
      },
      getCharacterCardFields: ({ chid }: { chid?: unknown } = {}) => {
        const context = open()?.context;
        if (!context) return {};
        return getCharacterCardFields(
          context.state,
          substitute,
          chid === undefined || chid === null ? undefined : Number(chid),
        );
      },
      parseMesExamples: (examples: unknown, isInstruct: unknown): string[] => {
        const context = open()?.context;
        return context
          ? parseMesExamples(
              context.state,
              context.substitute,
              String(examples ?? ''),
              !!isInstruct,
            )
          : [];
      },
      /** ST `messageFormatting(mes, ch_name, isSystem, isUser, messageId)` → sanitized HTML */
      messageFormatting: (
        mes: unknown,
        name: unknown,
        isSystem: unknown,
        isUser: unknown,
        messageId: unknown,
      ): string => {
        const at = open();
        if (!at) return String(mes ?? '');
        at.renderer ??= new MessageRenderer({
          powerUser: formatPowerUserFrom(plainChat.settings),
          substitute: at.context.substitute,
          applyRegex: (text, placement, params) =>
            at.context.regex.getRegexedString(text, placement, params),
        });
        return at.renderer.render(
          String(mes ?? ''),
          { name: String(name ?? ''), is_user: !!isUser, is_system: !!isSystem },
          Number(messageId ?? -1),
          chat,
        );
      },
      getCharacters: () => chatStore.refreshCharacters(),
      getOneCharacter: () => chatStore.refreshCharacters(),
      // the app's character list always holds whole cards
      unshallowCharacter: async (): Promise<void> => {},
      selectCharacterById: async (id: unknown): Promise<void> => {
        const avatar = extState.characters[Number(id)]?.['avatar'];
        if (typeof avatar === 'string') await chatStore.openCharacter(avatar);
      },
      /** ST `getPastCharacterChats(characterId)`: only the open character's chats are listed here */
      getPastCharacterChats: async (id: unknown = null): Promise<Obj[]> => {
        if (id !== null && String(id) !== String(extState.characterId)) return [];
        return chatStore.chatNames().map((name) => ({ file_name: `${name}.jsonl` }));
      },
      getMaxContextSize: (): number => extState.maxContext,
      saveSettings: async (): Promise<void> => deps.saveSettings(),
      activateSendButtons: uiOnly(SCRIPT, 'activateSendButtons'),
      deactivateSendButtons: uiOnly(SCRIPT, 'deactivateSendButtons'),
      deleteCharacter: uiOnly(SCRIPT, 'deleteCharacter', Promise.resolve()),
      printCharacters: uiOnly(SCRIPT, 'printCharacters', Promise.resolve()),
      reloadMarkdownProcessor: uiOnly(SCRIPT, 'reloadMarkdownProcessor'),
      saveCharacterDebounced: uiOnly(SCRIPT, 'saveCharacterDebounced'),
      scrollChatToBottom: uiOnly(SCRIPT, 'scrollChatToBottom'),
      setGenerationProgress: uiOnly(SCRIPT, 'setGenerationProgress'),
      setUserName: uiOnly(SCRIPT, 'setUserName'),
      showSwipeButtons: uiOnly(SCRIPT, 'showSwipeButtons'),
    },
    '/scripts/RossAscends-mods.js': {
      favsToHotswap: uiOnly('/scripts/RossAscends-mods.js', 'favsToHotswap', Promise.resolve()),
      isMobile: (): boolean =>
        /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1,
    },
    '/scripts/authors-note.js': { shouldWIAddPrompt: false },
    '/scripts/extensions.js': {
      extensionTypes: Object.fromEntries([...deps.manifests.keys()].map((id) => [id, 'local'])),
    },
    '/scripts/extensions/regex/engine.js': {
      getRegexedString: (raw: unknown, placement: unknown, params: Obj = {}): string => {
        const text = String(raw ?? '');
        return open()?.context.regex.getRegexedString(text, Number(placement), params) ?? text;
      },
    },
    '/scripts/macros.js': {
      getLastMessageId: (options?: Parameters<typeof lastMessageId>[1]) =>
        lastMessageId(chat, options),
    },
    [OPENAI]: {
      getChatCompletionModel: (settings: GenerationSettings | null = null): string =>
        getChatCompletionModel(
          settings ?? (section(plainChat.settings, 'oai_settings') as GenerationSettings),
        ),
      isImageInliningSupported: (): boolean =>
        isImageInliningSupported(
          section(plainChat.settings, 'oai_settings'),
          null,
          extState.mainApi,
        ),
      getStreamingReply: (data: unknown, state: unknown, options = {}) =>
        getStreamingReply(data, state, options, replySettings()),
      tryParseStreamingError: (response: Response, decoded: string, options = {}): void =>
        void tryParseStreamingError(response, decoded, options, deps.report),
      /** ST `sendOpenAIRequest(type, messages)`: always the main connection, never streamed */
      sendOpenAIRequest: async (_type: unknown, messages: unknown): Promise<Obj> => {
        const content = await deps.generateRaw({ prompt: messages });
        return { choices: [{ message: { role: 'assistant', content } }] };
      },
      // ST's prompt-manager page object; the app has its own preset editor, so drawing is a no-op
      promptManager: {
        render: uiOnly(PROMPTS, 'promptManager.render'),
        renderDebounced: uiOnly(PROMPTS, 'promptManager.renderDebounced'),
        saveServiceSettings: async (): Promise<void> => deps.saveSettings(),
      },
      prepareOpenAIMessages: uiOnly(OPENAI, 'prepareOpenAIMessages', Promise.resolve([[], false])),
      setOpenAIMessageExamples: uiOnly(OPENAI, 'setOpenAIMessageExamples', []),
      setOpenAIMessages: uiOnly(OPENAI, 'setOpenAIMessages', []),
      setupChatCompletionPromptManager: uiOnly(OPENAI, 'setupChatCompletionPromptManager', null),
    },
    '/scripts/personas.js': {
      getUserAvatar: (file: unknown): string =>
        chatStore.root ? userAvatarUrl(chatStore.root, String(file ?? '')) : '',
      getUserAvatars: async (): Promise<string[]> =>
        chatStore.root ? listUserAvatars(chatStore.root) : [],
      setUserAvatar: uiOnly('/scripts/personas.js', 'setUserAvatar', Promise.resolve()),
    },
    '/scripts/power-user.js': {
      flushEphemeralStoppingStrings: uiOnly(
        '/scripts/power-user.js',
        'flushEphemeralStoppingStrings',
      ),
    },
    '/scripts/preset-manager.js': {
      /** ST `getPresetManager(apiId)`: Chat Completion presets only */
      getPresetManager: (apiId: unknown = ''): PresetManagerStandIn | null => {
        if ((apiId || extState.mainApi) !== 'openai') {
          deps.coverage.miss(
            'module',
            `/scripts/preset-manager.js#getPresetManager(${String(apiId)})`,
          );
          return null;
        }
        void presets.ready().catch(() => {});
        return presets;
      },
    },
    '/scripts/reasoning.js': {
      extractReasoningFromData: (data: unknown, options = {}): string =>
        extractReasoningFromData(data, options, replySettings()),
    },
    '/scripts/slash-commands/SlashCommandCommonEnumsProvider.js': {
      commonEnumProviders: createCommonEnumProviders({
        characters: () => extState.characters,
        groups: () => extState.groups,
        personas: () => section(extState.powerUserSettings, 'personas'),
        worldNames: () => worldNames,
        messageCount: () => chat.length,
      }),
    },
    '/scripts/sse-stream.js': { getEventSourceStream: () => new EventSourceStream() },
    '/scripts/user.js': { isAdmin: (): boolean => true },
    '/scripts/utils.js': {
      // every format the webview decodes can be stored as is
      ensureImageFormatSupported: async (file: unknown): Promise<unknown> => file,
      getCharaFilename: (
        chid: unknown = null,
        { manualAvatarKey = null }: { manualAvatarKey?: string | null } = {},
      ): string | null => {
        const avatar =
          manualAvatarKey ?? extState.characters[Number(chid ?? extState.characterId)]?.['avatar'];
        return typeof avatar === 'string' ? avatar.replace(/\.[^/.]+$/, '') : null;
      },
      showFontAwesomePicker: uiOnly(
        '/scripts/utils.js',
        'showFontAwesomePicker',
        Promise.resolve(null),
      ),
    },
    [WORLD]: {
      world_names: worldNames,
      getWorldInfoSettings: (): Obj => structuredClone(worldSettings()),
      /** ST `convertCharacterBook()`: a card's embedded book → a world info file */
      convertCharacterBook: (book: unknown) =>
        characterBookToWorldInfo(CharacterBookSchema.parse(book)),
      createNewWorldInfo: async (name: unknown): Promise<boolean> => {
        if (!chatStore.root || !name) return false;
        try {
          await createWorld(chatStore.root, String(name));
        } catch {
          return false;
        }
        await refreshWorlds();
        return true;
      },
      deleteWorldInfo: async (name: unknown): Promise<boolean> => {
        const root = chatStore.root;
        if (!root || !knownWorldNames().includes(String(name))) return false;
        const settings = plainChat.settings && structuredClone(plainChat.settings);
        const next = await deleteWorld(root, String(name), settings);
        if (next) await chatStore.saveSettings(next);
        await refreshWorlds();
        return true;
      },
      setWorldInfoButtonClass: uiOnly(WORLD, 'setWorldInfoButtonClass'),
    },
  };
}

/** ST exports of these modules that ST reassigns: `[module path, export name, read]`, each `read` reactive */
export const APP_LIVE_EXPORTS: readonly (readonly [string, string, () => unknown])[] = [
  ['/script.js', 'is_send_press', () => chatPageIfOpen()?.busy() ?? false],
  ['/script.js', 'user_avatar', () => String(plainChat.settings?.['user_avatar'] ?? '')],
  ['/scripts/personas.js', 'user_avatar', () => String(plainChat.settings?.['user_avatar'] ?? '')],
  ['/scripts/openai.js', 'oai_settings', () => extState.chatCompletionSettings],
  [
    '/scripts/world-info.js',
    'world_info',
    () => section(section(plainChat.settings, 'world_info_settings'), 'world_info'),
  ],
  [
    '/scripts/world-info.js',
    'selected_world_info',
    () =>
      section(section(plainChat.settings, 'world_info_settings'), 'world_info')['globalSelect'] ??
      [],
  ],
  [
    '/scripts/world-info.js',
    'world_info_include_names',
    () => section(plainChat.settings, 'world_info_settings')['world_info_include_names'] !== false,
  ],
];
