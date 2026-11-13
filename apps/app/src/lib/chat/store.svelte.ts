/**
 * Chat session state: which character or group / chat file is open, its parsed messages, and the
 * file operations behind them (DEV_NOTES §5.1 layout, §5.2 jsonl rules, §9.21 groups). Pure data
 * + IPC; no rendering.
 */
import {
  looksLikeChatHeader,
  parseChatHeader,
  parseChatMessage,
  serializeMessage,
  type ChatHeader,
  type ChatMessage,
  type Group,
} from '@tm/formats';
import {
  attributeUserMessages,
  addGroupChat,
  buildGroupFirstMessages,
  resolvePersonaForChat,
  groupChatHeader,
  switchGroupChat,
  thumbnailUrl,
  addBranch,
  bookmarkMetadata,
  branchName,
  branchSnapshot,
  checkpointName,
  mainChatName,
  setBookmarkLink,
  type CharacterLike,
} from '@tm/core';
import {
  appSettingsRead,
  appSettingsWrite,
  cardRead,
  cardWrite,
  chatAppend,
  chatCreate,
  chatReadTail,
  chatRewriteFrom,
  chatWrite,
  chatWriteHeader,
  contentSeed,
  dataRoot,
  indexCharacters,
  indexChats,
  indexScan,
  isTauri,
  settingsRead,
  settingsWrite,
  type CharacterRow,
  type ChatRow,
} from '../ipc';
import { groupChatFile, groupChatPath, listGroups, readGroup, writeGroup } from '../groups';
import { listUserAvatars } from '../personas';
import { createChatContext } from './pipeline';

/** ST `characters[i]` shape: v2 `data` fields flattened to the top level, plus `data` and `avatar`. */
export interface Character extends Record<string, unknown> {
  name: string;
  avatar: string;
  first_mes?: string;
  description?: string;
  data?: Record<string, unknown> & { alternate_greetings?: string[] };
}

/** `app_settings.json`: last open chat + per-chat composer drafts keyed by root-relative path (DEV_NOTES §9.22) */
export interface AppChatSettings {
  chat?: { character?: string; group?: string; file: string } | undefined;
  drafts?: Record<string, string> | undefined;
  /** DEV_NOTES §9.31: last page, restored on launch */
  ui?: { route?: string | undefined } | undefined;
  /** DEV_NOTES §9.5: `render: false` turns front-end card rendering off */
  helper?: { render?: boolean | undefined } | undefined;
}

/** ST humanizedDateTime(): `2026-11-1@12h34m56s` */
export function humanizedDateTime(ts = Date.now()): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}@${d.getHours()}h${d.getMinutes()}m${d.getSeconds()}s`;
}
/** ST getMessageTimeStamp(): ISO string */
export const messageTimeStamp = (ts = Date.now()) => new Date(ts).toISOString();

export function flattenCard(json: string, avatar: string): Character {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const data = (raw['data'] as Record<string, unknown> | undefined) ?? raw;
  return {
    ...raw,
    ...data,
    data,
    avatar,
    name: String(data['name'] ?? raw['name'] ?? avatar),
  } as Character;
}

const DRAFT_DELAY = 500;
/** script edits reach the disk this long after the last one (ST debounces its saves the same way) */
const SCRIPT_WRITE_DELAY = 500;

class ChatStore {
  root = $state<string | null>(null);
  settings = $state<Record<string, unknown> | null>(null);
  characters = $state<CharacterRow[]>([]);
  groups = $state<Group[]>([]);
  /** single-character chat */
  character = $state<Character | null>(null);
  /** group chat: the group file + the flattened cards of its present members (group.members order) */
  group = $state<Group | null>(null);
  members = $state<Character[]>([]);
  chats = $state<ChatRow[]>([]);
  chatFile = $state<string | null>(null);
  header = $state<ChatHeader | null>(null);
  /** always replaced wholesale, never mutated in place → raw: no deep proxy over thousands of rows (§9.31) */
  messages = $state.raw<ChatMessage[]>([]);
  total = $state(0);
  loading = $state(false);
  error = $state<string | null>(null);
  ready = $state(false);
  /** TavernHelper front-end cards are rendered (DEV_NOTES §9.5); on unless switched off */
  helperRender = $state(true);
  private drafts: Record<string, string> = {};
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  /** what scripts changed in memory that the files do not have yet (DEV_NOTES §9.5) */
  private deferred: {
    /** the chat file the message / header changes belong to */
    path: string | null;
    /** lowest changed message index */
    from: number | null;
    header: boolean;
    settings: boolean;
    /** card `data.extensions` keys to write, and the avatar they belong to */
    card: { avatar: string; keys: Set<string> } | null;
  } = { path: null, from: null, header: false, settings: false, card: null };
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  /** deferred writes run one after another, in the order they were captured */
  private deferredWrites: Promise<void> = Promise.resolve();

  /** ST name1 = settings `username` (the persona name); the chat header only records who created it */
  get userName(): string {
    const fromSettings = this.settings?.['username'];
    if (typeof fromSettings === 'string' && fromSettings) return fromSettings;
    const fromHeader = this.header?.user_name;
    if (fromHeader && fromHeader !== 'unused') return fromHeader;
    return 'User';
  }
  /** Something is open: a character or a group */
  get open(): boolean {
    return !!this.character || !!this.group;
  }
  /** Title text: character name or group name */
  get displayName(): string {
    return this.group?.name ?? this.character?.name ?? '';
  }
  get chatPath(): string | null {
    if (!this.root || !this.chatFile) return null;
    if (this.group) return groupChatPath(this.root, this.chatFile.replace(/\.jsonl$/i, ''));
    if (!this.character) return null;
    return `${this.root}/chats/${this.character.avatar.replace(/\.png$/i, '')}/${this.chatFile}`;
  }
  /** chat file path relative to the data root (stable across iOS container moves); drafts are keyed by it */
  get chatRel(): string | null {
    const path = this.chatPath;
    return path && this.root ? path.slice(this.root.length + 1) : null;
  }
  get chatMetadata(): Record<string, unknown> {
    return (this.header?.chat_metadata as Record<string, unknown> | undefined) ?? {};
  }

  async init(): Promise<void> {
    if (this.ready || !isTauri()) return;
    this.loading = true;
    this.error = null;
    try {
      const root = await dataRoot();
      this.root = root;
      // a backgrounded mobile app can be killed without notice
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) void this.flushDeferred();
      });
      try {
        await contentSeed(root); // ST content-manager: default templates on first run
      } catch {
        /* non-fatal: the template lists are just empty */
      }
      this.settings = (await settingsRead(root)) as Record<string, unknown> | null;
      await indexScan(root);
      this.characters = await indexCharacters(root);
      this.groups = await listGroups(root);
      const app = ((await appSettingsRead(root)) as AppChatSettings | null) ?? {};
      this.drafts = { ...(app.drafts ?? {}) };
      this.savedRoute = app.ui?.route ?? null;
      this.helperRender = app.helper?.render !== false;
      const last = app.chat;
      if (last?.group && this.groups.some((g) => g.id === last.group)) {
        await this.openGroup(last.group, last.file.replace(/\.jsonl$/i, ''));
      } else if (last?.character && this.characters.some((c) => c.avatar === last.character)) {
        await this.openCharacter(last.character, last.file);
      }
      this.ready = true;
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loading = false;
    }
  }

  /** Re-read the open character's card (after the editor saved it). */
  async reloadCharacter(): Promise<void> {
    if (!this.root || !this.character) return;
    const avatar = this.character.avatar;
    const json = await cardRead(`${this.root}/characters/${avatar}`);
    this.character = flattenCard(json, avatar);
  }

  /** Re-read the open group + its member cards (after the group editor saved it). */
  async reloadGroup(): Promise<void> {
    if (!this.root || !this.group) return;
    const group = await readGroup(this.root, this.group.id);
    this.group = group;
    this.members = await this.loadMembers(group);
    await this.refreshGroups();
  }

  /** Leave the current chat (deleted / renamed): back to the picker, forget the last chat. */
  async closeCharacter(): Promise<void> {
    const flushed = this.flushDeferred();
    this.character = null;
    this.group = null;
    this.members = [];
    this.chats = [];
    this.chatFile = null;
    this.header = null;
    this.messages = [];
    this.total = 0;
    await flushed;
    if (!this.root) return;
    try {
      const app = ((await appSettingsRead(this.root)) as Record<string, unknown> | null) ?? {};
      delete app['chat'];
      await appSettingsWrite(this.root, app);
    } catch {
      /* non-fatal */
    }
  }
  /** alias: groups close the same way */
  closeGroup(): Promise<void> {
    return this.closeCharacter();
  }

  /** Persist a new settings.json object (secrets are scrubbed on the Rust side) and adopt it. */
  async saveSettings(next: Record<string, unknown>): Promise<void> {
    if (!this.root) throw new Error('no data root');
    // `next` was built from the in-memory settings, so it already carries any deferred change
    this.deferred.settings = false;
    await settingsWrite(this.root, next);
    this.settings = next;
  }

  async refreshCharacters(): Promise<void> {
    if (!this.root) return;
    await indexScan(this.root);
    this.characters = await indexCharacters(this.root);
  }
  async refreshGroups(): Promise<void> {
    if (!this.root) return;
    this.groups = await listGroups(this.root);
  }

  /** Open a character; opens `file` or its most recent chat, creating one when none exists (ST getChat → first_mes). */
  async openCharacter(avatar: string, file?: string): Promise<void> {
    if (!this.root) return;
    this.loading = true;
    this.error = null;
    try {
      const json = await cardRead(`${this.root}/characters/${avatar}`);
      const flushed = this.flushDeferred();
      this.group = null;
      this.members = [];
      this.character = flattenCard(json, avatar);
      await flushed;
      this.chats = (await indexChats(this.root, avatar)).sort((a, b) => b.mtime - a.mtime);
      const target = file && this.chats.some((c) => c.file === file) ? file : this.chats[0]?.file;
      if (target) await this.openChat(target);
      else await this.newChat();
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loading = false;
    }
  }

  /**
   * ST `openGroupById` + `getGroupChat`: load the group and its members, then `chatId` (or
   * `group.chat_id`); a chat id whose file does not exist yet is a fresh chat → member greetings.
   */
  async openGroup(id: string, chatId?: string): Promise<void> {
    if (!this.root) return;
    this.loading = true;
    this.error = null;
    try {
      const group = await readGroup(this.root, id);
      const flushed = this.flushDeferred();
      this.character = null;
      this.group = group;
      await flushed;
      this.members = await this.loadMembers(group);
      await this.refreshGroupChats(group);
      let target = chatId && (group.chats ?? []).includes(chatId) ? chatId : group.chat_id;
      if (!target || !(group.chats ?? []).includes(target)) target = group.chats?.at(-1);
      if (target) {
        if (target !== group.chat_id) {
          switchGroupChat(group, target);
          await writeGroup(this.root, group);
        }
        await this.openChat(`${target}.jsonl`);
      } else {
        await this.newChat();
      }
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loading = false;
    }
  }

  private async loadMembers(group: Group): Promise<Character[]> {
    const out: Character[] = [];
    for (const avatar of group.members) {
      try {
        out.push(flattenCard(await cardRead(`${this.root}/characters/${avatar}`), avatar));
      } catch {
        /* ST getGroupCharacters: a missing member is skipped */
      }
    }
    return out;
  }

  /** Re-list the chat files of the open character / group (after rename / delete). */
  async refreshChats(): Promise<void> {
    if (!this.root) return;
    if (this.group) {
      await this.refreshGroupChats(this.group);
    } else if (this.character) {
      await indexScan(this.root);
      this.chats = (await indexChats(this.root, this.character.avatar)).sort(
        (a, b) => b.mtime - a.mtime,
      );
    }
  }

  /** `getGroupPastChats`: one row per `group.chats` entry, newest first; missing files count as empty. */
  private async refreshGroupChats(group: Group): Promise<void> {
    if (!this.root) return;
    const rows: ChatRow[] = [];
    for (const id of [...(group.chats ?? [])].reverse()) {
      let mes_count = 0;
      let last_mes: string | null = null;
      let last_name: string | null = null;
      try {
        const tail = await chatReadTail(groupChatPath(this.root, id), 1);
        const headerIsMessage = !looksLikeChatHeader(JSON.parse(tail.header));
        mes_count = tail.total + (headerIsMessage ? 1 : 0);
        const lastLine =
          tail.messages[tail.messages.length - 1] ?? (headerIsMessage ? tail.header : null);
        if (lastLine) {
          const m = parseChatMessage(JSON.parse(lastLine));
          last_mes = m.mes;
          last_name = m.name;
        }
      } catch {
        /* not created yet */
      }
      rows.push({ char_avatar: '', file: `${id}.jsonl`, mes_count, last_mes, last_name, mtime: 0 });
    }
    this.chats = rows;
  }

  async openChat(file: string): Promise<void> {
    if (!this.root || !this.open) return;
    const flushed = this.flushDeferred();
    this.chatFile = file;
    await flushed;
    const path = this.chatPath!;
    if (this.group) {
      const chatId = file.replace(/\.jsonl$/i, '');
      let tail;
      try {
        tail = await chatReadTail(path, 100_000);
      } catch {
        await this.freshGroupChat(chatId);
        return;
      }
      const first = JSON.parse(tail.header) as unknown;
      if (looksLikeChatHeader(first)) {
        this.header = parseChatHeader(first);
        this.messages = tail.messages.map((l) => parseChatMessage(JSON.parse(l)));
        this.total = tail.total;
      } else {
        // legacy headerless group chat: add the ST header line once (DEV_NOTES §9.21)
        const header = parseChatHeader(groupChatHeader({}));
        const lines = [tail.header, ...tail.messages];
        this.messages = lines.map((l) => parseChatMessage(JSON.parse(l)));
        this.total = this.messages.length;
        this.header = header;
        await chatWrite(path, [JSON.stringify(header), ...lines]);
      }
      if (this.group.chat_id !== chatId) {
        switchGroupChat(this.group, chatId);
        await writeGroup(this.root, $state.snapshot(this.group) as Group);
      }
    } else {
      const tail = await chatReadTail(path, 100_000);
      this.header = parseChatHeader(JSON.parse(tail.header));
      this.messages = tail.messages.map((l) => parseChatMessage(JSON.parse(l)));
      this.total = tail.total;
    }
    await this.remember();
    await this.applyPersonaForChat();
  }

  /**
   * ST `loadPersonaForCurrentChat` (DEV_NOTES §9.24): chat lock → character / group connection →
   * default persona; stale references are cleared. Writes settings.json / the header when changed.
   */
  async applyPersonaForChat(): Promise<void> {
    if (!this.root || !this.settings || !this.header) return;
    try {
      const files = await listUserAvatars(this.root);
      const settings = structuredClone($state.snapshot(this.settings)) as Record<string, unknown>;
      const meta = structuredClone($state.snapshot(this.chatMetadata)) as Record<string, unknown>;
      const key = this.group ? this.group.id : (this.character?.avatar ?? null);
      const r = resolvePersonaForChat(settings, meta, files, key);
      if (r.settingsChanged) await this.saveSettings(settings);
      // `persona: undefined` drops the key when the header line is re-serialized
      if (r.metadataChanged) await this.setChatMetadata({ persona: meta['persona'] });
    } catch {
      /* persona auto-select is best effort */
    }
  }

  /** Macro / regex context for greetings, built from the open subject (no live generation member). */
  private greetingContext() {
    if (!this.settings) return null;
    return createChatContext(
      $state.snapshot(this.settings),
      {
        character: this.character ? ($state.snapshot(this.character) as CharacterLike) : null,
        group: this.group ? $state.snapshot(this.group) : null,
        members: $state.snapshot(this.members) as CharacterLike[],
        memberIndex: null,
      },
      this.userName,
      [],
      {},
    );
  }

  /** `getGroupChat` freshChat branch: header + each member's (random) greeting, then save. */
  private async freshGroupChat(chatId: string): Promise<void> {
    if (!this.root || !this.group) return;
    const ctx = this.greetingContext();
    const header = parseChatHeader(groupChatHeader({}));
    const greetings = buildGroupFirstMessages(
      $state.snapshot(this.group),
      $state.snapshot(this.members) as CharacterLike[],
      {
        substitute: (t, name) => (ctx ? ctx.regexAiOutput(ctx.substitute(t, name)) : t),
        timestamp: messageTimeStamp,
        thumbnailUrl: (a) => thumbnailUrl('avatar', a),
      },
    );
    const messages = greetings.map((g) => parseChatMessage(g));
    const flushed = this.flushDeferred();
    this.chatFile = `${chatId}.jsonl`;
    await flushed;
    await chatCreate(this.chatPath!, [JSON.stringify(header), ...messages.map(serializeMessage)]);
    this.header = header;
    this.messages = messages;
    this.total = messages.length;
    if (this.group.chat_id !== chatId) {
      switchGroupChat(this.group, chatId);
      await writeGroup(this.root, $state.snapshot(this.group) as Group);
    }
    await this.refreshGroupChats(this.group);
    await this.remember();
    await this.applyPersonaForChat();
  }

  /** ST newChat(): header + first_mes (+ alternate greetings as swipes); groups: createNewGroupChat. */
  async newChat(): Promise<void> {
    if (!this.root || !this.open) return;
    if (this.group) {
      const chatId = humanizedDateTime();
      addGroupChat(this.group, chatId);
      await writeGroup(this.root, $state.snapshot(this.group) as Group);
      await this.freshGroupChat(chatId);
      await this.refreshGroups();
      return;
    }
    const ch = this.character!;
    const ctx = this.greetingContext();
    const applyRegex = (t: string) => (ctx ? ctx.regexAiOutput(t) : t);
    const file = `${ch.name} - ${humanizedDateTime()}.jsonl`;
    const header: ChatHeader = {
      user_name: this.userName,
      character_name: ch.name,
      create_date: humanizedDateTime(),
      chat_metadata: {},
    };
    const firstMes = applyRegex(String(ch.first_mes ?? ''));
    const greetings = ch.data?.alternate_greetings;
    const message: ChatMessage = {
      name: ch.name,
      is_user: false,
      is_system: false,
      send_date: messageTimeStamp(),
      mes: firstMes,
      extra: {},
    };
    if (Array.isArray(greetings) && greetings.length > 0) {
      const swipes = [message.mes, ...greetings.map((g) => applyRegex(String(g)))];
      if (!message.mes) {
        swipes.shift();
        message.mes = swipes[0] ?? '';
      }
      message.swipe_id = 0;
      message.swipes = swipes;
      message.swipe_info = swipes.map(() => ({ send_date: message.send_date, extra: {} }));
    }
    const lines = [JSON.stringify(header)];
    if (message.mes) lines.push(serializeMessage(message));
    const flushed = this.flushDeferred();
    this.chatFile = file;
    await flushed;
    await chatCreate(this.chatPath!, lines);
    this.header = header;
    this.messages = message.mes ? [message] : [];
    this.total = this.messages.length;
    await indexScan(this.root);
    this.chats = (await indexChats(this.root, ch.avatar)).sort((a, b) => b.mtime - a.mtime);
    await this.remember();
    await this.applyPersonaForChat();
  }

  async append(message: ChatMessage): Promise<void> {
    const path = this.chatPath;
    if (!path) throw new Error('no chat open');
    const flushed = this.flushDeferred();
    this.messages = [...this.messages, message];
    this.total = this.messages.length;
    await flushed;
    await chatAppend(path, serializeMessage(message));
  }

  /** Replace message `index` in place (edit / swipe / finalize a streamed reply). */
  async replace(index: number, message: ChatMessage): Promise<void> {
    const path = this.chatPath;
    if (!path) throw new Error('no chat open');
    const flushed = this.flushDeferred();
    const next = this.messages.slice();
    next[index] = message;
    this.messages = next;
    await flushed;
    await chatRewriteFrom(path, index, next.slice(index).map(serializeMessage));
  }

  /** ST `syncUserNameToPersona`: every user message takes this name and avatar. Returns how many changed. */
  async attributeUserMessages(name: string, forceAvatar: string | undefined): Promise<number> {
    const path = this.chatPath;
    if (!path) throw new Error('no chat open');
    const flushed = this.flushDeferred();
    const r = attributeUserMessages(this.messages, name, forceAvatar);
    if (r.first < 0) return 0;
    this.messages = r.messages;
    await flushed;
    await chatRewriteFrom(path, r.first, r.messages.slice(r.first).map(serializeMessage));
    return r.changed;
  }

  /** Swap two adjacent messages (ST mes_edit_up / mes_edit_down). */
  async swap(i: number, j: number): Promise<void> {
    const path = this.chatPath;
    if (!path) throw new Error('no chat open');
    const next = this.messages.slice();
    const a = next[i];
    const b = next[j];
    if (!a || !b) return;
    const flushed = this.flushDeferred();
    next[i] = b;
    next[j] = a;
    this.messages = next;
    const from = Math.min(i, j);
    await flushed;
    await chatRewriteFrom(path, from, next.slice(from).map(serializeMessage));
  }

  /** Remove one message (ST deleteMessage: chat.splice(id, 1)). */
  async remove(index: number): Promise<void> {
    const path = this.chatPath;
    if (!path) throw new Error('no chat open');
    const flushed = this.flushDeferred();
    const next = this.messages.filter((_, i) => i !== index);
    this.messages = next;
    this.total = next.length;
    await flushed;
    await chatRewriteFrom(path, index, next.slice(index).map(serializeMessage));
  }

  /** Delete messages from `index` to the end (ST: delete last / cut). */
  async truncate(index: number): Promise<void> {
    const path = this.chatPath;
    if (!path) throw new Error('no chat open');
    const flushed = this.flushDeferred();
    this.messages = this.messages.slice(0, index);
    this.total = this.messages.length;
    await flushed;
    await chatRewriteFrom(path, index, []);
  }

  /**
   * ST updateChatMetadata + saveChat: merge into `chat_metadata` and rewrite the header line
   * (author's note, `tainted`, chat lorebook). The messages stay as they are on disk.
   */
  async setChatMetadata(patch: Record<string, unknown>): Promise<void> {
    const path = this.chatPath;
    if (!path || !this.header) throw new Error('no chat open');
    const header: ChatHeader = {
      ...this.header,
      chat_metadata: { ...this.chatMetadata, ...patch },
    };
    this.header = header;
    // this write carries any header change a script left pending
    this.deferred.header = false;
    await chatWriteHeader(path, JSON.stringify($state.snapshot(header)));
  }

  // ---- script-driven edits (TavernHelper bridge, DEV_NOTES §9.5) ----
  // Scripts change the chat and its variables in bursts, so these update memory at once and
  // write a moment later, coalesced. Every other write and every chat switch calls
  // `flushDeferred()` first, which keeps the file in step with what the user does.

  /** `Array.prototype.splice` on the open chat. Returns the new message array. */
  spliceMessages(
    start: number,
    deleteCount: number,
    messages: readonly ChatMessage[],
  ): readonly ChatMessage[] {
    const path = this.chatPath;
    if (!path) throw new Error('no chat open');
    const next = this.messages.slice();
    next.splice(start, deleteCount, ...messages);
    this.messages = next;
    this.total += messages.length - deleteCount;
    this.defer(path).from = Math.min(this.deferred.from ?? start, start);
    return next;
  }

  /** ST local variables: `chat_metadata.variables` */
  setChatVariables(variables: Record<string, unknown>): void {
    const path = this.chatPath;
    if (!path || !this.header) throw new Error('no chat open');
    // in place: only readers of the variables are invalidated, not every reader of the header
    this.header.chat_metadata ??= {};
    this.header.chat_metadata.variables = variables;
    this.defer(path).header = true;
  }

  /** ST global variables: `extension_settings.variables.global` */
  setGlobalVariables(variables: Record<string, unknown>): void {
    const settings = this.settings;
    if (!settings) throw new Error('settings not loaded');
    // read back after assigning: the stored value is the reactive proxy, not the literal
    settings['extension_settings'] ??= {};
    const extensions = settings['extension_settings'] as Record<string, unknown>;
    extensions['variables'] ??= {};
    (extensions['variables'] as Record<string, unknown>)['global'] = variables;
    this.defer(null).settings = true;
  }

  /**
   * ST writeExtensionField on the open card: `data.extensions[key] = value`, in memory at once and
   * on the card a moment later (TavernHelper character variables, scoped regex set by scripts).
   */
  setCardExtension(key: string, value: unknown): void {
    const character = this.character;
    if (!character) throw new Error('no character open');
    character.data ??= {};
    character.data['extensions'] ??= {};
    (character.data['extensions'] as Record<string, unknown>)[key] = value;
    const pending = this.deferred.card;
    if (pending && pending.avatar === character.avatar) pending.keys.add(key);
    else this.defer(null).card = { avatar: character.avatar, keys: new Set([key]) };
    this.defer(null);
  }

  /** A script-driven settings change: applied in place, written with the next deferred flush */
  mutateSettings(change: (settings: Record<string, unknown>) => void): void {
    const settings = this.settings;
    if (!settings) throw new Error('settings not loaded');
    change(settings);
    this.defer(null).settings = true;
  }

  // ---- extension-driven edits (ST extension host, DEV_NOTES §9.34) ----
  // Extensions hold the chat array itself and change it in place, then call `saveChat()`.

  /**
   * ST saveChat from an extension: `messages` (the array the extension was handed, after its own
   * edits) becomes the chat. Only when the whole chat is in memory, since a tail would cut the file.
   */
  adoptChat(messages: readonly ChatMessage[]): readonly ChatMessage[] {
    const path = this.chatPath;
    if (!path) throw new Error('no chat open');
    if (this.total !== this.messages.length) throw new Error('chat is not whole in memory');
    const next = messages.slice();
    this.messages = next;
    this.total = next.length;
    this.defer(path).from = 0;
    return next;
  }

  /** ST saveMetadata from an extension: the keys it changed or deleted in `chat_metadata` */
  patchChatMetadata(set: Record<string, unknown>, removed: readonly string[]): void {
    const path = this.chatPath;
    if (!path || !this.header) throw new Error('no chat open');
    this.header.chat_metadata ??= {};
    const metadata = this.header.chat_metadata as Record<string, unknown>;
    for (const key of removed) delete metadata[key];
    Object.assign(metadata, set);
    this.defer(path).header = true;
  }

  private defer(path: string | null) {
    if (path) this.deferred.path = path;
    if (this.deferredTimer === null) {
      this.deferredTimer = setTimeout(() => void this.flushDeferred(), SCRIPT_WRITE_DELAY);
    }
    return this.deferred;
  }

  /**
   * Write what scripts left pending. What to write is captured before this returns, so calling it
   * right before the chat is switched or changed (and awaiting it afterwards) is safe. Also call
   * it before renaming, deleting or exporting chat files from outside the store.
   */
  flushDeferred(): Promise<void> {
    if (this.deferredTimer !== null) {
      clearTimeout(this.deferredTimer);
      this.deferredTimer = null;
    }
    const { path, from, header, settings, card } = this.deferred;
    this.deferred = { path: null, from: null, header: false, settings: false, card: null };
    const jobs: (() => Promise<void>)[] = [];
    // a change recorded for another file than the open one has nowhere safe to go
    if (path && path === this.chatPath) {
      if (header && this.header) {
        const line = JSON.stringify($state.snapshot(this.header));
        jobs.push(() => chatWriteHeader(path, line));
      }
      if (from !== null) {
        const lines = this.messages.slice(from).map(serializeMessage);
        jobs.push(() => chatRewriteFrom(path, from, lines));
      }
    }
    if (settings && this.root && this.settings) {
      const root = this.root;
      const value = $state.snapshot(this.settings);
      jobs.push(() => settingsWrite(root, value));
    }
    if (card && this.root && this.character?.avatar === card.avatar) {
      const file = `${this.root}/characters/${card.avatar}`;
      const extensions = this.character.data?.['extensions'] as Record<string, unknown> | undefined;
      const fields = [...card.keys].map(
        (key) => [key, $state.snapshot(extensions?.[key])] as const,
      );
      jobs.push(async () => {
        const raw = JSON.parse(await cardRead(file)) as Record<string, unknown>;
        const data = (raw['data'] as Record<string, unknown> | undefined) ?? {};
        const stored = (data['extensions'] as Record<string, unknown> | undefined) ?? {};
        raw['data'] = { ...data, extensions: { ...stored, ...Object.fromEntries(fields) } };
        await cardWrite(file, JSON.stringify(raw));
      });
    }
    if (jobs.length > 0) {
      this.deferredWrites = this.deferredWrites.then(async () => {
        for (const job of jobs) {
          try {
            await job();
          } catch (e) {
            this.error = String(e);
          }
        }
      });
    }
    return this.deferredWrites;
  }

  /** Patch one message's `extra` and rewrite it (checkpoint link, branches, media edits). */
  async patchMessageExtra(index: number, patch: Record<string, unknown>): Promise<void> {
    const cur = this.messages[index];
    if (!cur) return;
    const extra = {
      ...(($state.snapshot(cur.extra) as Record<string, unknown> | undefined) ?? {}),
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete extra[k];
      else extra[k] = v;
    }
    await this.replace(index, { ...($state.snapshot(cur) as ChatMessage), extra });
  }

  // ---- checkpoints / branches (ST bookmarks.js, DEV_NOTES §9.29) ----

  /** Current chat name without `.jsonl` (ST getCurrentChatDetails().sessionName). */
  get chatName(): string | null {
    return this.chatFile ? this.chatFile.replace(/\.jsonl$/i, '') : null;
  }

  /** Names of every chat of the open character / group (checkpoint / branch uniqueness). */
  chatNames(): string[] {
    if (this.group) return [...(this.group.chats ?? [])];
    return this.chats.map((c) => c.file.replace(/\.jsonl$/i, ''));
  }

  /** Write `messages` as a new chat file `<name>.jsonl` carrying `metadata` (ST saveChat with mesId). */
  private async saveChatAs(
    name: string,
    messages: readonly ChatMessage[],
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.root || !this.header) throw new Error('no chat open');
    const header: ChatHeader = { ...$state.snapshot(this.header), chat_metadata: metadata };
    const lines = [JSON.stringify(header), ...messages.map((m) => serializeMessage(m))];
    if (this.group) {
      addGroupChat(this.group, name);
      // addGroupChat also makes it current; a checkpoint must not switch the open chat
      this.group.chat_id = this.chatName ?? this.group.chat_id;
      await writeGroup(this.root, $state.snapshot(this.group) as Group);
      await chatCreate(groupChatPath(this.root, name), lines);
      await this.refreshGroups();
    } else {
      const dir = this.character!.avatar.replace(/\.png$/i, '');
      await chatCreate(`${this.root}/chats/${dir}/${name}.jsonl`, lines);
      await indexScan(this.root);
      await this.refreshChats();
    }
  }

  /** ST createNewBookmark: snapshot up to `mesId`, link it on the message. Returns the chat name. */
  async createCheckpoint(mesId: number): Promise<string | null> {
    const main = this.chatName;
    const msg = this.messages[mesId];
    if (!main || !msg) return null;
    const name = checkpointName(main, this.chatNames());
    if (!name) return null;
    const snapshot = branchSnapshot($state.snapshot(this.messages) as ChatMessage[], mesId);
    if (!snapshot) return null;
    await this.saveChatAs(
      name,
      snapshot,
      bookmarkMetadata($state.snapshot(this.chatMetadata) as Record<string, unknown>, main),
    );
    const marked = $state.snapshot(msg) as ChatMessage;
    setBookmarkLink(marked, name);
    await this.replace(mesId, marked);
    return name;
  }

  /** ST branchChat: snapshot (optionally at a swipe), record it in `extra.branches`, open it. */
  async createBranch(mesId: number, swipeId: number | null = null): Promise<string | null> {
    const main = this.chatName;
    const msg = this.messages[mesId];
    if (!main || !msg) return null;
    const name = branchName(main, this.chatNames());
    if (!name) return null;
    const snapshot = branchSnapshot(
      $state.snapshot(this.messages) as ChatMessage[],
      mesId,
      swipeId,
    );
    if (!snapshot) return null;
    await this.saveChatAs(
      name,
      snapshot,
      bookmarkMetadata($state.snapshot(this.chatMetadata) as Record<string, unknown>, main),
    );
    const marked = $state.snapshot(msg) as ChatMessage;
    addBranch(marked, name);
    await this.replace(mesId, marked);
    await this.openChat(`${name}.jsonl`);
    return name;
  }

  /** ST getMainChatName + the "exists" check of backToMainChat; null when there is nothing to go back to. */
  mainChat(): string | null {
    const { name } = mainChatName(this.chatMetadata, this.chatName, !!this.group);
    if (!name) return null;
    return this.chatNames().includes(name) ? name : null;
  }

  async backToMainChat(): Promise<void> {
    const name = this.mainChat();
    if (!name) return;
    const { derived } = mainChatName(this.chatMetadata, this.chatName, !!this.group);
    if (derived) await this.setChatMetadata({ main_chat: name });
    await this.openChat(`${name}.jsonl`);
  }

  // ---- TavernHelper rendering switch (DEV_NOTES §9.5) ----
  async setHelperRender(on: boolean): Promise<void> {
    this.helperRender = on;
    if (!this.root) return;
    try {
      const app = ((await appSettingsRead(this.root)) as AppChatSettings | null) ?? {};
      await appSettingsWrite(this.root, { ...app, helper: { ...(app.helper ?? {}), render: on } });
    } catch {
      /* non-fatal */
    }
  }

  // ---- remembered page (DEV_NOTES §9.31) ----
  private uiTimer: ReturnType<typeof setTimeout> | null = null;
  rememberRoute(route: string): void {
    if (!this.root) return;
    if (this.uiTimer) clearTimeout(this.uiTimer);
    this.uiTimer = setTimeout(() => {
      this.uiTimer = null;
      void (async () => {
        try {
          const app = ((await appSettingsRead(this.root!)) as AppChatSettings | null) ?? {};
          await appSettingsWrite(this.root!, { ...app, ui: { ...(app.ui ?? {}), route } });
        } catch {
          /* non-fatal */
        }
      })();
    }, 300);
  }
  /** the route saved by the previous session (read once in init) */
  savedRoute: string | null = null;

  // ---- composer drafts (app_settings.json `drafts[chatRel]`, debounced) ----
  draftFor(path: string | null): string {
    return path ? (this.drafts[path] ?? '') : '';
  }
  setDraft(path: string | null, text: string): void {
    if (!path) return;
    const cur = this.drafts[path] ?? '';
    if (cur === text) return;
    if (text) this.drafts[path] = text;
    else delete this.drafts[path];
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => void this.flushDrafts(), DRAFT_DELAY);
  }
  async flushDrafts(): Promise<void> {
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    if (!this.root) return;
    try {
      const app = ((await appSettingsRead(this.root)) as Record<string, unknown> | null) ?? {};
      await appSettingsWrite(this.root, { ...app, drafts: { ...this.drafts } });
    } catch {
      /* non-fatal */
    }
  }

  private async remember(): Promise<void> {
    if (!this.root || !this.chatFile || !this.open) return;
    try {
      const app = ((await appSettingsRead(this.root)) as Record<string, unknown> | null) ?? {};
      const chat = this.group
        ? { group: this.group.id, file: this.chatFile }
        : { character: this.character!.avatar, file: this.chatFile };
      await appSettingsWrite(this.root, { ...app, chat });
    } catch {
      /* non-fatal */
    }
  }
}

export const chatStore = new ChatStore();
