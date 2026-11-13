import { describe, expect, it } from 'vitest';
import { PresetManagerStandIn, type PresetIo } from '../src/lib/ext/preset-manager';

type Obj = Record<string, unknown>;

function memoryIo(files: Record<string, Obj>, selected = 'Default') {
  const state = { selected, applied: [] as string[] };
  const io: PresetIo = {
    list: async () => Object.keys(files),
    read: async (name) => structuredClone(files[name]!),
    write: async (name, body) => {
      files[name] = structuredClone(body);
      return name;
    },
    remove: async (name) => void delete files[name],
    selected: () => state.selected,
    current: () => ({ temperature: 1 }),
    apply: async (name) => {
      state.selected = name;
      state.applied.push(name);
    },
  };
  return { io, state };
}

describe('ST preset manager stand-in', () => {
  it('lists presets the way ST does and keeps the lists live', async () => {
    const { io } = memoryIo({ Default: { temperature: 1 }, Cool: { temperature: 0.2 } });
    const manager = new PresetManagerStandIn(io);
    await manager.ready();
    const list = manager.getPresetList();
    expect(list.preset_names).toEqual({ Default: 0, Cool: 1 });
    expect(list.presets[1]).toEqual({ temperature: 0.2 });
    expect(manager.getAllPresets()).toEqual(['Default', 'Cool']);
    expect(manager.findPreset('Cool')).toBe('1');
    expect(manager.findPreset('Missing')).toBeUndefined();
    expect(manager.getSelectedPresetName()).toBe('Default');
    expect(manager.getSelectedPreset()).toBe('0');
    expect(manager.getCompletionPresetByName('Cool')).toEqual({ temperature: 0.2 });
    await manager.refresh();
    expect(manager.getPresetList().presets).toBe(list.presets);
    expect(manager.getPresetList().preset_names).toBe(list.preset_names);
  });

  it('selects by option value, including one the extension added itself', async () => {
    const { io, state } = memoryIo({ Default: {} });
    const manager = new PresetManagerStandIn(io);
    await manager.ready();
    const { presets, preset_names } = manager.getPresetList();
    preset_names['Mine'] = presets.push({ temperature: 0.5 }) - 1;
    await manager.selectPreset(manager.findPreset('Mine'));
    await manager.selectPreset('7');
    expect(state.applied).toEqual(['Mine']);
  });

  it('saving chooses the preset unless told not to; deleting keeps other values valid', async () => {
    const files: Record<string, Obj> = { Default: {}, Cool: { temperature: 0.2 } };
    const { io, state } = memoryIo(files);
    const manager = new PresetManagerStandIn(io);
    await manager.ready();
    await manager.savePreset('Warm', { temperature: 1.4 });
    expect(state.applied).toEqual(['Warm']);
    expect(manager.findPreset('Warm')).toBe('2');
    await manager.savePreset('Quiet', { temperature: 0 }, { skipUpdate: true });
    expect(files['Quiet']).toEqual({ temperature: 0 });
    expect(manager.findPreset('Quiet')).toBeUndefined();
    await manager.savePreset('Now');
    expect(files['Now']).toEqual({ temperature: 1 });
    expect(await manager.deletePreset('Cool')).toBe(true);
    expect(await manager.deletePreset('Cool')).toBe(false);
    expect(files['Cool']).toBeUndefined();
    expect(manager.findPreset('Warm')).toBe('2');
  });
});
