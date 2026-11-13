/**
 * A slot: the realm page behind one rendered block. It hosts the card document in a `srcdoc`
 * child, gives it the hub's API, and reports the card's height to the app (DEV_NOTES §9.5).
 */
import { slotMessageId } from '../detect.js';
import {
  envelope,
  HUB_FRAME_NAME,
  openEnvelope,
  REALM_SANDBOX,
  type HostToSlot,
  type SlotContent,
  type SlotToHost,
} from '../protocol.js';
import { iframe_events } from './events.js';
import type { HubWindow } from './hub.js';
import { buildCardDocument } from './srcdoc.js';

export interface SlotOptions {
  /** absolute URL of the jQuery build every card document loads */
  jqueryUrl: string;
  /** absolute URL of `/th/lib/`: where the libraries a card may ask for are served */
  libBase?: string;
}

interface SlotWindow extends Window {
  /** called by the first script of the card document */
  __tmSlot?: { install(card: Window): void };
}

export function startSlot(win: SlotWindow, options: SlotOptions): void {
  const host = win.parent;
  const send = (message: SlotToHost) => host.postMessage(envelope(message), '*');
  let card: HTMLIFrameElement | null = null;

  function render(content: SlotContent): void {
    const hub = (host.frames as unknown as Record<string, HubWindow>)[HUB_FRAME_NAME]?.__tmHub;
    if (!hub || card) return;
    const frame = win.document.createElement('iframe');
    card = frame;
    // the same id and name as upstream gives its iframe: scripts read them off `frameElement`
    frame.id = content.name;
    frame.name = content.name;
    frame.setAttribute('sandbox', REALM_SANDBOX);
    frame.style.cssText = 'display:block;width:100%;height:0;border:0';

    let cardWindow: Window | null = null;
    const messageId = slotMessageId(content.name) ?? 0;
    win.__tmSlot = {
      install(target) {
        cardWindow = target;
        hub.install(target, { name: content.name, messageId });
      },
    };
    win.addEventListener('pagehide', () => {
      if (cardWindow) hub.release(cardWindow);
    });

    let height = -1;
    let scheduled = false;
    const measure = () => {
      scheduled = false;
      const body = frame.contentDocument?.body;
      if (!body) return;
      const next = Math.ceil(Math.max(body.scrollHeight, body.offsetHeight));
      if (next === height) return;
      height = next;
      frame.style.height = `${next}px`;
      send({ type: 'slot.height', height: next });
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      win.requestAnimationFrame(measure);
    };
    frame.addEventListener('load', () => {
      const body = frame.contentDocument?.body;
      if (!body) return;
      new ResizeObserver(schedule).observe(body);
      schedule();
      void hub.bus.emit(iframe_events.MESSAGE_IFRAME_RENDER_ENDED, [content.name]);
    });

    void hub.bus.emit(iframe_events.MESSAGE_IFRAME_RENDER_STARTED, [content.name]);
    const html = hub.cardFilters.reduce((text, filter) => filter(text, messageId), content.html);
    const libs = options.libBase === undefined ? undefined : { base: options.libBase };
    frame.srcdoc = buildCardDocument({ ...content, html }, options.jqueryUrl, libs);
    win.document.body.append(frame);
  }

  win.addEventListener('message', (event) => {
    if (event.source !== host) return;
    const message = openEnvelope<HostToSlot>(event.data);
    if (!message) return;
    if (message.type === 'slot.content') render(message);
    else if (message.type === 'viewport') {
      card?.contentDocument?.documentElement.style.setProperty(
        '--TH-viewport-height',
        `${Math.max(0, Math.round(message.height))}px`,
      );
    }
  });
  send({ type: 'slot.ready' });
}
