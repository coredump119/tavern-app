/**
 * Slash commands for scripts (TavernHelper `triggerSlash`, DEV_NOTES §9.5 第 2 轮). The parser,
 * the runner and the commands that need nothing from the app come from `@tm/st-compat`; the
 * commands here are the ones that touch the open chat, plus the groups in the sibling files,
 * which reach the app through the `SlashEnv` built below. Behavior follows ST 1.18.0
 * (`slash-commands.js`, `power-user.js`).
 */
import { extractMessageBias, REGEX_PLACEMENT, removeMacros, trimToEndSentence } from '@tm/core';
import type { ChatMessage } from '@tm/formats';
import {
  coreCommands,
  isFalse,
  isTrue,
  SlashError,
  SlashRunner,
  type Named,
  type SlashCommand,
  type VariableHost,
  type VariableKind,
} from '@tm/st-compat';
import { chatPage, type ChatPageActions } from '../chat/page-actions';
import {
  buildUserMessage,
  createChatContext,
  type ChatContext,
  type GenType,
} from '../chat/pipeline';
import { extraMacroVersion } from '../chat/extra-macros';
import { plainChat } from '../chat/plain.svelte';
import { chatStore, messageTimeStamp } from '../chat/store.svelte';
import { quietGenerate, rawGenerate } from '../helper/generate.svelte';
import { injectPosition, injectRole, scriptInjects } from '../helper/injects.svelte';
import { cardRead } from '../ipc';
import { userForceAvatar } from '../personas';
import { askPopup } from '../popup.svelte';
import { relinkCharacters } from '../worlds';
import { characterCommands } from './characters';
import { withExtensionCommands } from './extra';
import { injectCommands } from './inject';
import { personaCommands } from './persona';
import { popupCommands } from './popup';
import { parseRange, record, text, type SlashEnv } from './shared';
import { worldCommands } from './world';

export interface SlashHostDeps {
  /** A tavern event for the scripts (`message_sent`…) */
  emit(name: string, ...args: unknown[]): void;
}

/** ST `system_avatar` / `comment_avatar`: kept in the file for ST, the app draws its own */
const NARRATOR_AVATAR = 'img/five.png';
const COMMENT_AVATAR = 'img/quill.png';
/** `/trigger` and friends wait this long for a running reply (ST waits the same) */
const BUSY_TIMEOUT = 10_000;
const BUSY_POLL = 100;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function variableStore(kind: VariableKind): Record<string, unknown> {
  if (kind === 'local') {
    if (!chatStore.chatPath) throw new SlashError('没有打开的聊天');
    return (chatStore.chatMetadata['variables'] as Record<string, unknown> | undefined) ?? {};
  }
  const extensions = chatStore.settings?.['extension_settings'] as
    { variables?: { global?: Record<string, unknown> } } | undefined;
  return extensions?.variables?.global ?? {};
}
function writeVariables(kind: VariableKind, next: Record<string, unknown>): void {
  if (kind === 'local') chatStore.setChatVariables(next);
  else chatStore.setGlobalVariables(next);
}
export const variables: VariableHost = {
  // one value, not the table: scripts read variables in loops
  get: (kind, name) => $state.snapshot(variableStore(kind)[name]),
  set: (kind, name, value) => writeVariables(kind, { ...variableStore(kind), [name]: value }),
  delete: (kind, name) => {
    const { [name]: _removed, ...rest } = variableStore(kind);
    writeVariables(kind, rest);
  },
};

// The macro / regex context of the open chat. Building one is not free, so it is made on first
// use and kept until something it was built from is replaced.
let cached: { key: readonly unknown[]; context: ChatContext } | null = null;
function context(): ChatContext {
  const { settings, character, group, members, chatMetadata } = plainChat;
  if (!settings || !(character || group)) throw new SlashError('没有打开的聊天');
  const key = [
    settings,
    character,
    group,
    members,
    chatMetadata,
    chatStore.messages,
    chatStore.userName,
    extraMacroVersion(),
  ];
  if (cached && cached.key.every((value, i) => value === key[i])) return cached.context;
  const built = createChatContext(
    settings,
    { character, group, members, memberIndex: null },
    chatStore.userName,
    chatStore.messages,
    // core adds `variables` to what it is given
    structuredClone(chatMetadata),
  );
  cached = { key, context: built };
  return built;
}
/** ST substituteParams for the open chat (macros in argument text); plain text never builds the context */
export const substitute = (value: string) =>
  value.includes('{{') ? context().substitute(value) : value;

/** ST's `at=`: an index, or a negative depth from the end; anything else appends */
function insertIndex(at: unknown): number {
  const length = chatStore.messages.length;
  let index = Number(at);
  if (Number.isNaN(index)) return length;
  if (index < 0 || Object.is(index, -0)) index += length;
  return index >= 0 && index <= length ? index : length;
}

/** The reply-page actions once no reply is being generated */
async function idlePage(): Promise<ChatPageActions> {
  const page = chatPage();
  for (let waited = 0; page.busy(); waited += BUSY_POLL) {
    if (waited >= BUSY_TIMEOUT) throw new SlashError('上一条回复还在生成');
    await sleep(BUSY_POLL);
  }
  return page;
}

function dataRoot(): string {
  if (!chatStore.root) throw new SlashError('数据目录还没有准备好');
  return chatStore.root;
}

/** One line for the user, when the chat page is there to show it */
function notify(message: string): void {
  try {
    chatPage().notify(message);
  } catch {
    // nowhere to show it while the chat page is off screen
  }
}

/** The card as the app holds it when the character is on screen, else as its file has it */
async function characterWorld(avatar: string): Promise<string> {
  const loaded = [chatStore.character, ...chatStore.members].find((c) => c?.avatar === avatar);
  const card = loaded
    ? $state.snapshot(loaded)
    : record(JSON.parse(await cardRead(`${dataRoot()}/characters/${avatar}`)));
  const world = record(record(card?.['data'])?.['extensions'])?.['world'];
  return typeof world === 'string' ? world : '';
}
async function setCharacterWorld(avatar: string, world: string): Promise<void> {
  if (chatStore.character?.avatar === avatar) chatStore.setCardExtension('world', world);
  else await relinkCharacters(dataRoot(), [avatar], world);
}

/** What the command groups in the sibling files see of the app */
const env: SlashEnv = {
  root: dataRoot,
  settings: () => plainChat.settings ?? {},
  mutateSettings: (change) => chatStore.mutateSettings(change),
  saveSettings: (next) => chatStore.saveSettings(next),
  chatName: () => chatStore.chatName,
  chatMetadata: () => plainChat.chatMetadata,
  setChatMetadata: (patch) => chatStore.setChatMetadata(patch),
  messages: () => chatStore.messages,
  spliceMessages: (start, deleteCount, messages) => {
    chatStore.spliceMessages(start, deleteCount, messages);
  },
  userName: () => chatStore.userName,
  characters: () => chatStore.characters,
  currentAvatars: () => {
    if (chatStore.group) return chatStore.members.map((member) => member.avatar);
    return chatStore.character ? [chatStore.character.avatar] : [];
  },
  inGroup: () => chatStore.group !== null,
  characterWorld,
  setCharacterWorld,
  substitute,
  warn: notify,
  ask: askPopup,
  variables,
  injects: {
    set: (injects) => scriptInjects.set(injects),
    remove: (ids) => scriptInjects.remove(ids),
    clear: () => scriptInjects.clear(),
    list: () => scriptInjects.list(),
    role: injectRole,
    position: injectPosition,
  },
};

/** Runs slash command text for the scripts of the open chat. Resolves to the final pipe value. */
export function createSlashHost(deps: SlashHostDeps): (command: string) => Promise<string> {
  const commands = coreCommands({ variables });
  const add = (names: string[], command: SlashCommand) => {
    for (const name of names) commands.set(name, command);
  };

  const insert = (message: ChatMessage, at: unknown, sender: 'user' | 'character') => {
    if (!chatStore.chatPath) throw new SlashError('没有打开的聊天');
    const index = insertIndex(at);
    chatStore.spliceMessages(index, 0, [message]);
    if (sender === 'user') {
      deps.emit('message_sent', index);
      deps.emit('user_message_rendered', index);
    } else {
      deps.emit('message_received', index, 'command');
      deps.emit('character_message_rendered', index, 'command');
    }
  };
  /** ST doMesCut: remove the range, return the removed text */
  const cut = (start: number, end: number): string => {
    const removed = chatStore.messages.slice(start, end + 1);
    chatStore.spliceMessages(start, removed.length, []);
    deps.emit('message_deleted', chatStore.messages.length);
    return removed.map((message) => `${message.mes || ''}\n`).join('');
  };
  /** ST hideChatMessageRange: hidden messages are `is_system` */
  const setHidden = (named: Named, unnamed: unknown, hidden: boolean): string => {
    const last = chatStore.messages.length - 1;
    const value = text(unnamed).trim();
    const range = value ? parseRange(value, 0, last) : { start: last, end: last };
    if (!range || last < 0) return '';
    const name = named['name'] === undefined ? null : text(named['name']);
    const next = chatStore.messages
      .slice(range.start, range.end + 1)
      .map((message) =>
        (name === null || message.name === name) && message.is_system !== hidden
          ? { ...message, is_system: hidden }
          : message,
      );
    chatStore.spliceMessages(range.start, next.length, next);
    return '';
  };
  const generate = (type: GenType): SlashCommand => ({
    run: async (named) => {
      const page = await idlePage();
      const done = page.generate(type);
      if (isTrue(named['await'])) await done;
      // not awaited: the page reports its own failures
      else done.catch(() => {});
      return '';
    },
  });

  add(['send'], {
    run: (named, unnamed) => {
      const ctx = context();
      const message = buildUserMessage(
        ctx,
        chatStore.userName,
        text(unnamed).trim(),
        userForceAvatar(plainChat.settings),
      );
      if (isTrue(named['compact'])) message.extra = { ...message.extra, isSmallSys: true };
      insert(message, named['at'], 'user');
      return '';
    },
  });
  add(['sendas'], {
    run: (named, unnamed) => {
      const ctx = context();
      const name = text(named['name']).trim() || ctx.state.charName;
      if (!name) throw new SlashError('/sendas 需要 name=');
      const regexed = ctx.regex.getRegexedString(
        text(unnamed).trim(),
        REGEX_PLACEMENT.SLASH_COMMAND,
        { characterOverride: name },
      );
      const bias = extractMessageBias(regexed);
      const mes = ctx.substitute(regexed);
      const sendDate = messageTimeStamp();
      const extra = {
        bias: bias.trim().length > 0 ? bias : null,
        gen_id: Date.now(),
        isSmallSys: isTrue(named['compact']),
        api: 'manual',
        model: 'slash command',
      };
      insert(
        {
          name,
          is_user: false,
          // a message that only sets a bias stays out of the prompt
          is_system: !!bias && removeMacros(regexed).length === 0,
          send_date: sendDate,
          mes,
          extra,
          swipe_id: 0,
          swipes: [mes],
          swipe_info: [{ send_date: sendDate, extra }],
        } as ChatMessage,
        named['at'],
        'character',
      );
      return '';
    },
  });
  /** ST sendNarratorMessage */
  const narrate = (named: Named, raw: string): string => {
    const ctx = context();
    const bias = extractMessageBias(raw);
    const narrator = chatStore.chatMetadata['narrator_name'];
    insert(
      {
        name: text(named['name'] ?? (narrator || 'System')),
        is_user: false,
        is_system: !!bias && removeMacros(raw).length === 0,
        send_date: messageTimeStamp(),
        mes: ctx.substitute(ctx.regex.getRegexedString(raw, REGEX_PLACEMENT.SLASH_COMMAND, {})),
        force_avatar: NARRATOR_AVATAR,
        extra: {
          type: 'narrator',
          bias: bias.trim().length > 0 ? bias : null,
          gen_id: Date.now(),
          isSmallSys: isTrue(named['compact']),
        },
      } as ChatMessage,
      named['at'],
      'user',
    );
    return '';
  };
  add(['sys', 'nar'], { run: (named, unnamed) => narrate(named, text(unnamed)) });
  add(['sysgen'], {
    run: async (named, unnamed) => {
      const prompt = text(unnamed);
      if (!prompt) {
        notify('/sysgen 需要给出提示词');
        return '';
      }
      const reply = await quietGenerate(prompt);
      return narrate(named, isTrue(named['trim']) ? trimToEndSentence(reply) : reply);
    },
  });
  add(['comment'], {
    run: async (named, unnamed) => {
      const ctx = context();
      if (!chatStore.chatPath) throw new SlashError('没有打开的聊天');
      if (chatStore.chatMetadata['tainted'] !== true) {
        await chatStore.setChatMetadata({ tainted: true });
      }
      insert(
        {
          name: 'Note',
          is_user: false,
          is_system: true,
          send_date: messageTimeStamp(),
          mes: ctx.substitute(text(unnamed).trim()),
          force_avatar: COMMENT_AVATAR,
          extra: {
            type: 'comment',
            gen_id: Date.now(),
            isSmallSys: isTrue(named['compact']),
            api: 'manual',
            model: 'slash command',
          },
        } as ChatMessage,
        named['at'],
        'user',
      );
      return '';
    },
  });

  add(['trigger'], generate('normal'));
  add(['continue', 'cont'], generate('continue'));
  add(['regenerate', 'regen'], generate('regenerate'));
  add(['stop'], {
    run: () => {
      const page = chatPage();
      const wasBusy = page.busy();
      if (wasBusy) page.stop();
      return String(wasBusy);
    },
  });

  add(['cut'], {
    run: (_named, unnamed) => {
      const range = parseRange(text(unnamed).trim(), 0, chatStore.messages.length - 1);
      return range ? cut(range.start, range.end) : '';
    },
  });
  add(['del', 'delete'], {
    run: (_named, unnamed) => {
      const value = text(unnamed).trim();
      // ST opens its delete mode without a number; scripts have no use for that
      if (!value || Number.isNaN(Number(value))) throw new SlashError('/del 需要给出条数');
      const count = Number(value);
      const length = chatStore.messages.length;
      return count < 1 || count > length ? '' : cut(length - count, length - 1);
    },
  });
  add(['hide'], { run: (named, unnamed) => setHidden(named, unnamed, true) });
  add(['unhide'], { run: (named, unnamed) => setHidden(named, unnamed, false) });
  add(['messages', 'message'], {
    run: (named, unnamed) => {
      const chat = chatStore.messages;
      const range = parseRange(text(unnamed).trim(), 0, chat.length - 1);
      if (!range) return '';
      const role = named['role'] === undefined ? '' : text(named['role']);
      if (role && !['system', 'assistant', 'user'].includes(role)) {
        throw new SlashError(`role 只能是 system、assistant、user：${role}`);
      }
      const names = !isFalse(named['names']);
      const hidden = isTrue(named['hidden']);
      const lines: string[] = [];
      for (let i = range.start; i <= range.end; i++) {
        const message = chat[i]!;
        const narrator = message.extra?.type === 'narrator';
        const actual = narrator ? 'system' : message.is_user ? 'user' : 'assistant';
        // ST: a narrator message written as the user matches no role
        if (role && (role !== actual || (narrator && message.is_user))) continue;
        if (!hidden && message.is_system) continue;
        lines.push(names ? `${message.name}: ${message.mes}` : message.mes);
      }
      return lines.join('\n\n');
    },
  });

  add(['setinput'], {
    run: (_named, unnamed) => {
      const value = text(unnamed);
      chatPage().setDraft(value);
      return value;
    },
  });
  add(['echo'], {
    run: (_named, unnamed) => {
      const value = text(unnamed);
      if (value) notify(value);
      return value;
    },
  });

  add(['gen'], { run: (_named, unnamed) => quietGenerate(text(unnamed)) });
  add(['genraw'], {
    run: (named, unnamed) => rawGenerate(text(unnamed), text(named['system'])),
  });

  add(['getchatname'], { run: () => chatStore.chatName ?? '' });

  injectCommands(add, env);
  popupCommands(add, env);
  characterCommands(add, env);
  personaCommands(add, env);
  worldCommands(add, env);

  // TavernHelper's own command: `/event-emit event=name data…`
  add(['event-emit'], {
    split: true,
    run: (named, unnamed) => {
      const event = text(named['event']).trim();
      if (!event) throw new SlashError('/event-emit 需要 event=');
      const data = (Array.isArray(unnamed) ? unnamed : [unnamed]).map(text).filter(Boolean);
      deps.emit(event, ...data);
      return event;
    },
  });

  const runner = new SlashRunner(withExtensionCommands(commands), substitute);
  return async (command) => text((await runner.run(command)).pipe);
}
