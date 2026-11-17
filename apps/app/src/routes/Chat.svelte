<script lang="ts">
  /**
   * The chat page: character picker → message list (virtualized, cached Markdown) → composer.
   * Generation = @tm/core prompt pipeline → Rust streaming (runGeneration handles background resume).
   */
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import {
    countHiddenChange,
    countMessagesToRegenerate,
    ensureNoteDefaults,
    generateGroup,
    groupCollageAvatars,
    groupMessageFields,
    NOTE_METADATA_KEYS,
    timestampToMoment,
    activeBackgroundRel,
    backgroundSettingsOf,
    type CharacterLike,
    type ChatMessageLike,
    type GroupGenerationType,
    type NoteSettings,
  } from '@tm/core';
  import type { ChatMessage } from '@tm/formats';
  import GroupCollage from '../lib/components/GroupCollage.svelte';
  import Segmented from '@tm/ui/components/Segmented.svelte';
  import Button from '@tm/ui/components/Button.svelte';
  import VirtualList from '@tm/ui/components/VirtualList.svelte';
  import type { JumpTarget } from '@tm/ui';
  import MessageItem from '../lib/components/chat/MessageItem.svelte';
  import Composer from '../lib/components/chat/Composer.svelte';
  import BottomSheet from '../lib/components/BottomSheet.svelte';
  import { replyAnnouncement } from '../lib/announce';
  import Icon from '../lib/components/Icon.svelte';
  import { chatStore, humanizedDateTime, messageTimeStamp } from '../lib/chat/store.svelte';
  import { extensionHost } from '../lib/ext/host.svelte';
  import { plainChat } from '../lib/chat/plain.svelte';
  import { generationHooks } from '../lib/chat/hooks';
  import { withSwipe } from '../lib/chat/swipes';
  import { followsUp, isBareToolReply, toolRecordMessage } from '../lib/chat/tool-calls';
  import { registerChatPage } from '../lib/chat/page-actions';
  import { emitAppEvent } from '../lib/events';
  import { event_types } from '@tm/st-compat';
  import { pickFiles } from '../lib/files';
  import { offerCardExtras } from '../lib/card-extras.svelte';
  import { toasts } from '../lib/toast.svelte';
  import { askPopup } from '../lib/popup.svelte';
  import { listWorldNames } from '../lib/worlds';
  import { MessageRenderer, formatPowerUserFrom } from '../lib/chat/render';
  import {
    applyEdit,
    autoParseReasoning,
    buildUserMessage,
    createChatContext,
    prepareGeneration,
    type ChatContext,
    type ChatSubject,
    type GenType,
  } from '../lib/chat/pipeline';
  import {
    DEFAULT_REASONING_SETTINGS,
    ensureMessageMediaIsArray,
    getMediaDisplay,
    humanFileSize,
    getMediaIndex,
    parseReasoningFromString,
    type MediaAttachment,
  } from '@tm/core';
  import {
    inlineMediaDeps,
    mediaUrl,
    pickMedia,
    toAttachments,
    discardMedia,
    type PendingMedia,
  } from '../lib/chat/media';
  import { oaiRuntime } from '../lib/oai.svelte';
  import { perfBench } from '../lib/perf.svelte';
  import { helperBridge } from '../lib/helper/bridge.svelte';
  import { helperDisplay, macroDisplay } from '../lib/helper/display.svelte';
  import { applyMacroLikes } from '../lib/helper/macro-like';
  import { helperPage } from '../lib/helper/page.svelte';
  import {
    chatInjectPrompts,
    scriptRuns,
    spendInjectsWhenSent,
    stopScriptGeneration,
  } from '../lib/helper/generate.svelte';
  import { scriptLibrary } from '../lib/helper/scripts.svelte';
  import { buttonEvent } from '@tm/tavern-helper';
  import ScriptLibrary from '../lib/components/ScriptLibrary.svelte';
  import { chatCreate, dataDelete } from '../lib/ipc';
  import type { MediaView } from '../lib/components/chat/MessageItem.svelte';
  import { runGeneration, type GenerationHandle, type GenerationOutcome } from '../lib/generation';
  import { fileUrl, isTauri } from '../lib/ipc';
  import { avatarBackgroundRel } from '../lib/characters';
  import { personaFileFromForceAvatar, userAvatarUrl, userForceAvatar } from '../lib/personas';
  import {
    characterChatRel,
    chatStem,
    chatToTxt,
    deleteCharacterChat,
    deleteGroupChat,
    importCharacterChats,
    importGroupChats,
    renameCharacterChat,
    renameGroupChat,
    searchCharacterChats,
  } from '../lib/chats';
  import { describeExport, exportFileCopy, exportText } from '../lib/export';
  import { groupChatPath } from '../lib/groups';
  import { chatReadTail, type ChatRow, type SearchHit } from '../lib/ipc';
  import { parseChatMessage, type Group } from '@tm/formats';
  import { themeStore } from '../lib/theme.svelte';

  interface Props {
    /**
     * False while another page is open. The page is then hidden, not unmounted, so a reply that is
     * being generated keeps streaming and is there on return (DEV_NOTES §9.45).
     */
    active?: boolean;
    onTitle?: ((title: string, subtitle?: string) => void) | undefined;
    onOpenCharacters?: (() => void) | undefined;
    onEditCharacter?: ((avatar: string) => void) | undefined;
    onEditGroup?: ((id: string) => void) | undefined;
  }
  let { active = true, onTitle, onOpenCharacters, onEditCharacter, onEditGroup }: Props = $props();

  // the reply being generated belongs to the chat it started in: opening another one stops it
  let liveChat: string | null = null;
  $effect(() => {
    const path = store.chatPath;
    const running = busy;
    untrack(() => {
      if (running && liveChat !== null && path !== liveChat) abortGeneration();
      liveChat = running ? path : null;
    });
  });

  // a hidden list has no size and loses its scroll offset: note where it was, put it back on return
  let scrollMemo: { top: number; atEnd: boolean } | null = null;
  $effect.pre(() => {
    if (active) return;
    const list = document.getElementById('chat');
    if (!list || list.clientHeight === 0) return;
    const fromEnd = list.scrollHeight - list.clientHeight - list.scrollTop;
    scrollMemo = { top: list.scrollTop, atEnd: fromEnd < list.clientHeight / 4 };
  });
  $effect(() => {
    if (!active || !scrollMemo) return;
    const memo = scrollMemo;
    scrollMemo = null;
    // two frames: the list measures itself again in the first
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const list = document.getElementById('chat');
        if (list) list.scrollTop = memo.atEnd ? list.scrollHeight : memo.top;
      }),
    );
  });

  const store = chatStore;
  onMount(() => void store.init());
  // the wand menu's "attach a file" row acts on this page (DEV_NOTES §9.44)
  $effect(() => {
    extensionHost.attachFile = isTauri() ? () => void attach() : null;
    return () => {
      extensionHost.attachFile = null;
    };
  });
  // slash commands run by scripts drive generation and the input box through the page (DEV_NOTES §9.5)
  onMount(() =>
    registerChatPage({
      busy: () => busy,
      generate: (type) => generate(type),
      send: sendDraft,
      stop: abortGeneration,
      swipe: (dir) => swipe(dir),
      loadSwipe: (index, swipeId) => loadSwipe(index, swipeId),
      getDraft: () => draft,
      setDraft: (text) => (draft = text),
      notify: (text) => (notice = text),
    }),
  );

  // ---- performance self-check (DEV_NOTES §9.31): synthetic chat → open timing → scroll frames ----
  $effect(() => {
    if (!perfBench.requested || perfBench.running || !store.ready) return;
    perfBench.requested = false;
    void runPerfBench();
  });
  const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
  async function runPerfBench() {
    const ch = store.character;
    const root = store.root;
    if (!ch || !root || store.group) {
      perfBench.error = '需要先打开一个角色聊天';
      return;
    }
    perfBench.running = true;
    const previous = store.chatFile;
    const file = `bench-${perfBench.rows}.jsonl`;
    const rel = characterChatRel(ch.avatar, file);
    try {
      const rows = perfBench.rows;
      const lines = [
        JSON.stringify({
          user_name: store.userName,
          character_name: ch.name,
          create_date: '2026-11-08@10h00m00s',
          chat_metadata: {},
        }),
      ];
      const body =
        '*She looks up from the ledger.* "You again? Sit down, the tea is still warm." The glade was quiet. **Too** quiet.';
      for (let i = 0; i < rows; i++) {
        const user = i % 2 === 1;
        lines.push(
          JSON.stringify({
            name: user ? store.userName : ch.name,
            is_user: user,
            is_system: false,
            send_date: `2026-11-08 10:${String(i % 60).padStart(2, '0')}`,
            mes: `${body} (#${i})`,
            extra: {},
          }),
        );
      }
      await chatCreate(`${root}/${rel}`, lines);
      const t0 = performance.now();
      await store.openChat(file);
      await tick();
      await nextFrame();
      const openMs = performance.now() - t0;
      // scroll upward through the list for ~3s and count long frames
      const viewport = document.getElementById('chat');
      let frames = 0;
      let dropped = 0;
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
        let last = await nextFrame();
        const end = last + 3000;
        while (last < end) {
          viewport.scrollTop = Math.max(0, viewport.scrollTop - 24);
          const now = await nextFrame();
          frames++;
          if (now - last > 16.7 * 1.5) dropped++;
          last = now;
        }
      }
      perfBench.result = {
        rows,
        openMs,
        frames,
        dropped,
        droppedPct: frames ? (dropped / frames) * 100 : 0,
        at: Date.now(),
      };
      notice = `性能自检：${rows} 条打开 ${openMs.toFixed(0)}ms，滚动掉帧 ${perfBench.result.droppedPct.toFixed(1)}%`;
    } catch (e) {
      perfBench.error = e instanceof Error ? e.message : String(e);
    } finally {
      try {
        await dataDelete(root, rel);
      } catch {
        /* already gone */
      }
      if (previous && previous !== file) await store.openChat(previous);
      else await store.refreshChats();
      perfBench.running = false;
    }
  }

  // Macro / regex context follows the open chat; the renderer only depends on settings so its cache survives.
  // Core gets plain snapshots: it may write into chat_metadata (variable scopes) and must never touch $state proxies.
  const settingsPlain = $derived(plainChat.settings);
  const characterPlain = $derived(plainChat.character);
  const groupPlain = $derived(plainChat.group);
  const membersPlain = $derived(plainChat.members);
  // group: the member being generated (index into store.members); null while idle (ST name2 = '')
  let liveMember = $state<number | null>(null);
  const subject = $derived<ChatSubject>({
    character: characterPlain as unknown as CharacterLike | null,
    group: groupPlain,
    members: membersPlain,
    memberIndex: liveMember,
  });
  const ctx = $derived.by<ChatContext | null>(() =>
    settingsPlain && (characterPlain || groupPlain)
      ? createChatContext(
          settingsPlain,
          subject,
          store.userName,
          $state.snapshot(store.messages),
          structuredClone($state.snapshot(store.chatMetadata)),
        )
      : null,
  );
  // The closures read `ctx` lazily at render time (never cached while ctx is still null).
  // Reads the formatting options off the settings proxy, not `settingsPlain`: any other settings
  // write (a script setting a global variable, DEV_NOTES §9.5) must not cost the render cache.
  const renderer = $derived.by(() => {
    const pu = formatPowerUserFrom(store.settings);
    return new MessageRenderer({
      powerUser: pu,
      substitute: (t, name) => ctx?.substitute(t, name) ?? t,
      applyRegex: (t, placement, params) => ctx?.regex.getRegexedString(t, placement, params) ?? t,
    });
  });

  $effect(() => {
    if (store.open)
      onTitle?.(store.displayName, store.chatFile?.replace(/\.jsonl$/, '') ?? undefined);
    else onTitle?.('聊天', undefined);
  });

  // composer draft follows the open chat file (app_settings.json drafts, DEV_NOTES §9.22)
  $effect(() => {
    const key = store.chatRel;
    untrack(() => (draft = store.draftFor(key)));
  });
  $effect(() => {
    const text = draft;
    const key = untrack(() => store.chatRel);
    store.setDraft(key, text);
  });

  // ---- generation state ----
  interface Live {
    type: GenType;
    text: string;
    reasoning: string;
    handle: GenerationHandle | null;
    startedAt: string;
  }
  let live = $state<Live | null>(null);
  // group run in progress (generateGroup loop); aborting it stops after the current member
  let groupRun = $state<AbortController | null>(null);
  const busy = $derived(!!live || !!groupRun);
  // screen reader: one line when a reply starts and one when it is in, never the stream (§9.40)
  let spoken = $state('');
  let wasBusy = false;
  $effect(() => {
    const now = busy;
    if (now === wasBusy) return;
    wasBusy = now;
    spoken = now
      ? '正在生成回复'
      : untrack(() => {
          const last = store.messages.at(-1);
          return last && !last.is_user ? replyAnnouncement(last.name, last.mes) : '';
        });
  });
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  /** the line a running tool put into `notice`; taken down when the chain ends */
  let toolNotice: string | null = null;
  // DEV_NOTES §9.30: attachments waiting in the composer; tapped picture shown full screen
  let pendingMedia = $state<PendingMedia[]>([]);
  let lightbox = $state<{ url: string; title: string } | null>(null);
  let lastOutcome = $state<GenerationOutcome | null>(null);
  // ST #options menu / "delete messages" mode / chat file list / composer draft (impersonate writes into it)
  let optionsOpen = $state(false);
  let scriptsOpen = $state(false);
  const scriptButtons = $derived(helperBridge.scriptsOn ? scriptLibrary.buttons : []);
  // scripts that came with a card or preset stay off: say so once (DEV_NOTES §9.5)
  $effect(() => {
    const scope = scriptLibrary.unseen;
    if (!scope || !store.ready) return;
    untrack(() => {
      scriptLibrary.markSeen(scope);
      notice = `这${scope === 'character' ? '张角色卡' : '个预设'}带有脚本，默认不运行；可以在「选项 → 脚本库」里打开`;
    });
  });
  let chatsOpen = $state(false);
  let noteOpen = $state(false);
  let loreOpen = $state(false);
  let loreNames = $state<string[]>([]);
  let deleteFrom = $state<number | null>(null);
  let deleteMode = $state(false);
  let draft = $state('');
  // the stand-in page scripts see mirrors the input box and the stop button (DEV_NOTES §9.5 DOM)
  $effect(() => {
    helperPage.draft = draft;
    helperPage.generating = busy;
  });
  onDestroy(() => {
    clearTimeout(moreMessagesTimer);
    helperPage.draft = '';
    helperPage.generating = false;
  });
  const quick = $derived.by(() => {
    const pu = (settingsPlain?.['power_user'] as Record<string, unknown> | undefined) ?? {};
    return { continue: !!pu['quick_continue'], impersonate: !!pu['quick_impersonate'] };
  });
  let frame = 0;
  // getStoppingStrings for the running generation (cleanUpMessage, ST streaming processor)
  let liveStops: string[] = [];
  const cleanLive = (text: string, type: GenType, finished: boolean) =>
    ctx
      ? ctx.cleanUp(text, {
          isImpersonate: type === 'impersonate',
          isContinue: type === 'continue',
          displayIncompleteSentences: !finished,
          stoppingStrings: liveStops,
        })
      : text;
  let pendingText = '';
  let pendingReasoning = '';
  function scheduleLive(text: string, reasoning: string) {
    pendingText = text;
    pendingReasoning = reasoning;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (live) {
        live.text = cleanLive(pendingText, live.type, false);
        live.reasoning = pendingReasoning;
        if (live.type === 'impersonate') draft = live.text;
        generationHooks.token?.(live.text);
      }
    });
  }

  // ST auto_parse while streaming: a leading <think> block is shown as reasoning, the rest as content;
  // an unterminated block means "still thinking".
  const reasoningCfg = $derived.by(() => {
    const pu = (settingsPlain?.['power_user'] as Record<string, unknown> | undefined) ?? {};
    const r = {
      ...DEFAULT_REASONING_SETTINGS,
      ...((pu['reasoning'] as Record<string, unknown> | undefined) ?? {}),
    };
    return {
      autoParse: !!r['auto_parse'],
      prefix: String(r['prefix'] ?? ''),
      suffix: String(r['suffix'] ?? ''),
      trim: pu['trim_spaces'] !== false,
    };
  });
  function splitLive(text: string, reasoning: string): { content: string; reasoning: string } {
    if (reasoning || !reasoningCfg.autoParse || !reasoningCfg.prefix)
      return { content: text, reasoning };
    const trimmed = text.trimStart();
    if (!trimmed.startsWith(reasoningCfg.prefix)) return { content: text, reasoning };
    const parsed = parseReasoningFromString(text, reasoningCfg, { trimSpaces: reasoningCfg.trim });
    if (parsed && parsed.reasoning) return parsed;
    // prefix seen, suffix not yet: everything after the prefix is reasoning so far
    return { content: '', reasoning: trimmed.slice(reasoningCfg.prefix.length).trimStart() };
  }
  /** the character a new reply is attributed to: the drafted member in a group, else the character */
  const speaker = $derived.by(() => {
    if (store.group) return liveMember === null ? null : (store.members[liveMember] ?? null);
    return store.character;
  });
  const pendingRow = $derived.by<ChatMessage | null>(() => {
    if (!live || !speaker) return null;
    if (live.type === 'continue' || live.type === 'impersonate') return null;
    const parts = splitLive(live.text, live.reasoning);
    return {
      name: speaker.name,
      is_user: false,
      is_system: false,
      send_date: live.startedAt,
      mes: parts.content,
      extra: parts.reasoning ? { reasoning: parts.reasoning } : {},
      ...(store.group ? { original_avatar: speaker.avatar } : {}),
    };
  });
  /**
   * A swipe or a regenerate rewrites the last reply, so the new text streams in that reply's
   * place, as in ST (DEV_NOTES §9.44). The stored message only changes when the reply is in, so a
   * failed or stopped run brings the old one back. A group regenerate has already removed the
   * batch it replaces.
   */
  const replacesLast = $derived.by(() => {
    if (!live || !pendingRow) return false;
    if (live.type !== 'swipe' && !(live.type === 'regenerate' && !store.group)) return false;
    const last = store.messages.at(-1);
    return !!last && !last.is_user;
  });
  const rows = $derived(
    pendingRow
      ? [...(replacesLast ? store.messages.slice(0, -1) : store.messages), pendingRow]
      : store.messages,
  );

  // ST asks about a card's own world book / regex scripts the first time its chat opens; cards
  // imported here were already asked at import (DEV_NOTES §9.41)
  let extrasOffered: string | null = null;
  $effect(() => {
    const avatar = store.open && !store.group ? (store.character?.avatar ?? null) : null;
    if (!avatar || avatar === extrasOffered) return;
    extrasOffered = avatar;
    void offerCardExtras(avatar)
      .then((done) => {
        if (done.length) toasts.show('success', done.join('，'));
      })
      .catch(() => undefined);
  });

  // avatar as background (theme `background.avatar`): the large copy from `backgrounds/`, else the card PNG
  const bgAvatar = $derived(store.character?.avatar ?? store.members[0]?.avatar ?? null);
  let bgLargeFailed = $state(false);
  $effect(() => {
    void bgAvatar;
    bgLargeFailed = false;
  });
  const bgUrl = $derived.by(() => {
    if (!themeStore.current.background.avatar || !store.root || !bgAvatar) return null;
    const v = store.characters.find((c) => c.avatar === bgAvatar)?.mtime ?? 0;
    return bgLargeFailed
      ? `${fileUrl(`${store.root}/characters/${bgAvatar}`)}?v=${v}`
      : `${fileUrl(`${store.root}/${avatarBackgroundRel(bgAvatar)}`)}?v=${v}`;
  });
  // a picked background image (chat-locked, else global) goes before the avatar one (DEV_NOTES §9.42)
  const bgImageRel = $derived(
    activeBackgroundRel(settingsPlain, store.open ? store.chatMetadata : null),
  );
  const bgFitting = $derived(backgroundSettingsOf(settingsPlain).fitting);
  const rowKey = (m: ChatMessage, i: number) =>
    m === pendingRow ? 'pending' : `${i}:${m.send_date}`;
  /** rows with a front-end card stay mounted for a while after scrolling away (DEV_NOTES §9.5 保活) */
  const hasLiveCard = (_m: ChatMessage, i: number) => helperBridge.hasSlots(i);
  const lastIndex = $derived(rows.length - 1);

  // ---- jump to the top / the end: offered only while scrolling that way (DEV_NOTES §9.47) ----
  let list: { scrollToTop: () => void; scrollToBottom: () => void } | undefined = $state();
  let jump = $state<JumpTarget>(null);
  /** the last one offered: the icon stays put while the button fades out */
  let jumpShown = $state<'top' | 'bottom'>('bottom');
  function showJump(target: JumpTarget): void {
    jump = target;
    if (target) jumpShown = target;
  }
  function jumpNow(): void {
    if (jump === 'top') list?.scrollToTop();
    else if (jump === 'bottom') list?.scrollToBottom();
  }

  // ST `MORE_MESSAGES_LOADED`: messages that were not in the DOM are now (DEV_NOTES §9.34). Here
  // that is the virtual window growing at either end for a reason other than a new message.
  const MORE_MESSAGES_DELAY_MS = 250;
  let mounted = { start: 0, end: 0, count: 0 };
  let moreMessagesTimer: ReturnType<typeof setTimeout> | undefined;
  function onWindow(start: number, end: number): void {
    const before = mounted;
    mounted = { start, end, count: rows.length };
    const grew = start < before.start || end > before.end;
    if (!grew || before.count !== mounted.count || extensionHost.status !== 'running') return;
    clearTimeout(moreMessagesTimer);
    moreMessagesTimer = setTimeout(
      () => emitAppEvent('more_messages_loaded'),
      MORE_MESSAGES_DELAY_MS,
    );
  }

  function textOf(m: ChatMessage, i: number): string {
    const base = MessageRenderer.displayText(m);
    if (live?.type === 'continue' && i === store.messages.length - 1) return base + live.text;
    return base;
  }
  function htmlOf(m: ChatMessage, i: number): string {
    if (!ctx) return '';
    const text = textOf(m, i);
    const streamingRow = !!live && i === lastIndex && !m.is_user;
    if (streamingRow) return renderer.renderLive(text, m, i, store.messages);
    // a script changed this message's body through the stand-in page (DEV_NOTES §9.5 显示接口)
    return (
      helperDisplay.get(i, text) ??
      renderer.render(macroDisplay.text(i, text), m, i, store.messages)
    );
  }
  function reasoningOf(m: ChatMessage, i: number): string | undefined {
    const r = m.extra?.reasoning;
    return r ? renderer.renderReasoning(r, m, i) : undefined;
  }
  function timeOf(m: ChatMessage): string {
    const t = timestampToMoment(m.send_date);
    return t.isValid() ? t.format('HH:mm') : '';
  }
  const avatarOf = (m: ChatMessage): string | undefined => {
    if (!store.root) return undefined;
    if (m.is_user) {
      // ST: a persona message carries its own avatar; otherwise the current user avatar
      const pinned = personaFileFromForceAvatar(m['force_avatar']);
      const ua = pinned ?? store.settings?.['user_avatar'];
      return typeof ua === 'string' && ua ? userAvatarUrl(store.root, ua) : undefined;
    }
    // group messages carry original_avatar (ST saveReply); fall back to the member with that name
    const avatar = store.group
      ? typeof m['original_avatar'] === 'string'
        ? (m['original_avatar'] as string)
        : store.members.find((c) => c.name === m.name)?.avatar
      : store.character?.avatar;
    if (!avatar) return undefined;
    // the index row's mtime busts the WebView cache after the avatar was replaced
    const v = store.characters.find((c) => c.avatar === avatar)?.mtime ?? 0;
    return `${fileUrl(`${store.root}/characters/${avatar}`)}?v=${v}`;
  };

  // ---- actions ----
  async function send(text: string) {
    if (busy || !ctx || !store.open) return;
    const pu = (store.settings?.['power_user'] as Record<string, unknown> | undefined) ?? {};
    const trimmed = pu['trim_spaces'] === false ? text : text.trim();
    const last = store.messages[store.messages.length - 1];
    const hasFiles = pendingMedia.length > 0;
    // ST continue_on_send: empty send after a character message continues it
    if (
      !trimmed &&
      !hasFiles &&
      pu['continue_on_send'] &&
      last &&
      !last.is_user &&
      !last.is_system
    ) {
      await generate('continue');
      return;
    }
    try {
      // ST Generate(): sendMessageAsUser when there is text or a pending attachment
      if (trimmed || hasFiles) {
        const message = buildUserMessage(
          ctx,
          store.userName,
          trimmed,
          userForceAvatar(settingsPlain),
        );
        if (hasFiles && store.root) {
          // ST populateFileAttachment: files land in user/images/<name2>/, the message points at them
          const { media, files } = toAttachments($state.snapshot(pendingMedia));
          message.extra = {
            ...(message.extra ?? {}),
            ...(media.length ? { media, media_index: media.length - 1, inline_image: true } : {}),
            ...(files.length ? { files } : {}),
          };
          pendingMedia = [];
        }
        // ST Generate(): GENERATION_STARTED comes before the user's message is added
        if (!store.group) announceStart('normal');
        await store.append(message);
      }
    } catch (e) {
      startAnnounced = false;
      error = e instanceof Error ? e.message : String(e);
      return;
    }
    await generate('normal', trimmed);
    startAnnounced = false;
  }
  /** The send button pressed from outside the page (Composer's own `submit` does the same) */
  async function sendDraft() {
    if (busy) return;
    const text = draft;
    draft = '';
    await send(text);
  }
  async function attach() {
    if (!store.root) return;
    try {
      const picked = await pickMedia(store.root, store.displayName);
      if (picked.length) pendingMedia = [...pendingMedia, ...picked];
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  async function removePending(i: number) {
    const item = pendingMedia[i];
    pendingMedia = pendingMedia.filter((_, j) => j !== i);
    if (item && store.root) await discardMedia(store.root, $state.snapshot(item));
  }

  // ---- media on stored messages (ST appendMediaToMessage, DEV_NOTES §9.30) ----
  interface MediaInfo {
    media: MediaView[];
    display: 'list' | 'gallery';
    index: number;
    hideText: boolean;
    files: string[];
  }
  const NO_MEDIA: MediaInfo = { media: [], display: 'list', index: 0, hideText: false, files: [] };
  function mediaOf(m: ChatMessage): MediaInfo {
    if (!m.extra || !store.root) return NO_MEDIA;
    const extra = { ...m.extra } as Record<string, unknown>;
    ensureMessageMediaIsArray(extra); // legacy image / image_swipes / file, in memory only
    const list = Array.isArray(extra['media']) ? (extra['media'] as MediaAttachment[]) : [];
    // ST .mes_file_name + .mes_file_size
    const files = Array.isArray(extra['files'])
      ? (extra['files'] as { name?: string; url?: string; size?: number }[]).map((f) => {
          const name = f.name ?? f.url?.split('/').pop() ?? '附件';
          return typeof f.size === 'number' ? `${name} · ${humanFileSize(f.size)}` : name;
        })
      : [];
    if (!list.length && !files.length) return NO_MEDIA;
    const probe = { ...m, extra };
    const pu = (settingsPlain?.['power_user'] as Record<string, unknown> | undefined) ?? {};
    const root = store.root;
    return {
      media: list.map((a, index) => ({
        index,
        url: mediaUrl(root, a.url),
        kind: a.type === 'video' ? 'video' : a.type === 'audio' ? 'audio' : 'image',
        title: a.title ?? '',
      })),
      display: getMediaDisplay(probe, pu['media_display']),
      index: getMediaIndex(probe),
      hideText: list.length > 0 && extra['inline_image'] === false,
      files,
    };
  }
  /** ST deleteMediaFromMessage: drop one attachment; the last one removed clears the media keys */
  async function deleteMedia(i: number, index: number) {
    const m = store.messages[i];
    if (!m?.extra) return;
    const extra = { ...m.extra } as Record<string, unknown>;
    ensureMessageMediaIsArray(extra);
    const list = Array.isArray(extra['media']) ? [...(extra['media'] as MediaAttachment[])] : [];
    list.splice(index, 1);
    const patch: Record<string, unknown> = {
      image: undefined,
      image_swipes: undefined,
      media: list.length ? list : undefined,
      media_index: list.length
        ? Math.min(getMediaIndex({ ...m, extra }), list.length - 1)
        : undefined,
      inline_image: list.length ? extra['inline_image'] : undefined,
      title: list.length ? extra['title'] : undefined,
    };
    await store.patchMessageExtra(i, patch);
  }
  async function setMediaIndex(i: number, index: number) {
    await store.patchMessageExtra(i, { media_index: index });
  }
  function openMedia(i: number, index: number) {
    const info = mediaOf(store.messages[i]!);
    const item = info.media[index];
    if (item && item.kind === 'image') lightbox = { url: item.url, title: item.title };
  }

  // ---- checkpoints / branches (ST bookmarks.js, DEV_NOTES §9.29) ----
  async function checkpoint(i: number) {
    try {
      const name = await store.createCheckpoint(i);
      notice = name ? `已创建检查点「${name}」，点消息旁的旗子可以打开` : '无法创建检查点';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  async function branch(i: number) {
    try {
      const name = await store.createBranch(i);
      notice = name ? `已切到分支「${name}」` : '无法创建分支';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  async function openBookmark(link: string) {
    if (!store.chatNames().includes(link)) {
      notice = `检查点聊天「${link}」已不存在`;
      return;
    }
    await store.openChat(`${link}.jsonl`);
  }
  const bookmarkOf = (m: ChatMessage): string | null => {
    const v = m.extra?.['bookmark_link'];
    return typeof v === 'string' && v ? v : null;
  };

  const oaiSource = (settings: Record<string, unknown> | null) =>
    (settings?.['oai_settings'] as Record<string, unknown> | undefined)?.[
      'chat_completion_source'
    ] ?? '';
  /** `send` announced the generation it is about to start (ST order, DEV_NOTES §9.34 第 8 轮) */
  let startAnnounced = false;
  /** ST Generate(): GENERATION_STARTED(type, options, dryRun), for script and extension listeners */
  function announceStart(type: GenType) {
    if (startAnnounced) return;
    emitAppEvent('generation_started', type, {}, false);
    startAnnounced = true;
  }
  /** ST CHAT_COMPLETION_PROMPT_READY, GENERATE_AFTER_DATA: listeners may edit the messages in place */
  async function announcePrompt(messages: unknown[]) {
    await generationHooks.emit?.(event_types.CHAT_COMPLETION_PROMPT_READY, {
      chat: messages,
      dryRun: false,
    });
    await generationHooks.emit?.(event_types.GENERATE_AFTER_DATA, { prompt: messages }, false);
  }
  /**
   * ST tool calls of one reply (DEV_NOTES §9.34 第 8 轮): run them and write the record into the
   * chat. True when the results should go back to the model.
   */
  async function runToolCalls(calls: unknown[], api: string, model: string): Promise<boolean> {
    const run = await generationHooks.tools?.run(calls, (text) => (notice = toolNotice = text));
    if (!run) return false;
    if (run.errors.length) error = run.errors.map((e) => e.message).join('\n');
    if (!followsUp(run)) return false;
    await store.append(toolRecordMessage(run.invocations, api, model));
    await generationHooks.emit?.(event_types.TOOL_CALLS_PERFORMED, run.invocations);
    await generationHooks.emit?.(event_types.TOOL_CALLS_RENDERED, run.invocations);
    return true;
  }

  async function generate(type: GenType, textareaText = '') {
    if (busy || !store.root || !store.settings || !store.open) return;
    if (store.group) return generateInGroup(type, textareaText);
    error = null;
    lastOutcome = null;
    await generateOne(type, textareaText, null, null);
  }

  /**
   * ST Generate() for one speaker: build the prompt, stream, write the reply. `memberIndex`
   * selects the group member (null = single character); `genId` is the group batch id.
   */
  async function generateOne(
    type: GenType,
    textareaText: string,
    memberIndex: number | null,
    genId: number | null,
    depth = 0,
  ): Promise<void> {
    if (!store.root || !store.settings) return;
    liveMember = memberIndex;
    // the chat this reply belongs to; a different one may be open by the time it is in (§9.45)
    const origin = store.chatPath;
    live = { type, text: '', reasoning: '', handle: null, startedAt: messageTimeStamp() };
    announceStart(type);
    startAnnounced = false;
    let followUp = false;
    try {
      await generationHooks.emit?.(event_types.GENERATION_AFTER_COMMANDS, type, {}, false);
      const chat = $state.snapshot(store.messages);
      // ST runGenerationInterceptors: extensions may edit this copy, or cancel (DEV_NOTES §9.34)
      if (await generationHooks.intercept?.(chat, type)) return;
      // function tools registered by extensions; `depth` counts the follow-ups of tool calls
      const tools = (await generationHooks.tools?.definitions(type, depth)) ?? [];
      const prep = await prepareGeneration({
        root: store.root,
        settings: $state.snapshot(store.settings),
        subject: {
          character: characterPlain as unknown as CharacterLike | null,
          group: groupPlain,
          members: membersPlain,
          memberIndex,
        },
        userName: store.userName,
        chat,
        chatMetadata: structuredClone($state.snapshot(store.chatMetadata)),
        type,
        textareaText,
        extensionPrompts: chatInjectPrompts(),
        inlineMedia: inlineMediaDeps(
          store.root,
          $state.snapshot(store.settings),
          oaiRuntime.source === String(oaiSource(store.settings))
            ? $state.snapshot(oaiRuntime.models)
            : null,
        ),
        ...(tools.length ? { tools } : {}),
        canUseTools: generationHooks.tools?.supported() ?? false,
        onPrompt: announcePrompt,
      });
      showPipelineWarnings(prep.warnings);
      await applyMacroLikes(prep.request);
      liveStops = prep.stoppingStrings;
      const handle = runGeneration(prep.request, prep.secret, { onDelta: scheduleLive });
      spendInjectsWhenSent(handle);
      if (live) live.handle = handle;
      const outcome = await handle.result;
      // a frame still queued belongs to the finished stream; the outcome carries its whole text
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      lastOutcome = outcome;
      // another character or chat was opened meanwhile: the reply must not land in that one
      if (store.chatPath !== origin) return;
      const calls = outcome.state === 'done' && tools.length ? outcome.toolCalls : [];
      if (!calls.length || !isBareToolReply(type, outcome.text.trim(), outcome.reasoning))
        await finalize(
          type,
          outcome,
          prep.source,
          prep.model,
          live?.startedAt ?? messageTimeStamp(),
          genId,
        );
      if (outcome.state === 'error') error = outcome.error ?? '生成失败';
      else if (outcome.state === 'done') {
        if (calls.length) followUp = await runToolCalls(calls, prep.source, prep.model);
        if (!followUp) emitAppEvent('generation_ended', store.messages.length);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      live = null;
      liveMember = null;
    }
    // ST: the tool results go back to the model in a new generation
    if (followUp) await generateOne('normal', '', memberIndex, genId, depth + 1);
    // ST takes the tool toast down when the call returns; ours stays until the reply it led to is in
    if (depth === 0 && toolNotice) {
      if (notice === toolNotice) notice = null;
      toolNotice = null;
    }
  }

  /**
   * What the prompt had to leave out (an unreadable world book, world-info entries over budget):
   * said once per chat, not on every message (DEV_NOTES §9.44).
   */
  let warned = { chat: '', texts: new Set<string>() };
  function showPipelineWarnings(warnings: readonly string[]) {
    const chat = `${store.character?.avatar ?? store.group?.id ?? ''}/${store.chatFile ?? ''}`;
    if (warned.chat !== chat) warned = { chat, texts: new Set() };
    for (const text of warnings) {
      if (warned.texts.has(text)) continue;
      warned.texts.add(text);
      toasts.show('warning', text, '', 0);
    }
  }

  /**
   * ST generateGroupWrapper: pick the speakers (activation strategy), then Generate for each in
   * turn. Regenerate = regenerateGroup: drop the last batch (same gen_id), then a 'normal' round.
   */
  async function generateInGroup(
    type: GenType | 'auto',
    textareaText: string,
    byAutoMode = false,
  ): Promise<void> {
    if (!store.root || !store.settings || !store.group) return;
    error = null;
    lastOutcome = null;
    const abort = new AbortController();
    groupRun = abort;
    try {
      if (type === 'regenerate') {
        const n = countMessagesToRegenerate(
          $state.snapshot(store.messages) as unknown as ChatMessageLike[],
        );
        if (n > 0) await store.truncate(store.messages.length - n);
      }
      const gType: GroupGenerationType = type === 'regenerate' ? 'normal' : type;
      const generationId = Date.now();
      let first = true;
      await generateGroup(
        {
          group: $state.snapshot(store.group),
          type: gType,
          userInput: textareaText,
          byAutoMode,
        },
        {
          characters: membersPlain,
          chat: $state.snapshot(store.messages) as unknown as ChatMessageLike[],
          now: () => generationId,
        },
        {
          signal: abort.signal,
          generate: async (chId, gt) => {
            // the textarea text belongs to the first speaker only (ST clears it after sending)
            const text = first ? textareaText : '';
            first = false;
            await generateOne(gt === 'quiet' ? 'normal' : gt, text, chId, generationId);
            if (error) throw new Error(error);
          },
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!abort.signal.aborted) error = msg;
      // a failing round must not repeat on a timer
      autoMode = false;
    } finally {
      groupRun = null;
    }
  }

  // ---- group auto mode (ST #rm_group_automode + groupChatAutoModeWorker; never persisted) ----
  let autoMode = $state(false);
  const autoModeChat = $derived(`${store.group?.id ?? ''}|${store.chatFile ?? ''}`);
  // off when the chat changes, and (ST onSendTextareaInput) as soon as the user starts typing
  $effect(() => {
    void autoModeChat;
    void draft;
    untrack(() => (autoMode = false));
  });
  const autoModeDelay = $derived(Math.max(1, Number(store.group?.auto_mode_delay) || 5));
  $effect(() => {
    if (!autoMode || !store.group) return;
    const timer = setInterval(() => {
      if (busy || !store.open || !store.group?.members.length) return;
      void generateInGroup('auto', '', true);
    }, autoModeDelay * 1000);
    return () => clearInterval(timer);
  });

  function abortGeneration() {
    autoMode = false;
    groupRun?.abort();
    live?.handle?.abort();
    emitAppEvent('generation_stopped');
  }

  /** Write the reply into the chat the way ST does (swipes, swipe_info, extra.api/model/reasoning). */
  async function finalize(
    type: GenType,
    o: GenerationOutcome,
    api: string,
    model: string,
    started: string,
    genId: number | null,
  ) {
    const who = speaker;
    if (!who) return;
    const text = cleanLive(o.text, type, true);
    if (type === 'impersonate') {
      // ST: the result lands in #send_textarea, nothing is saved
      draft = text.trim();
      return;
    }
    if (!text && !o.reasoning) return;
    const finished = messageTimeStamp();
    const extra: Record<string, unknown> = { api, model };
    if (o.reasoning) {
      extra['reasoning'] = o.reasoning;
      extra['reasoning_type'] = 'model';
    }
    // ST saveReply group branch: original_avatar / force_avatar / extra.gen_id on every reply
    const groupFields = store.group ? groupMessageFields(who.avatar, genId ?? Date.now()) : null;
    if (groupFields) extra['gen_id'] = groupFields.gen_id;
    const withGroup = (m: ChatMessage): ChatMessage =>
      groupFields
        ? {
            ...m,
            original_avatar: groupFields.original_avatar,
            force_avatar: groupFields.force_avatar,
          }
        : m;
    const lastIdx = store.messages.length - 1;
    const last = store.messages[lastIdx];
    const parse = (m: ChatMessage) =>
      ctx && settingsPlain ? autoParseReasoning(ctx, settingsPlain, m) : m;
    if (type === 'continue' && last && !last.is_user) {
      const merged = { ...last, mes: last.mes + text, gen_finished: finished } as ChatMessage;
      if (merged.swipes && typeof merged.swipe_id === 'number')
        merged.swipes[merged.swipe_id] = merged.mes;
      await store.replace(lastIdx, parse(withGroup(merged)));
      return;
    }
    if (type === 'swipe' && last && !last.is_user) {
      const swipes = [...(last.swipes ?? [last.mes]), text];
      const info = [
        ...(last.swipe_info ??
          (last.swipes ?? [last.mes]).map(() => ({
            send_date: last.send_date,
            extra: last.extra ?? {},
          }))),
      ];
      info.push({ send_date: finished, gen_started: started, gen_finished: finished, extra });
      await store.replace(
        lastIdx,
        parse(
          withGroup({
            ...last,
            mes: text,
            swipe_id: swipes.length - 1,
            swipes,
            swipe_info: info,
            extra,
            gen_started: started,
            gen_finished: finished,
            send_date: finished,
          }),
        ),
      );
      return;
    }
    const message: ChatMessage = withGroup({
      name: who.name,
      is_user: false,
      is_system: false,
      send_date: finished,
      mes: text,
      extra,
      swipe_id: 0,
      swipes: [text],
      swipe_info: [{ send_date: finished, gen_started: started, gen_finished: finished, extra }],
      gen_started: started,
      gen_finished: finished,
    });
    const final = parse(message);
    if (type === 'regenerate' && last && !last.is_user) await store.replace(lastIdx, final);
    else await store.append(final);
  }

  /** ST deleteSwipe(): drop one swipe of the last message, select the neighbour, mark the chat tainted. */
  async function deleteSwipe(i: number) {
    const m = store.messages[i];
    if (!m || busy || !Array.isArray(m.swipes) || m.swipes.length <= 1) return;
    const swipes = m.swipes.slice();
    const info = Array.isArray(m.swipe_info) ? m.swipe_info.slice() : [];
    const current = Math.min(Math.max(Number(m.swipe_id ?? 0), 0), swipes.length - 1);
    swipes.splice(current, 1);
    if (info.length) info.splice(current, 1);
    const next = Math.min(current, swipes.length - 1);
    const nextInfo = info[next];
    try {
      await store.replace(i, {
        ...m,
        swipes,
        ...(info.length ? { swipe_info: info } : {}),
        swipe_id: next,
        mes: swipes[next] ?? '',
        ...(nextInfo?.send_date ? { send_date: nextInfo.send_date } : {}),
        ...(nextInfo?.extra ? { extra: nextInfo.extra as ChatMessage['extra'] } : {}),
      });
      await store.setChatMetadata({ tainted: true });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // ---- chat files: search / rename / delete / export (DEV_NOTES §9.27) ----
  let chatQuery = $state('');
  // ST #chat_import_file: freshly imported files are highlighted in the list (displayPastChats(names))
  let importedChats = $state<string[]>([]);
  async function importChats() {
    if (!store.root || busy) return;
    const paths = await pickFiles({
      extensions: ['json', 'jsonl'],
      multiple: true,
      title: '导入聊天',
    });
    if (!paths.length) return;
    const stamp = humanizedDateTime();
    try {
      const r = store.group
        ? await importGroupChats(store.root, $state.snapshot(store.group) as Group, paths, stamp)
        : store.character
          ? await importCharacterChats(
              store.root,
              { avatar: store.character.avatar, name: store.character.name },
              store.userName,
              paths,
              stamp,
              store.chats.map((c) => c.file),
            )
          : null;
      if (!r) return;
      if (store.group && r.imported.length) await store.reloadGroup();
      await store.refreshChats();
      importedChats = r.imported;
      notice = [r.imported.length ? `已导入 ${r.imported.length} 个聊天` : '', ...r.errors]
        .filter(Boolean)
        .join('；');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  let chatHits = $state<Map<string, SearchHit>>(new Map());
  let chatSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let renameChatTarget = $state<ChatRow | null>(null);
  let renameChatTo = $state('');
  let deleteChatTarget = $state<ChatRow | null>(null);
  const visibleChats = $derived.by(() => {
    const q = chatQuery.trim().toLowerCase();
    if (!q) return store.chats;
    return store.chats.filter((c) => c.file.toLowerCase().includes(q) || chatHits.has(c.file));
  });
  function scheduleChatSearch() {
    if (chatSearchTimer) clearTimeout(chatSearchTimer);
    chatSearchTimer = setTimeout(async () => {
      if (!store.root || !store.character || !chatQuery.trim()) {
        chatHits = new Map();
        return;
      }
      try {
        chatHits = await searchCharacterChats(store.root, store.character.avatar, chatQuery);
      } catch {
        chatHits = new Map();
      }
    }, 250);
  }
  const chatPathOf = (c: ChatRow) =>
    store.group
      ? groupChatPath(store.root ?? '', chatStem(c.file))
      : `${store.root}/${characterChatRel(store.character?.avatar ?? '', c.file)}`;
  /** Run a per-row action; errors land in the banner (the row is passed explicitly, never read later). */
  function runChatAction(row: ChatRow, action: (row: ChatRow) => Promise<void>) {
    void action(row).catch((e) => (error = e instanceof Error ? e.message : String(e)));
  }
  async function doRenameChat() {
    const c = renameChatTarget;
    if (!c || !store.root) return;
    renameChatTarget = null;
    try {
      // scripts may have left changes that are not in the files yet (DEV_NOTES §9.5)
      await store.flushDeferred();
      const wasCurrent = c.file === store.chatFile;
      let nextFile: string;
      if (store.group) {
        const group = $state.snapshot(store.group) as Group;
        nextFile = `${await renameGroupChat(store.root, group, chatStem(c.file), renameChatTo)}.jsonl`;
        await store.reloadGroup();
      } else if (store.character) {
        nextFile = (
          await renameCharacterChat(store.root, store.character.avatar, c.file, renameChatTo)
        ).file;
      } else return;
      await store.refreshChats();
      if (wasCurrent) await store.openChat(nextFile);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  /** ST doDeleteChat / deleteGroupChat: drop the file, then land on the newest remaining chat or a fresh one */
  async function doDeleteChat() {
    const c = deleteChatTarget;
    if (!c || !store.root) return;
    deleteChatTarget = null;
    try {
      // scripts may have left changes that are not in the files yet (DEV_NOTES §9.5)
      await store.flushDeferred();
      const wasCurrent = c.file === store.chatFile;
      if (store.group) {
        const group = $state.snapshot(store.group) as Group;
        await deleteGroupChat(store.root, group, chatStem(c.file));
        await store.reloadGroup();
        if (wasCurrent) {
          const last = store.group?.chats?.at(-1);
          if (last) await store.openChat(`${last}.jsonl`);
          else await store.newChat();
        }
      } else if (store.character) {
        await deleteCharacterChat(store.root, store.character.avatar, c.file);
        await store.refreshChats();
        if (wasCurrent) {
          const next = store.chats[0];
          if (next) await store.openChat(next.file);
          else await store.newChat();
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  async function exportChatFile(c: ChatRow, format: 'jsonl' | 'txt') {
    if (!store.root) return;
    const stem = chatStem(c.file);
    let target;
    if (format === 'jsonl') target = await exportFileCopy(chatPathOf(c), `${stem}.jsonl`);
    else {
      const messages =
        c.file === store.chatFile
          ? ($state.snapshot(store.messages) as ChatMessage[])
          : (await chatReadTail(chatPathOf(c), 100_000)).messages.map((l) =>
              parseChatMessage(JSON.parse(l)),
            );
      target = await exportText(`${stem}.txt`, chatToTxt(messages));
    }
    if (target) notice = await describeExport(target);
  }

  // ---- author's note (ST authors-note.js: chat_metadata note_* with extension_settings.note defaults) ----
  interface NoteForm {
    prompt: string;
    interval: number;
    depth: number;
    position: 'chat' | 'after';
    role: '0' | '1' | '2';
  }
  let noteForm = $state<NoteForm>({
    prompt: '',
    interval: 1,
    depth: 4,
    position: 'chat',
    role: '0',
  });
  function openNote() {
    const ext =
      (settingsPlain?.['extension_settings'] as Record<string, unknown> | undefined) ?? {};
    const note = structuredClone((ext['note'] as NoteSettings | undefined) ?? {});
    const meta = structuredClone($state.snapshot(store.chatMetadata));
    ensureNoteDefaults(meta, note);
    noteForm = {
      prompt: String(meta[NOTE_METADATA_KEYS.prompt] ?? ''),
      interval: Number(meta[NOTE_METADATA_KEYS.interval] ?? 1),
      depth: Number(meta[NOTE_METADATA_KEYS.depth] ?? 4),
      position: Number(meta[NOTE_METADATA_KEYS.position] ?? 1) === 0 ? 'after' : 'chat',
      role: String(Number(meta[NOTE_METADATA_KEYS.role] ?? 0)) as NoteForm['role'],
    };
    noteOpen = true;
  }
  async function saveNote() {
    try {
      await store.setChatMetadata({
        [NOTE_METADATA_KEYS.prompt]: noteForm.prompt,
        [NOTE_METADATA_KEYS.interval]: Math.max(0, Math.floor(Number(noteForm.interval) || 0)),
        [NOTE_METADATA_KEYS.depth]: Math.max(0, Math.floor(Number(noteForm.depth) || 0)),
        [NOTE_METADATA_KEYS.position]: noteForm.position === 'after' ? 0 : 1,
        [NOTE_METADATA_KEYS.role]: Number(noteForm.role),
      });
      noteOpen = false;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // ---- chat lorebook: `chat_metadata.world_info` (DEV_NOTES §9.35) ----
  const chatLore = $derived(String(store.chatMetadata['world_info'] ?? ''));
  async function openLore() {
    try {
      loreNames = store.root ? await listWorldNames(store.root) : [];
      loreOpen = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  async function pickLore(name: string) {
    loreOpen = false;
    if (name === chatLore) return;
    try {
      await store.setChatMetadata({ world_info: name || undefined });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** ST messageEditDone → updateMessage + re-render; reasoning auto-parse runs on MESSAGE_UPDATED too */
  async function editMessage(i: number, text: string) {
    const m = store.messages[i];
    if (!m || !ctx || !settingsPlain || busy) return;
    const pu = (settingsPlain['power_user'] as Record<string, unknown> | undefined) ?? {};
    try {
      await store.replace(
        i,
        autoParseReasoning(
          ctx,
          settingsPlain,
          applyEdit(ctx, m, text, pu['trim_spaces'] !== false),
        ),
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** ST deleteMessage(id): remove exactly one message (edit toolbar 🗑) */
  async function deleteMessage(i: number) {
    if (busy) return;
    try {
      if (i === store.messages.length - 1) await store.truncate(i);
      else await store.remove(i);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  /** ST "Delete messages": picking a message selects it and everything after it; confirm truncates. */
  async function confirmDelete() {
    if (deleteFrom === null) return;
    try {
      await store.truncate(deleteFrom);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    deleteMode = false;
    deleteFrom = null;
  }
  async function move(i: number, dir: -1 | 1) {
    if (busy) return;
    const j = i + dir;
    if (j < 0 || j >= store.messages.length) return;
    await store.swap(i, j);
  }
  /** ST mes_hide / mes_unhide: toggle is_system (hidden from prompts, still rendered with the ghost mark) */
  async function toggleHidden(i: number) {
    const m = store.messages[i];
    if (!m || busy) return;
    await store.replace(i, { ...m, is_system: !m.is_system });
  }
  /**
   * One tap for "this message and everything before it": hide them all, or — on a hidden message —
   * show them all again (DEV_NOTES §9.47). Asks first: it can touch hundreds of messages.
   */
  async function toggleHiddenThrough(i: number) {
    const m = store.messages[i];
    if (!m || busy) return;
    const hidden = !m.is_system;
    const count = countHiddenChange(store.messages, 0, i, hidden);
    const ok = await askPopup({
      kind: 'confirm',
      title: hidden ? '隐藏此楼及之前' : '取消隐藏此楼及之前',
      text: hidden
        ? `这一楼和它前面的楼层（共 ${count} 条）会被隐藏：它们不再发给 AI，但还留在聊天里，随时可以取消隐藏。`
        : `这一楼和它前面被隐藏的楼层（共 ${count} 条）会重新发给 AI。`,
      okButton: hidden ? '隐藏' : '取消隐藏',
      cancelButton: '不了',
    });
    // the chat may have moved on while the question was up
    if (ok !== true || busy || store.messages[i] !== m) return;
    try {
      const n = await store.setHiddenRange(0, i, hidden);
      toasts.show('success', hidden ? `已隐藏 ${n} 条` : `已取消隐藏 ${n} 条`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  function runOption(action: () => void | Promise<void>) {
    optionsOpen = false;
    void action();
  }

  /** ST `loadFromSwipeId`: show one stored swipe of a message */
  async function loadSwipe(index: number, swipeId: number) {
    const message = store.messages[index];
    const next = message && !busy ? withSwipe(message, swipeId) : null;
    if (next) await store.replace(index, next);
  }
  async function swipe(dir: -1 | 1) {
    const idx = store.messages.length - 1;
    const last = store.messages[idx];
    if (!last || last.is_user || busy) return;
    const next = (last.swipe_id ?? 0) + dir;
    if (next < 0) return;
    if (next >= (last.swipes?.length ?? 1)) {
      await generate('swipe');
      return;
    }
    await loadSwipe(idx, next);
  }
</script>

<div class="tm-chat-page" class:tm-chat-page--hidden={!active}>
  {#if !isTauri()}
    <section class="tm-chat__empty">
      <p>聊天页需要在 app 里运行（读取本地角色与对话）。</p>
    </section>
  {:else if store.error}
    <section class="tm-chat__empty">
      <p class="tm-chat__error">{store.error}</p>
      <button class="tm-chat__link" onclick={() => (store.error = null)}>关闭</button>
    </section>
  {:else if !store.open}
    <section class="tm-chat__picker welcomePanel">
      <h2 class="tm-chat__picker-title">选择角色</h2>
      {#if onOpenCharacters}
        <p class="tm-chat__hint">
          <button class="tm-chat__link" onclick={onOpenCharacters}>去角色列表导入 / 管理 →</button>
        </p>
      {/if}
      {#if store.loading}
        <p class="tm-chat__hint">读取中…</p>
      {:else if store.characters.length === 0 && store.groups.length === 0}
        <p class="tm-chat__hint">
          还没有角色。把 ST 的 <code>characters/</code> 卡片放进数据目录，或导入 ST 备份 zip。
        </p>
        <p class="tm-chat__hint tm-chat__path">{store.root}</p>
        <button class="tm-chat__link" onclick={() => store.refreshCharacters()}>重新扫描</button>
      {:else}
        <ul class="tm-chat__cards">
          {#each store.groups as g (g.id)}
            <li>
              <button class="tm-chat__card" onclick={() => store.openGroup(g.id)}>
                <span class="tm-chat__card-avatar tm-chat__card-collage">
                  <GroupCollage
                    avatars={groupCollageAvatars(g, store.characters)}
                    custom={g.avatar_url}
                    root={store.root ?? ''}
                  />
                </span>
                <span class="tm-chat__card-name">{g.name}</span>
                <span class="tm-chat__card-sub">群聊 · {g.members.length} 人</span>
                {#if g.fav === true || g.fav === 'true'}<span
                    class="tm-chat__card-fav"
                    aria-label="收藏">★</span
                  >{/if}
              </button>
            </li>
          {/each}
          {#each store.characters as c (c.avatar)}
            <li>
              <button class="tm-chat__card" onclick={() => store.openCharacter(c.avatar)}>
                <img
                  class="tm-chat__card-avatar"
                  src={fileUrl(`${store.root}/characters/${c.avatar}`)}
                  alt=""
                />
                <span class="tm-chat__card-name">{c.name}</span>
                {#if c.fav}<span class="tm-chat__card-fav" aria-label="收藏">★</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {:else}
    <div id="sheld" class="tm-chat" {@attach helperDisplay.listen}>
      <!-- ST #bg1: always there, so theme CSS can paint it too -->
      <div
        id="bg1"
        class="tm-chat__bg {bgImageRel && bgFitting !== 'classic' ? bgFitting : ''}"
        class:tm-chat__bg--image={!!bgImageRel}
        style:background-image={bgImageRel && store.root
          ? `url("${fileUrl(`${store.root}/${bgImageRel}`)}")`
          : null}
        aria-hidden="true"
      >
        {#if bgUrl && !bgImageRel}
          <img class="tm-chat__bg-img" src={bgUrl} alt="" onerror={() => (bgLargeFailed = true)} />
        {/if}
      </div>
      <p class="tm-sr-only" aria-live="polite">{spoken}</p>
      <VirtualList
        id="chat"
        class="tm-chat__scroll"
        items={rows}
        key={rowKey}
        estimate={140}
        followBottom={true}
        keepAlive={hasLiveCard}
        {onWindow}
        onJump={showJump}
        bind:this={list}
      >
        {#snippet header()}
          <div class="tm-chat__top">
            <p class="tm-chat__divider">
              <span>{store.total} 条 · {store.chatFile?.replace(/\.jsonl$/, '')}</span>
            </p>
          </div>
        {/snippet}
        {#snippet row(m, i, attach, parked)}
          {@const prev = rows[i - 1]}
          <!-- media goes in as plain props: a spread would tie every prop read in the row to the
             row index, re-running the row's effects each time the virtual window shifts -->
          {@const attached = mediaOf(m)}
          <MessageItem
            {attach}
            {parked}
            index={i}
            name={m.name}
            isUser={m.is_user}
            isSystem={!!m.is_system}
            time={timeOf(m)}
            html={htmlOf(m, i)}
            reasoningHtml={reasoningOf(m, i)}
            avatarUrl={avatarOf(m)}
            grouped={!!prev && prev.name === m.name && prev.is_user === m.is_user}
            streaming={!!live && i === lastIndex && !m.is_user}
            isLast={i === lastIndex}
            swipe={m.swipes && m.swipes.length > 0
              ? { id: m.swipe_id ?? 0, count: m.swipes.length }
              : { id: 0, count: 1 }}
            rawText={m.mes}
            selectMode={deleteMode}
            selected={deleteFrom !== null && i >= deleteFrom}
            onSelect={() => (deleteFrom = i)}
            onEdit={m === pendingRow || live ? undefined : (text) => editMessage(i, text)}
            onDelete={m === pendingRow ? undefined : () => deleteMessage(i)}
            onDeleteSwipe={m !== pendingRow &&
            i === store.messages.length - 1 &&
            (m.swipes?.length ?? 0) > 1
              ? () => deleteSwipe(i)
              : undefined}
            onMoveUp={i > 0 ? () => move(i, -1) : undefined}
            onMoveDown={i < store.messages.length - 1 ? () => move(i, 1) : undefined}
            onToggleHidden={() => toggleHidden(i)}
            onToggleHiddenThrough={i > 0 && m !== pendingRow
              ? () => toggleHiddenThrough(i)
              : undefined}
            onSwipe={swipe}
            bookmarkLink={bookmarkOf(m)}
            onOpenBookmark={() => {
              const link = bookmarkOf(m);
              if (link) void openBookmark(link);
            }}
            onCheckpoint={m === pendingRow || busy ? undefined : () => checkpoint(i)}
            onBranch={m === pendingRow || busy ? undefined : () => branch(i)}
            media={attached.media}
            mediaDisplay={attached.display}
            mediaIndex={attached.index}
            hideText={attached.hideText}
            fileNames={attached.files}
            onMediaOpen={(index) => openMedia(i, index)}
            onMediaDelete={m === pendingRow ? undefined : (index) => deleteMedia(i, index)}
            onMediaIndex={(index) => setMediaIndex(i, index)}
          />
        {/snippet}
      </VirtualList>
      <!-- no height of its own: the button floats over the end of the list, above whatever follows -->
      <div class="tm-chat__jump">
        <button
          class="tm-chat__jump-button"
          class:tm-chat__jump-button--shown={jump !== null}
          title={jumpShown === 'top' ? '回到顶部' : '回到底部'}
          aria-label={jumpShown === 'top' ? '回到顶部' : '回到底部'}
          onclick={jumpNow}
          ><Icon name={jumpShown === 'top' ? 'angles-up' : 'angles-down'} /></button
        >
      </div>
      {#if error}
        <div class="tm-chat__column tm-chat__banner" role="alert">
          <span>{error}</span>
          <button class="tm-chat__link" onclick={() => (error = null)}>关闭</button>
        </div>
      {/if}
      {#if notice}
        <div class="tm-chat__column tm-chat__banner tm-chat__banner--info">
          <span>{notice}</span>
          <button class="tm-chat__link" onclick={() => (notice = null)}>关闭</button>
        </div>
      {/if}
      {#if scriptRuns.visible.length > 0}
        <div class="tm-chat__column tm-chat__banner tm-chat__banner--info" role="status">
          <span>脚本正在生成…</span>
          <button class="tm-chat__link" onclick={() => stopScriptGeneration(null)}>停止</button>
        </div>
      {/if}
      {#if scriptButtons.length > 0 && !deleteMode}
        <div id="tm_script_buttons" class="tm-chat__column tm-chat__scriptbar">
          {#each scriptButtons as button (`${button.scriptId}|${button.name}`)}
            <button
              class="tm-chat__scriptbtn qr--button menu_button"
              onclick={() => helperBridge.emit(buttonEvent(button.scriptId, button.name))}
              >{button.name}</button
            >
          {/each}
        </div>
      {/if}
      {#if deleteMode}
        <div id="dialogue_del_mes" class="tm-chat__column tm-chat__delbar">
          <span
            >{deleteFrom === null
              ? '点一条消息：从它到末尾都会删掉'
              : `将删除 ${store.messages.length - deleteFrom} 条`}</span
          >
          <span class="tm-chat__delbar-actions">
            <button
              class="tm-chat__link"
              onclick={() => {
                deleteMode = false;
                deleteFrom = null;
              }}>取消</button
            >
            <button
              class="tm-chat__link tm-chat__link--danger"
              disabled={deleteFrom === null}
              onclick={confirmDelete}>删除</button
            >
          </span>
        </div>
      {:else}
        <Composer
          bind:draft
          {busy}
          disabled={store.loading}
          quickContinue={quick.continue}
          quickImpersonate={quick.impersonate}
          onSend={send}
          onAbort={abortGeneration}
          onOptions={() => (optionsOpen = true)}
          onContinue={() => generate('continue')}
          onImpersonate={() => generate('impersonate')}
          attachments={pendingMedia}
          onRemoveAttachment={removePending}
          onExtensions={() => (extensionHost.menuOpen = true)}
        />
      {/if}
    </div>

    <BottomSheet
      id="options"
      open={optionsOpen}
      title="选项"
      startAtEnd
      onClose={() => (optionsOpen = false)}
    >
      {#if isTauri()}
        <button
          id="attachFile"
          class="tm-opt"
          disabled={store.loading}
          onclick={() => runOption(attach)}
        >
          <Icon name="paperclip" /><span>附加图片 / 文件</span>
        </button>
      {/if}
      {#if extensionHost.status === 'running'}
        <button
          id="tm_option_extensions"
          class="tm-opt"
          onclick={() => runOption(() => void (extensionHost.menuOpen = true))}
        >
          <Icon name="wand" /><span>扩展</span><small>扩展加的入口</small>
        </button>
      {/if}
      <button id="chat_lorebook_button" class="tm-opt" onclick={() => runOption(openLore)}>
        <Icon name="file-lines" /><span>聊天世界书</span><small
          >{chatLore || '只在本聊天生效的世界书'}</small
        >
      </button>
      {#if store.group}
        <button
          class="tm-opt"
          role="switch"
          aria-checked={autoMode}
          onclick={() => runOption(() => void (autoMode = !autoMode))}
        >
          <Icon name={autoMode ? 'stop' : 'wand'} /><span
            >{autoMode ? '关闭自动模式' : '自动模式'}</span
          ><small
            >{autoMode
              ? '成员正在自动接话'
              : `每 ${autoModeDelay} 秒让成员自动接话，打字或停止就关`}</small
          >
        </button>
      {/if}
      {#if store.group && onEditGroup}
        <button
          class="tm-opt"
          onclick={() =>
            runOption(() => {
              if (store.group) onEditGroup(store.group.id);
            })}
        >
          <Icon name="user" /><span>群组设定</span><small>成员、发言顺序、生成模式</small>
        </button>
      {:else if onEditCharacter}
        <button
          class="tm-opt"
          onclick={() =>
            runOption(() => {
              if (store.character) onEditCharacter(store.character.avatar);
            })}
        >
          <Icon name="user" /><span>角色设定</span><small>编辑卡片、标签、头像</small>
        </button>
      {/if}
      {#if isTauri()}
        <button
          id="tm_option_helper_render"
          class="tm-opt"
          aria-pressed={store.helperRender}
          onclick={() => store.setHelperRender(!store.helperRender)}
        >
          <Icon name="wand" /><span>前端卡片渲染</span><small
            >{store.helperRender
              ? helperBridge.status === 'unsupported'
                ? '此设备不支持'
                : '已开启'
              : '已关闭'}</small
          >
        </button>
        <button
          id="tm_option_scripts"
          class="tm-opt"
          onclick={() => {
            optionsOpen = false;
            scriptsOpen = true;
          }}
        >
          <Icon name="code" /><span>脚本库</span><small
            >{scriptLibrary.state.running.length
              ? `${scriptLibrary.state.running.length} 个脚本在运行`
              : '没有运行中的脚本'}</small
          >
        </button>
      {/if}
      <!-- from here down: ST's own options, in ST's order (its menu reads bottom-up from the button) -->
      <button id="option_toggle_AN" class="tm-opt" onclick={() => runOption(openNote)}>
        <Icon name="pencil" /><span>作者注释</span><small
          >{String(store.chatMetadata[NOTE_METADATA_KEYS.prompt] ?? '').trim()
            ? '已设置'
            : '本聊天的注入提示'}</small
        >
      </button>
      {#if store.mainChat()}
        <button
          id="option_back_to_main"
          class="tm-opt"
          disabled={busy}
          onclick={() => runOption(() => store.backToMainChat())}
        >
          <Icon name="arrow-left" /><span>回到主聊天</span><small>{store.mainChat()}</small>
        </button>
      {/if}
      <button
        id="option_new_bookmark"
        class="tm-opt"
        disabled={busy || store.messages.length === 0}
        onclick={() => runOption(() => checkpoint(store.messages.length - 1))}
      >
        <Icon name="flag-checkered" /><span>创建检查点</span><small
          >把到目前为止的聊天另存一份</small
        >
      </button>
      <button
        id="option_start_new_chat"
        class="tm-opt"
        disabled={busy}
        onclick={() => runOption(() => store.newChat())}
      >
        <Icon name="plus" /><span>开始新聊天</span>
      </button>
      <button
        id="option_select_chat"
        class="tm-opt"
        onclick={() =>
          runOption(() => {
            chatsOpen = true;
          })}
      >
        <Icon name="bars" /><span>管理聊天文件</span><small>{store.chats.length} 个</small>
      </button>
      <button
        id="option_delete_mes"
        class="tm-opt"
        disabled={!!live}
        onclick={() =>
          runOption(() => {
            deleteMode = true;
            deleteFrom = null;
          })}
      >
        <Icon name="trash" /><span>删除消息</span>
      </button>
      <button
        id="option_regenerate"
        class="tm-opt"
        disabled={busy}
        onclick={() => runOption(() => generate('regenerate'))}
      >
        <Icon name="chevron-right" /><span>重新生成</span>
      </button>
      <button
        id="option_impersonate"
        class="tm-opt"
        disabled={busy}
        onclick={() => runOption(() => generate('impersonate'))}
      >
        <Icon name="mask" /><span>AI 帮答</span><small>让 AI 为你写这条消息</small>
      </button>
      <button
        id="option_continue"
        class="tm-opt"
        disabled={busy}
        onclick={() => runOption(() => generate('continue'))}
      >
        <Icon name="arrow-right" /><span>续写</span><small>续写上一条消息</small>
      </button>
    </BottomSheet>
    <ScriptLibrary open={scriptsOpen} onClose={() => (scriptsOpen = false)} />

    <BottomSheet open={loreOpen} title="聊天世界书" onClose={() => (loreOpen = false)}>
      <button class="tm-opt" onclick={() => pickLore('')}>
        <Icon name={chatLore ? 'xmark' : 'check'} /><span>无</span>
      </button>
      {#each loreNames as name (name)}
        <button class="tm-opt chat_world_info_selector" onclick={() => pickLore(name)}>
          <Icon name={name === chatLore ? 'check' : 'file-lines'} /><span>{name}</span>
        </button>
      {/each}
      {#if chatLore && !loreNames.includes(chatLore)}
        <p class="tm-form__sheet-text">当前绑定的「{chatLore}」文件不存在。</p>
      {/if}
      {#if loreNames.length === 0}
        <p class="tm-form__sheet-text">还没有世界书，可以在「世界书」页新建或导入。</p>
      {/if}
    </BottomSheet>

    <BottomSheet
      id="floatingPrompt"
      open={noteOpen}
      title="作者注释"
      onClose={() => (noteOpen = false)}
    >
      <div class="tm-note">
        <label class="tm-form__field">
          <span class="tm-form__label">注释内容</span>
          <textarea
            id="extension_floating_prompt"
            class="text_pole tm-form__textarea"
            rows="4"
            bind:value={noteForm.prompt}
            placeholder="每次生成都会注入的提示，例如风格要求"></textarea>
        </label>
        <div class="tm-form__field">
          <span class="tm-form__label">插入位置</span>
          <Segmented
            label="插入位置"
            bind:value={noteForm.position}
            options={[
              { value: 'chat', label: '聊天中（按深度）' },
              { value: 'after', label: '场景之后' },
            ]}
          />
        </div>
        <div class="tm-form__row">
          <label class="tm-form__field tm-form__field--narrow">
            <span class="tm-form__label">深度</span>
            <input
              id="extension_floating_depth"
              class="text_pole tm-form__input"
              type="number"
              min="0"
              max="9999"
              bind:value={noteForm.depth}
              disabled={noteForm.position !== 'chat'}
            />
          </label>
          <label class="tm-form__field tm-form__field--narrow">
            <span class="tm-form__label">间隔 <small>每 N 条消息</small></span>
            <input
              id="extension_floating_interval"
              class="text_pole tm-form__input"
              type="number"
              min="0"
              max="999"
              bind:value={noteForm.interval}
            />
          </label>
        </div>
        <div class="tm-form__field">
          <span class="tm-form__label">角色</span>
          <Segmented
            label="角色"
            bind:value={noteForm.role}
            options={[
              { value: '0', label: '系统' },
              { value: '1', label: '用户' },
              { value: '2', label: '助手' },
            ]}
          />
        </div>
        <div class="tm-form__actions">
          <Button variant="outline" size="sm" onclick={() => (noteOpen = false)}>取消</Button>
          <Button variant="primary" size="sm" onclick={saveNote}>保存</Button>
        </div>
      </div>
    </BottomSheet>

    <BottomSheet
      id="select_chat_popup"
      open={chatsOpen}
      title="聊天文件"
      onClose={() => (chatsOpen = false)}
    >
      <div class="tm-chatlist">
        <div class="tm-chatlist__tools">
          <button
            id="chat_import_button"
            class="menu_button tm-form__chip"
            disabled={busy}
            onclick={importChats}><Icon name="file-export" size="sm" />导入聊天</button
          >
          <span class="tm-form__hint"
            >{store.group
              ? '只支持酒馆 .jsonl'
              : '酒馆 .jsonl，或 Kobold / CAI / ooba / Agnai / Risu 的 .json'}</span
          >
        </div>
        <input
          aria-label="搜索聊天"
          class="text_pole tm-form__input tm-chatlist__search"
          type="search"
          placeholder={store.group ? '搜索文件名' : '搜索文件名或消息内容'}
          bind:value={chatQuery}
          oninput={scheduleChatSearch}
          autocapitalize="off"
          autocorrect="off"
        />
        {#if visibleChats.length === 0}
          <p class="tm-form__hint">{chatQuery ? '没有匹配的聊天。' : '还没有聊天。'}</p>
        {/if}
        {#each visibleChats as c (c.file)}
          {@const hit = chatHits.get(c.file)}
          <!-- ST .select_chat_block_wrapper: name + pencil, meta, action icons, preview -->
          <div
            class="tm-chatrow select_chat_block_wrapper"
            class:is-active={c.file === store.chatFile}
            class:is-new={importedChats.includes(c.file)}
            file_name={c.file}
          >
            <div class="tm-chatrow__head select_chat_block" file_name={c.file}>
              <button
                class="tm-chatrow__open"
                onclick={() => {
                  chatsOpen = false;
                  store.openChat(c.file).catch((e: unknown) => {
                    toasts.show(
                      'error',
                      `打不开这个聊天，还停在原来的聊天：${e instanceof Error ? e.message : String(e)}`,
                      '',
                      0,
                    );
                  });
                }}
              >
                <span class="tm-form__item-name select_chat_block_filename">{chatStem(c.file)}</span
                >
                <span class="tm-form__item-meta chat_messages_num">{c.mes_count} 条</span>
              </button>
              <span class="tm-chatrow__actions select_chat_actions">
                <button
                  class="tm-form__icon renameChatButton"
                  title="重命名"
                  aria-label="重命名"
                  disabled={busy}
                  onclick={() => {
                    renameChatTarget = c;
                    renameChatTo = chatStem(c.file);
                  }}><Icon name="pencil" size="sm" /></button
                >
                <button
                  class="tm-form__icon exportRawChatButton"
                  title="导出 .jsonl（原文件，可导回酒馆）"
                  aria-label="导出 .jsonl"
                  data-format="jsonl"
                  onclick={() => runChatAction(c, (row) => exportChatFile(row, 'jsonl'))}
                  ><Icon name="file-export" size="sm" /></button
                >
                <button
                  class="tm-form__icon exportChatButton"
                  title="导出 .txt（纯文本）"
                  aria-label="导出 .txt"
                  data-format="txt"
                  onclick={() => runChatAction(c, (row) => exportChatFile(row, 'txt'))}
                  ><Icon name="file-lines" size="sm" /></button
                >
                <button
                  class="tm-form__icon tm-chatrow__danger PastChat_cross"
                  title="删除聊天"
                  aria-label="删除聊天"
                  disabled={busy}
                  file_name={c.file}
                  onclick={() => (deleteChatTarget = c)}><Icon name="trash" size="sm" /></button
                >
              </span>
            </div>
            {#if hit || c.last_mes}
              <p class="tm-chatrow__preview select_chat_block_mes">
                {hit ? `匹配：${hit.snippet.slice(0, 80)}` : (c.last_mes ?? '').slice(0, 80)}
              </p>
            {/if}
          </div>
        {/each}
      </div>
    </BottomSheet>

    <BottomSheet
      open={!!renameChatTarget}
      title="重命名聊天"
      onClose={() => (renameChatTarget = null)}
    >
      <div class="tm-chatlist">
        <input
          aria-label="聊天的新名字"
          class="text_pole tm-form__input"
          type="text"
          bind:value={renameChatTo}
          autocapitalize="off"
          autocorrect="off"
          onkeydown={(e) => {
            if (e.key === 'Enter') void doRenameChat();
          }}
        />
        <div class="tm-form__sheet-actions">
          <Button variant="outline" onclick={() => (renameChatTarget = null)}>取消</Button>
          <Button variant="primary" disabled={!renameChatTo.trim()} onclick={doRenameChat}
            >重命名</Button
          >
        </div>
      </div>
    </BottomSheet>

    {#if lightbox}
      <!-- ST zoomed image popup: tap anywhere to close -->
      <div
        class="tm-lightbox"
        role="button"
        tabindex="0"
        aria-label="关闭大图"
        onclick={() => (lightbox = null)}
        onkeydown={(e) => {
          if (e.key === 'Escape' || e.key === 'Enter') lightbox = null;
        }}
      >
        <img class="tm-lightbox__img" src={lightbox.url} alt={lightbox.title} />
        {#if lightbox.title}<span class="tm-lightbox__title">{lightbox.title}</span>{/if}
      </div>
    {/if}

    <BottomSheet
      open={!!deleteChatTarget}
      title="删除聊天"
      onClose={() => (deleteChatTarget = null)}
    >
      <p class="tm-form__sheet-text">
        删除「{deleteChatTarget
          ? chatStem(deleteChatTarget.file)
          : ''}」？{deleteChatTarget?.mes_count ?? 0} 条消息会一起删掉，无法撤销。
      </p>
      <div class="tm-form__sheet-actions">
        <Button variant="outline" onclick={() => (deleteChatTarget = null)}>取消</Button>
        <Button variant="primary" class="tm-chat__danger-btn" onclick={doDeleteChat}>删除</Button>
      </div>
    </BottomSheet>
  {/if}
</div>

<style>
  /* no box of its own: the page's parts lay out as children of the app shell, as before */
  .tm-chat-page {
    display: contents;
  }
  .tm-chat-page--hidden {
    display: none;
  }
  .tm-chat {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* avatar background: fixed behind the list, dimmed by the theme opacity, optional blur */
  .tm-chat__bg {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  /* a picked image: ST css/backgrounds.css fitting rules, dimmed / blurred like the avatar one */
  .tm-chat__bg--image {
    background-repeat: no-repeat;
    background-size: cover;
    opacity: var(--tm-chat-bg-opacity);
    filter: blur(var(--tm-chat-bg-blur));
  }
  .tm-chat__bg--image:global(.cover) {
    background-position: center;
  }
  .tm-chat__bg--image:global(.contain) {
    background-size: contain;
    background-position: center;
  }
  .tm-chat__bg--image:global(.stretch) {
    background-size: 100% 100%;
  }
  .tm-chat__bg--image:global(.center) {
    background-size: auto;
    background-position: center;
  }
  .tm-chat__bg-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center top;
    opacity: var(--tm-chat-bg-opacity);
    filter: blur(var(--tm-chat-bg-blur));
    transform: scale(1.04); /* hides blurred edges */
  }
  /* everything else (list, banner, composer) paints above the background layer */
  .tm-chat > :global(*:not(.tm-chat__bg)) {
    position: relative;
  }
  /* immersive top bar floats over the list: start the content below it */
  :root[data-tm-immersive='true'] .tm-chat__top {
    padding-top: calc(var(--tm-topbar-height) + var(--tm-safe-top) + var(--tm-space-4));
  }
  /* phone / tablet: full width capped by the reading measure; desktop: theme chat_width (see DESIGN.md §4) */
  .tm-chat__column {
    width: 100%;
    max-width: var(--tm-chat-measure);
    margin: 0 auto;
    padding: 0 var(--tm-gutter);
  }
  @media (min-width: 1024px) {
    .tm-chat__column {
      width: var(--tm-chat-width);
      max-width: var(--tm-chat-desktop-max);
    }
  }
  .tm-note {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-4);
    font-family: var(--tm-font-ui);
  }
  /* messages are direct children of #chat (ST contract), so the reading column is the list's own
     inline padding: same box for .mes as when a centred column wrapped each one */
  :global(.tm-chat__scroll) {
    padding-inline: max(
      var(--tm-gutter),
      calc((100% - var(--tm-chat-measure)) / 2 + var(--tm-gutter))
    );
  }
  @media (min-width: 1024px) {
    :global(.tm-chat__scroll) {
      padding-inline: max(
        var(--tm-gutter),
        calc((100% - var(--tm-chat-desktop-column)) / 2 + var(--tm-gutter))
      );
    }
  }
  .tm-chat__top {
    padding-top: var(--tm-space-8);
    padding-bottom: var(--tm-space-6);
  }
  .tm-chat__divider {
    display: flex;
    align-items: center;
    gap: var(--tm-space-4);
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
    letter-spacing: var(--tm-tracking-wide);
  }
  .tm-chat__divider::before,
  .tm-chat__divider::after {
    content: '';
    flex: 1;
    border-top: var(--tm-border-width) solid var(--tm-color-border);
  }
  .tm-chat__banner {
    display: flex;
    justify-content: space-between;
    gap: var(--tm-space-3);
    padding-block: var(--tm-space-2);
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-sm);
    color: var(--tm-color-danger);
  }
  .tm-chat__banner--info {
    color: var(--tm-color-text);
  }
  .tm-chat__jump {
    position: relative;
    height: 0;
    flex: none;
  }
  .tm-chat__jump-button {
    position: absolute;
    right: var(--tm-gutter);
    bottom: var(--tm-space-3);
    display: grid;
    place-items: center;
    width: var(--tm-touch-target);
    height: var(--tm-touch-target);
    border: var(--tm-border-width) solid var(--tm-color-border);
    border-radius: var(--tm-radius-full);
    background: color-mix(in srgb, var(--tm-color-surface-raised) 92%, transparent);
    color: var(--tm-color-text);
    box-shadow: var(--tm-shadow-2);
    /* hidden: out of sight, out of the tab order and the accessibility tree */
    opacity: 0;
    visibility: hidden;
    transition:
      opacity var(--tm-duration-fast) var(--tm-ease),
      visibility 0s linear var(--tm-duration-fast);
  }
  .tm-chat__jump-button--shown {
    opacity: 1;
    visibility: visible;
    transition-delay: 0s;
  }
  /* banners sit over the avatar background: give them a readable backing */
  .tm-chat__banner {
    align-items: center;
    border-radius: var(--tm-radius-md);
    background: color-mix(in srgb, var(--tm-color-surface) 92%, transparent);
    margin-bottom: var(--tm-space-2);
  }
  .tm-chatlist {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-2);
  }
  .tm-chatlist__tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--tm-space-2) var(--tm-space-3);
  }
  .tm-chatlist__tools .tm-form__chip {
    display: inline-flex;
    align-items: center;
    gap: var(--tm-space-2);
  }
  .tm-chatrow.is-new {
    box-shadow: inset calc(var(--tm-border-width) * 3) 0 0 var(--tm-color-success);
  }
  .tm-chatlist__search {
    margin-bottom: var(--tm-space-2);
  }
  /* ST past-chat row: name + pencil on the left, export / delete icons on the right, preview below */
  .tm-chatrow {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-1);
    padding: var(--tm-space-2) var(--tm-space-3);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface);
    border: var(--tm-border-width) solid var(--tm-color-border);
  }
  .tm-chatrow.is-active {
    border-color: var(--tm-color-accent);
  }
  .tm-chatrow__head {
    display: flex;
    align-items: center;
    gap: var(--tm-space-2);
    min-height: var(--tm-touch-target);
  }
  .tm-chatrow__open {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--tm-space-1);
    text-align: left;
    color: var(--tm-color-text);
  }
  /* long names (imported chats) wrap inside the button instead of running under the icons */
  .tm-chatrow__open :global(.select_chat_block_filename) {
    max-width: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .tm-chatrow__actions {
    display: flex;
    flex: none;
    gap: 0;
  }
  .tm-chatrow__danger {
    color: var(--tm-color-danger);
  }
  .tm-chatrow__preview {
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global(.tm-chat__danger-btn) {
    background: var(--tm-color-danger) !important;
  }
  .tm-chat__scriptbar {
    display: flex;
    gap: var(--tm-space-2);
    overflow-x: auto;
    padding-block: var(--tm-space-2);
    scrollbar-width: none;
  }
  .tm-chat__scriptbtn {
    flex: none;
    min-height: calc(var(--tm-touch-target) * 0.8);
    padding: 0 var(--tm-space-4);
    border: var(--tm-border-width) solid var(--tm-color-border);
    border-radius: var(--tm-radius-full);
    background: color-mix(in srgb, var(--tm-color-surface) 92%, transparent);
    color: var(--tm-color-text);
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-sm);
    white-space: nowrap;
  }
  .tm-chat__link {
    color: var(--tm-color-text-link);
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-sm);
    min-height: calc(var(--tm-touch-target) * 0.7);
  }
  .tm-chat__link--danger {
    color: var(--tm-color-danger);
  }
  .tm-chat__link:disabled {
    opacity: 0.4;
  }
  .tm-chat__delbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--tm-space-3);
    padding-top: var(--tm-space-3);
    padding-bottom: calc(var(--tm-space-3) + var(--tm-safe-bottom));
    border-top: var(--tm-border-width) solid var(--tm-color-border);
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-secondary);
  }
  .tm-chat__delbar-actions {
    display: flex;
    gap: var(--tm-space-4);
  }
  .tm-opt {
    display: grid;
    grid-template-columns: var(--tm-icon-md) minmax(0, 1fr);
    column-gap: var(--tm-space-4);
    align-items: center;
    text-align: left;
    width: 100%;
    min-height: var(--tm-touch-target);
    padding: var(--tm-space-2) var(--tm-space-3);
    border-radius: var(--tm-radius-md);
    color: var(--tm-color-text);
    font-size: var(--tm-text-md);
  }
  .tm-opt:hover:not(:disabled) {
    background: var(--tm-color-surface-sunken);
  }
  .tm-opt:disabled {
    opacity: 0.4;
  }
  .tm-opt small {
    grid-column: 2;
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }
  .tm-chat__empty,
  .tm-chat__picker {
    padding: var(--tm-space-8) var(--tm-gutter);
    max-width: var(--tm-chat-measure);
    margin: 0 auto;
    width: 100%;
    font-family: var(--tm-font-ui);
  }
  .tm-chat__picker-title {
    font-size: var(--tm-text-2xl);
    font-weight: 600;
    margin: 0 0 var(--tm-space-6);
  }
  .tm-chat__hint {
    color: var(--tm-color-text-secondary);
    font-size: var(--tm-text-sm);
    line-height: var(--tm-leading-relaxed);
  }
  .tm-chat__path {
    font-family: var(--tm-font-mono);
    font-size: var(--tm-text-xs);
    overflow-wrap: anywhere;
  }
  .tm-chat__error {
    color: var(--tm-color-danger);
  }
  .tm-chat__cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(var(--tm-avatar-size) * 3.5), 1fr));
    gap: var(--tm-space-4);
  }
  .tm-chat__card {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--tm-space-2);
    padding: var(--tm-space-4);
    border-radius: var(--tm-radius-lg);
    border: var(--tm-border-width) solid var(--tm-color-border);
    background: var(--tm-color-surface);
    color: var(--tm-color-text);
    position: relative;
  }
  .tm-chat__card:hover {
    background: var(--tm-color-surface-raised);
  }
  .tm-chat__card-avatar {
    width: calc(var(--tm-avatar-size) * 2);
    height: calc(var(--tm-avatar-size) * 2);
    border-radius: var(--tm-radius-avatar);
    object-fit: cover;
    background: var(--tm-color-surface-sunken);
  }
  .tm-chat__card-collage {
    display: block;
    overflow: hidden;
  }
  .tm-chat__card-name {
    font-size: var(--tm-text-sm);
    font-weight: 600;
    text-align: center;
  }
  .tm-chat__card-sub {
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }
  .tm-chat__card-fav {
    position: absolute;
    top: var(--tm-space-2);
    right: var(--tm-space-3);
    color: var(--tm-color-warning);
    font-size: var(--tm-text-xs);
  }

  /* full-screen image viewer */
  .tm-lightbox {
    position: fixed;
    inset: 0;
    z-index: var(--tm-z-modal);
    display: grid;
    place-items: center;
    gap: var(--tm-space-3);
    padding: var(--tm-space-5);
    background: var(--tm-color-scrim);
    backdrop-filter: blur(var(--tm-space-3));
    -webkit-backdrop-filter: blur(var(--tm-space-3));
  }
  .tm-lightbox__img {
    max-width: 100%;
    max-height: calc(100vh - var(--tm-safe-top) - var(--tm-safe-bottom) - var(--tm-space-7) * 2);
    object-fit: contain;
    border-radius: var(--tm-radius-md);
  }
  .tm-lightbox__title {
    position: absolute;
    bottom: calc(var(--tm-safe-bottom) + var(--tm-space-5));
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-sm);
    color: var(--tm-color-on-accent);
  }
</style>
