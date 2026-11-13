/**
 * Character card interfaces (DEV_NOTES §9.5 第 3 轮 → 数据接口 → 角色). The list of cards and the
 * open card come with the catalog; every other card is read from the app by its avatar file name.
 */
import {
  characterName,
  fromCharacter,
  toCharacter,
  type Character,
} from '../../convert/character.js';
import type { ApiModule, Hub } from '../hub.js';
import { own } from '../util.js';
import {
  cardData,
  characterRows,
  currentAvatar,
  findAvatar,
  record,
  records,
  requireAvatar,
  text,
  unsupported,
  type Dict,
  type Stores,
} from './shared.js';

type Updater = (character: Character) => Character | PromiseLike<Character>;

/** The card as ST keeps it in memory (`characters[i]`); synchronous, so other cards come from the cache */
function storedCard(hub: Hub, stores: Stores, avatar: string): Dict {
  if (avatar === currentAvatar(hub)) return record(hub.catalog.character);
  const card = stores.cards.peek(avatar);
  return { ...card, avatar, name: characterName(card, avatar) };
}

export function characterModule(hub: Hub, stores: Stores): ApiModule {
  const { cards } = stores;

  const exists = (nameOrId: unknown): boolean => findAvatar(hub, nameOrId) !== null;

  const read = async (nameOrId: unknown): Promise<Character> => {
    const avatar = requireAvatar(hub, nameOrId);
    return toCharacter(await cards.get(avatar), avatar);
  };

  const replace = async (nameOrId: unknown, character: unknown): Promise<void> => {
    const avatar = requireAvatar(hub, nameOrId);
    const next = fromCharacter(own(character), await cards.get(avatar));
    await hub.call('character.write', [avatar, next]);
    cards.set(avatar, next);
  };

  const create = async (name: string, character: unknown): Promise<void> => {
    const card = fromCharacter(own(character ?? {}), undefined, name);
    const avatar = await hub.call<string>('character.create', [card]);
    hub.catalog.characters = [...characterRows(hub), { avatar, name }];
  };

  return ({ give }) => {
    /** `RawCharacter`: a thin reader over one card, as upstream scripts construct it */
    class RawCharacter {
      private readonly card: Dict;
      constructor(characterData: unknown) {
        this.card = record(own(characterData));
      }
      static find(option: { name?: string } = {}): Dict | null {
        const avatar = findAvatar(hub, option.name ?? 'current');
        return avatar ? give(storedCard(hub, stores, avatar)) : null;
      }
      static findIndex(name: string): number {
        const avatar = findAvatar(hub, name);
        return avatar ? characterRows(hub).findIndex((row) => row.avatar === avatar) : -1;
      }
      static getChatsFromFiles = unsupported('RawCharacter.getChatsFromFiles');
      getCardData(): Dict {
        return give(this.card);
      }
      getAvatarId(): string {
        return text(this.card['avatar']);
      }
      getRegexScripts(): Dict[] {
        return give(records(record(cardData(this.card)['extensions'])['regex_scripts']));
      }
      getCharacterBook(): Dict | null {
        const book = cardData(this.card)['character_book'];
        return book && typeof book === 'object' ? give(book as Dict) : null;
      }
      getWorldName(): string {
        return text(record(cardData(this.card)['extensions'])['world']);
      }
    }

    return {
      getCharacterNames: (): string[] => give(characterRows(hub).map((row) => row.name)),
      getCharacterIds: (): string[] => give(characterRows(hub).map((row) => row.avatar)),
      getCurrentCharacterName: (): string | null =>
        text(record(hub.part('session')['character'])['name']) || null,
      getCurrentCharacterId: (): string | null => currentAvatar(hub),

      getCharacter: async (nameOrId?: string): Promise<Character> => give(await read(nameOrId)),
      createCharacter: async (nameOrId: string, character?: unknown): Promise<boolean> => {
        if (exists(nameOrId)) return false;
        await create(String(nameOrId), character);
        return true;
      },
      createOrReplaceCharacter: async (nameOrId: string, character?: unknown): Promise<boolean> => {
        if (exists(nameOrId)) {
          await replace(nameOrId, character ?? {});
          return false;
        }
        await create(String(nameOrId), character);
        return true;
      },
      replaceCharacter: (nameOrId: string, character: unknown): Promise<void> =>
        replace(nameOrId, character),
      updateCharacterWith: async (nameOrId: string, updater: Updater): Promise<Character> => {
        await replace(nameOrId, await updater(give(await read(nameOrId))));
        return give(await read(nameOrId));
      },
      deleteCharacter: async (
        nameOrId: string,
        option: { delete_chats?: boolean } = {},
      ): Promise<boolean> => {
        const avatar = findAvatar(hub, nameOrId);
        if (!avatar) return false;
        await hub.call('character.delete', [avatar, !!option.delete_chats]);
        cards.drop(avatar);
        hub.catalog.characters = characterRows(hub).filter((row) => row.avatar !== avatar);
        return true;
      },

      // ---- older interfaces ----
      RawCharacter,
      getCharData: (name?: string): Dict | null => {
        const avatar = findAvatar(hub, name);
        return avatar ? give(storedCard(hub, stores, avatar)) : null;
      },
      /** The avatar's place in the data folder. Not a URL: the realm cannot load app files. */
      getCharAvatarPath: (name?: string): string | null => {
        const avatar = findAvatar(hub, name);
        return avatar ? `characters/${avatar}` : null;
      },
      getChatHistoryBrief: async (name?: string): Promise<Dict[] | null> => {
        const avatar = findAvatar(hub, name);
        return avatar ? give(await hub.call<Dict[]>('chat.list', [avatar])) : null;
      },
      getChatHistoryDetail: unsupported('getChatHistoryDetail'),
    };
  };
}
