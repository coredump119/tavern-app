/**
 * Worldbook interfaces and the older lorebook ones (DEV_NOTES §9.5 第 3 轮 → 数据接口 → 世界书).
 * The catalog carries the names, the bindings and the global settings; a book's entries are read
 * from the app each time, converted here, and written back whole in ST's own shape.
 */
import {
  fromLorebookEntry,
  fromLorebookSettings,
  fromWorldbookEntries,
  toLorebookEntries,
  toLorebookSettings,
  toWorldbookEntries,
  type LorebookEntry,
  type LorebookSettings,
  type StWorldFile,
  type WorldbookEntry,
} from '../../convert/worldbook.js';
import type { ApiModule, Hub } from '../hub.js';
import { own } from '../util.js';
import {
  cardData,
  currentAvatar,
  patchPart,
  record,
  records,
  requireAvatar,
  strings,
  text,
  type Dict,
  type Stores,
} from './shared.js';

interface CharWorldbooks {
  primary: string | null;
  additional: string[];
}
type EntriesUpdater<T> = (entries: T[]) => T[] | PromiseLike<T[]>;

const names = (hub: Hub): string[] => strings(hub.part('worlds')['names']);
const settings = (hub: Hub): Dict => record(hub.part('worlds')['settings']);

/** ST links a card's additional books by its file name without the extension */
const loreKey = (avatar: string): string => avatar.replace(/\.[^.]+$/, '');

/** The lowest non-negative integer not in `taken`; it is added */
function freeUid(taken: Set<number>): number {
  let uid = 0;
  while (taken.has(uid)) uid++;
  taken.add(uid);
  return uid;
}

const isUid = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

export function worldbookModule(hub: Hub, stores: Stores): ApiModule {
  const read = (name: string): Promise<StWorldFile> =>
    hub.call<StWorldFile>('world.read', [String(name)]);

  /** Creates the book when there is none by that name */
  const write = async (name: string, file: StWorldFile): Promise<void> => {
    const stored = await hub.call<string>('world.write', [String(name), file]);
    const known = names(hub);
    if (!known.includes(stored)) patchPart(hub, 'worlds', { names: [...known, stored] });
  };

  const remove = async (name: string): Promise<boolean> => {
    if (!names(hub).includes(name)) return false;
    await hub.call('world.delete', [name]);
    patchPart(hub, 'worlds', { names: names(hub).filter((other) => other !== name) });
    return true;
  };

  const globalNames = (): string[] => toLorebookSettings(settings(hub)).selected_global_lorebooks;

  const applySettings = async (patch: Dict): Promise<void> => {
    const assign = fromLorebookSettings(patch, settings(hub));
    await hub.call('world.settings', [assign]);
    patchPart(hub, 'worlds', { settings: { ...settings(hub), ...assign } });
  };

  const charBooks = (name: unknown): CharWorldbooks => {
    const avatar = requireAvatar(hub, name);
    const card =
      avatar === currentAvatar(hub) ? record(hub.catalog.character) : stores.cards.peek(avatar);
    const links = records(record(settings(hub)['world_info'])['charLore']);
    const link = links.find((row) => row['name'] === loreKey(avatar));
    return {
      primary: text(record(cardData(card)['extensions'])['world']) || null,
      additional: strings(link?.['extraBooks']),
    };
  };

  const bindChar = async (name: unknown, books: CharWorldbooks): Promise<void> => {
    const avatar = requireAvatar(hub, name);
    await hub.call('world.bindCharacter', [avatar, books]);
    stores.cards.drop(avatar);
  };

  const chatBook = (): string | null => text(hub.part('worlds')['chat']) || null;

  const bindChat = async (name: string | null): Promise<void> => {
    await hub.call('world.bindChat', [name]);
    patchPart(hub, 'worlds', { chat: name });
  };

  const chatBookOrNew = async (wanted?: string): Promise<string> => {
    const bound = chatBook();
    if (bound) return bound;
    const name = wanted || `Chat Book ${hub.chatId ?? ''}`.trim();
    if (!names(hub).includes(name)) await write(name, { entries: {} });
    await bindChat(name);
    return name;
  };

  const entries = async (name: string): Promise<WorldbookEntry[]> =>
    toWorldbookEntries(await read(name));

  const replace = async (name: string, next: unknown): Promise<void> => {
    await write(name, fromWorldbookEntries(own(next) as unknown[], await read(name)));
  };

  // ---- the older flat shape ----

  const flat = async (name: string): Promise<LorebookEntry[]> =>
    toLorebookEntries(await read(name));

  /** Partial flat entries onto a book: a known uid changes that entry, anything else is added */
  const mergeFlat = async (
    name: string,
    patches: unknown,
    keepOthers: boolean,
  ): Promise<{ added: number[] }> => {
    const file = await read(name);
    const stored = record(file.entries);
    const taken = new Set(Object.keys(stored).map(Number).filter(isUid));
    const next: Record<string, Dict> = keepOthers ? { ...(stored as Record<string, Dict>) } : {};
    const added: number[] = [];
    const seen = new Set<number>();
    for (const patch of records(own(patches))) {
      const given = patch['uid'];
      const known = isUid(given) && !seen.has(given) && stored[String(given)] !== undefined;
      const uid = known ? given : freeUid(taken);
      seen.add(uid);
      if (!known) added.push(uid);
      next[String(uid)] = fromLorebookEntry(
        patch,
        uid,
        known ? record(stored[String(uid)]) : undefined,
      );
    }
    await write(name, { ...file, entries: next });
    return { added };
  };

  return ({ give }) => ({
    getWorldbookNames: (): string[] => give(names(hub)),
    getGlobalWorldbookNames: (): string[] => give(globalNames()),
    rebindGlobalWorldbooks: (worldbooks: string[]): Promise<void> =>
      applySettings({ selected_global_lorebooks: strings(own(worldbooks)) }),
    getCharWorldbookNames: (name?: string): CharWorldbooks => give(charBooks(name)),
    rebindCharWorldbooks: (name: string, books: CharWorldbooks): Promise<void> =>
      bindChar(name, {
        primary: books.primary ?? null,
        additional: strings(own(books.additional)),
      }),
    getChatWorldbookName: (): string | null => chatBook(),
    rebindChatWorldbook: (_chat: 'current', name: string): Promise<void> => bindChat(String(name)),
    getOrCreateChatWorldbook: (_chat?: 'current', name?: string): Promise<string> =>
      chatBookOrNew(name),

    getWorldbook: async (name: string): Promise<WorldbookEntry[]> => give(await entries(name)),
    createWorldbook: async (name: string, worldbook: unknown[] = []): Promise<boolean> => {
      if (names(hub).includes(name)) return false;
      await write(name, fromWorldbookEntries(own(worldbook)));
      return true;
    },
    createOrReplaceWorldbook: async (name: string, worldbook: unknown[] = []): Promise<boolean> => {
      if (names(hub).includes(name)) {
        await replace(name, worldbook);
        return false;
      }
      await write(name, fromWorldbookEntries(own(worldbook)));
      return true;
    },
    deleteWorldbook: (name: string): Promise<boolean> => remove(name),
    replaceWorldbook: (name: string, worldbook: unknown[]): Promise<void> =>
      replace(name, worldbook),
    updateWorldbookWith: async (
      name: string,
      updater: EntriesUpdater<WorldbookEntry>,
    ): Promise<WorldbookEntry[]> => {
      await replace(name, await updater(give(await entries(name))));
      return give(await entries(name));
    },
    createWorldbookEntries: async (
      name: string,
      added: unknown[],
    ): Promise<{ worldbook: WorldbookEntry[]; new_entries: WorldbookEntry[] }> => {
      const file = await read(name);
      const before = toWorldbookEntries(file);
      // behind the existing ones, which claim their uids first: a new entry never takes one over
      await write(name, fromWorldbookEntries([...before, ...records(own(added))], file));
      const worldbook = await entries(name);
      return give({ worldbook, new_entries: worldbook.slice(before.length) });
    },
    deleteWorldbookEntries: async (
      name: string,
      predicate: (entry: WorldbookEntry) => boolean,
    ): Promise<{ worldbook: WorldbookEntry[]; deleted_entries: WorldbookEntry[] }> => {
      const file = await read(name);
      const all = toWorldbookEntries(file);
      const doomed = new Set(
        all.filter((entry) => predicate(give(entry))).map((entry) => entry.uid),
      );
      if (doomed.size > 0)
        await write(
          name,
          fromWorldbookEntries(
            all.filter((entry) => !doomed.has(entry.uid)),
            file,
          ),
        );
      return give({
        worldbook: doomed.size > 0 ? await entries(name) : all,
        deleted_entries: all.filter((entry) => doomed.has(entry.uid)),
      });
    },

    // ---- older interfaces ----
    getLorebookSettings: (): LorebookSettings => give(toLorebookSettings(settings(hub))),
    setLorebookSettings: (patch: Partial<LorebookSettings>): Promise<void> =>
      applySettings(record(own(patch))),
    getLorebooks: (): string[] => give(names(hub)),
    createLorebook: async (name: string): Promise<boolean> => {
      if (names(hub).includes(name)) return false;
      await write(name, { entries: {} });
      return true;
    },
    deleteLorebook: (name: string): Promise<boolean> => remove(name),
    getCharLorebooks: (
      option: { name?: string; type?: 'all' | 'primary' | 'additional' } = {},
    ): CharWorldbooks => {
      const books = charBooks(option.name);
      const type = option.type ?? 'all';
      return give({
        primary: type === 'additional' ? null : books.primary,
        additional: type === 'primary' ? [] : books.additional,
      });
    },
    getCurrentCharPrimaryLorebook: (): string | null =>
      currentAvatar(hub) ? charBooks('current').primary : null,
    setCurrentCharLorebooks: (books: Partial<CharWorldbooks>): Promise<void> => {
      const now = charBooks('current');
      return bindChar('current', {
        primary: books.primary === undefined ? now.primary : books.primary,
        additional:
          books.additional === undefined ? now.additional : strings(own(books.additional)),
      });
    },
    getChatLorebook: (): string | null => chatBook(),
    setChatLorebook: (name: string | null): Promise<void> => bindChat(name || null),
    getOrCreateChatLorebook: (name?: string): Promise<string> => chatBookOrNew(name),

    getLorebookEntries: async (name: string): Promise<LorebookEntry[]> => give(await flat(name)),
    replaceLorebookEntries: async (name: string, next: unknown[]): Promise<void> => {
      await mergeFlat(name, next, false);
    },
    updateLorebookEntriesWith: async (
      name: string,
      updater: EntriesUpdater<LorebookEntry>,
    ): Promise<LorebookEntry[]> => {
      await mergeFlat(name, await updater(give(await flat(name))), false);
      return give(await flat(name));
    },
    setLorebookEntries: async (name: string, patches: unknown[]): Promise<LorebookEntry[]> => {
      await mergeFlat(name, patches, true);
      return give(await flat(name));
    },
    createLorebookEntries: async (
      name: string,
      added: unknown[],
    ): Promise<{ entries: LorebookEntry[]; new_uids: number[] }> => {
      // a uid of their own would overwrite an entry: new ones always get a free number
      const fresh = records(own(added)).map(({ uid: _uid, ...rest }) => rest);
      const { added: new_uids } = await mergeFlat(name, fresh, true);
      return give({ entries: await flat(name), new_uids });
    },
    deleteLorebookEntries: async (
      name: string,
      uids: number[],
    ): Promise<{ entries: LorebookEntry[]; delete_occurred: boolean }> => {
      const file = await read(name);
      const stored = record(file.entries) as Record<string, Dict>;
      const doomed = new Set(own(uids).map(String));
      const kept = Object.fromEntries(Object.entries(stored).filter(([uid]) => !doomed.has(uid)));
      const delete_occurred = Object.keys(kept).length !== Object.keys(stored).length;
      if (delete_occurred) await write(name, { ...file, entries: kept });
      return give({ entries: toLorebookEntries({ ...file, entries: kept }), delete_occurred });
    },
  });
}
