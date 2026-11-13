/**
 * The script library as the app sees it (DEV_NOTES §9.5): where the three scopes are stored, which
 * scripts run for the open chat, and the writes behind the library sheet and the bridge.
 *
 * Reads go through the store's deep state, so a settings change elsewhere (a variable write, a
 * slider) does not re-read the library.
 */
import {
  allScripts,
  editScript,
  helperField,
  mapScript,
  normalizeScriptSettings,
  normalizeScriptTrees,
  runningScripts,
  visibleButtons,
  withHelperFields,
  type Script,
  type ScriptEdit,
  type ScriptScope,
  type ScriptSettings,
  type ScriptsState,
  type ScriptTree,
  type ScriptTrees,
} from '@tm/tavern-helper';
import { chatStore } from '../chat/store.svelte';
import { cardRead, cardWrite, dataReadText, dataWriteText } from '../ipc';

type Obj = Record<string, unknown>;

/** card and preset files are rewritten this long after the last change to their scripts */
const FILE_WRITE_DELAY = 500;
const PRESET_DIR = 'OpenAI Settings';
const NO_TREES: ScriptTree[] = [];

const isRecord = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** ids for stored scripts that have none: the same on every read, so their iframes are not rebuilt */
function fallbackIds(scope: ScriptScope): () => string {
  let n = 0;
  return () => `auto-${scope}-${n++}`;
}

/** The old card field wrapped each script as `{ type, value }` */
function legacyScripts(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return (raw as unknown[]).map((item) =>
    isRecord(item) && isRecord(item['value']) ? { ...item['value'], type: item['type'] } : item,
  );
}

const toggled = (list: readonly string[], item: string, on: boolean): string[] =>
  on ? (list.includes(item) ? [...list] : [...list, item]) : list.filter((x) => x !== item);

export interface ScriptButtonRef {
  scriptId: string;
  name: string;
}

class ScriptLibrary {
  /** `extension_settings.tavern_helper.script` */
  readonly stored = $derived.by((): ScriptSettings => {
    const extensions = chatStore.settings?.['extension_settings'] as
      { tavern_helper?: { script?: unknown } } | undefined;
    const raw = extensions?.tavern_helper?.script;
    return normalizeScriptSettings(
      raw === undefined ? undefined : $state.snapshot(raw),
      fallbackIds('global'),
    );
  });

  /** the open character's card file; null in a group chat */
  readonly avatar = $derived(chatStore.group ? null : (chatStore.character?.avatar ?? null));
  /** the Chat Completion preset in use; null while another API is selected */
  readonly presetName = $derived.by((): string | null => {
    const settings = chatStore.settings;
    if (settings?.['main_api'] !== 'openai') return null;
    const oai = settings['oai_settings'] as Obj | undefined;
    return String(oai?.['preset_settings_openai'] ?? '') || null;
  });

  private readonly characterTrees = $derived.by((): ScriptTree[] => {
    if (!this.avatar) return NO_TREES;
    const data = chatStore.character?.['data'] as Obj | undefined;
    const extensions = data?.['extensions'];
    if (!isRecord(extensions)) return NO_TREES;
    const raw =
      helperField(extensions)['scripts'] ?? legacyScripts(extensions['TavernHelper_scripts']);
    return raw === undefined
      ? NO_TREES
      : normalizeScriptTrees($state.snapshot(raw), fallbackIds('character'));
  });

  private readonly presetTrees = $derived.by((): ScriptTree[] => {
    if (!this.presetName) return NO_TREES;
    const oai = chatStore.settings?.['oai_settings'] as Obj | undefined;
    const raw = helperField(oai?.['extensions'])['scripts'];
    return raw === undefined
      ? NO_TREES
      : normalizeScriptTrees($state.snapshot(raw), fallbackIds('preset'));
  });

  readonly trees = $derived<ScriptTrees>({
    global: this.stored.scripts,
    character: this.characterTrees,
    preset: this.presetTrees,
  });

  /** scope switches: character and preset scripts stay off until the user turns them on */
  readonly scopes = $derived<Record<ScriptScope, boolean>>({
    global: this.stored.enabled.global,
    character: this.avatar !== null && this.stored.enabled.characters.includes(this.avatar),
    preset: this.presetName !== null && this.stored.enabled.presets.includes(this.presetName),
  });

  private readonly running = $derived(
    chatStore.open ? runningScripts(this.trees, this.scopes) : [],
  );

  /** what the realm is told; scripts restart when the chat (`epoch`) changes */
  readonly state = $derived<ScriptsState>({
    epoch: chatStore.chatRel ?? '',
    trees: this.trees,
    running: this.running.map((s) => s.id),
  });

  readonly buttons = $derived<ScriptButtonRef[]>(
    this.running.flatMap((s) => visibleButtons(s).map((b) => ({ scriptId: s.id, name: b.name }))),
  );

  /** a card or preset brought scripts the user has not been told about yet */
  readonly unseen = $derived.by((): Exclude<ScriptScope, 'global'> | null => {
    const { popuped, enabled } = this.stored;
    const fresh = (key: string | null, trees: ScriptTree[], seen: string[], on: string[]) =>
      key !== null && trees.length > 0 && !seen.includes(key) && !on.includes(key);
    if (fresh(this.avatar, this.characterTrees, popuped.characters, enabled.characters)) {
      return 'character';
    }
    if (fresh(this.presetName, this.presetTrees, popuped.presets, enabled.presets)) return 'preset';
    return null;
  });

  private readonly pendingCards = new Map<string, ScriptTree[]>();
  /** preset name → the `tavern_helper` fields its file has not got yet */
  private readonly pendingPresets = new Map<string, Obj>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();

  /** Replace one scope's scripts: memory now, files a moment later. */
  setTrees(scope: ScriptScope, trees: ScriptTree[]): void {
    if (scope === 'global') {
      this.writeStored({ ...this.stored, scripts: trees });
      return;
    }
    if (scope === 'character') {
      const avatar = this.avatar;
      const data = chatStore.character?.['data'];
      if (!avatar || !isRecord(data)) throw new Error('没有打开的角色');
      data['extensions'] = withHelperFields($state.snapshot(data['extensions']), {
        scripts: trees,
      });
      this.pendingCards.set(avatar, trees);
      this.schedule();
    } else {
      if (!this.presetName) throw new Error('当前没有 Chat Completion 预设');
      this.setPresetField('scripts', trees);
    }
  }

  /**
   * One `tavern_helper` field (`scripts`, `variables`) of the preset in use: the settings bucket
   * now, the preset's file a moment later (ST `writePresetExtensionField` writes both).
   */
  setPresetField(key: 'scripts' | 'variables', value: unknown): void {
    chatStore.mutateSettings((settings) => {
      const oai = (settings['oai_settings'] ??= {}) as Obj;
      oai['extensions'] = withHelperFields($state.snapshot(oai['extensions']), { [key]: value });
    });
    // unsaved defaults or another API selected: the settings bucket is all there is
    const name = this.presetName;
    if (!name) return;
    this.pendingPresets.set(name, { ...this.pendingPresets.get(name), [key]: value });
    this.schedule();
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.writes = this.writes.then(() => this.flush());
    }, FILE_WRITE_DELAY);
  }

  setScopeEnabled(scope: ScriptScope, on: boolean): void {
    const { enabled } = this.stored;
    if (scope === 'global') {
      this.writeStored({ ...this.stored, enabled: { ...enabled, global: on } });
    } else if (scope === 'character' && this.avatar) {
      const characters = toggled(enabled.characters, this.avatar, on);
      this.writeStored({ ...this.stored, enabled: { ...enabled, characters } });
    } else if (scope === 'preset' && this.presetName) {
      const presets = toggled(enabled.presets, this.presetName, on);
      this.writeStored({ ...this.stored, enabled: { ...enabled, presets } });
    }
  }

  /** Switch a script or a folder */
  setEnabled(scope: ScriptScope, id: string, on: boolean): void {
    const trees = this.trees[scope];
    const folder = trees.some((t) => t.type === 'folder' && t.id === id);
    this.setTrees(
      scope,
      folder
        ? trees.map((t) => (t.id === id ? { ...t, enabled: on } : t))
        : mapScript(trees, id, (s) => ({ ...s, enabled: on })),
    );
  }

  /** Delete a script or a folder (with what it holds) */
  remove(scope: ScriptScope, id: string): void {
    this.setTrees(
      scope,
      this.trees[scope]
        .filter((t) => t.id !== id)
        .map((t) =>
          t.type === 'folder' ? { ...t, scripts: t.scripts.filter((s) => s.id !== id) } : t,
        ),
    );
  }

  /**
   * Save what the editor changed about one script (also inside a folder). The switch is left as it
   * is: code the user wrote here is code they have seen. False when the script is no longer in
   * `scope`.
   */
  updateScript(scope: ScriptScope, id: string, edit: ScriptEdit): boolean {
    const trees = this.trees[scope];
    const next = editScript(trees, id, edit);
    if (next === trees) return false;
    this.setTrees(scope, next);
    return true;
  }

  /** Append a script written in the app to `scope`; returns the id it got (a taken one is replaced) */
  addScript(scope: ScriptScope, script: Script): string {
    const trees = this.trees[scope];
    const taken = allScripts(trees).some((s) => s.id === script.id);
    const id = taken ? crypto.randomUUID() : script.id;
    this.setTrees(scope, [...trees, { ...script, id }]);
    return id;
  }

  /**
   * Add scripts from an exported JSON (one script, a list, or a folder) to the global scope.
   * They arrive switched off: the user turns on what they have looked at. Returns how many came in.
   */
  importGlobal(input: unknown): number {
    const off = (tree: ScriptTree): ScriptTree =>
      tree.type === 'folder'
        ? { ...tree, scripts: tree.scripts.map((s) => ({ ...s, enabled: false })) }
        : { ...tree, enabled: false };
    const taken = new Set(
      this.trees.global.flatMap((t) => [
        t.id,
        ...(t.type === 'folder' ? t.scripts.map((s) => s.id) : []),
      ]),
    );
    // a re-imported file must not collide with what is already there
    const fresh = (tree: ScriptTree): ScriptTree => {
      const id = taken.has(tree.id) ? crypto.randomUUID() : tree.id;
      return tree.type === 'folder'
        ? { ...tree, id, scripts: tree.scripts.map((s) => fresh(s) as typeof s) }
        : { ...tree, id };
    };
    const incoming = normalizeScriptTrees(input, () => crypto.randomUUID()).map((t) =>
      fresh(off(t)),
    );
    if (incoming.length > 0) this.setTrees('global', [...this.trees.global, ...incoming]);
    return incoming.length;
  }

  /** The one-time notice about `scope`'s scripts was shown */
  markSeen(scope: Exclude<ScriptScope, 'global'>): void {
    const { popuped } = this.stored;
    const key = scope === 'character' ? this.avatar : this.presetName;
    if (!key) return;
    this.writeStored({
      ...this.stored,
      popuped:
        scope === 'character'
          ? { ...popuped, characters: toggled(popuped.characters, key, true) }
          : { ...popuped, presets: toggled(popuped.presets, key, true) },
    });
  }

  private writeStored(next: ScriptSettings): void {
    chatStore.mutateSettings((settings) => {
      settings['extension_settings'] ??= {};
      const extensions = settings['extension_settings'] as Obj;
      extensions['tavern_helper'] ??= {};
      (extensions['tavern_helper'] as Obj)['script'] = next;
    });
  }

  private async flush(): Promise<void> {
    const root = chatStore.root;
    if (!root) return;
    const cards = [...this.pendingCards];
    const presets = [...this.pendingPresets];
    this.pendingCards.clear();
    this.pendingPresets.clear();
    for (const [avatar, trees] of cards) {
      try {
        const path = `${root}/characters/${avatar}`;
        const card = JSON.parse(await cardRead(path)) as Obj;
        const data = card['data'];
        if (!isRecord(data)) throw new Error('卡片没有 data 字段');
        card['data'] = {
          ...data,
          extensions: withHelperFields(data['extensions'], { scripts: trees }),
        };
        await cardWrite(path, JSON.stringify(card));
      } catch (e) {
        console.warn(`[TavernHelper] 角色脚本没有写进 ${avatar}`, e);
      }
    }
    for (const [name, fields] of presets) {
      const rel = `${PRESET_DIR}/${name}.json`;
      let preset: Obj;
      try {
        preset = JSON.parse(await dataReadText(root, rel)) as Obj;
      } catch {
        continue; // no file for this preset name: the settings bucket is the source
      }
      try {
        preset['extensions'] = withHelperFields(preset['extensions'], fields);
        await dataWriteText(root, rel, JSON.stringify(preset, null, 4));
      } catch (e) {
        console.warn(`[TavernHelper] 预设的脚本或变量没有写进 ${name}`, e);
      }
    }
  }
}

export const scriptLibrary = new ScriptLibrary();
