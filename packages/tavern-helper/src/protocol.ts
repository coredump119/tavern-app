/**
 * Wire protocol between the app and the TavernHelper realm (DEV_NOTES §9.5). Every message is a
 * plain structured-cloneable object wrapped in `{ tm: 'th', v: 1 }`. The app never trusts a field
 * it did not validate; the realm never receives anything but the open chat's own data.
 */
import type { ScriptPatch, ScriptScope, ScriptTrees } from './scripts.js';

export const TH_TAG = 'th';
export const TH_VERSION = 1;
/** `window.name` of the hub iframe; slots reach it through `parent.frames[HUB_FRAME_NAME]` */
export const HUB_FRAME_NAME = 'tm-th-hub';
/** Sandbox for every realm iframe: scripts and forms, no top navigation, no popups, no downloads */
export const REALM_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals';

/** One chat line as stored in the `.jsonl` (ST message shape); only the fields the bridge reads */
export interface RawMessage {
  name: string;
  is_user: boolean;
  is_system?: boolean | undefined;
  mes: string;
  send_date?: unknown;
  swipe_id?: number | undefined;
  swipes?: string[] | undefined;
  swipe_info?: unknown[] | undefined;
  /** TavernHelper message variables: one object per swipe */
  variables?: unknown;
  extra?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

export type Variables = Record<string, unknown>;
/** Variable scopes that live outside messages */
/** Variable tables the app stores and the realm mirrors whole; `character` and `preset` since round 3 */
export type VariableScope = 'chat' | 'global' | 'character' | 'preset';
export const VARIABLE_SCOPES: readonly VariableScope[] = ['chat', 'global', 'character', 'preset'];

/**
 * Curated snapshots of app state the realm answers synchronous reads from (round 3). Each part is
 * built field by field in the app: connection addresses, proxy passwords and keys are never in one.
 */
export type CatalogPart =
  | 'session'
  | 'character'
  | 'characters'
  | 'worlds'
  | 'presets'
  | 'regex'
  | 'personas'
  | 'extensions'
  | 'format'
  | 'macro'
  | 'page';
export const CATALOG_PARTS: readonly CatalogPart[] = [
  'session',
  'character',
  'characters',
  'worlds',
  'presets',
  'regex',
  'personas',
  'extensions',
  'format',
  'macro',
  'page',
];

/** Stamped on every element of a message's HTML the hub sends to the app, to find it again on an event */
export const NODE_ATTRIBUTE = 'data-tm-node';

/** What happened to an element a script put into a message (the stand-in page, round 3) */
export interface PageDomEvent {
  /** 楼层 */
  index: number;
  /** which element under `.mes_text`, in document order (the `data-tm-node` the hub stamped) */
  node: number;
  event: 'click' | 'input' | 'change';
  /** what the field holds now, for `input` and `change` */
  value?: string;
}

export interface Names {
  user: string;
  char: string;
}

export interface ChatSplice {
  start: number;
  deleteCount: number;
  messages: RawMessage[];
}

/** Fields a script may set on a message; anything else in a patch is dropped by the host */
export type MessagePatch = Partial<
  Pick<
    RawMessage,
    'name' | 'is_user' | 'is_system' | 'mes' | 'swipe_id' | 'swipes' | 'swipe_info' | 'variables'
  >
> & { extra?: Record<string, unknown> };

/** Addressed by 楼层: checked against `rev`, answered at once with the resulting splice */
export type HubChatRequest =
  | { method: 'chat.set'; params: { updates: { index: number; patch: MessagePatch }[] } }
  | { method: 'chat.insert'; params: { index: number; messages: MessagePatch[] } }
  | { method: 'chat.delete'; params: { indices: number[] } }
  | { method: 'chat.vars'; params: { index: number; variables: unknown } };

export type GenerateKind = 'generate' | 'raw';

/** Not addressed by 楼层: no `rev` check, answered when the host is done (round 2) */
export type HubAsyncRequest =
  | { method: 'slash.run'; params: { command: string } }
  | {
      method: 'generate.start';
      /** `from`: the frame that asked (`TH-message--…` / `TH-script--…`), shown when the app must ask the user */
      params: {
        kind: GenerateKind;
        generationId: string;
        config: Record<string, unknown>;
        from?: string;
      };
    }
  | { method: 'generate.stop'; params: { generationId: string | null } }
  | { method: 'script.patch'; params: { scope: ScriptScope; id: string; patch: ScriptPatch } }
  | { method: 'scripts.set'; params: { scope: ScriptScope; trees: unknown } }
  /** a function from the app's whitelist (round 3); unknown names are rejected */
  | { method: 'call'; params: { name: string; args: unknown[]; from?: string } };

export type HubRequest = HubChatRequest | HubAsyncRequest;

/** The script library as the realm sees it; `running` lists the ids that get an iframe */
export interface ScriptsState {
  /** chat key: a different one reloads every script iframe */
  epoch: string;
  trees: ScriptTrees;
  running: string[];
}

export type HostToHub =
  | {
      type: 'init';
      rev: number;
      /** another chat was opened (as opposed to a resync of the same one): fires `chat_id_changed` */
      switched: boolean;
      chatId: string | null;
      chat: RawMessage[];
      chatVariables: Variables;
      globalVariables: Variables;
      names: Names;
    }
  /** a change made by the app; the hub derives the matching ST events from it */
  | { type: 'chat.splice'; rev: number; splice: ChatSplice }
  | { type: 'vars'; scope: VariableScope; value: Variables }
  | { type: 'catalog'; part: CatalogPart; value: unknown }
  /** the app asks the realm something only scripts know (inject filters, macro-likes) */
  | { type: 'query'; id: number; name: string; args: unknown[] }
  | ({ type: 'dom.event' } & PageDomEvent)
  | { type: 'names'; names: Names }
  | { type: 'event'; name: string; args: unknown[] }
  /** `splice`: what the request changed, applied to the mirror without events */
  | { type: 'reply'; id: number; ok: true; splice: ChatSplice | null; result?: unknown }
  | ({ type: 'scripts' } & ScriptsState)
  | { type: 'reply'; id: number; ok: false; error: string };

export type HubToHost =
  | { type: 'ready'; ok: boolean; reason?: string }
  | { type: 'vars.set'; scope: VariableScope; value: Variables }
  | { type: 'query.reply'; id: number; value: unknown }
  | ({ type: 'request'; id: number; rev: number } & HubRequest);

export interface SlotContent {
  /** `TH-message--<楼层>--<序号>` */
  name: string;
  html: string;
  viewportHeight: number;
  avatars: { user: string | null; char: string | null };
}

export type HostToSlot =
  ({ type: 'slot.content' } & SlotContent) | { type: 'viewport'; height: number };

export type SlotToHost = { type: 'slot.ready' } | { type: 'slot.height'; height: number };

export type Envelope<T> = T & { tm: typeof TH_TAG; v: typeof TH_VERSION };

export function envelope<T extends { type: string }>(message: T): Envelope<T> {
  return { ...message, tm: TH_TAG, v: TH_VERSION };
}

/** The message when `data` is one of ours, else null. Field-level checks are the receiver's job. */
export function openEnvelope<T extends { type: string }>(data: unknown): T | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d['tm'] !== TH_TAG || d['v'] !== TH_VERSION || typeof d['type'] !== 'string') return null;
  return data as T;
}
