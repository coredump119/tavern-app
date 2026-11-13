/**
 * Script library data (DEV_NOTES §9.5, round 2): the shapes upstream TavernHelper stores, plus the
 * pure helpers both sides of the bridge share. No DOM, no Svelte.
 */
export interface ScriptButton {
  name: string;
  visible: boolean;
}

export interface Script {
  type: 'script';
  enabled: boolean;
  name: string;
  id: string;
  content: string;
  info: string;
  button: { enabled: boolean; buttons: ScriptButton[] };
  data: Record<string, unknown>;
  /** fields this app does not know are kept as they are */
  [key: string]: unknown;
}

export interface ScriptFolder {
  type: 'folder';
  enabled: boolean;
  name: string;
  id: string;
  icon: string;
  color: string;
  scripts: Script[];
  [key: string]: unknown;
}

export type ScriptTree = Script | ScriptFolder;
export type ScriptScope = 'global' | 'character' | 'preset';
export type ScriptTrees = Record<ScriptScope, ScriptTree[]>;
export const SCRIPT_SCOPES: readonly ScriptScope[] = ['global', 'character', 'preset'];

/** What a running script may change about itself */
export interface ScriptPatch {
  info?: string;
  data?: Record<string, unknown>;
  buttons?: ScriptButton[];
}

/** `extension_settings.tavern_helper.script` */
export interface ScriptSettings {
  enabled: { global: boolean; presets: string[]; characters: string[] };
  popuped: { presets: string[]; characters: string[] };
  scripts: ScriptTree[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** `tavern_helper` on a card or preset: an object, or its `Object.entries` (older upstream) */
export function helperField(extensions: unknown): Record<string, unknown> {
  const field = isRecord(extensions) ? extensions['tavern_helper'] : undefined;
  if (isRecord(field)) return field;
  const out: Record<string, unknown> = {};
  if (Array.isArray(field)) {
    for (const entry of field as unknown[]) {
      if (Array.isArray(entry) && typeof entry[0] === 'string') out[entry[0]] = entry[1];
    }
  }
  return out;
}

/** `extensions` with `fields` set on its `tavern_helper` (`scripts`, `variables`); the rest is kept */
export function withHelperFields(
  extensions: unknown,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const ext = isRecord(extensions) ? extensions : {};
  return { ...ext, tavern_helper: { ...helperField(ext), ...fields } };
}

export function normalizeButtons(input: unknown): ScriptButton[] {
  if (!Array.isArray(input)) return [];
  const out: ScriptButton[] = [];
  for (const b of input) {
    if (!isRecord(b) || typeof b['name'] !== 'string' || !b['name']) continue;
    out.push({ name: b['name'], visible: b['visible'] !== false });
  }
  return out;
}

function normalizeScript(raw: Record<string, unknown>, newId: () => string): Script {
  const button = raw['button'];
  // before `button { enabled, buttons }` upstream stored a bare `buttons` array
  const buttons = isRecord(button) ? button['buttons'] : raw['buttons'];
  return {
    ...raw,
    type: 'script',
    enabled: raw['enabled'] === true,
    name: text(raw['name'], '未命名脚本'),
    id: text(raw['id']) || newId(),
    content: text(raw['content']),
    info: text(raw['info']),
    button: {
      enabled: isRecord(button) ? button['enabled'] !== false : true,
      buttons: normalizeButtons(buttons),
    },
    data: isRecord(raw['data']) ? raw['data'] : {},
  };
}

/**
 * Anything a script list may arrive as (an array, one script, one folder, junk) → `ScriptTree[]`.
 * Folders hold scripts only, as upstream; a folder inside a folder is flattened into its parent.
 */
export function normalizeScriptTrees(input: unknown, newId: () => string): ScriptTree[] {
  const list = Array.isArray(input) ? input : isRecord(input) ? [input] : [];
  const out: ScriptTree[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    if (raw['type'] === 'folder' || Array.isArray(raw['scripts'])) {
      out.push({
        ...raw,
        type: 'folder',
        enabled: raw['enabled'] !== false,
        name: text(raw['name'], '未命名文件夹'),
        id: text(raw['id']) || newId(),
        icon: text(raw['icon']),
        color: text(raw['color']),
        scripts: allScripts(normalizeScriptTrees(raw['scripts'], newId)),
      });
    } else {
      out.push(normalizeScript(raw, newId));
    }
  }
  return out;
}

export function normalizeScriptSettings(raw: unknown, newId: () => string): ScriptSettings {
  const r = isRecord(raw) ? raw : {};
  const enabled = isRecord(r['enabled']) ? r['enabled'] : {};
  const popuped = isRecord(r['popuped']) ? r['popuped'] : {};
  return {
    enabled: {
      global: enabled['global'] !== false,
      presets: strings(enabled['presets']),
      characters: strings(enabled['characters']),
    },
    popuped: { presets: strings(popuped['presets']), characters: strings(popuped['characters']) },
    scripts: normalizeScriptTrees(r['scripts'], newId),
  };
}

/** Every script, folders opened, in display order */
export function allScripts(trees: readonly ScriptTree[]): Script[] {
  return trees.flatMap((t) => (t.type === 'folder' ? t.scripts : [t]));
}

/** Scripts that are switched on themselves and whose folder is */
export function enabledScripts(trees: readonly ScriptTree[]): Script[] {
  return trees.flatMap((t) =>
    t.type === 'folder'
      ? t.enabled
        ? t.scripts.filter((s) => s.enabled)
        : []
      : t.enabled
        ? [t]
        : [],
  );
}

/** Buttons a running script shows above the composer */
export function visibleButtons(script: Script): ScriptButton[] {
  return script.button.enabled ? script.button.buttons.filter((b) => b.visible) : [];
}

/** ST-side contract: the iframe name scripts and themes can look up */
export const scriptFrameName = (script: Pick<Script, 'name' | 'id'>): string =>
  `TH-script--${script.name}--${script.id}`;

/** upstream `getButtonEvent` */
export const buttonEvent = (scriptId: string, button: string): string => `${scriptId}_${button}`;

/** Copy of `trees` with script `id` replaced by `change(script)`; the same array when it is absent */
export function mapScript(
  trees: readonly ScriptTree[],
  id: string,
  change: (script: Script) => Script,
): ScriptTree[] {
  let found = false;
  const one = (s: Script): Script => {
    if (s.id !== id) return s;
    found = true;
    return change(s);
  };
  const next = trees.map((t) =>
    t.type === 'folder' ? { ...t, scripts: t.scripts.map(one) } : one(t),
  );
  return found ? next : (trees as ScriptTree[]);
}

/** What the in-app editor changes about a script; fields left out stay as they are */
export interface ScriptEdit {
  name?: string;
  info?: string;
  content?: string;
  button?: { enabled: boolean; buttons: readonly ScriptButton[] };
}

export function findScript(trees: readonly ScriptTree[], id: string): Script | undefined {
  return allScripts(trees).find((s) => s.id === id);
}

/** An empty script, switched off, for the editor to fill in */
export function newScript(id: string): Script {
  return {
    type: 'script',
    enabled: false,
    name: '未命名脚本',
    id,
    content: '',
    info: '',
    button: { enabled: true, buttons: [] },
    data: {},
  };
}

/** `script` with the editor's changes; a blank name keeps the old one (the frame name needs it) */
export function applyScriptEdit(script: Script, edit: ScriptEdit): Script {
  const name = edit.name?.trim();
  return {
    ...script,
    ...(name ? { name } : {}),
    ...(edit.info !== undefined ? { info: edit.info } : {}),
    ...(edit.content !== undefined ? { content: edit.content } : {}),
    ...(edit.button !== undefined
      ? {
          button: {
            ...script.button,
            enabled: edit.button.enabled,
            buttons: normalizeButtons(edit.button.buttons),
          },
        }
      : {}),
  };
}

/** `mapScript` for the editor: reaches into folders; the same array when `id` is absent */
export function editScript(
  trees: readonly ScriptTree[],
  id: string,
  edit: ScriptEdit,
): ScriptTree[] {
  return mapScript(trees, id, (s) => applyScriptEdit(s, edit));
}

/**
 * One script as an export file: the stored shape, which is what import reads back. `data` is the
 * script's own storage and may hold what the user typed into it, so it can be left out.
 */
export function scriptExport(script: Script, withData = true): Script {
  return { ...script, data: withData ? script.data : {} };
}

export function scriptExportFileName(script: Pick<Script, 'name'>): string {
  const base = script.name.replace(/[\\/:*?"<>|]+/g, '-').trim();
  return `${base || 'script'}.json`;
}

/** Only well-formed fields survive; the rest of the patch is dropped */
export function sanitizeScriptPatch(raw: unknown): ScriptPatch {
  const patch: ScriptPatch = {};
  if (!isRecord(raw)) return patch;
  if (typeof raw['info'] === 'string') patch.info = raw['info'];
  if (isRecord(raw['data'])) patch.data = raw['data'];
  if (Array.isArray(raw['buttons'])) patch.buttons = normalizeButtons(raw['buttons']);
  return patch;
}

export function patchScript(
  trees: readonly ScriptTree[],
  id: string,
  patch: ScriptPatch,
): ScriptTree[] {
  return mapScript(trees, id, (s) => ({
    ...s,
    ...(patch.info !== undefined ? { info: patch.info } : {}),
    ...(patch.data !== undefined ? { data: patch.data } : {}),
    ...(patch.buttons !== undefined ? { button: { ...s.button, buttons: patch.buttons } } : {}),
  }));
}

/**
 * A script list written by a script (`replaceScriptTrees`): code the user has not seen must not
 * start running by itself, so a script that is new or whose `content` changed arrives switched off.
 */
export function guardScriptTrees(
  next: readonly ScriptTree[],
  stored: readonly ScriptTree[],
): ScriptTree[] {
  const known = new Map(allScripts(stored).map((s) => [s.id, s.content]));
  const guard = (s: Script): Script =>
    s.enabled && known.get(s.id) !== s.content ? { ...s, enabled: false } : s;
  return next.map((t) =>
    t.type === 'folder' ? { ...t, scripts: t.scripts.map(guard) } : guard(t),
  );
}

/** Which scripts should have an iframe: scope switch, folder switch, script switch all on */
export function runningScripts(
  trees: ScriptTrees,
  scopes: Readonly<Record<ScriptScope, boolean>>,
): Script[] {
  const seen = new Set<string>();
  const out: Script[] = [];
  for (const scope of SCRIPT_SCOPES) {
    if (!scopes[scope]) continue;
    for (const s of enabledScripts(trees[scope])) {
      // the same script imported into two scopes runs once
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}
