/**
 * The hub: one hidden frame in the realm that holds a mirror of the open chat and hands every
 * card frame its TavernHelper API (DEV_NOTES §9.5). Reads are answered from the mirror, so they
 * are synchronous like upstream's; writes go to the app, which validates and persists them.
 */
import _ from 'lodash';
import { slotMessageId } from '../detect.js';
import {
  envelope,
  HUB_FRAME_NAME,
  openEnvelope,
  type CatalogPart,
  type ChatSplice,
  type GenerateKind,
  type HostToHub,
  type HubRequest,
  type HubToHost,
  type Names,
  type RawMessage,
  type PageDomEvent,
  type ScriptsState,
  type VariableScope,
  type Variables,
} from '../protocol.js';
import {
  allScripts,
  buttonEvent,
  normalizeButtons,
  patchScript,
  SCRIPT_SCOPES,
  visibleButtons,
  type Script,
  type ScriptButton,
  type ScriptPatch,
  type ScriptScope,
  type ScriptTree,
} from '../scripts.js';
import {
  creatingToPatch,
  roleOf,
  toChatMessage,
  toChatMessageSwiped,
  updateToPatch,
  type ChatMessage,
  type ChatMessageCreating,
  type ChatMessageSwiped,
  type ChatMessageUpdate,
  type Role,
} from './chat.js';
import { deriveEvents, EventBus, iframe_events, tavern_events, type Listener } from './events.js';
import { parseRange, resolveMessageId } from './range.js';
import { audioModule } from './api/audio.js';
import { characterModule } from './api/character.js';
import { contextModule } from './api/context.js';
import { injectModule } from './api/inject.js';
import { miscModule } from './api/misc.js';
import { pageModule } from './api/page.js';
import { personaModule } from './api/persona.js';
import { presetModule } from './api/preset.js';
import { regexModule } from './api/regex.js';
import { createStores } from './api/shared.js';
import { worldbookModule } from './api/worldbook.js';
import { sharedLibraries } from './libs.js';
import type { HubRenderer } from './render.js';
import { ScriptFrames } from './scripts.js';
import { isBlob, isRecord, isThenable, own, printable, toDataUrl, uuid } from './util.js';
import {
  deletePath,
  insertMissing,
  mergeAssign,
  messageVariables,
  withMessageVariables,
  type VariableOption,
} from './variables.js';

/** A script from the library running in its own hidden frame */
export interface ScriptRef {
  id: string;
  scope: ScriptScope;
  /** `reloadIframe()` */
  reload(): void;
}

/** Which rendered block a card frame is, or which library script */
export interface FrameInfo {
  /** `TH-message--<楼层>--<序号>`, or `TH-script--<名称>--<id>` */
  name: string;
  /** the block's 楼层; -1 for a library script, which belongs to no message */
  messageId: number;
  script?: ScriptRef;
}

/** A card window as the hub uses it: an identity for its listeners, and its own `structuredClone` */
export interface CardRealm {
  structuredClone<T>(value: T): T;
}

export interface GetChatMessagesOption {
  role?: 'all' | Role;
  hide_state?: 'all' | 'hidden' | 'unhidden';
  include_swipes?: boolean;
}

export type TavernHelperApi = ReturnType<Hub['createApi']>;

/** What an API module is handed for one frame (round 3: the API is assembled from modules) */
export interface ApiContext {
  hub: Hub;
  /** the frame's window: keys its listeners, and clones results into its realm */
  owner: CardRealm;
  frame: FrameInfo;
  /** a copy of `value` the frame owns */
  give<T>(value: T): T;
}
/** Returns the globals it adds to a frame; they also become members of `TavernHelper` */
export type ApiModule = (context: ApiContext) => Record<string, unknown>;

type DirtyKey = VariableScope | number | `script:${string}` | `ext:${string}`;
const SCRIPT_KEY = 'script:';
const EXTENSION_KEY = 'ext:';
const STORED_SCOPES: ReadonlySet<string> = new Set<VariableScope>([
  'chat',
  'global',
  'character',
  'preset',
]);

const MACRO = /\{\{([^{}]+)\}\}/g;

export class Hub {
  chat: RawMessage[] = [];
  chatId: string | null = null;
  names: Names = { user: '', char: '' };
  readonly bus = new EventBus();
  readonly lodash = _;
  /** Resolves once the app has sent the first chat state; card frames are created after it */
  readonly initialized: Promise<void>;
  /** the script library; null until the app sends it */
  scripts: ScriptsState | null = null;
  /** set by the script frame manager: called whenever the app sends a new library state */
  onScripts: ((state: ScriptsState) => void) | null = null;

  /** what the app last sent of each catalog part: read-only snapshots, replaced whole */
  readonly catalog: Partial<Record<CatalogPart, unknown>> = {};
  /** API groups added on top of the built-in ones; set up once by the hub page */
  readonly modules: ApiModule[] = [];
  /** run for every frame after its globals are in place */
  readonly installers: ((target: object, frame: FrameInfo) => void)[] = [];
  /** globals every frame gets as they are: `YAML`, `z`, `toastr`… */
  readonly libraries: Record<string, unknown> = {};
  /** applied by a slot to a card's HTML before it becomes a document (macro-likes) */
  readonly cardFilters: ((html: string, messageId: number) => string)[] = [];
  /** more members for a frame's `SillyTavern`; accessors are kept as accessors */
  readonly contexts: ((context: ApiContext) => object)[] = [];
  /** the app's message renderer; null where the hub page gave none (then texts pass unrendered) */
  renderer: HubRenderer | null = null;

  private readonly variables: Record<VariableScope, Variables> = {
    chat: {},
    global: {},
    character: {},
    preset: {},
  };
  private readonly catalogListeners = new Set<(part: CatalogPart) => void>();
  private readonly domListeners = new Set<(event: PageDomEvent) => void>();
  private readonly chatListeners = new Set<(splice: ChatSplice | null) => void>();
  /** what the app may ask of the realm, by name */
  private readonly answers = new Map<string, (...args: unknown[]) => unknown>();
  /** last chat revision received from the app, echoed in every request */
  private rev = 0;
  private started = false;
  private markInitialized: () => void = () => {};
  private nextRequest = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  /** variable stores written this tick: a scope, the index of a message, or a script's data */
  private readonly dirty = new Set<DirtyKey>();
  /** script generations this realm started and has no answer for yet */
  private readonly generating = new Set<string>();

  constructor(private readonly send: (message: HubToHost) => void) {
    this.initialized = new Promise((resolve) => (this.markInitialized = resolve));
  }

  receive(message: HostToHub): void {
    switch (message.type) {
      case 'init': {
        this.rev = message.rev;
        this.chatId = message.chatId;
        this.chat = message.chat;
        this.variables.chat = message.chatVariables;
        this.variables.global = message.globalVariables;
        this.names = message.names;
        for (const listener of this.chatListeners) listener(null);
        if (!this.started) {
          this.started = true;
          this.markInitialized();
        } else if (message.switched) void this.bus.emit(tavern_events.CHAT_CHANGED, [this.chatId]);
        return;
      }
      case 'chat.splice': {
        this.rev = message.rev;
        const before = this.chat.length;
        const removed = this.applySplice(message.splice);
        void this.emitAll(deriveEvents(before, removed, message.splice));
        return;
      }
      case 'vars':
        this.variables[message.scope] = message.value;
        return;
      case 'catalog':
        this.catalog[message.part] = message.value;
        for (const listener of this.catalogListeners) listener(message.part);
        return;
      case 'query':
        void this.answer(message.id, message.name, message.args);
        return;
      case 'dom.event':
        for (const listener of this.domListeners) listener(message);
        return;
      case 'names':
        this.names = message.names;
        return;
      case 'scripts': {
        const { epoch, trees, running } = message;
        this.scripts = { epoch, trees, running };
        this.onScripts?.(this.scripts);
        return;
      }
      case 'event':
        void this.bus.emit(message.name, message.args);
        return;
      case 'reply': {
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id);
        if (message.ok) {
          if (message.splice) this.applySplice(message.splice);
          waiting.resolve(message.result);
        } else waiting.reject(new Error(message.error));
        return;
      }
    }
  }

  /** A card frame is gone: forget its listeners. */
  release(owner: object): void {
    this.bus.clearOwner(owner);
    for (const listener of this.releaseListeners) listener(owner);
  }
  private readonly releaseListeners = new Set<(owner: object) => void>();
  /** Told when a frame goes away, so per-frame registrations (macro-likes, injects) go with it */
  onRelease(listener: (owner: object) => void): void {
    this.releaseListeners.add(listener);
  }

  /** Give a frame its globals: the API, the shared libraries, then whatever the installers add. */
  install(target: CardRealm & object, frame: FrameInfo): void {
    Object.assign(target, this.createApi(target, frame));
    for (const installer of this.installers) installer(target, frame);
  }

  /** A function of the app's whitelist; `args` are copied out of the caller's realm first. */
  call<T = unknown>(name: string, args: unknown[] = [], from = ''): Promise<T> {
    return this.request({ method: 'call', params: { name, args: own(args), from } }) as Promise<T>;
  }

  /** One catalog part as a record (`{}` until the app sent it) */
  part(part: CatalogPart): Record<string, unknown> {
    const value = this.catalog[part];
    return isRecord(value) ? value : {};
  }

  onCatalog(listener: (part: CatalogPart) => void): void {
    this.catalogListeners.add(listener);
  }

  onDomEvent(listener: (event: PageDomEvent) => void): void {
    this.domListeners.add(listener);
  }

  /**
   * Told right after the mirror changed and before any event goes out: a splice, or null when
   * the whole chat was replaced. The stand-in page keeps its message nodes in step with this.
   */
  onChat(listener: (splice: ChatSplice | null) => void): void {
    this.chatListeners.add(listener);
  }

  /** Register what the app's `query(name)` gets; the result may be a promise */
  provide(name: string, handler: (...args: unknown[]) => unknown): void {
    this.answers.set(name, handler);
  }

  private async answer(id: number, name: string, args: unknown[]): Promise<void> {
    let value: unknown;
    try {
      value = await this.answers.get(name)?.(...args);
    } catch (e) {
      console.warn(`[TavernHelper] ${name}`, e);
    }
    try {
      this.send({ type: 'query.reply', id, value });
    } catch {
      this.send({ type: 'query.reply', id, value: undefined });
    }
  }

  /** The stored variables of one scope, as the mirror holds them (not a copy) */
  stored(scope: VariableScope): Variables {
    return this.variables[scope];
  }

  /**
   * `substitudeMacros`: the macros the hub can answer by itself — names, variables, the last
   * messages, swipe numbers, ISO time, the input box — and the argument-less ones the app evaluated ahead of time (the
   * `macro` catalog part). Anything else is left as written.
   */
  substitute(text: string, post?: (value: string) => string): string {
    if (!text.includes('{{')) return text;
    return text.replace(MACRO, (all, body: string) => {
      const value = this.macro(body);
      return value === undefined ? all : post ? post(value) : value;
    });
  }

  private macro(body: string): string | undefined {
    const [head = '', ...rest] = body.split('::');
    const name = head.trim().toLowerCase();
    const argument = rest.join('::').trim();
    const last = (wanted: (message: RawMessage) => boolean): string => {
      for (let i = this.chat.length - 1; i >= 0; i--) {
        const message = this.chat[i]!;
        if (wanted(message)) return message.mes;
      }
      return '';
    };
    switch (name) {
      case 'user':
        return this.names.user;
      case 'char':
        return this.names.char;
      case 'lastmessageid':
        return String(this.chat.length - 1);
      case 'getvar':
        return rest.length ? printable(this.variables.chat[argument]) : undefined;
      case 'getglobalvar':
        return rest.length ? printable(this.variables.global[argument]) : undefined;
      case 'lastmessage':
        return last(() => true);
      case 'lastusermessage':
        return last((message) => !!message.is_user && !message.is_system);
      case 'lastcharmessage':
        return last((message) => !message.is_user && !message.is_system);
      case 'input': {
        const draft = this.part('page')['draft'];
        return typeof draft === 'string' ? draft : '';
      }
      case 'lastswipeid': {
        const swipes = this.chat[this.chat.length - 1]?.swipes;
        return Array.isArray(swipes) ? String(swipes.length) : '';
      }
      case 'currentswipeid': {
        const swipe = this.chat[this.chat.length - 1]?.swipe_id;
        return typeof swipe === 'number' ? String(swipe + 1) : '';
      }
      case 'allchatrange':
        return this.chat.length ? `0-${this.chat.length - 1}` : '';
      case 'isotime':
      case 'isodate': {
        const now = new Date();
        const two = (n: number): string => String(n).padStart(2, '0');
        return name === 'isotime'
          ? `${two(now.getHours())}:${two(now.getMinutes())}`
          : `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
      }
      case 'newline':
        return '\n';
      case 'space':
        return ' ';
      case 'noop':
        return '';
    }
    const value = this.part('macro')[name];
    return typeof value === 'string' ? value : undefined;
  }

  /** The globals one card frame gets. `owner` keys its listeners; results are cloned into its realm. */
  createApi(owner: CardRealm, frame: FrameInfo) {
    const give = <T>(value: T): T => owner.structuredClone(value);
    const { bus } = this;

    const api = {
      // ---- variables ----
      getVariables: (option?: VariableOption): Variables => give(this.read(option, frame)),
      replaceVariables: (variables: Variables, option?: VariableOption): void => {
        this.write(option, own(variables), frame);
      },
      updateVariablesWith: (
        updater: (variables: Variables) => Variables | PromiseLike<Variables>,
        option?: VariableOption,
      ): Variables | PromiseLike<Variables> => {
        const current = give(this.read(option, frame));
        const store = (next: Variables | undefined) => {
          const result = next ?? current;
          this.write(option, own(result), frame);
          return result;
        };
        const result = updater(current);
        return isThenable<Variables>(result) ? result.then(store) : store(result);
      },
      insertOrAssignVariables: (variables: Variables, option?: VariableOption): Variables => {
        const next = mergeAssign(own(this.read(option, frame)), own(variables));
        this.write(option, next, frame);
        return give(next);
      },
      insertVariables: (variables: Variables, option?: VariableOption): Variables => {
        const next = insertMissing(own(this.read(option, frame)), own(variables));
        this.write(option, next, frame);
        return give(next);
      },
      deleteVariable: (
        path: string,
        option?: VariableOption,
      ): { variables: Variables; delete_occurred: boolean } => {
        const next = own(this.read(option, frame));
        const delete_occurred = deletePath(next, path);
        if (delete_occurred) this.write(option, next, frame);
        return { variables: give(next), delete_occurred };
      },
      /** global → chat → each message up to this frame's own, later ones winning */
      getAllVariables: (): Variables => {
        const all = _.merge(
          {},
          this.variables.global,
          this.variables.preset,
          this.variables.character,
          frame.script ? this.script(frame.script.id)?.script.data : undefined,
          this.variables.chat,
        );
        const last = Math.min(frame.messageId, this.chat.length - 1);
        for (let i = 0; i <= last; i++) _.merge(all, messageVariables(this.chat[i]!));
        return give(all);
      },

      // ---- chat messages ----
      getChatMessages: (
        range: string | number,
        option: GetChatMessagesOption = {},
      ): (ChatMessage | ChatMessageSwiped)[] => {
        const { role = 'all', hide_state = 'all', include_swipes = false } = option;
        const text = typeof range === 'string' ? this.substitute(range) : range;
        const span = parseRange(text, this.chat.length);
        if (!span) return [];
        const out: (ChatMessage | ChatMessageSwiped)[] = [];
        for (let id = span[0]; id <= span[1]; id++) {
          const message = this.chat[id]!;
          if (role !== 'all' && roleOf(message) !== role) continue;
          if (hide_state !== 'all' && (hide_state === 'hidden') !== !!message.is_system) continue;
          out.push(include_swipes ? toChatMessageSwiped(message, id) : toChatMessage(message, id));
        }
        return give(out);
      },
      setChatMessages: (updates: ChatMessageUpdate[]): Promise<void> =>
        this.attempt(() => ({
          method: 'chat.set',
          params: {
            updates: own(updates).map((update) => {
              const index = resolveMessageId(update.message_id, this.chat.length);
              return { index, patch: updateToPatch(this.chat[index]!, update) };
            }),
          },
        })),
      createChatMessages: (
        messages: ChatMessageCreating[],
        option: { insert_before?: number | 'end' } = {},
      ): Promise<void> =>
        this.attempt(() => {
          const before = option.insert_before ?? 'end';
          return {
            method: 'chat.insert',
            params: {
              index:
                before === 'end' ? this.chat.length : resolveMessageId(before, this.chat.length),
              messages: own(messages).map((m) => creatingToPatch(m, this.names)),
            },
          };
        }),
      deleteChatMessages: (ids: number[]): Promise<void> =>
        this.attempt(() => ({
          method: 'chat.delete',
          params: { indices: ids.map((id) => resolveMessageId(id, this.chat.length)) },
        })),
      getLastMessageId: (): number => this.chat.length - 1,

      // ---- this frame ----
      getIframeName: (): string => frame.name,
      getCurrentMessageId: (): number => {
        if (frame.script) throw new Error('脚本不属于任何楼层，没有 getCurrentMessageId()');
        return frame.messageId;
      },
      getMessageId: (name: string): number => {
        const id = slotMessageId(name);
        if (id === null) throw new Error(`不是消息 iframe 的名称: ${name}`);
        return id;
      },

      // ---- events ----
      eventOn: (type: string, listener: Listener) => bus.on(owner, type, listener),
      eventOnce: (type: string, listener: Listener) =>
        bus.on(owner, type, listener, { once: true }),
      eventMakeFirst: (type: string, listener: Listener) =>
        bus.on(owner, type, listener, { position: 'first' }),
      eventMakeLast: (type: string, listener: Listener) =>
        bus.on(owner, type, listener, { position: 'last' }),
      eventEmit: (type: string, ...args: unknown[]): Promise<void> => bus.emit(type, args),
      eventEmitAndWait: (type: string, ...args: unknown[]): Promise<void> => bus.emit(type, args),
      eventRemoveListener: (type: string, listener: Listener): void =>
        bus.off(owner, type, listener),
      eventClearEvent: (type: string): void => bus.clearEvent(owner, type),
      eventClearListener: (listener: Listener): void => bus.clearListener(owner, listener),
      eventClearAll: (): void => bus.clearOwner(owner),
      tavern_events,
      iframe_events,

      // ---- slash commands and generation (round 2) ----
      triggerSlash: (command: string): Promise<string> =>
        this.request({ method: 'slash.run', params: { command: String(command) } }).then((result) =>
          printable(result),
        ),
      generate: (config?: Record<string, unknown>): Promise<unknown> =>
        this.generate('generate', config, frame.name).then(give),
      generateRaw: (config?: Record<string, unknown>): Promise<unknown> =>
        this.generate('raw', config, frame.name).then(give),
      stopGenerationById: (generationId: string): boolean => {
        if (!this.generating.has(generationId)) return false;
        void this.request({ method: 'generate.stop', params: { generationId } });
        return true;
      },
      stopAllGeneration: (): boolean => {
        if (this.generating.size === 0) return false;
        void this.request({ method: 'generate.stop', params: { generationId: null } });
        return true;
      },

      // ---- utilities ----
      substitudeMacros: (text: string): string => this.substitute(text),
      errorCatched:
        <A extends unknown[], R>(fn: (...args: A) => R) =>
        (...args: A): R | undefined => {
          const report = (e: unknown) => console.error(`[TavernHelper] ${frame.name}`, e);
          try {
            const result = fn(...args);
            if (isThenable(result)) result.then(undefined, report);
            return result;
          } catch (e) {
            report(e);
            return undefined;
          }
        },
    };

    /** The part of ST's `SillyTavern.getContext()` surface the mirror can answer; read-only. */
    const hub = this;
    const SillyTavern = {
      get chat() {
        return hub.chat;
      },
      get chatMetadata() {
        return { variables: hub.variables.chat };
      },
      get name1() {
        return hub.names.user;
      },
      get name2() {
        return hub.names.char;
      },
      get chatId() {
        return hub.chatId;
      },
      getCurrentChatId: () => hub.chatId,
      substituteParams: (text: string) => hub.substitute(text),
      getContext: () => SillyTavern,
    };

    // upstream's older name for the same call
    const extended = { ...api, triggerSlashWithResult: api.triggerSlash };
    const base = frame.script
      ? { ...extended, ...this.createScriptApi(owner, frame.script) }
      : extended;
    const full: typeof base & Record<string, unknown> = { ...base };
    const context: ApiContext = { hub: this, owner, frame, give };
    for (const module of this.modules) Object.assign(full, module(context));
    for (const more of this.contexts)
      Object.defineProperties(SillyTavern, Object.getOwnPropertyDescriptors(more(context)));
    return { ...this.libraries, ...full, TavernHelper: full, SillyTavern, _ };
  }

  /** What only a library script gets on top of {@link createApi} */
  private createScriptApi(owner: CardRealm, ref: ScriptRef) {
    const give = <T>(value: T): T => owner.structuredClone(value);
    const self = (): Script => {
      const found = this.script(ref.id);
      if (!found) throw new Error('这个脚本已经不在脚本库里了');
      return found.script;
    };
    const setButtons = (buttons: unknown): void =>
      this.patchScript(ref.id, { buttons: normalizeButtons(own(buttons)) });
    const trees = (option?: { type?: ScriptScope }): ScriptTree[] => {
      const scope = option?.type ?? 'global';
      if (!SCRIPT_SCOPES.includes(scope)) throw new Error(`没有 "${String(scope)}" 这个脚本库`);
      return this.scripts?.trees[scope] ?? [];
    };
    const setTrees = (next: unknown, option?: { type?: ScriptScope }): Promise<void> => {
      trees(option);
      return this.request({
        method: 'scripts.set',
        params: { scope: option?.type ?? 'global', trees: own(next) },
      }).then(() => undefined);
    };
    return {
      getScriptId: (): string => ref.id,
      getScriptName: (): string => self().name,
      getScriptInfo: (): string => self().info,
      replaceScriptInfo: (info: string): void => this.patchScript(ref.id, { info: String(info) }),
      getScriptButtons: (): ScriptButton[] => give(self().button.buttons),
      replaceScriptButtons: setButtons,
      updateScriptButtonsWith: (
        updater: (buttons: ScriptButton[]) => ScriptButton[] | PromiseLike<ScriptButton[]>,
      ): ScriptButton[] | PromiseLike<ScriptButton[]> => {
        const store = (next: ScriptButton[]) => {
          setButtons(next);
          return give(self().button.buttons);
        };
        const result = updater(give(self().button.buttons));
        return isThenable<ScriptButton[]>(result) ? result.then(store) : store(result);
      },
      appendInexistentScriptButtons: (buttons: ScriptButton[]): void => {
        const current = self().button.buttons;
        const names = new Set(current.map((b) => b.name));
        const added = normalizeButtons(own(buttons)).filter((b) => !names.has(b.name));
        if (added.length) setButtons([...current, ...added]);
      },
      getButtonEvent: (name: string): string => buttonEvent(ref.id, name),
      /** upstream's older form: listen to one of this script's buttons */
      eventOnButton: (name: string, listener: Listener) =>
        this.bus.on(owner, buttonEvent(ref.id, name), listener),
      getAllEnabledScriptButtons: (): Record<
        string,
        { button_id: string; button_name: string }[]
      > => {
        const out: Record<string, { button_id: string; button_name: string }[]> = {};
        const running = new Set(this.scripts?.running);
        for (const scope of SCRIPT_SCOPES)
          for (const script of allScripts(this.scripts?.trees[scope] ?? [])) {
            if (!running.has(script.id)) continue;
            out[script.id] = visibleButtons(script).map((b) => ({
              button_id: buttonEvent(script.id, b.name),
              button_name: b.name,
            }));
          }
        return give(out);
      },
      getScriptTrees: (option?: { type?: ScriptScope }): ScriptTree[] => give(trees(option)),
      replaceScriptTrees: setTrees,
      updateScriptTreesWith: async (
        updater: (trees: ScriptTree[]) => ScriptTree[] | PromiseLike<ScriptTree[]>,
        option?: { type?: ScriptScope },
      ): Promise<ScriptTree[]> => {
        const next = await updater(give(trees(option)));
        await setTrees(next, option);
        return next;
      },
      reloadIframe: (): void => ref.reload(),
    };
  }

  /** Where script `id` lives in the mirrored library */
  private script(id: string): { scope: ScriptScope; script: Script } | null {
    if (!this.scripts) return null;
    for (const scope of SCRIPT_SCOPES) {
      const script = allScripts(this.scripts.trees[scope]).find((s) => s.id === id);
      if (script) return { scope, script };
    }
    return null;
  }

  /** Change a script in the mirror now; the app hears about it at the end of the tick. */
  private patchScript(id: string, patch: ScriptPatch): void {
    const found = this.script(id);
    if (!found || !this.scripts) throw new Error('这个脚本已经不在脚本库里了');
    const { scope } = found;
    this.scripts.trees[scope] = patchScript(this.scripts.trees[scope], id, patch);
    this.touch(`${SCRIPT_KEY}${id}`);
  }

  private async generate(
    kind: GenerateKind,
    input: Record<string, unknown> = {},
    from = '',
  ): Promise<unknown> {
    // files cannot cross to the app; read them while the frame that made them is still here
    const image = input['image'];
    const files = [image].flat().some(isBlob);
    const config = own(files ? { ...input, image: undefined } : input);
    if (files) {
      const urls = await Promise.all(
        [image].flat().map((item) => (isBlob(item) ? toDataUrl(item) : (item as unknown))),
      );
      config['image'] = Array.isArray(image) ? urls : urls[0];
    }
    const given = config['generation_id'];
    const generationId = typeof given === 'string' && given ? given : uuid();
    await this.bus.emit(iframe_events.GENERATION_REQUESTED, [
      generationId,
      kind === 'raw' ? 'generateRaw' : 'generate',
      config,
    ]);
    this.generating.add(generationId);
    try {
      return await this.request({
        method: 'generate.start',
        params: { kind, generationId, config, from },
      });
    } finally {
      this.generating.delete(generationId);
    }
  }

  private applySplice(splice: ChatSplice): RawMessage[] {
    const removed = this.chat.splice(splice.start, splice.deleteCount, ...splice.messages);
    for (const listener of this.chatListeners) listener(splice);
    return removed;
  }

  private async emitAll(events: [name: string, ...args: unknown[]][]): Promise<void> {
    for (const [name, ...args] of events) await this.bus.emit(name, args);
  }

  request(request: HubRequest): Promise<unknown> {
    // variable writes made before this call must reach the app first
    this.flush();
    return new Promise((resolve, reject) => {
      const id = this.nextRequest++;
      this.pending.set(id, { resolve, reject });
      this.send({ type: 'request', id, rev: this.rev, ...request });
    });
  }

  /** Build a request (which may throw on bad input) and send it; either way the caller gets a promise. */
  private async attempt(build: () => HubRequest): Promise<void> {
    await this.request(build());
  }

  /** `latest`: the last visible message when reading, the very last one when writing (upstream). */
  private messageIndex(id: number | 'latest' | undefined, forWrite: boolean): number {
    if (id !== undefined && id !== 'latest') return resolveMessageId(id, this.chat.length);
    if (forWrite) return resolveMessageId(-1, this.chat.length);
    let at = this.chat.length - 1;
    while (at >= 0 && this.chat[at]!.is_system) at--;
    return at;
  }

  /** The stored object itself: callers clone before handing it out or changing it. */
  private read(option: VariableOption | undefined, frame: FrameInfo): Variables {
    const type = option?.type ?? 'chat';
    switch (type) {
      case 'chat':
      case 'global':
      case 'character':
      case 'preset':
        return this.variables[type];
      case 'message': {
        const at = this.messageIndex(option?.message_id, false);
        return at < 0 ? {} : messageVariables(this.chat[at]!);
      }
      case 'script':
        return this.script(this.scriptId(option, frame))?.script.data ?? {};
      case 'extension': {
        const value = this.part('extensions')[this.extensionId(option)];
        return isRecord(value) ? value : {};
      }
      default:
        throw new Error(`变量类型 "${String(type)}" 尚未支持`);
    }
  }

  /** `value` must already be owned by the hub. */
  private write(option: VariableOption | undefined, value: Variables, frame: FrameInfo): void {
    const type = option?.type ?? 'chat';
    switch (type) {
      case 'character':
        // upstream's wording: scripts match on it
        if (!this.part('session')['character'])
          throw new Error('当前没有打开角色卡，保存角色卡变量失败');
      // falls through
      case 'chat':
      case 'global':
      case 'preset':
        this.variables[type] = value;
        this.touch(type);
        return;
      case 'extension': {
        const id = this.extensionId(option);
        this.catalog.extensions = { ...this.part('extensions'), [id]: value };
        this.touch(`${EXTENSION_KEY}${id}`);
        return;
      }
      case 'message': {
        const at = this.messageIndex(option?.message_id, true);
        const message = this.chat[at]!;
        this.chat[at] = { ...message, variables: withMessageVariables(message, value) };
        this.touch(at);
        return;
      }
      case 'script':
        this.patchScript(this.scriptId(option, frame), { data: value });
        return;
      default:
        throw new Error(`变量类型 "${String(type)}" 尚未支持`);
    }
  }

  private extensionId(option: VariableOption | undefined): string {
    const id = option?.extension_id;
    if (!id) throw new Error('读写扩展变量要给出 extension_id');
    return id;
  }

  private scriptId(option: VariableOption | undefined, frame: FrameInfo): string {
    const id = option?.script_id ?? frame.script?.id;
    if (!id) throw new Error('在脚本之外读写脚本变量要给出 script_id');
    return id;
  }

  /** Many writes in one tick (a status bar updating ten values) become one message to the app. */
  private touch(key: DirtyKey): void {
    if (this.dirty.size === 0) queueMicrotask(() => this.flush());
    this.dirty.add(key);
  }

  private flush(): void {
    if (this.dirty.size === 0) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const key of keys) {
      if (typeof key === 'string' && STORED_SCOPES.has(key)) {
        const scope = key as VariableScope;
        this.send({ type: 'vars.set', scope, value: this.variables[scope] });
        continue;
      }
      if (typeof key === 'string' && key.startsWith(EXTENSION_KEY)) {
        const id = key.slice(EXTENSION_KEY.length);
        this.call('ext.set', [id, this.part('extensions')[id]]).catch((e: unknown) =>
          console.warn('[TavernHelper] 扩展变量未保存', e),
        );
        continue;
      }
      if (typeof key === 'string') {
        this.flushScript(key.slice(SCRIPT_KEY.length));
        continue;
      }
      const message = this.chat[key];
      if (!message) continue;
      this.request({
        method: 'chat.vars',
        params: { index: key, variables: message.variables },
      }).catch((e: unknown) => console.warn('[TavernHelper] 消息变量未保存', e));
    }
  }

  /** Everything a script may change about itself goes in one patch: the latest of each field */
  private flushScript(id: string): void {
    const found = this.script(id);
    if (!found) return;
    const { scope, script } = found;
    this.request({
      method: 'script.patch',
      params: {
        scope,
        id,
        patch: { info: script.info, data: script.data, buttons: script.button.buttons },
      },
    }).catch((e: unknown) => console.warn('[TavernHelper] 脚本数据未保存', e));
  }
}

export interface HubWindow extends Window {
  __tmHub?: Hub;
}

/**
 * Entry of the hub page. Refuses to run where the WebView put app scripts into this document
 * (old Android WebViews inline them into every page): the realm would not be isolated there.
 */
export interface HubOptions {
  jqueryUrl: string;
  /** where the pre-bundled libraries scripts import by upstream's fixed paths are served from */
  libBase?: string;
  /** the app's message formatting, so what a script asks to have rendered looks like the chat */
  render?: (hub: Hub) => HubRenderer;
}

export function startHub(win: HubWindow & typeof globalThis, options: HubOptions): void {
  const host = win.parent;
  const send = (message: HubToHost) => host.postMessage(envelope(message), '*');
  const exposed = [...win.document.scripts].some(
    (s) => !s.src && /__TAURI_(?:INTERNALS|INVOKE_KEY)__/.test(s.textContent ?? ''),
  );
  if (host === win || exposed) {
    send({ type: 'ready', ok: false, reason: exposed ? 'app scripts present' : 'not embedded' });
    return;
  }
  const hub = new Hub(send);
  win.__tmHub = hub;
  const stores = createStores(hub);
  Object.assign(hub.libraries, sharedLibraries(hub));
  hub.modules.push(
    audioModule(hub, win),
    characterModule(hub, stores),
    worldbookModule(hub, stores),
    presetModule(hub, stores),
    regexModule(hub, stores),
    personaModule(hub),
    injectModule(hub),
    miscModule(hub, win),
    pageModule(hub, win),
  );
  hub.contexts.push(contextModule(hub));
  hub.renderer = options.render?.(hub) ?? null;
  // scripts reach these as `parent.TavernHelper`, `parent.toastr`, …: `parent` is this window for
  // every frame. What is listened to through here belongs to the hub and lives as long as it does.
  Object.assign(win, hub.createApi(win, { name: HUB_FRAME_NAME, messageId: -1 }));
  new ScriptFrames(win, hub, options.jqueryUrl, options.libBase);
  win.addEventListener('message', (event) => {
    if (event.source !== host) return;
    const message = openEnvelope<HostToHub>(event.data);
    if (message) hub.receive(message);
  });
  send({ type: 'ready', ok: true });
}
