// 条目收集与排序：ST getGlobalLore / getCharacterLore / getChatLore / getPersonaLore / getSortedEntries / parseDecorators。
import { getStringHash } from '../util/hash.js';
import {
  KNOWN_DECORATORS,
  WORLD_INFO_INSERTION_STRATEGY,
  WORLD_INFO_METADATA_KEY,
  type WIBook,
  type WIEntry,
} from './types.js';

const sortFn = (a: WIEntry, b: WIEntry) => (b.order ?? 0) - (a.order ?? 0);

export function bookEntries(book: WIBook | undefined | null, worldName: string): WIEntry[] {
  if (!book?.entries) return [];
  return Object.keys(book.entries).map((k) => {
    const { uid, ...rest } = book.entries[k]!;
    return { uid, world: worldName, ...rest } as WIEntry;
  });
}

export interface LoreSources {
  /** selected_world_info：全局启用的世界书名 */
  globalBooks: readonly string[];
  /** character.data.extensions.world */
  characterBook?: string | null | undefined;
  /** world_info.charLore[].extraBooks（按角色文件名匹配后的结果） */
  characterExtraBooks?: readonly string[] | undefined;
  /** chat_metadata.world_info */
  chatBook?: string | null | undefined;
  /** power_user.persona_description_lorebook */
  personaBook?: string | null | undefined;
}

export interface LoreCollection {
  globalLore: WIEntry[];
  characterLore: WIEntry[];
  chatLore: WIEntry[];
  personaLore: WIEntry[];
}

/** 等价于 ST 四个 get*Lore 的去重规则（同一本书只在一个来源出现） */
export function collectLore(
  sources: LoreSources,
  loadBook: (name: string) => WIBook | undefined | null,
): LoreCollection {
  const global = sources.globalBooks ?? [];
  const chatWorld = sources.chatBook || null;
  const personaWorld = sources.personaBook || null;

  const globalLore = global.flatMap((name) => bookEntries(loadBook(name), name));

  const worlds = new Set<string>();
  if (sources.characterBook) worlds.add(sources.characterBook);
  for (const extra of sources.characterExtraBooks ?? []) worlds.add(extra);
  const characterLore: WIEntry[] = [];
  for (const worldName of worlds) {
    if (global.includes(worldName) || chatWorld === worldName || personaWorld === worldName)
      continue;
    characterLore.push(...bookEntries(loadBook(worldName), worldName));
  }

  const chatLore =
    chatWorld && !global.includes(chatWorld) ? bookEntries(loadBook(chatWorld), chatWorld) : [];
  const personaLore =
    personaWorld && chatWorld !== personaWorld && !global.includes(personaWorld)
      ? bookEntries(loadBook(personaWorld), personaWorld)
      : [];

  return { globalLore, characterLore, chatLore, personaLore };
}

export function parseDecorators(content: string): [string[], string] {
  const isKnownDecorator = (data: string) => {
    if (data.startsWith('@@@')) data = data.substring(1);
    return KNOWN_DECORATORS.some((d) => data.startsWith(d));
  };
  if (content.startsWith('@@')) {
    let newContent = content;
    const split = content.split('\n');
    const decorators: string[] = [];
    let fallbacked = false;
    for (let i = 0; i < split.length; i++) {
      const line = split[i]!;
      if (line.startsWith('@@')) {
        if (line.startsWith('@@@') && !fallbacked) continue;
        if (isKnownDecorator(line)) {
          decorators.push(line.startsWith('@@@') ? line.substring(1) : line);
          fallbacked = false;
        } else {
          fallbacked = true;
        }
      } else {
        newContent = split.slice(i).join('\n');
        break;
      }
    }
    return [decorators, newContent];
  }
  return [[], content];
}

/** ST getSortedEntries：按插入策略合并，chat lore 最前、persona lore 次之，再解析 decorators 并计算 hash */
export function getSortedEntries(
  lore: LoreCollection,
  strategy: number,
  onUnknownStrategy?: (strategy: number) => void,
): WIEntry[] {
  const globalLore = [...lore.globalLore];
  const characterLore = [...lore.characterLore];
  let entries: WIEntry[];
  switch (Number(strategy)) {
    case WORLD_INFO_INSERTION_STRATEGY.evenly:
      entries = [...globalLore, ...characterLore].sort(sortFn);
      break;
    case WORLD_INFO_INSERTION_STRATEGY.character_first:
      entries = [...characterLore.sort(sortFn), ...globalLore.sort(sortFn)];
      break;
    case WORLD_INFO_INSERTION_STRATEGY.global_first:
      entries = [...globalLore.sort(sortFn), ...characterLore.sort(sortFn)];
      break;
    default:
      onUnknownStrategy?.(strategy);
      entries = [...globalLore, ...characterLore].sort(sortFn);
      break;
  }
  entries = [...[...lore.chatLore].sort(sortFn), ...[...lore.personaLore].sort(sortFn), ...entries];
  entries = entries
    .map((entry) => {
      const [decorators, content] = parseDecorators(entry.content || '');
      return { ...entry, decorators, content };
    })
    .map((entry) => ({ ...entry, hash: getStringHash(JSON.stringify(entry)) }));
  return structuredClone(entries);
}

export { WORLD_INFO_METADATA_KEY };
