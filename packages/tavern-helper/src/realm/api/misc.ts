/**
 * The small interfaces that belong to no data kind (DEV_NOTES §9.5 第 3 轮): `builtin`, versions,
 * extension management answers, shared globals (MVU), raw imports, and the upstream members that
 * are not built here.
 */
import type { ApiModule, Hub } from '../hub.js';
import { uuid } from '../util.js';
import {
  inert,
  patchPart,
  record,
  records,
  strings,
  unsupportedAsync,
  type Dict,
} from './shared.js';

/** The upstream version whose interfaces these follow, and the ST version the data formats match */
const HELPER_VERSION = '4.12.1';
const TAVERN_VERSION = '1.18.0';
const EXTENSION_ID = 'JS-Slash-Runner';

/** `generateRaw`'s default `ordered_prompts` */
const PLACEHOLDER_PROMPT_ORDER = [
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

const globalEvent = (name: string): string => `global_${name}_initialized`;
const baseName = (filename: unknown): string => String(filename).replace(/\.[^./\\]+$/, '');

/** `/pattern/flags` → a RegExp made by `make`; null for anything else */
function parseRegex(input: unknown, make: RegExpConstructor): RegExp | null {
  const match = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(String(input));
  if (!match) return null;
  try {
    return new make(match[1]!, match[2]);
  } catch {
    return null;
  }
}

export function miscModule(hub: Hub, win: object): ApiModule {
  /** values scripts share by name; a frame gets each as a global of its own window */
  const globals = new Map<string, unknown>();
  const frames = new Set<object>([win]);
  const define = (target: object, name: string, value: unknown): void => {
    try {
      Object.defineProperty(target, name, { value, configurable: true, writable: true });
    } catch {
      /* the frame is going away */
    }
  };
  hub.installers.push((target) => {
    frames.add(target);
    for (const [name, value] of globals) define(target, name, value);
  });
  hub.onRelease((owner) => frames.delete(owner));

  const parsed = (content: unknown): Dict => record(JSON.parse(String(content)));
  const ok = (): Response => new Response(null, { status: 200 });

  return ({ owner, frame, give }) => ({
    getTavernHelperVersion: (): string => HELPER_VERSION,
    getTavernVersion: (): string => TAVERN_VERSION,

    isAdmin: (): boolean => false,
    getTavernHelperExtensionId: (): string => EXTENSION_ID,
    getExtensionType: (): null => null,
    getExtensionInstallationInfo: (): Promise<null> => Promise.resolve(null),
    isInstalledExtension: (): boolean => false,
    installExtension: unsupportedAsync('installExtension'),
    uninstallExtension: unsupportedAsync('uninstallExtension'),
    reinstallExtension: unsupportedAsync('reinstallExtension'),
    updateExtension: unsupportedAsync('updateExtension'),

    getTavernFile: unsupportedAsync('getTavernFile'),
    uploadTavernFile: unsupportedAsync('uploadTavernFile'),
    deleteTavernFile: unsupportedAsync('deleteTavernFile'),

    importRawCharacter: async (filename: string, content: Blob): Promise<Response> => {
      // a JSON card; a PNG would have to cross the bridge as bytes, which it does not yet
      const card = parsed(await content.text());
      await hub.call('character.create', [card]);
      return ok();
    },
    importRawChat: unsupportedAsync('importRawChat'),
    importRawPreset: async (filename: string, content: string): Promise<boolean> => {
      const saved = await hub.call<string>('preset.write', [baseName(filename), parsed(content)]);
      const names = strings(hub.part('presets')['names']);
      if (!names.includes(saved)) patchPart(hub, 'presets', { names: [...names, saved] });
      return true;
    },
    importRawWorldbook: async (filename: string, content: string): Promise<Response> => {
      const saved = await hub.call<string>('world.write', [baseName(filename), parsed(content)]);
      const names = strings(hub.part('worlds')['names']);
      if (!names.includes(saved)) patchPart(hub, 'worlds', { names: [...names, saved] });
      return ok();
    },
    importRawTavernRegex: (filename: string, content: string): boolean => {
      const script = parsed(content);
      if (typeof script['findRegex'] !== 'string') return false;
      const scripts = [
        ...records(hub.part('regex')['global']),
        { ...script, id: uuid(), scriptName: script['scriptName'] ?? baseName(filename) },
      ];
      patchPart(hub, 'regex', { global: scripts });
      void hub.call('regex.set', ['global', scripts]).catch((e: unknown) => console.warn(e));
      return true;
    },

    rotateChatMessages: (begin: number, middle: number, end: number): Promise<void> =>
      hub.call('chat.rotate', [begin, middle, end]),
    /** No variable manager to validate against: the schema is accepted and not used */
    registerVariableSchema: (): void => undefined,

    getModelList: (api: { apiurl: string; key?: string }): Promise<string[]> =>
      hub.call('models.list', [{ apiurl: String(api?.apiurl ?? ''), key: api?.key }], frame.name),
    getProxyPresetNames: (): string[] => give(strings(hub.part('session')['proxyPresets'])),
    placeholder_prompt_default_order: give([...PLACEHOLDER_PROMPT_ORDER]),
    builtin_prompt_default_order: give([...PLACEHOLDER_PROMPT_ORDER]),

    initializeGlobal: (name: string, value: unknown): void => {
      const key = String(name);
      globals.set(key, value);
      for (const target of frames) define(target, key, value);
      void hub.bus.emit(globalEvent(key), [value]);
    },
    waitGlobalInitialized: <T>(name: string): Promise<T> => {
      const key = String(name);
      if (globals.has(key)) return Promise.resolve(globals.get(key) as T);
      return new Promise<T>((resolve) => {
        hub.bus.on(owner, globalEvent(key), () => resolve(globals.get(key) as T), { once: true });
      });
    },

    builtin: {
      addOneMessage: inert('builtin.addOneMessage', undefined),
      copyText: (value: string): void => {
        void hub.call('copy', [String(value)]).catch((e: unknown) => console.warn(e));
      },
      duringGenerating: (): boolean => !!hub.part('page')['generating'],
      getImageTokenCost: inert('builtin.getImageTokenCost', Promise.resolve(0)),
      getVideoTokenCost: inert('builtin.getVideoTokenCost', Promise.resolve(0)),
      parseRegexFromString: (input: string): RegExp | null =>
        parseRegex(input, (owner as { RegExp?: RegExpConstructor }).RegExp ?? RegExp),
      promptManager: {
        messages: [],
        getPromptCollection: () => ({
          collection: give(records(record(hub.part('presets')['current'])['prompts'])),
        }),
      },
      reloadAndRenderChatWithoutEvents: (): Promise<void> => hub.call('chat.reload'),
      reloadChatWithoutEvents: (): Promise<void> => hub.call('chat.reload'),
      reloadEditor: inert('builtin.reloadEditor', undefined),
      reloadEditorDebounced: inert('builtin.reloadEditorDebounced', undefined),
      renderMarkdown: (markdown: string): string =>
        hub.renderer?.markdown(String(markdown)) ?? String(markdown),
      renderPromptManager: inert('builtin.renderPromptManager', undefined),
      renderPromptManagerDebounced: inert('builtin.renderPromptManagerDebounced', undefined),
      saveSettings: (): Promise<void> => hub.call('settings.save'),
      uuidv4: uuid,
    },
  });
}
