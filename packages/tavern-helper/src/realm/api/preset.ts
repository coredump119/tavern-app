/**
 * Chat Completion preset interfaces (DEV_NOTES §9.5 第 3 轮 → 数据接口 → 预设). `'in_use'` is the
 * live settings, which the catalog carries; a named preset is its file, read from the app.
 */
import _ from 'lodash';
import {
  DEFAULT_PRESET,
  fromPreset,
  isPresetNormalPrompt,
  isPresetPlaceholderPrompt,
  isPresetSystemPrompt,
  toPreset,
  type Preset,
} from '../../convert/preset.js';
import type { ApiModule, Hub } from '../hub.js';
import { own } from '../util.js';
import { patchPart, record, strings, text, type Dict, type Stores } from './shared.js';

const IN_USE = 'in_use';
type Updater = (preset: Preset) => Preset | PromiseLike<Preset>;

const names = (hub: Hub): string[] => strings(hub.part('presets')['names']);
const loaded = (hub: Hub): string => text(hub.part('presets')['inUse']);
const live = (hub: Hub): Dict => record(hub.part('presets')['current']);

const missing = (name: string): Error => new Error(`预设 '${name}' 不存在`);

export function presetModule(hub: Hub, stores: Stores): ApiModule {
  const { presets } = stores;

  const stored = async (name: string): Promise<Dict> => {
    if (name === IN_USE) return live(hub);
    if (!names(hub).includes(name)) throw missing(name);
    return presets.get(name);
  };

  const replace = async (name: string, preset: unknown): Promise<void> => {
    const body = fromPreset(own(preset), await stored(name));
    if (name === IN_USE) {
      await hub.call('preset.apply', [body]);
      patchPart(hub, 'presets', { current: { ...live(hub), ...body } });
      return;
    }
    await hub.call('preset.write', [name, body]);
    presets.set(name, body);
  };

  const create = async (name: string, preset: unknown): Promise<void> => {
    const body = fromPreset(own(preset ?? DEFAULT_PRESET));
    const saved = await hub.call<string>('preset.write', [name, body]);
    presets.set(saved, body);
    if (!names(hub).includes(saved)) patchPart(hub, 'presets', { names: [...names(hub), saved] });
  };

  return ({ give }) => ({
    getPresetNames: (): string[] => give([IN_USE, ...names(hub)]),
    getLoadedPresetName: (): string => loaded(hub),
    /** Synchronous like upstream: answers whether the preset exists, the app switches right after */
    loadPreset: (name: string): boolean => {
      if (!names(hub).includes(name)) return false;
      hub
        .call('preset.load', [name])
        .catch((e: unknown) => console.warn('[TavernHelper] loadPreset', e));
      return true;
    },
    getPreset: (name: string = IN_USE): Preset => {
      if (name === IN_USE) return give(toPreset(live(hub)));
      if (!names(hub).includes(name)) throw missing(name);
      return give(toPreset(presets.peek(name)));
    },
    createPreset: async (name: string, preset?: unknown): Promise<boolean> => {
      if (name === IN_USE || names(hub).includes(name)) return false;
      await create(name, preset);
      return true;
    },
    createOrReplacePreset: async (name: string, preset?: unknown): Promise<boolean> => {
      if (name === IN_USE || names(hub).includes(name)) {
        await replace(name, preset ?? DEFAULT_PRESET);
        return false;
      }
      await create(name, preset);
      return true;
    },
    deletePreset: async (name: string): Promise<boolean> => {
      if (name === IN_USE || !names(hub).includes(name)) return false;
      await hub.call('preset.delete', [name]);
      presets.drop(name);
      patchPart(hub, 'presets', { names: names(hub).filter((other) => other !== name) });
      return true;
    },
    renamePreset: async (name: string, newName: string): Promise<boolean> => {
      if (name === IN_USE || !names(hub).includes(name) || names(hub).includes(newName))
        return false;
      const saved = await hub.call<string>('preset.rename', [name, String(newName)]);
      presets.drop(name);
      patchPart(hub, 'presets', {
        names: names(hub).map((other) => (other === name ? saved : other)),
        ...(loaded(hub) === name ? { inUse: saved } : {}),
      });
      return true;
    },
    replacePreset: (name: string, preset: unknown): Promise<void> => replace(name, preset),
    updatePresetWith: async (name: string, updater: Updater): Promise<Preset> => {
      await replace(name, await updater(give(toPreset(await stored(name)))));
      return give(toPreset(await stored(name)));
    },
    /** A partial preset merged into the stored one; a list replaces the list it meets */
    setPreset: async (name: string, partial: unknown): Promise<Preset> => {
      const merged = _.mergeWith(toPreset(await stored(name)), own(partial), (_old, next) =>
        Array.isArray(next) ? next : undefined,
      );
      await replace(name, merged);
      return give(toPreset(await stored(name)));
    },
    isPresetNormalPrompt,
    isPresetSystemPrompt,
    isPresetPlaceholderPrompt,
    default_preset: give(DEFAULT_PRESET),
  });
}
