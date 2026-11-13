/**
 * Macro-likes (`registerMacroLike` and the built-in variable macros, DEV_NOTES §9.5 第 3 轮 →
 * 注入): the replacers are closures in the realm, so right before a request goes out its prompt
 * texts make one round trip to the hub. No hub, or no answer in time: the request goes out as
 * it is. The messages on screen make the same trip once per text (`MacroDisplay`).
 */
import type { GenerateRequest } from '../ipc';

type Obj = Record<string, unknown>;
interface Item {
  text: string;
  role?: 'user' | 'assistant' | 'system';
  /** 楼层 of the message the text belongs to */
  index?: number;
}
/** where a prompt text sits in the request body */
interface Slot {
  holder: Obj;
  key: string;
}

/** The parts of a request body that hold prompt text, whatever the provider's shape */
const ROOTS = ['messages', 'prompt', 'contents', 'system', 'systemInstruction'] as const;
const TEXT_KEYS = new Set(['content', 'text']);
/** the built-in macro-likes are written with braces: without a script's own, other texts stay home */
const MARK = '{{';

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const roleOf = (value: unknown, inherited: Item['role']): Item['role'] => {
  if (value === 'user' || value === 'assistant' || value === 'system') return value;
  // Gemini's name for the assistant
  return value === 'model' ? 'assistant' : inherited;
};

export const scriptMacros = {
  /** set by the bridge while the hub is up: the texts with every macro-like applied */
  apply: null as ((items: Item[]) => Promise<unknown>) | null,
  /** a script registered an expression of its own (`registerMacroLike`), which may be anything */
  custom: false,
};

const wanted = (text: string): boolean =>
  text !== '' && (scriptMacros.custom || text.includes(MARK));

function collect(node: unknown, role: Item['role'], slots: Slot[], items: Item[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, role, slots, items);
    return;
  }
  if (!isObj(node)) return;
  const own = roleOf(node['role'], role);
  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== 'string') collect(value, own, slots, items);
    else if (TEXT_KEYS.has(key) && wanted(value)) {
      slots.push({ holder: node, key });
      items.push({ text: value, ...(own ? { role: own } : {}) });
    }
  }
}

/** Replace the macro-likes in a request that is about to be sent; changes `request.body` in place */
export async function applyMacroLikes(request: GenerateRequest): Promise<void> {
  const { apply } = scriptMacros;
  const body = request.body;
  if (!apply || !isObj(body)) return;
  const slots: Slot[] = [];
  const items: Item[] = [];
  for (const root of ROOTS) {
    const value = body[root];
    // Text Completion's `prompt` and Claude's `system` may be bare strings
    if (typeof value !== 'string')
      collect(value, root === 'messages' ? undefined : 'system', slots, items);
    else if (wanted(value)) {
      slots.push({ holder: body, key: root });
      items.push({ text: value });
    }
  }
  if (!items.length) return;
  const replaced = await apply(items);
  if (!Array.isArray(replaced) || replaced.length !== slots.length) return;
  slots.forEach(({ holder, key }, i) => {
    const text: unknown = replaced[i];
    if (typeof text === 'string') holder[key] = text;
  });
}

/** what a message was last shown as, and the text that was made from */
export interface ShownText {
  source: string;
  text: string;
}
/** the reactive parts, handed in by the app: this module stays free of Svelte */
export interface MacroDisplayState {
  shown: Map<number, ShownText>;
  /** read by every row, so `bump` renders them again */
  read: () => void;
  bump: () => void;
}
interface Ask {
  index: number;
  source: string;
  /** the text cut at its code fences: even places are prose, odd ones code */
  parts: string[];
  /** the places in `parts` that went to the realm */
  places: number[];
}

/** a fenced block is a card's source: the realm applies macro-likes to it when the card loads */
const FENCE = /(```[\s\S]*?(?:```|$))/;

/**
 * Macro-likes in the messages on screen. Like upstream, a message is replaced when it is
 * rendered, not when a variable changes later: 楼层 → the text to format instead of its own.
 * Until the realm answers, the message shows as written.
 */
export class MacroDisplay {
  /** 楼层 → the text already asked about */
  private readonly asked = new Map<number, string>();
  private queue: Ask[] = [];

  constructor(private readonly state: MacroDisplayState) {}

  /** The text to format for 楼层 `index`; asks the realm the first time a text is seen */
  text(index: number, source: string): string {
    this.state.read();
    if (!scriptMacros.apply) return source;
    if (this.asked.get(index) !== source) {
      this.asked.set(index, source);
      const parts = source.split(FENCE);
      const places = parts.flatMap((part, place) => (place % 2 === 0 && wanted(part) ? place : []));
      if (places.length) {
        if (!this.queue.length) queueMicrotask(() => void this.flush());
        this.queue.push({ index, source, parts, places });
      }
    }
    const entry = this.state.shown.get(index);
    return entry?.source === source ? entry.text : source;
  }

  /** The list of macro-likes changed, or the realm came up: every message is asked about again */
  refresh(): void {
    this.asked.clear();
    this.state.bump();
  }

  /** Another chat, or no realm any more */
  clear(): void {
    this.asked.clear();
    this.queue = [];
    if (this.state.shown.size) this.state.shown.clear();
    this.state.bump();
  }

  private async flush(): Promise<void> {
    const batch = this.queue;
    this.queue = [];
    const { apply } = scriptMacros;
    if (!apply || !batch.length) return;
    const items = batch.flatMap(({ index, parts, places }) =>
      places.map((place) => ({ text: parts[place]!, index })),
    );
    const replaced = await apply(items).catch(() => undefined);
    if (!Array.isArray(replaced) || replaced.length !== items.length) return;
    let next = 0;
    for (const { index, source, parts, places } of batch) {
      const texts = [...parts];
      for (const place of places) {
        const text: unknown = replaced[next++];
        if (typeof text === 'string') texts[place] = text;
      }
      // asked again since, or another chat: this answer is for a text no longer there
      if (this.asked.get(index) !== source) continue;
      const text = texts.join('');
      const { shown } = this.state;
      const before = shown.get(index);
      if (text === source) {
        if (before) shown.delete(index);
      } else if (before?.text !== text || before.source !== source) {
        shown.set(index, { source, text });
      }
    }
  }
}
