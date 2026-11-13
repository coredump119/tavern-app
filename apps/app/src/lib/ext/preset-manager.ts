/**
 * ST `getPresetManager('openai')` stand-in (DEV_NOTES §9.34, 第 10 轮): the Chat Completion preset
 * list as ST's PresetManager shows it to extensions. The lists it hands out are the live ones, as in
 * ST, so an extension that adds to them itself stays in step. Bodies never carry connection fields.
 */
type Obj = Record<string, unknown>;

/** where the presets live; every body crossing it is already free of connection fields */
export interface PresetIo {
  list(): Promise<string[]>;
  read(name: string): Promise<Obj>;
  /** store a preset, keeping the file's own connection fields; resolves to the stored name */
  write(name: string, body: Obj): Promise<string>;
  remove(name: string): Promise<void>;
  /** name of the preset in use */
  selected(): string;
  /** the settings in use, as a preset body */
  current(): Obj;
  /** make `body` the settings in use, under `name` */
  apply(name: string, body: Obj): Promise<void>;
  /** ST's `#settings_preset_openai` stand-in: a select the extension may add options to */
  select?(): unknown;
}

export class PresetManagerStandIn {
  readonly apiId = 'openai';
  /** ST `openai_settings` / `openai_setting_names`: bodies by index, index by name */
  private readonly presets: Obj[] = [];
  private readonly names: Record<string, number> = {};
  private loading: Promise<void> | null = null;

  constructor(private readonly io: PresetIo) {}

  /** read the preset folder once; later calls wait for the same read */
  ready(): Promise<void> {
    return (this.loading ??= this.refresh());
  }

  async refresh(): Promise<void> {
    const names = await this.io.list();
    const bodies = await Promise.all(names.map((name) => this.io.read(name)));
    this.presets.splice(0, this.presets.length, ...bodies);
    for (const name of Object.keys(this.names)) delete this.names[name];
    names.forEach((name, index) => (this.names[name] = index));
  }

  get select(): unknown {
    return this.io.select?.();
  }

  isKeyedApi(): boolean {
    return true;
  }

  getPresetList(): { presets: Obj[]; preset_names: Record<string, number>; settings: Obj } {
    return { presets: this.presets, preset_names: this.names, settings: this.io.current() };
  }

  getAllPresets(): string[] {
    return Object.keys(this.names);
  }

  /** ST: the option value of the preset called `name` */
  findPreset(name: unknown): string | undefined {
    const index = this.names[String(name)];
    return index === undefined ? undefined : String(index);
  }

  getSelectedPresetName(): string {
    return this.io.selected();
  }

  getSelectedPreset(): string | undefined {
    return this.findPreset(this.io.selected());
  }

  getCompletionPresetByName(name: unknown): Obj | undefined {
    const index = this.names[String(name)];
    return index === undefined ? undefined : this.presets[index];
  }

  getPresetSettings(): Obj {
    return this.io.current();
  }

  private nameAt(value: unknown): string | undefined {
    const index = Number(value);
    return Object.keys(this.names).find((name) => this.names[name] === index);
  }

  /** ST: choose the option with this value, which loads the preset */
  async selectPreset(value: unknown): Promise<void> {
    const name = this.nameAt(value);
    const body = name === undefined ? undefined : this.presets[this.names[name]!];
    if (name !== undefined && body) await this.io.apply(name, body);
  }

  /** ST `savePreset(name, settings, { skipUpdate })`: without `skipUpdate` the saved preset is also chosen */
  async savePreset(name: unknown, settings?: Obj, { skipUpdate = false } = {}): Promise<void> {
    const body = settings ?? this.io.current();
    const stored = await this.io.write(String(name), body);
    if (skipUpdate) return;
    const kept = await this.io.read(stored);
    const at = this.names[stored];
    if (at === undefined) this.names[stored] = this.presets.push(kept) - 1;
    else this.presets[at] = kept;
    await this.io.apply(stored, kept);
  }

  /** ST keeps the body slot and drops the name, so the other option values stay valid */
  async deletePreset(name: unknown): Promise<boolean> {
    const target = name === undefined ? this.io.selected() : String(name);
    if (this.names[target] === undefined) return false;
    await this.io.remove(target);
    delete this.names[target];
    return true;
  }
}
