/**
 * The app's end of the TavernHelper bridge (DEV_NOTES §9.5). It owns the hidden hub iframe, keeps
 * the realm's copy of the open chat current, applies what scripts ask for through the chat store,
 * and puts a slot iframe in place of every front-end code block.
 *
 * Nothing exists until the first block is rendered: a chat without front-end cards costs one
 * `includes` check per code block and no iframe.
 */
import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { parseChatMessage } from '@tm/formats';
import {
  helperField,
  HostController,
  HUB_FRAME_NAME,
  REALM_SANDBOX,
  slotName,
  type HostStatus,
  type RawMessage,
  type SlotContent,
  type Variables,
} from '@tm/tavern-helper';
import { chatStore, messageTimeStamp } from '../chat/store.svelte';
import { onAppEvent } from '../events';
import { fileUrl, helperRealmBase } from '../ipc';
import { userAvatarUrl } from '../personas';
import { createSlashHost } from '../slash/host.svelte';
import { runCall } from './calls';
import { syncCatalog } from './catalog.svelte';
import { helperDisplay, macroDisplay } from './display.svelte';
import { scriptGenerate, stopScriptGeneration } from './generate.svelte';
import { scriptInjects } from './injects.svelte';
import { scriptMacros } from './macro-like';
import { helperPage } from './page.svelte';
import { scriptLibrary } from './scripts.svelte';

/** class on a `<pre>` whose slot stands in for it: the element stays in place, hidden and emptied */
const SOURCE_CLASS = 'tm-th-source';
/** a slot that has not reported a height by then never loaded: its source comes back */
const SLOT_LOAD_TIMEOUT_MS = 5000;
const SLOT_CLASS = 'tm-th-slot';
/** remembered slot heights; a re-mounted card (scrolled back into view) starts at its old height */
const MAX_HEIGHTS = 500;

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A plain copy of a variables object held in `$state`; `{}` for anything else */
function plainVariables(value: unknown): Variables {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? ($state.snapshot(value) as Variables)
    : {};
}

type Obj = Record<string, unknown>;
const record = (value: unknown): Obj | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : undefined;

/** Where each variable table that is not the chat's own lives (DEV_NOTES §9.5 第 3 轮) */
function storeVariables(scope: 'global' | 'character' | 'preset', value: Variables): void {
  if (scope === 'global') chatStore.setGlobalVariables(value);
  else if (scope === 'character') {
    const character = chatStore.character;
    // the realm refuses the write before it gets here; a card closed in between has nowhere to go
    if (!character) return;
    const bucket = helperField($state.snapshot(record(character.data)?.['extensions']));
    chatStore.setCardExtension('tavern_helper', { ...bucket, variables: value });
  } else scriptLibrary.setPresetField('variables', value);
}

class HelperBridge {
  status = $state<HostStatus>('idle');
  /** the realm's origin, also the base of its URLs; null outside the app shell */
  private readonly base = helperRealmBase();
  /** Front-end blocks are being rendered. Messages are addressed by index, so the whole chat must be in memory. */
  readonly active = $derived(
    this.base !== null &&
      chatStore.helperRender &&
      this.status !== 'unsupported' &&
      chatStore.total === chatStore.messages.length,
  );

  /** Library scripts can run: they need a chat, not the whole of it in memory */
  readonly scriptsOn = $derived(
    this.base !== null && chatStore.helperRender && this.status !== 'unsupported' && chatStore.open,
  );

  private controller: HostController | null = null;
  private hub: HTMLIFrameElement | null = null;
  private stopSync: (() => void) | null = null;
  private readonly heights = new Map<string, number>();
  /** 楼层 → how many slots are mounted in it */
  private readonly slots = new SvelteMap<number, number>();

  constructor() {
    onAppEvent((name, ...args) => this.emit(name, ...args));
    $effect.root(() => {
      $effect(() => {
        if (!chatStore.helperRender) untrack(() => this.stop());
      });
      // a chat with scripts to run needs the hub even when it shows no card
      $effect(() => {
        if (this.scriptsOn && scriptLibrary.state.running.length > 0) untrack(() => this.start());
      });
    });
  }

  /** Forward an app event to script listeners (ST event names). No-op while no script is running. */
  emit(name: string, ...args: unknown[]): void {
    this.controller?.emit(name, ...args);
  }

  /** The row of message `messageId` holds a live card: worth keeping mounted when it scrolls away. */
  hasSlots(messageId: number): boolean {
    return this.slots.has(messageId);
  }

  /**
   * Show the front-end page `html` (the text of `pre`'s code block) in a slot iframe right after
   * `pre`. While the slot stands in, the code's text is held out of the DOM, so an extension that
   * renders such code blocks itself finds nothing and the card is not shown twice. A card that
   * fails to load gets its source back. Returns the cleanup.
   */
  mountSlot(pre: HTMLElement, messageId: number, block: number, html: string): () => void {
    const controller = this.start();
    if (!controller) return () => {};
    const key = `${chatStore.chatRel}|${messageId}|${block}|${html.length}|${fnv1a(html)}`;
    const frame = document.createElement('iframe');
    frame.className = SLOT_CLASS;
    frame.title = '前端卡片';
    frame.setAttribute('sandbox', REALM_SANDBOX);
    const code = pre.querySelector(':scope > code');
    const held = document.createDocumentFragment();
    const hide = () => {
      if (code && !held.hasChildNodes()) held.append(...code.childNodes);
      pre.classList.add(SOURCE_CLASS);
    };
    const restore = () => {
      if (code && held.hasChildNodes()) code.append(held);
      pre.classList.remove(SOURCE_CLASS);
    };
    let unloaded: ReturnType<typeof setTimeout> | undefined;
    const show = (height: number) => {
      clearTimeout(unloaded);
      frame.style.height = `${height}px`;
      hide();
    };
    const known = this.heights.get(key);
    if (known === undefined) {
      frame.style.height = '0';
      hide();
      unloaded = setTimeout(restore, SLOT_LOAD_TIMEOUT_MS);
    } else show(known);
    frame.src = `${this.base}/th/slot.html`;
    pre.after(frame);
    const port = frame.contentWindow;
    const content = { name: slotName(messageId, block), html, avatars: this.avatars() };
    const detach = port
      ? controller.attachSlot(port, content, (height) => {
          this.rememberHeight(key, height);
          show(height);
        })
      : null;
    this.slots.set(messageId, (this.slots.get(messageId) ?? 0) + 1);
    return () => {
      const left = (this.slots.get(messageId) ?? 1) - 1;
      if (left > 0) this.slots.set(messageId, left);
      else this.slots.delete(messageId);
      detach?.();
      clearTimeout(unloaded);
      frame.remove();
      restore();
    };
  }

  private rememberHeight(key: string, height: number): void {
    // re-inserting keeps the map ordered by last use, so the oldest entry is the first key
    this.heights.delete(key);
    this.heights.set(key, height);
    if (this.heights.size > MAX_HEIGHTS) {
      const oldest = this.heights.keys().next().value;
      if (oldest !== undefined) this.heights.delete(oldest);
    }
  }

  private avatars(): SlotContent['avatars'] {
    const root = chatStore.root;
    if (!root) return { user: null, char: null };
    const user = chatStore.settings?.['user_avatar'];
    const char = chatStore.character?.avatar;
    return {
      user: typeof user === 'string' && user ? userAvatarUrl(root, user) : null,
      char: char ? fileUrl(`${root}/characters/${char}`) : null,
    };
  }

  /** Create the hub on first use. Null when the realm is unavailable. */
  private start(): HostController | null {
    if (this.controller || this.base === null) return this.controller;
    const base = this.base;
    const controller = new HostController(
      base,
      {
        spliceChat: ({ start, deleteCount, messages }) =>
          chatStore.spliceMessages(
            start,
            deleteCount,
            messages.map((m) => parseChatMessage(m)),
          ) as readonly RawMessage[],
        setVariables: (scope, value) => {
          if (scope !== 'chat') storeVariables(scope, value);
          // a script outliving its chat has nothing to write to
          else if (chatStore.chatPath && chatStore.header) chatStore.setChatVariables(value);
        },
        timestamp: () => messageTimeStamp(),
        runSlash: createSlashHost({ emit: (name, ...args) => this.emit(name, ...args) }),
        generate: scriptGenerate,
        stopGeneration: stopScriptGeneration,
        setScriptTrees: (scope, trees) => scriptLibrary.setTrees(scope, trees),
        newId: () => crypto.randomUUID(),
        call: runCall,
      },
      (status) => {
        this.status = status;
      },
    );
    this.controller = controller;
    // a `filter` function stays in the realm: an unanswered question lets the injection through
    scriptInjects.ask = (id) => controller.query('injects.active', [id]).then((on) => on !== false);
    scriptMacros.apply = (items) => controller.query('macro.apply', [items]);
    macroDisplay.refresh();
    helperDisplay.send = (event) => controller.domEvent(event);

    const hub = document.createElement('iframe');
    hub.name = HUB_FRAME_NAME;
    hub.hidden = true;
    hub.setAttribute('aria-hidden', 'true');
    hub.setAttribute('sandbox', REALM_SANDBOX);
    hub.src = `${base}/th/hub.html`;
    document.body.append(hub);
    this.hub = hub;
    if (hub.contentWindow) controller.attachHub(hub.contentWindow);

    const onMessage = (event: MessageEvent) => {
      // the controller also checks that the sender is a window it created
      if (event.origin === base) controller.handleMessage(event.source, event.data);
    };
    const onResize = () => controller.setViewport(window.innerHeight);
    window.addEventListener('message', onMessage);
    window.addEventListener('resize', onResize);
    onResize();

    // Variables first: when a chat opens, the `init` the chat effect sends then carries them.
    const stopEffects = $effect.root(() => {
      $effect(() => {
        controller.syncVariables('chat', plainVariables(chatStore.chatMetadata['variables']));
      });
      $effect(() => {
        const extensions = chatStore.settings?.['extension_settings'] as
          { variables?: { global?: unknown } } | undefined;
        controller.syncVariables('global', plainVariables(extensions?.variables?.global));
      });
      $effect(() => {
        const extensions = record(chatStore.character?.data)?.['extensions'];
        controller.syncVariables('character', plainVariables(helperField(extensions)['variables']));
      });
      $effect(() => {
        const extensions = record(chatStore.settings?.['oai_settings'])?.['extensions'];
        controller.syncVariables('preset', plainVariables(helperField(extensions)['variables']));
      });
      syncCatalog(controller);
      $effect(() => {
        controller.syncNames({ user: chatStore.userName, char: chatStore.displayName });
      });
      $effect(() => {
        controller.syncScripts(scriptLibrary.state);
      });
      $effect(() => {
        // tracks the message array alone; one reference compare when nothing changed
        const messages = chatStore.messages;
        untrack(() => {
          const id = chatStore.total === messages.length ? chatStore.chatName : null;
          if (id === null) controller.syncChat(null, []);
          else controller.syncChat(chatStore.chatRel, messages as readonly RawMessage[], id);
        });
      });
    });
    this.stopSync = () => {
      stopEffects();
      window.removeEventListener('message', onMessage);
      window.removeEventListener('resize', onResize);
    };
    return controller;
  }

  /** Drop the hub and every script with it. Slots unmount on their own: `active` went false. */
  private stop(): void {
    this.stopSync?.();
    this.stopSync = null;
    this.hub?.remove();
    this.hub = null;
    this.controller = null;
    scriptInjects.ask = () => Promise.resolve(true);
    scriptMacros.apply = null;
    scriptMacros.custom = false;
    macroDisplay.clear();
    helperDisplay.send = null;
    helperDisplay.clear();
    helperPage.reset();
    this.status = 'idle';
  }
}

export const helperBridge = new HelperBridge();
