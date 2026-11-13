/**
 * Regex script interfaces (DEV_NOTES §9.5 第 3 轮 → 数据接口 → 正则). The three script lists in
 * use (global, the open card's, the loaded preset's) come with the catalog; those of another card
 * or preset are read from its file.
 */
import { fromTavernRegex, toTavernRegex, type TavernRegex } from '../../convert/preset.js';
import type { ApiModule, Hub } from '../hub.js';
import type { RegexDestination, RegexSource } from '../render.js';
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

type Scope = 'global' | 'character' | 'preset';
/** The current option names a list by `type`; the older one filtered by `scope` and `enable_state` */
interface RegexOption {
  type?: Scope;
  name?: string;
  scope?: 'all' | 'global' | 'character';
  enable_state?: 'all' | 'enabled' | 'disabled';
}
type ScopedRegex = TavernRegex & { scope?: 'global' | 'character' };
type Updater = (regexes: ScopedRegex[]) => ScopedRegex[] | PromiseLike<ScopedRegex[]>;

interface Target {
  scope: Scope;
  /** an avatar or a preset name when the list is not one of the three in use */
  other: string | null;
}

export function regexModule(hub: Hub, stores: Stores): ApiModule {
  const part = (): Dict => hub.part('regex');
  const loadedPreset = (): string => text(hub.part('presets')['inUse']);

  const target = (option: RegexOption): Target => {
    const scope = option.type ?? 'global';
    if (scope === 'character') {
      const avatar = requireAvatar(hub, option.name);
      return { scope, other: avatar === currentAvatar(hub) ? null : avatar };
    }
    if (scope === 'preset') {
      const name = option.name ?? 'in_use';
      if (name === 'in_use' || name === loadedPreset()) return { scope, other: null };
      if (!strings(hub.part('presets')['names']).includes(name))
        throw new Error(`预设 '${name}' 不存在`);
      return { scope, other: name };
    }
    if (scope !== 'global') throw new Error(`没有 "${String(scope)}" 这组正则`);
    return { scope, other: null };
  };

  const fileScripts = (at: Target, file: Dict): Dict[] =>
    records(
      record(at.scope === 'character' ? cardData(file)['extensions'] : file['extensions'])[
        'regex_scripts'
      ],
    );

  /** ST-shaped scripts of one list; synchronous, so another card or preset comes from the cache */
  const stored = (at: Target): Dict[] => {
    if (!at.other) return records(part()[at.scope]);
    const cache = at.scope === 'character' ? stores.cards : stores.presets;
    return fileScripts(at, cache.peek(at.other));
  };

  const save = async (at: Target, regexes: unknown): Promise<void> => {
    const input = records(own(regexes));
    if (!at.other) {
      const before = new Map(stored(at).map((script) => [script['id'], script]));
      const scripts = input.map((regex) => fromTavernRegex(regex, before.get(regex['id'])));
      await hub.call('regex.set', [at.scope, scripts]);
      patchPart(hub, 'regex', { [at.scope]: scripts });
      return;
    }
    // another card or preset: its file is rewritten with the new list
    const cache = at.scope === 'character' ? stores.cards : stores.presets;
    const file = structuredClone(await cache.get(at.other));
    const before = new Map(fileScripts(at, file).map((script) => [script['id'], script]));
    const scripts = input.map((regex) => fromTavernRegex(regex, before.get(regex['id'])));
    const holder = at.scope === 'character' ? cardData(file) : file;
    holder['extensions'] = { ...record(holder['extensions']), regex_scripts: scripts };
    await hub.call(at.scope === 'character' ? 'character.write' : 'preset.write', [at.other, file]);
    cache.set(at.other, file);
  };

  const tagged = (scope: 'global' | 'character'): ScopedRegex[] =>
    stored({ scope, other: null }).map((script) => ({ ...toTavernRegex(script), scope }));

  const list = (option: RegexOption = {}): ScopedRegex[] => {
    if (option.type) return stored(target(option)).map(toTavernRegex);
    // the older call: both lists, each script saying where it lives
    const scope = option.scope ?? 'all';
    const state = option.enable_state ?? 'all';
    return [
      ...(scope === 'character' ? [] : tagged('global')),
      ...(scope === 'global' || !currentAvatar(hub) ? [] : tagged('character')),
    ].filter((regex) => state === 'all' || (state === 'enabled') === regex.enabled);
  };

  const replace = async (regexes: unknown, option: RegexOption = {}): Promise<void> => {
    if (option.type) return save(target(option), regexes);
    const scope = option.scope ?? 'all';
    const input = records(own(regexes));
    const of = (wanted: 'global' | 'character') =>
      input.filter((regex) => (regex['scope'] ?? 'global') === wanted);
    if (scope !== 'character') await save({ scope: 'global', other: null }, of('global'));
    if (scope !== 'global' && currentAvatar(hub))
      await save({ scope: 'character', other: null }, of('character'));
  };

  return ({ give }) => ({
    formatAsTavernRegexedString: (
      input: string,
      source: RegexSource,
      destination: RegexDestination,
      option: { depth?: number; character_name?: string } = {},
    ): string =>
      hub.renderer?.regex(String(input), source, destination, {
        ...(option.depth === undefined ? {} : { depth: option.depth }),
        ...(option.character_name === undefined ? {} : { characterName: option.character_name }),
      }) ?? String(input),
    isCharacterTavernRegexesEnabled: (): boolean => !!part()['characterEnabled'],
    getTavernRegexes: (option?: RegexOption): ScopedRegex[] => give(list(option)),
    replaceTavernRegexes: (regexes: ScopedRegex[], option?: RegexOption): Promise<void> =>
      replace(regexes, option),
    updateTavernRegexesWith: async (
      updater: Updater,
      option?: RegexOption,
    ): Promise<ScopedRegex[]> => {
      await replace(await updater(give(list(option))), option);
      return give(list(option));
    },
  });
}
