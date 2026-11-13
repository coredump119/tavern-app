/**
 * The stand-in page (DEV_NOTES §9.5 第 3 轮 → DOM). Upstream scripts share a page with ST and
 * reach it as `parent.document`; here the app's page is another origin, so `parent` of every
 * frame is pointed at the hub window, whose document carries a skeleton of ST's page built from
 * the chat mirror. What a script does to it is carried over where the app can honour it:
 *
 * - the content of a message's `.mes_text` → shown in the chat instead of the app's own rendering;
 * - `<style>` elements outside the chat → added to the app page (sanitized there);
 * - `#send_textarea` and the send / stop / regenerate / continue buttons → the real ones.
 *
 * Anything else a script adds to the page stays in the stand-in, where nobody sees it. The
 * stand-in is only built when a frame first reads `parent`, so chats without such scripts pay
 * nothing for it.
 */
import { NODE_ATTRIBUTE, type ChatSplice, type RawMessage } from '../../protocol.js';
import type { ApiModule, Hub } from '../hub.js';
import type { DisplayedAs } from '../render.js';
import { resolveMessageId } from '../range.js';
import { record, strings, text } from './shared.js';

/** How many messages at the end of the chat are rendered ahead of being asked for */
export const RENDERED_TAIL = 20;
/** Message and style changes are gathered this long before they go to the app */
const FLUSH_DELAY_MS = 16;
const STYLE_DELAY_MS = 60;

// ST's element ids and classes are the contract scripts are written against
const SKELETON =
  '<div id="top-bar"></div><div id="top-settings-holder">' +
  '<div id="extensions_settings"></div><div id="extensions_settings2"></div></div>' +
  '<div id="sheld"><div id="chat"></div><div id="form_sheld"><form id="send_form">' +
  '<div id="leftSendForm"><div id="options_button"></div><div id="extensionsMenuButton"></div></div>' +
  '<textarea id="send_textarea" name="text"></textarea>' +
  '<div id="rightSendForm"><div id="mes_stop"></div><div id="send_but"></div></div>' +
  '</form></div></div>' +
  '<div id="options"><div id="option_regenerate"></div><div id="option_continue"></div></div>' +
  '<div id="extensionsMenu"></div><div id="movingDivs"></div>';
const MESSAGE =
  '<div class="mesAvatarWrapper"><div class="avatar"><img alt=""></div>' +
  '<div class="mesIDDisplay"></div></div><div class="swipe_left"></div>' +
  '<div class="mes_block"><div class="ch_name"><span class="name_text"></span>' +
  '<div class="mes_buttons"></div></div><div class="mes_text"></div></div>' +
  '<div class="swipeRightBlock"><div class="swipe_right"></div></div>';
const BUTTONS: readonly (readonly [id: string, action: string])[] = [
  ['send_but', 'send'],
  ['mes_stop', 'stop'],
  ['option_regenerate', 'regenerate'],
  ['option_continue', 'continue'],
];

interface Entry {
  node: HTMLElement;
  body: HTMLElement;
  /** what the body was rendered from; null while it has not been rendered */
  source: string | null;
  /** a script changed the body since it was rendered */
  modified: boolean;
}

type PageWindow = Window & typeof globalThis & { jQuery?: (target: unknown) => unknown };

const displayText = (message: RawMessage): string => {
  const shown = message.extra?.['display_text'];
  return typeof shown === 'string' ? shown : message.mes;
};
const warn = (what: string) => (e: unknown) => console.warn(`[TavernHelper] ${what}`, e);

export function pageModule(hub: Hub, win: PageWindow): ApiModule {
  const doc = win.document;
  const baseline = new Set<Element>(doc.querySelectorAll('style'));
  let active = false;
  let chat: HTMLElement;
  let input: HTMLTextAreaElement;
  let observer: MutationObserver;
  let entries: Entry[] = [];
  let bodyClasses: string[] = [];
  let sentCss = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let styleTimer: ReturnType<typeof setTimeout> | null = null;
  const dirty = new Set<number>();
  const nativeValue = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!;

  const as = (index: number, message: RawMessage): DisplayedAs => ({
    index,
    name: message.name,
    isUser: !!message.is_user,
    isSystem: !!message.is_system,
  });

  // ---- what scripts did, on its way to the app ----
  /** `innerHTML` writes attributes; what a field holds lives in properties */
  const reflect = (from: Element | undefined, to: Element): void => {
    if (from instanceof win.HTMLInputElement) {
      if (from.type === 'checkbox' || from.type === 'radio')
        to.toggleAttribute('checked', from.checked);
      else to.setAttribute('value', from.value);
    } else if (from instanceof win.HTMLTextAreaElement) to.textContent = from.value;
    else if (from instanceof win.HTMLOptionElement) to.toggleAttribute('selected', from.selected);
  };
  const flush = (): void => {
    flushTimer = null;
    for (const index of dirty) {
      const entry = entries[index];
      if (!entry?.modified) continue;
      const copy = entry.body.cloneNode(true) as HTMLElement;
      const originals = entry.body.querySelectorAll('*');
      copy.querySelectorAll('*').forEach((element, n) => {
        element.setAttribute(NODE_ATTRIBUTE, `${n}`);
        reflect(originals[n], element);
      });
      void hub.call('display.set', [index, copy.innerHTML]).catch(warn('显示接口'));
    }
    dirty.clear();
  };
  const syncStyles = (): void => {
    styleTimer = null;
    let css = '';
    for (const style of doc.querySelectorAll('style')) {
      if (!baseline.has(style) && !chat.contains(style)) css += `${style.textContent ?? ''}\n`;
    }
    if (css === sentCss) return;
    sentCss = css;
    void hub.call('page.style', [css]).catch(warn('页面样式'));
  };
  const handle = (records: readonly MutationRecord[]): void => {
    let outside = false;
    for (const { target } of records) {
      const element = target.nodeType === 1 ? (target as Element) : target.parentElement;
      const body = element?.closest('.mes_text');
      const index = Number(body?.closest('.mes')?.getAttribute('mesid') ?? -1);
      const entry = entries[index];
      if (!entry || entry.body !== body) outside = true;
      // a body that was never rendered holds nothing a script could have meant to change
      else if (entry.source !== null) {
        entry.modified = true;
        dirty.add(index);
      }
    }
    if (dirty.size) flushTimer ??= setTimeout(flush, FLUSH_DELAY_MS);
    if (outside) styleTimer ??= setTimeout(syncStyles, STYLE_DELAY_MS);
  };
  /** Run our own change to the stand-in: what scripts did before it still counts, the change itself does not */
  const quiet = (change: () => void): void => {
    handle(observer.takeRecords());
    change();
    observer.takeRecords();
  };

  // ---- message nodes ----
  const describe = ({ node }: Entry, index: number): void => {
    const message = hub.chat[index]!;
    node.setAttribute('mesid', `${index}`);
    node.setAttribute('ch_name', message.name);
    node.setAttribute('is_user', `${!!message.is_user}`);
    node.setAttribute('is_system', `${!!message.is_system}`);
    node.setAttribute('swipeid', `${message.swipe_id ?? 0}`);
    node.classList.toggle('last_mes', index === hub.chat.length - 1);
    node.querySelector('.name_text')!.textContent = message.name;
    node.querySelector('.mesIDDisplay')!.textContent = `#${index}`;
  };
  const create = (index: number): Entry => {
    const node = doc.createElement('div');
    node.className = 'mes';
    node.innerHTML = MESSAGE;
    const entry = {
      node,
      body: node.querySelector<HTMLElement>('.mes_text')!,
      source: null,
      modified: false,
    };
    describe(entry, index);
    return entry;
  };
  const render = (entry: Entry, index: number): void => {
    const message = hub.chat[index];
    if (!message) return;
    const source = displayText(message);
    if (hub.renderer) entry.body.innerHTML = hub.renderer.message(source, as(index, message));
    else entry.body.textContent = source;
    entry.source = source;
    entry.modified = false;
  };
  const inTail = (index: number): boolean => index >= entries.length - RENDERED_TAIL;
  const rebuild = (): void => {
    dirty.clear();
    entries = hub.chat.map((_, index) => create(index));
    entries.forEach((entry, index) => inTail(index) && render(entry, index));
    chat.replaceChildren(...entries.map((entry) => entry.node));
  };
  const splice = ({ start, deleteCount, messages }: ChatSplice): void => {
    if (deleteCount === messages.length) {
      // changed in place (an edit, a swipe, new variables): the nodes stay, like ST's
      for (let index = start; index < start + deleteCount; index++) {
        const entry = entries[index];
        if (!entry) continue;
        describe(entry, index);
        const stale = entry.source !== null && entry.source !== displayText(hub.chat[index]!);
        if (stale || (entry.source === null && inTail(index))) render(entry, index);
      }
      return;
    }
    const added = messages.map((_, i) => create(start + i));
    for (const gone of entries.splice(start, deleteCount, ...added)) gone.node.remove();
    const next = entries[start + added.length]?.node ?? null;
    for (const entry of added) chat.insertBefore(entry.node, next);
    added.forEach((entry, i) => inTail(start + i) && render(entry, start + i));
    // everything behind moved to another 楼层: say so to the app for the ones scripts changed
    for (let index = start + added.length; index < entries.length; index++) {
      describe(entries[index]!, index);
      if (entries[index]!.modified) dirty.add(index);
    }
    const before = entries[start - 1];
    if (before) describe(before, start - 1);
    if (dirty.size) flushTimer ??= setTimeout(flush, FLUSH_DELAY_MS);
  };

  // ---- the input box, the buttons, the theme ----
  const applyPage = (): void => {
    const page = hub.part('page');
    const draft = text(page['draft']);
    const typed = nativeValue.get!.call(input) !== draft;
    quiet(() => {
      if (typed) nativeValue.set!.call(input, draft);
      doc.getElementById('mes_stop')!.style.display = page['generating'] ? 'flex' : 'none';
      const classes = strings(page['bodyClasses']);
      doc.body.classList.remove(...bodyClasses);
      doc.body.classList.add(...classes);
      bodyClasses = classes;
      for (const [name, value] of Object.entries(record(page['vars'])))
        doc.documentElement.style.setProperty(name, text(value));
    });
    if (typed) input.dispatchEvent(new win.Event('input', { bubbles: true }));
  };

  const activate = (): void => {
    if (active) return;
    active = true;
    doc.body.insertAdjacentHTML('afterbegin', SKELETON);
    chat = doc.getElementById('chat')!;
    input = doc.getElementById('send_textarea') as HTMLTextAreaElement;
    // scripts set `.value` (jQuery's `.val()` does): the real input box follows
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: (): string => nativeValue.get!.call(input) as string,
      set: (value: unknown) => {
        nativeValue.set!.call(input, value);
        void hub.call('page.draft', [nativeValue.get!.call(input)]).catch(warn('输入框'));
      },
    });
    for (const [id, action] of BUTTONS) {
      doc.getElementById(id)!.addEventListener('click', () => {
        void hub.call('page.click', [action]).catch(warn(`#${id}`));
      });
    }
    rebuild();
    observer = new win.MutationObserver(handle);
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    applyPage();
  };

  hub.onChat((change) => {
    if (active) quiet(() => (change ? splice(change) : rebuild()));
  });
  hub.onCatalog((part) => {
    if (part === 'page' && active) applyPage();
  });
  hub.onDomEvent(({ index, node, event, value }) => {
    const target = entries[index]?.body.querySelectorAll('*')[node];
    if (!target) return;
    if (value !== undefined && 'value' in target) target.value = value;
    if (event === 'click' && target instanceof win.HTMLElement) target.click();
    else target.dispatchEvent(new win.Event(event, { bubbles: true }));
  });
  // `parent` of a card is its slot and of a library script already the hub: one answer for both
  hub.installers.push((target) => {
    Object.defineProperty(target, 'parent', {
      configurable: true,
      get: () => {
        activate();
        return win;
      },
    });
  });

  const entryAt = (index: number): Entry | undefined => {
    activate();
    const entry = entries[index];
    if (entry && entry.source === null) quiet(() => render(entry, index));
    return entry;
  };
  const anchor = (id: unknown): number => {
    const last = (wanted: (message: RawMessage) => boolean): number => {
      for (let i = hub.chat.length - 1; i >= 0; i--) if (wanted(hub.chat[i]!)) return i;
      return -1;
    };
    if (id === undefined || id === 'last') return hub.chat.length - 1;
    if (id === 'last_user') return last((message) => !!message.is_user);
    if (id === 'last_char') return last((message) => !message.is_user && !message.is_system);
    return resolveMessageId(Number(id), hub.chat.length);
  };

  return () => ({
    retrieveDisplayedMessage: (messageId: unknown): unknown => {
      const index = Number(messageId);
      const entry = entryAt(index < 0 ? hub.chat.length + index : index);
      return win.jQuery ? win.jQuery(entry ? entry.body : []) : (entry?.body ?? null);
    },
    formatAsDisplayedMessage: (content: unknown, option?: { message_id?: unknown }): string => {
      const index = anchor(option?.message_id);
      const message = hub.chat[index];
      const filtered = hub.cardFilters.reduce(
        (html, filter) => filter(html, index),
        String(content),
      );
      if (!message || !hub.renderer) return filtered;
      return hub.renderer.message(filtered, as(index, message));
    },
    refreshOneMessage: async (messageId: unknown): Promise<void> => {
      const index = resolveMessageId(Number(messageId), hub.chat.length);
      if (active) {
        const entry = entries[index];
        if (entry) quiet(() => render(entry, index));
        dirty.delete(index);
      }
      await hub.call('display.set', [index, null]);
    },
  });
}
