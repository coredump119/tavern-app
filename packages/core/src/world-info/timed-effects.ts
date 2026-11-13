// ST WorldInfoTimedEffects 移植：sticky / cooldown / delay，状态存在 chat_metadata.timedWorldInfo。
import type { TimedEffectType, WIEntry, WITimedEffect } from './types.js';

type TimedStore = Record<'sticky' | 'cooldown', Record<string, WITimedEffect>>;

export class WorldInfoTimedEffects {
  readonly #chat: readonly string[];
  readonly #entries: readonly WIEntry[];
  readonly #isDryRun: boolean;
  readonly #metadata: Record<string, unknown>;
  readonly #buffer: Record<TimedEffectType, WIEntry[]> = { sticky: [], cooldown: [], delay: [] };
  readonly #log: (message: string) => void;

  constructor(
    chat: readonly string[],
    entries: readonly WIEntry[],
    chatMetadata: Record<string, unknown>,
    {
      isDryRun = false,
      log = () => {},
    }: { isDryRun?: boolean; log?: (message: string) => void } = {},
  ) {
    this.#chat = chat;
    this.#entries = entries;
    this.#isDryRun = isDryRun;
    this.#metadata = chatMetadata;
    this.#log = log;
    this.#ensureChatMetadata();
  }

  get #store(): TimedStore {
    return this.#metadata['timedWorldInfo'] as TimedStore;
  }

  #ensureChatMetadata() {
    if (!this.#metadata['timedWorldInfo'] || typeof this.#metadata['timedWorldInfo'] !== 'object')
      this.#metadata['timedWorldInfo'] = {};
    const store = this.#metadata['timedWorldInfo'] as Record<string, unknown>;
    for (const type of ['sticky', 'cooldown'] as const) {
      if (!store[type] || typeof store[type] !== 'object') store[type] = {};
      const bucket = store[type] as Record<string, unknown>;
      for (const [key, value] of Object.entries(bucket)) {
        if (!value || typeof value !== 'object') delete bucket[key];
      }
    }
  }

  #getEntryHash(entry: WIEntry): number | undefined {
    return entry.hash;
  }
  #getEntryKey(entry: WIEntry): string {
    return `${entry.world}.${entry.uid}`;
  }
  #getEntryTimedEffect(type: TimedEffectType, entry: WIEntry, isProtected: boolean): WITimedEffect {
    return {
      hash: this.#getEntryHash(entry) ?? 0,
      start: this.#chat.length,
      end: this.#chat.length + Number(entry[type]),
      protected: !!isProtected,
    };
  }

  #onStickyEnded(entry: WIEntry) {
    if (!entry.cooldown) return;
    const key = this.#getEntryKey(entry);
    const effect = this.#getEntryTimedEffect('cooldown', entry, true);
    this.#store.cooldown[key] = effect;
    this.#log(
      `[WI] Adding cooldown entry ${key} on ended sticky: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`,
    );
    this.#buffer.cooldown.push(entry);
  }

  #checkTimedEffectOfType(
    type: 'sticky' | 'cooldown',
    buffer: WIEntry[],
    onEnded?: (entry: WIEntry) => void,
  ) {
    const bucket = this.#store[type];
    for (const [key, value] of Object.entries(bucket)) {
      const entry = this.#entries.find((x) => String(this.#getEntryHash(x)) === String(value.hash));
      if (this.#chat.length <= Number(value.start) && !value.protected) {
        this.#log(`[WI] Removing ${type} entry ${key} from timedWorldInfo: chat not advanced`);
        delete bucket[key];
        continue;
      }
      if (!entry) {
        if (this.#chat.length >= Number(value.end)) {
          this.#log(
            `[WI] Removing ${type} entry from timedWorldInfo: entry not found and interval passed`,
          );
          delete bucket[key];
        }
        continue;
      }
      if (!entry[type]) {
        this.#log(`[WI] Removing ${type} entry from timedWorldInfo: entry not ${type}`);
        delete bucket[key];
        continue;
      }
      if (this.#chat.length >= Number(value.end)) {
        this.#log(`[WI] Removing ${type} entry from timedWorldInfo: ${type} interval passed`);
        delete bucket[key];
        onEnded?.(entry);
        continue;
      }
      buffer.push(entry);
    }
  }

  #checkDelayEffect(buffer: WIEntry[]) {
    for (const entry of this.#entries) {
      if (!entry.delay) continue;
      if (this.#chat.length < entry.delay) buffer.push(entry);
    }
  }

  checkTimedEffects(): void {
    if (!this.#isDryRun) {
      this.#checkTimedEffectOfType('sticky', this.#buffer.sticky, (e) => this.#onStickyEnded(e));
      this.#checkTimedEffectOfType('cooldown', this.#buffer.cooldown);
    }
    this.#checkDelayEffect(this.#buffer.delay);
  }

  getEffectMetadata(type: TimedEffectType, entry: WIEntry): WITimedEffect | null {
    if (!this.isValidEffectType(type) || type === 'delay') return null;
    return this.#store[type][this.#getEntryKey(entry)] ?? null;
  }

  #setTimedEffectOfType(type: 'sticky' | 'cooldown', entry: WIEntry) {
    if (!entry[type]) return;
    const key = this.#getEntryKey(entry);
    if (!this.#store[type][key]) {
      const effect = this.#getEntryTimedEffect(type, entry, false);
      this.#store[type][key] = effect;
      this.#log(
        `[WI] Adding ${type} entry ${key}: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`,
      );
    }
  }

  setTimedEffects(activatedEntries: Iterable<WIEntry>): void {
    if (this.#isDryRun) return;
    for (const entry of activatedEntries) {
      this.#setTimedEffectOfType('sticky', entry);
      this.#setTimedEffectOfType('cooldown', entry);
    }
  }

  setTimedEffect(type: TimedEffectType, entry: WIEntry, newState: boolean): void {
    if (!this.isValidEffectType(type)) return;
    if (this.#isDryRun && type !== 'delay') return;
    if (type === 'delay') return;
    const key = this.#getEntryKey(entry);
    delete this.#store[type][key];
    if (newState) this.#store[type][key] = this.#getEntryTimedEffect(type, entry, false);
  }

  isValidEffectType(type: string): type is TimedEffectType {
    return (
      typeof type === 'string' &&
      ['sticky', 'cooldown', 'delay'].includes(type.trim().toLowerCase())
    );
  }

  isEffectActive(type: TimedEffectType, entry: WIEntry): boolean {
    if (!this.isValidEffectType(type)) return false;
    return (
      this.#buffer[type]?.some((x) => this.#getEntryHash(x) === this.#getEntryHash(entry)) ?? false
    );
  }

  cleanUp(): void {
    for (const buffer of Object.values(this.#buffer)) buffer.splice(0, buffer.length);
  }
}
