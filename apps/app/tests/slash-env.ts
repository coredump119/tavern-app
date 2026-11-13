/** A `SlashEnv` made of plain objects, and a runner over the command groups under test. */
import type { ChatMessage } from '@tm/formats';
import { coreCommands, SlashRunner, type SlashCommand, type VariableKind } from '@tm/st-compat';
import type { ScriptInject } from '../src/lib/helper/injects.svelte';
import type { PopupRequest, PopupResult } from '../src/lib/popup.svelte';
import type { AddCommand, Obj, SlashCharacter, SlashEnv } from '../src/lib/slash/shared';

export interface FakeEnv extends SlashEnv {
  state: {
    settings: Obj;
    /** `saveSettings` calls, as opposed to in-place changes */
    saved: number;
    chat: string | null;
    metadata: Obj;
    messages: ChatMessage[];
    userName: string;
    characters: SlashCharacter[];
    current: string[];
    group: boolean;
    /** avatar → primary lorebook */
    worlds: Record<string, string>;
    notes: string[];
    asked: PopupRequest[];
    /** answers for the dialogs to come, in order; null once they run out */
    answers: PopupResult[];
    injects: Map<string, ScriptInject>;
    variables: Record<VariableKind, Obj>;
  };
}

const ROLES: Record<string, number> = { system: 0, user: 1, assistant: 2 };
const POSITIONS: Record<string, number> = { before: 2, after: 0, chat: 1, none: -1 };

export function fakeEnv(initial: Partial<FakeEnv['state']> = {}): FakeEnv {
  const state: FakeEnv['state'] = {
    settings: {},
    saved: 0,
    chat: 'Ada - 2026-01-02@03h04m05s',
    metadata: {},
    messages: [],
    userName: 'User',
    characters: [],
    current: [],
    group: false,
    worlds: {},
    notes: [],
    asked: [],
    answers: [],
    injects: new Map(),
    variables: { local: {}, global: {} },
    ...initial,
  };
  return {
    state,
    root: () => '/data',
    settings: () => state.settings,
    mutateSettings: (change) => change(state.settings),
    saveSettings: async (next) => {
      state.settings = next;
      state.saved++;
    },
    chatName: () => state.chat,
    chatMetadata: () => state.metadata,
    setChatMetadata: async (patch) => {
      state.metadata = { ...state.metadata, ...patch };
    },
    messages: () => state.messages,
    spliceMessages: (start, deleteCount, messages) => {
      state.messages = state.messages.slice();
      state.messages.splice(start, deleteCount, ...messages);
    },
    userName: () => state.userName,
    characters: () => state.characters,
    currentAvatars: () => state.current,
    inGroup: () => state.group,
    characterWorld: async (avatar) => state.worlds[avatar] ?? '',
    setCharacterWorld: async (avatar, world) => {
      state.worlds[avatar] = world;
    },
    substitute: (text) => text.replaceAll('{{user}}', state.userName),
    warn: (message) => {
      state.notes.push(message);
    },
    ask: async (request) => {
      state.asked.push(request);
      return state.answers.shift() ?? null;
    },
    variables: {
      get: (kind, name) => state.variables[kind][name],
      set: (kind, name, value) => {
        state.variables[kind][name] = value;
      },
      delete: (kind, name) => {
        delete state.variables[kind][name];
      },
    },
    injects: {
      set: (injects) => {
        for (const inject of injects) state.injects.set(inject.id, inject);
      },
      remove: (ids) => {
        for (const id of ids) state.injects.delete(id);
      },
      clear: () => state.injects.clear(),
      list: () => [...state.injects.values()],
      role: (name) => ROLES[String(name).toLowerCase()] ?? 0,
      position: (name) => POSITIONS[String(name).toLowerCase()],
    },
  };
}

/** Run slash text over the core commands plus the given groups; resolves to the pipe */
export function slashRunner(
  env: FakeEnv,
  ...groups: Array<(add: AddCommand, env: FakeEnv) => void>
): (text: string) => Promise<unknown> {
  const commands = coreCommands({ variables: env.variables });
  const add = (names: string[], command: SlashCommand) => {
    for (const name of names) commands.set(name, command);
  };
  for (const group of groups) group(add, env);
  const runner = new SlashRunner(commands, env.substitute);
  return async (text) => (await runner.run(text)).pipe;
}
