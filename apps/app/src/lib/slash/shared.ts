/**
 * What the slash command groups in this folder share. They reach the app through `SlashEnv`
 * only: `host.svelte.ts` backs it with the stores, the tests with plain objects.
 */
import type { ChatMessage } from '@tm/formats';
import { SlashClosure, type SlashCommand, type VariableHost } from '@tm/st-compat';
import type { ScriptInject } from '../helper/injects.svelte';
import type { PopupRequest, PopupResult } from '../popup.svelte';

export type Obj = Record<string, unknown>;
export type AddCommand = (names: string[], command: SlashCommand) => void;

export interface SlashCharacter {
  avatar: string;
  name: string;
}

export interface SlashEnv {
  /** The data root; throws while the app has none */
  root(): string;
  /** settings.json as a plain object; read only, changes go through the two calls below */
  settings(): Obj;
  /** Change settings in place; the file is written a moment later */
  mutateSettings(change: (settings: Obj) => void): void;
  /** Replace settings.json and write it now */
  saveSettings(next: Obj): Promise<void>;

  /** File name of the open chat without `.jsonl`, or null */
  chatName(): string | null;
  /** Plain copy; read only */
  chatMetadata(): Obj;
  setChatMetadata(patch: Obj): Promise<void>;
  messages(): readonly ChatMessage[];
  spliceMessages(start: number, deleteCount: number, messages: readonly ChatMessage[]): void;
  userName(): string;

  characters(): readonly SlashCharacter[];
  /** The open character, or the members of the open group */
  currentAvatars(): readonly string[];
  inGroup(): boolean;
  /** A character's primary lorebook (`data.extensions.world`), '' for none */
  characterWorld(avatar: string): Promise<string>;
  setCharacterWorld(avatar: string, world: string): Promise<void>;

  /** ST macros in a text */
  substitute(text: string): string;
  /** A passing note for the user; nothing happens when there is nowhere to show it */
  warn(message: string): void;
  ask(request: PopupRequest): Promise<PopupResult>;
  variables: VariableHost;
  injects: InjectTable;
}

/** `scriptInjects` and its two name tables (helper/injects.svelte.ts) */
export interface InjectTable {
  set(injects: readonly ScriptInject[]): void;
  remove(ids: readonly string[]): void;
  clear(): void;
  list(): ScriptInject[];
  /** role name → `EXTENSION_PROMPT_ROLES`, system when unknown */
  role(name: unknown): number;
  /** position name → `EXTENSION_PROMPT_TYPES`, undefined when unknown */
  position(name: unknown): number | undefined;
}

export const text = (value: unknown): string =>
  value instanceof SlashClosure ? '' : String(value ?? '');

export const record = (value: unknown): Obj | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined;

/** settings.json `tags`: `{ id, name }` rows */
export const tagList = (settings: Obj): Obj[] =>
  Array.isArray(settings['tags']) ? (settings['tags'] as Obj[]) : [];

/** ST `getCharaFilename`: the avatar file without its extension, the key of per-character settings */
export const fileStem = (avatar: string): string => avatar.replace(/\.[^/.]+$/, '');

/** ST `stringToRange`: `3` or `2-5`, both ends inside `[min, max]` */
export function parseRange(
  input: string,
  min: number,
  max: number,
): { start: number; end: number } | null {
  if (input === '') return null;
  const [first, second] = input.includes('-') ? input.split('-') : [input, input];
  const start = first ? parseInt(first, 10) : NaN;
  const end = second ? parseInt(second, 10) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return start > end || start < min || end > max ? null : { start, end };
}
