/**
 * App side of the TavernHelper bridge (DEV_NOTES §9.5): keeps the realm's mirror of the open chat
 * in sync, validates and applies what scripts ask for, and feeds content to the slot iframes.
 * No DOM, no Svelte, no IPC: the app injects those as {@link HostCapabilities}.
 */
import {
  envelope,
  openEnvelope,
  type ChatSplice,
  type GenerateKind,
  type HostToHub,
  type HostToSlot,
  type HubAsyncRequest,
  type HubChatRequest,
  type HubToHost,
  type CatalogPart,
  type MessagePatch,
  type PageDomEvent,
  type Names,
  type RawMessage,
  type ScriptsState,
  type SlotContent,
  type SlotToHost,
  type VariableScope,
  type Variables,
  VARIABLE_SCOPES,
} from './protocol.js';
import {
  guardScriptTrees,
  normalizeScriptTrees,
  patchScript,
  sanitizeScriptPatch,
  SCRIPT_SCOPES,
  type ScriptScope,
  type ScriptTree,
} from './scripts.js';

/** Anything `postMessage` can be called on: a `Window` in the app, a fake in tests */
export interface Port {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** What a running script generation reports back while it is in flight */
export interface GenerateEvents {
  start(): void;
  text(full: string, delta: string): void;
}

export interface HostCapabilities {
  /** Apply a splice to the open chat and persist it; returns the chat's new message array */
  spliceChat(splice: ChatSplice): readonly RawMessage[];
  setVariables(scope: VariableScope, value: Variables): void;
  /** `send_date` for a message a script creates */
  timestamp(): string;
  /** Run a slash command line; resolves with the last pipe value */
  runSlash(command: string): Promise<unknown>;
  /**
   * A generation a script asked for; nothing is written to the chat. `on.start` is called once the
   * request passed validation and is about to be sent; `on.text` gets the whole text so far and
   * what was added since the last call. Resolves with what the script receives.
   */
  generate(
    kind: GenerateKind,
    config: Record<string, unknown>,
    generationId: string,
    on: GenerateEvents,
    /** name of the frame that asked, for when the app has to ask the user (`custom_api`) */
    from: string,
  ): Promise<unknown>;
  /** `null` stops every script generation */
  stopGeneration(generationId: string | null): void;
  /** Persist one scope of the script library */
  setScriptTrees(scope: ScriptScope, trees: ScriptTree[]): void;
  /** Id for a script that arrives without one */
  newId(): string;
  /** A function from the app's whitelist, by name (round 3). Rejects for an unknown name. */
  call(name: string, args: unknown[], from: string): Promise<unknown>;
}

/** `unsupported`: the realm reported it cannot be isolated on this WebView; nothing is rendered */
export type HostStatus = 'idle' | 'loading' | 'ready' | 'unsupported';

type SlotInput = Omit<SlotContent, 'viewportHeight'>;
interface Slot {
  content: SlotInput;
  onHeight: (height: number) => void;
  /** the slot page has loaded and asked for its content */
  waiting: boolean;
}

/** Taller than any real card; a script cannot push the chat row to an absurd height */
const MAX_SLOT_HEIGHT = 20_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isScope = (v: unknown): v is ScriptScope => SCRIPT_SCOPES.includes(v as ScriptScope);
const ASYNC_METHODS: ReadonlySet<string> = new Set<HubAsyncRequest['method']>([
  'slash.run',
  'generate.start',
  'generate.stop',
  'script.patch',
  'scripts.set',
  'call',
]);
/** how long the app waits for the realm to answer a {@link HostController.query} */
const QUERY_TIMEOUT = 2000;
/** `js_generation_*` iframe events, same names and argument order as upstream */
const GENERATION_EVENTS = {
  started: 'js_generation_started',
  full: 'js_stream_token_received_fully',
  delta: 'js_stream_token_received_incrementally',
  ended: 'js_generation_ended',
} as const;

const PATCH_CHECKS: { [K in keyof Required<MessagePatch>]: (v: unknown) => boolean } = {
  name: isString,
  mes: isString,
  is_user: isBoolean,
  is_system: isBoolean,
  swipe_id: (v) => Number.isInteger(v) && (v as number) >= 0,
  swipes: (v) => Array.isArray(v) && v.every(isString),
  swipe_info: Array.isArray,
  variables: (v) => typeof v === 'object' && v !== null,
  extra: isRecord,
};
const PATCH_KEYS = Object.keys(PATCH_CHECKS) as (keyof MessagePatch)[];

/** Keep only the known fields of a script-supplied message, type-checked. Throws on a bad field. */
export function sanitizePatch(input: unknown): MessagePatch {
  if (!isRecord(input)) throw new Error('message must be an object');
  const out: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (!PATCH_CHECKS[key](value)) throw new Error(`invalid message field: ${key}`);
    out[key] = value;
  }
  return out as MessagePatch;
}

function assertSwipes(message: RawMessage): void {
  if (message.swipes && (message.swipe_id ?? 0) >= message.swipes.length) {
    throw new Error('swipe_id out of range');
  }
}

/** The smallest splice turning `prev` into `next`, comparing messages by reference. */
export function diffByReference(
  prev: readonly RawMessage[],
  next: readonly RawMessage[],
): ChatSplice | null {
  const max = Math.min(prev.length, next.length);
  let head = 0;
  while (head < max && prev[head] === next[head]) head++;
  let tail = 0;
  while (tail < max - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const deleteCount = prev.length - head - tail;
  const messages = next.slice(head, next.length - tail);
  if (deleteCount === 0 && messages.length === 0) return null;
  return { start: head, deleteCount, messages };
}

function post(port: Port, message: unknown, origin: string): void {
  try {
    port.postMessage(message, origin);
  } catch {
    // a reactive proxy or other uncloneable value slipped in: send the JSON view of it
    port.postMessage(JSON.parse(JSON.stringify(message)), origin);
  }
}

export class HostController {
  status: HostStatus = 'idle';
  /** why the realm is `unsupported` */
  reason: string | null = null;

  private hub: Port | null = null;
  /** bumped for every chat state the app pushes; requests built on an older one are rejected */
  private rev = 0;
  private chatKey: string | null = null;
  private chatId: string | null = null;
  private messages: readonly RawMessage[] = [];
  private names: Names = { user: '', char: '' };
  private readonly variables: Record<VariableScope, Variables> = {
    chat: {},
    global: {},
    character: {},
    preset: {},
  };
  /** JSON of what the realm last had per scope, so an echo of its own write is not sent back */
  private readonly variablesJson: Record<VariableScope, string> = {
    chat: '{}',
    global: '{}',
    character: '{}',
    preset: '{}',
  };
  /** what the realm has of each catalog part, with its JSON for the change check */
  private readonly catalog = new Map<CatalogPart, { value: unknown; json: string }>();
  private nextQuery = 1;
  private readonly queries = new Map<number, (value: unknown) => void>();
  private scripts: ScriptsState | null = null;
  /** JSON of the script library the realm has, for the same echo suppression as variables */
  private scriptsJson = '';
  private readonly slots = new Map<Port, Slot>();
  private viewportHeight = 0;

  /** @param origin the realm's origin: target of every message sent, never `*` */
  constructor(
    private readonly origin: string,
    private readonly caps: HostCapabilities,
    private readonly onStatus: (status: HostStatus) => void = () => {},
  ) {}

  attachHub(port: Port): void {
    this.hub = port;
    this.setStatus('loading');
  }

  /**
   * Tell the realm about the open chat. Cheap when nothing changed: one reference compare.
   * @param key identifies the chat file: another key is another chat
   * @param chatId what scripts read as the chat id (ST: the file name without `.jsonl`, which
   *   two characters may share)
   */
  syncChat(key: string | null, messages: readonly RawMessage[], chatId: string | null = key): void {
    const prev = this.messages;
    const sameChat = key === this.chatKey;
    this.chatKey = key;
    this.chatId = chatId;
    this.messages = messages;
    if (this.status !== 'ready') return;
    if (!sameChat) {
      this.sendInit(true);
      return;
    }
    const splice = diffByReference(prev, messages);
    if (splice) this.toHub({ type: 'chat.splice', rev: ++this.rev, splice });
  }

  syncVariables(scope: VariableScope, value: Variables): void {
    const json = JSON.stringify(value);
    if (json === this.variablesJson[scope]) return;
    this.variables[scope] = value;
    this.variablesJson[scope] = json;
    if (this.status === 'ready') this.toHub({ type: 'vars', scope, value });
  }

  /** The script library and which scripts should run. Cheap to call again with the same state. */
  syncScripts(state: ScriptsState): void {
    const json = JSON.stringify(state);
    if (json === this.scriptsJson) return;
    this.scripts = state;
    this.scriptsJson = json;
    if (this.status === 'ready') this.toHub({ type: 'scripts', ...state });
  }

  /** One part of the catalog. Cheap to call again with an equal value: nothing is sent. */
  syncCatalog(part: CatalogPart, value: unknown): void {
    const json = JSON.stringify(value) ?? 'null';
    if (json === this.catalog.get(part)?.json) return;
    this.catalog.set(part, { value, json });
    if (this.status === 'ready') this.toHub({ type: 'catalog', part, value });
  }

  /**
   * Ask the realm something only scripts know. Resolves to `undefined` when the realm is not
   * running or does not answer in time: a stuck script must not hold up a reply.
   */
  query(name: string, args: unknown[], timeoutMs = QUERY_TIMEOUT): Promise<unknown> {
    if (this.status !== 'ready') return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const id = this.nextQuery++;
      const timer = setTimeout(() => {
        this.queries.delete(id);
        resolve(undefined);
      }, timeoutMs);
      this.queries.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.toHub({ type: 'query', id, name, args });
    });
  }

  /** Something happened to an element a script put into a message */
  domEvent(event: PageDomEvent): void {
    if (this.status === 'ready') this.toHub({ type: 'dom.event', ...event });
  }

  syncNames(names: Names): void {
    if (names.user === this.names.user && names.char === this.names.char) return;
    this.names = names;
    if (this.status === 'ready') this.toHub({ type: 'names', names });
  }

  /** Forward an app event (ST event name) to script listeners. */
  emit(name: string, ...args: unknown[]): void {
    if (this.status === 'ready') this.toHub({ type: 'event', name, args });
  }

  setViewport(height: number): void {
    if (height === this.viewportHeight) return;
    this.viewportHeight = height;
    for (const port of this.slots.keys()) this.toSlot(port, { type: 'viewport', height });
  }

  /** Register a slot iframe; its content is sent once both it and the hub are ready. */
  attachSlot(port: Port, content: SlotInput, onHeight: (height: number) => void): () => void {
    this.slots.set(port, { content, onHeight, waiting: false });
    return () => void this.slots.delete(port);
  }

  /** Route a `message` event. `source` must be a window this controller created. */
  handleMessage(source: unknown, data: unknown): void {
    if (source === null || typeof source !== 'object') return;
    if (source === this.hub) {
      const message = openEnvelope<HubToHost>(data);
      if (message) this.fromHub(message);
      return;
    }
    const slot = this.slots.get(source as Port);
    if (!slot) return;
    const message = openEnvelope<SlotToHost>(data);
    if (!message) return;
    if (message.type === 'slot.ready') {
      slot.waiting = true;
      if (this.status === 'ready') this.fillSlot(source as Port, slot);
    } else if (message.type === 'slot.height') {
      const height = Number(message.height);
      if (Number.isFinite(height) && height >= 0) slot.onHeight(Math.min(height, MAX_SLOT_HEIGHT));
    }
  }

  private setStatus(status: HostStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.onStatus(status);
  }

  private toHub(message: HostToHub): void {
    if (this.hub) post(this.hub, envelope(message), this.origin);
  }

  private toSlot(port: Port, message: HostToSlot): void {
    post(port, envelope(message), this.origin);
  }

  private fillSlot(port: Port, slot: Slot): void {
    slot.waiting = false;
    this.toSlot(port, {
      type: 'slot.content',
      ...slot.content,
      viewportHeight: this.viewportHeight,
    });
  }

  private sendInit(switched = false): void {
    this.toHub({
      type: 'init',
      rev: ++this.rev,
      switched,
      chatId: this.chatId,
      chat: this.messages as RawMessage[],
      chatVariables: this.variables.chat,
      globalVariables: this.variables.global,
      names: this.names,
    });
  }

  private fromHub(message: HubToHost): void {
    switch (message.type) {
      case 'ready':
        if (message.ok !== true) {
          this.reason = isString(message.reason) ? message.reason : 'unknown';
          this.setStatus('unsupported');
          return;
        }
        this.setStatus('ready');
        // everything a script may read synchronously is there before the first chat state
        for (const scope of VARIABLE_SCOPES)
          if (scope !== 'chat' && scope !== 'global')
            this.toHub({ type: 'vars', scope, value: this.variables[scope] });
        for (const [part, { value }] of this.catalog) this.toHub({ type: 'catalog', part, value });
        this.sendInit();
        if (this.scripts) this.toHub({ type: 'scripts', ...this.scripts });
        for (const [port, slot] of this.slots) if (slot.waiting) this.fillSlot(port, slot);
        return;
      case 'vars.set': {
        if (this.status !== 'ready') return;
        const { scope, value } = message;
        if (!VARIABLE_SCOPES.includes(scope) || !isRecord(value)) return;
        this.variables[scope] = value;
        this.variablesJson[scope] = JSON.stringify(value);
        this.caps.setVariables(scope, value);
        return;
      }
      case 'query.reply': {
        const answer = this.queries.get(Number(message.id));
        if (!answer) return;
        this.queries.delete(Number(message.id));
        answer(message.value);
        return;
      }
      case 'request':
        if (this.status === 'ready') this.handleRequest(message);
        return;
    }
  }

  private handleRequest(request: Extract<HubToHost, { type: 'request' }>): void {
    const id = Number(request.id);
    if (!Number.isInteger(id)) return;
    if (ASYNC_METHODS.has(request.method)) {
      this.handleAsync(request as HubAsyncRequest).then(
        (result) => this.toHub({ type: 'reply', id, ok: true, splice: null, result }),
        (e: unknown) =>
          this.toHub({
            type: 'reply',
            id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          }),
      );
      return;
    }
    if (request.rev !== this.rev) {
      // the script worked from a chat the app has since changed: refuse, then resend the truth
      this.toHub({ type: 'reply', id, ok: false, error: 'chat changed, retry' });
      this.sendInit();
      return;
    }
    try {
      this.toHub({ type: 'reply', id, ok: true, splice: this.apply(request as HubChatRequest) });
    } catch (e) {
      this.toHub({
        type: 'reply',
        id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Requests that take time or do not touch 楼层 numbers; a rejection becomes the error reply */
  private async handleAsync(request: HubAsyncRequest): Promise<unknown> {
    const params: Record<string, unknown> = isRecord(request.params) ? request.params : {};
    switch (request.method) {
      case 'slash.run': {
        if (!isString(params['command'])) throw new Error('slash 命令必须是字符串');
        return this.caps.runSlash(params['command']);
      }
      case 'generate.start': {
        const { kind, generationId, config } = params;
        if ((kind !== 'generate' && kind !== 'raw') || !isString(generationId) || !isRecord(config))
          throw new Error('生成请求格式不对');
        const events: GenerateEvents = {
          start: () => this.emit(GENERATION_EVENTS.started, generationId),
          text: (full, delta) => {
            this.emit(GENERATION_EVENTS.full, full, generationId);
            this.emit(GENERATION_EVENTS.delta, delta, generationId);
          },
        };
        const from = isString(params['from']) ? params['from'] : '';
        const result = await this.caps.generate(kind, config, generationId, events, from);
        const text = isRecord(result) ? result['content'] : result;
        this.emit(GENERATION_EVENTS.ended, text, generationId);
        return result;
      }
      case 'generate.stop': {
        const id = params['generationId'];
        this.caps.stopGeneration(isString(id) ? id : null);
        return undefined;
      }
      case 'script.patch': {
        const { scope, id } = params;
        if (!isScope(scope) || !isString(id) || !this.scripts) throw new Error('脚本不存在');
        const trees = patchScript(
          this.scripts.trees[scope],
          id,
          sanitizeScriptPatch(params['patch']),
        );
        if (trees === this.scripts.trees[scope]) throw new Error('脚本不存在');
        // the realm already applied this to its copy: remember it so the app's echo is not sent back
        this.scripts = { ...this.scripts, trees: { ...this.scripts.trees, [scope]: trees } };
        this.scriptsJson = JSON.stringify(this.scripts);
        this.caps.setScriptTrees(scope, trees);
        return undefined;
      }
      case 'call': {
        const { name, args } = params;
        if (!isString(name) || !Array.isArray(args)) throw new Error('调用格式不对');
        return this.caps.call(
          name,
          args as unknown[],
          isString(params['from']) ? params['from'] : '',
        );
      }
      case 'scripts.set': {
        const scope = params['scope'];
        if (!isScope(scope) || !this.scripts) throw new Error('脚本库还没有就绪');
        const next = normalizeScriptTrees(params['trees'], () => this.caps.newId());
        // the app's update comes back through syncScripts and reaches the realm from there
        this.caps.setScriptTrees(scope, guardScriptTrees(next, this.scripts.trees[scope]));
        return undefined;
      }
    }
  }

  private index(value: unknown, max: number): number {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) {
      throw new Error(`message index out of range: ${String(value)}`);
    }
    return value as number;
  }

  /** Validate a request against the current chat and apply it as one contiguous splice. */
  private apply(request: HubChatRequest): ChatSplice | null {
    const chat = this.messages;
    const params: unknown = request.params;
    if (!isRecord(params)) throw new Error('invalid request');
    switch (request.method) {
      case 'chat.set': {
        const updates = params['updates'];
        if (!Array.isArray(updates) || updates.length === 0) return null;
        const next = new Map<number, RawMessage>();
        for (const update of updates as unknown[]) {
          if (!isRecord(update)) throw new Error('invalid request');
          const at = this.index(update['index'], chat.length - 1);
          const merged = { ...(next.get(at) ?? chat[at]!), ...sanitizePatch(update['patch']) };
          assertSwipes(merged);
          next.set(at, merged);
        }
        const start = Math.min(...next.keys());
        const end = Math.max(...next.keys());
        const messages = chat.slice(start, end + 1).map((m, i) => next.get(start + i) ?? m);
        return this.commit({ start, deleteCount: messages.length, messages });
      }
      case 'chat.insert': {
        const list = params['messages'];
        if (!Array.isArray(list) || list.length === 0) return null;
        const start = this.index(params['index'], chat.length);
        const send_date = this.caps.timestamp();
        const messages = (list as unknown[]).map((item): RawMessage => {
          const patch = sanitizePatch(item);
          if (patch.name === undefined || patch.mes === undefined || patch.is_user === undefined) {
            throw new Error('a new message needs name, mes and is_user');
          }
          const message = { is_system: false, send_date, extra: {}, ...patch } as RawMessage;
          assertSwipes(message);
          return message;
        });
        return this.commit({ start, deleteCount: 0, messages });
      }
      case 'chat.delete': {
        const list = params['indices'];
        if (!Array.isArray(list) || list.length === 0) return null;
        const gone = new Set((list as unknown[]).map((v) => this.index(v, chat.length - 1)));
        const start = Math.min(...gone);
        const end = Math.max(...gone);
        const messages = chat.slice(start, end + 1).filter((_, i) => !gone.has(start + i));
        return this.commit({ start, deleteCount: end - start + 1, messages });
      }
      case 'chat.vars': {
        const at = this.index(params['index'], chat.length - 1);
        const { variables } = sanitizePatch({ variables: params['variables'] });
        // the hub already holds this value (message variables are written synchronously there)
        this.commit({ start: at, deleteCount: 1, messages: [{ ...chat[at]!, variables }] });
        return null;
      }
      default:
        throw new Error('unknown method');
    }
  }

  /** @returns the splice as the app stored it (it may normalise the messages it is given) */
  private commit(splice: ChatSplice): ChatSplice {
    // adopting the returned array as the baseline keeps `syncChat` from echoing this change
    const next = this.caps.spliceChat(splice);
    this.messages = next;
    const end = splice.start + splice.messages.length;
    return { ...splice, messages: next.slice(splice.start, end) as RawMessage[] };
  }
}
