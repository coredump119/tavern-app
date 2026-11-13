/**
 * Prompt injections owned by scripts (`injectPrompts`) and by `/inject` (DEV_NOTES §9.5 第 3 轮).
 * They live in memory and belong to the chat that was open when they were set; every generation
 * over that chat carries them, the user's own included.
 */
import {
  EXTENSION_PROMPT_ROLES,
  EXTENSION_PROMPT_TYPES,
  setExtensionPrompt,
  type ExtensionPrompts,
} from '@tm/core';
import { chatStore } from '../chat/store.svelte';

export interface ScriptInject {
  id: string;
  /** `EXTENSION_PROMPT_TYPES` */
  position: number;
  depth: number;
  /** `EXTENSION_PROMPT_ROLES` */
  role: number;
  content: string;
  /** takes part in the World Info scan */
  scan: boolean;
  /** dropped after the next generation */
  once: boolean;
  /** the script gave a `filter` function: asked in the realm before each generation */
  filtered: boolean;
}

/** ST `/inject` keys its prompts the same way */
const KEY_PREFIX = 'script_inject_';

const ROLES: Readonly<Record<string, number>> = {
  system: EXTENSION_PROMPT_ROLES.SYSTEM,
  user: EXTENSION_PROMPT_ROLES.USER,
  assistant: EXTENSION_PROMPT_ROLES.ASSISTANT,
};
const POSITIONS: Readonly<Record<string, number>> = {
  before: EXTENSION_PROMPT_TYPES.BEFORE_PROMPT,
  after: EXTENSION_PROMPT_TYPES.IN_PROMPT,
  chat: EXTENSION_PROMPT_TYPES.IN_CHAT,
  in_chat: EXTENSION_PROMPT_TYPES.IN_CHAT,
  none: EXTENSION_PROMPT_TYPES.NONE,
};

/** Role name → `EXTENSION_PROMPT_ROLES`; system for anything else */
export const injectRole = (name: unknown): number =>
  ROLES[String(name).toLowerCase()] ?? EXTENSION_PROMPT_ROLES.SYSTEM;

/** `/inject position=` or TavernHelper `position` → `EXTENSION_PROMPT_TYPES`; undefined when unknown */
export const injectPosition = (name: unknown): number | undefined =>
  POSITIONS[String(name).toLowerCase()];

class ScriptInjects {
  private chat: string | null = null;
  private readonly table = new Map<string, ScriptInject>();
  /** Set by the bridge: does the realm-side `filter` of this injection let it through? */
  ask: (id: string) => Promise<boolean> = () => Promise.resolve(true);

  /** The table of the open chat; switching chats empties it */
  private open(): Map<string, ScriptInject> {
    const chat = chatStore.chatRel;
    if (chat !== this.chat) {
      this.chat = chat;
      this.table.clear();
    }
    return this.table;
  }

  set(injects: readonly ScriptInject[]): void {
    const table = this.open();
    for (const inject of injects) table.set(inject.id, inject);
  }

  remove(ids: readonly string[]): void {
    const table = this.open();
    for (const id of ids) table.delete(id);
  }

  clear(): void {
    this.open().clear();
  }

  list(): ScriptInject[] {
    return [...this.open().values()];
  }

  /** Add the injections to an extension prompt table that is about to be used for one generation */
  addTo(prompts: ExtensionPrompts): void {
    for (const inject of this.open().values()) {
      setExtensionPrompt(
        prompts,
        KEY_PREFIX + inject.id,
        inject.content,
        inject.position,
        inject.depth,
        inject.scan,
        inject.role,
        inject.filtered ? () => this.ask(inject.id) : null,
      );
    }
  }

  /** A generation over the open chat has gone out: the one-shot injections are spent */
  spend(): string[] {
    const table = this.open();
    const spent: string[] = [];
    for (const inject of table.values()) {
      if (inject.once) spent.push(inject.id);
    }
    for (const id of spent) table.delete(id);
    return spent;
  }
}

export const scriptInjects = new ScriptInjects();
