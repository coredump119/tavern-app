/**
 * What scripts made of a message's body through the stand-in page (DEV_NOTES §9.5 第 3 轮 →
 * 显示接口): 楼层 → HTML shown instead of the app's own rendering. The HTML comes from the realm,
 * so it is sanitized again here. An override holds as long as the message text it was made for:
 * an edit, a swipe or streaming puts the app's rendering back.
 */
import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { createMessageSanitizer, type MessageSanitizer } from '@tm/ui';
import { NODE_ATTRIBUTE, type PageDomEvent } from '@tm/tavern-helper';
import { MessageRenderer, formatPowerUserFrom } from '../chat/render';
import { chatStore } from '../chat/store.svelte';
import { MacroDisplay, type ShownText } from './macro-like';

interface Override {
  html: string;
  /** the message text the stand-in rendered before the script changed it */
  source: string;
}

/** a message body a script filled is never larger than this by honest means */
const MAX_HTML = 2_000_000;
const FORWARDED = ['click', 'input', 'change'] as const;

class HelperDisplay {
  private readonly overrides = new SvelteMap<number, Override>();
  private sanitizer: MessageSanitizer | null = null;
  /** set by the bridge while the hub is up */
  send: ((event: PageDomEvent) => void) | null = null;

  constructor() {
    $effect.root(() => {
      // 楼层 numbers mean nothing in another chat
      $effect(() => {
        void chatStore.chatRel;
        untrack(() => {
          this.clear();
          macroDisplay.clear();
        });
      });
    });
  }

  private sanitize(html: string): string {
    this.sanitizer ??= createMessageSanitizer(window, {
      mediaAllowed: () => !formatPowerUserFrom(chatStore.settings).forbid_external_media,
    });
    // already formatted once in the realm: classes and styles stay as the script left them
    return this.sanitizer(html, { MESSAGE_KEEP_CLASSES: true, FORCE_BODY: true });
  }

  /** `html === null` puts the app's own rendering back */
  set(index: number, html: string | null): void {
    const message = chatStore.messages[index];
    if (html === null || !message) {
      this.overrides.delete(index);
      return;
    }
    if (html.length > MAX_HTML) throw new Error('消息内容过大');
    const next = { html: this.sanitize(html), source: MessageRenderer.displayText(message) };
    const before = this.overrides.get(index);
    if (before?.html !== next.html || before.source !== next.source) {
      this.overrides.set(index, next);
    }
  }

  /** The HTML to show for 楼层 `index` whose text is `source`, when a script changed it */
  get(index: number, source: string): string | undefined {
    const override = this.overrides.get(index);
    return override?.source === source ? override.html : undefined;
  }

  clear(): void {
    if (this.overrides.size) this.overrides.clear();
  }

  /** Attachment for the chat list: clicks and edits inside what a script made go back to it */
  readonly listen = (root: HTMLElement): (() => void) => {
    const forward = (event: Event): void => this.forward(event);
    for (const type of FORWARDED) root.addEventListener(type, forward);
    return () => {
      for (const type of FORWARDED) root.removeEventListener(type, forward);
    };
  };

  private forward(event: Event): void {
    if (!this.send || !this.overrides.size || !(event.target instanceof Element)) return;
    const target = event.target.closest(`[${NODE_ATTRIBUTE}]`);
    const index = Number(target?.closest('.mes_text')?.closest('.mes')?.getAttribute('mesid'));
    const message = chatStore.messages[index];
    // only what is on screen as the script left it: the same attribute in a message's own text is not one
    if (!target || !message || !this.get(index, MessageRenderer.displayText(message))) return;
    const node = Number(target.getAttribute(NODE_ATTRIBUTE));
    if (!Number.isInteger(node)) return;
    const type = event.type as PageDomEvent['event'];
    if (type === 'click') {
      this.send({ index, node, event: type });
      return;
    }
    // ticking a box is carried by its click: the stand-in's own box then fires these itself
    if (
      target instanceof HTMLInputElement &&
      (target.type === 'checkbox' || target.type === 'radio')
    ) {
      return;
    }
    const value = 'value' in target && typeof target.value === 'string' ? target.value : undefined;
    this.send({ index, node, event: type, ...(value === undefined ? {} : { value }) });
  }
}

/** counts up whenever every message has to be looked at again */
let revision = $state(0);

/** Macro-likes in the messages on screen (DEV_NOTES §9.5 第 3 轮 → 注入) */
export const macroDisplay = new MacroDisplay({
  shown: new SvelteMap<number, ShownText>(),
  read: () => void revision,
  bump: () => {
    revision++;
  },
});

export const helperDisplay = new HelperDisplay();
