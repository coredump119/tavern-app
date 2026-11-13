/**
 * Chat Completion preset (`OpenAI Settings/*.json`, or the same fields of the live `oai_settings`)
 * ⇄ the `Preset` shape of the TavernHelper script API. Pure data in, pure data out: no DOM, no I/O.
 * ST side follows SillyTavern 1.18 (`openai.js`, `PromptManager.js`); the TavernHelper side follows
 * its public type declarations, so the field names here are an API contract.
 */

// ---- TavernHelper shapes ----

export interface PresetSettings {
  max_context: number;
  max_completion_tokens: number;
  reply_count: number;
  should_stream: boolean;
  temperature: number;
  frequency_penalty: number;
  presence_penalty: number;
  repetition_penalty: number;
  top_p: number;
  min_p: number;
  top_k: number;
  top_a: number;
  /** -1 = random */
  seed: number;
  squash_system_messages: boolean;
  reasoning_effort: 'auto' | 'min' | 'low' | 'medium' | 'high' | 'max';
  request_thoughts: boolean;
  request_images: boolean;
  enable_function_calling: boolean;
  enable_web_search: boolean;
  allow_sending_images: 'disabled' | 'auto' | 'low' | 'high';
  allow_sending_videos: boolean;
  character_name_prefix: 'none' | 'default' | 'content' | 'completion';
  wrap_user_messages_in_quotes: boolean;
}

export type PresetPromptPosition =
  | { type: 'relative'; depth?: never; order?: never }
  | { type: 'in_chat'; depth: number; order: number };

export interface PresetPrompt {
  id: string;
  name: string;
  enabled: boolean;
  /** normal and placeholder prompts only */
  position?: PresetPromptPosition;
  role: 'system' | 'user' | 'assistant';
  /** normal and system prompts only */
  content?: string;
  extra?: Record<string, unknown>;
}

export type PresetSystemPromptId = 'main' | 'nsfw' | 'jailbreak' | 'enhanceDefinitions';
export type PresetPlaceholderPromptId =
  | 'worldInfoBefore'
  | 'personaDescription'
  | 'charDescription'
  | 'charPersonality'
  | 'scenario'
  | 'worldInfoAfter'
  | 'dialogueExamples'
  | 'chatHistory';

export type PresetNormalPrompt = PresetPrompt & { position: PresetPromptPosition; content: string };
export type PresetSystemPrompt = Omit<PresetPrompt, 'position'> & {
  id: PresetSystemPromptId;
  content: string;
};
export type PresetPlaceholderPrompt = Omit<PresetPrompt, 'content'> & {
  id: PresetPlaceholderPromptId;
  position: PresetPromptPosition;
};

export interface Preset {
  settings: PresetSettings;
  /** the prompt list, in sending order */
  prompts: PresetPrompt[];
  /** defined, but not in the list */
  prompts_unused: PresetPrompt[];
  /** `regex_scripts` (as `TavernRegex[]`), `tavern_helper`, and whatever else is bound to the preset */
  extensions: Record<string, unknown>;
}

export interface TavernRegex {
  id: string;
  script_name: string;
  enabled: boolean;
  find_regex: string;
  trim_strings: string[];
  replace_string: string;
  source: {
    user_input: boolean;
    ai_output: boolean;
    slash_command: boolean;
    world_info: boolean;
    reasoning: boolean;
  };
  destination: { display: boolean; prompt: boolean };
  run_on_edit: boolean;
  min_depth: number | null;
  max_depth: number | null;
}

// ---- prompt classes: decided by id alone ----

const SYSTEM_IDS: ReadonlySet<string> = new Set<PresetSystemPromptId>([
  'main',
  'nsfw',
  'jailbreak',
  'enhanceDefinitions',
]);
const PLACEHOLDER_IDS: ReadonlySet<string> = new Set<PresetPlaceholderPromptId>([
  'worldInfoBefore',
  'personaDescription',
  'charDescription',
  'charPersonality',
  'scenario',
  'worldInfoAfter',
  'dialogueExamples',
  'chatHistory',
]);
/** ST has no in-chat injection for these two, so their `injection_*` fields are never written */
const UNPLACEABLE_IDS: ReadonlySet<string> = new Set(['dialogueExamples', 'chatHistory']);

export function isPresetSystemPrompt(prompt: PresetPrompt): prompt is PresetSystemPrompt {
  return SYSTEM_IDS.has(prompt.id);
}
export function isPresetPlaceholderPrompt(prompt: PresetPrompt): prompt is PresetPlaceholderPrompt {
  return PLACEHOLDER_IDS.has(prompt.id);
}
export function isPresetNormalPrompt(prompt: PresetPrompt): prompt is PresetNormalPrompt {
  return !SYSTEM_IDS.has(prompt.id) && !PLACEHOLDER_IDS.has(prompt.id);
}

// ---- defaults ----

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const placeholder = (id: PresetPlaceholderPromptId, name: string): PresetPrompt => ({
  id,
  name,
  enabled: true,
  position: { type: 'relative' },
  role: 'system',
});

/** What a script gets when it creates a preset without content. Frozen: `structuredClone` it to edit. */
export const DEFAULT_PRESET: Preset = deepFreeze<Preset>({
  settings: {
    max_context: 2000000,
    max_completion_tokens: 300,
    reply_count: 1,
    should_stream: false,
    temperature: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    repetition_penalty: 1,
    top_p: 1,
    min_p: 0,
    top_k: 0,
    top_a: 0,
    seed: -1,
    squash_system_messages: false,
    reasoning_effort: 'auto',
    request_thoughts: false,
    request_images: false,
    enable_function_calling: false,
    enable_web_search: false,
    allow_sending_images: 'disabled',
    allow_sending_videos: false,
    character_name_prefix: 'none',
    wrap_user_messages_in_quotes: false,
  },
  prompts: [
    placeholder('worldInfoBefore', 'World Info (before) - 角色定义之前'),
    placeholder('personaDescription', 'Persona Description - 玩家描述'),
    placeholder('charDescription', 'Char Description - 角色描述'),
    placeholder('charPersonality', 'Char Personality - 角色性格'),
    placeholder('scenario', 'Scenario - 情景'),
    placeholder('worldInfoAfter', 'World Info (after) - 角色定义之后'),
    placeholder('dialogueExamples', 'Chat Examples - 对话示例'),
    placeholder('chatHistory', 'Chat History - 聊天记录'),
  ],
  prompts_unused: [],
  extensions: { tavern_helper: { scripts: [], variables: {} } },
});

type Dict = Record<string, unknown>;

const stMarker = (identifier: string, name: string): Dict => ({
  identifier,
  name,
  system_prompt: true,
  marker: true,
});
const stSystem = (identifier: string, name: string, content: string): Dict => ({
  identifier,
  name,
  system_prompt: true,
  role: 'system',
  content,
});

/** PromptManager.js `chatCompletionDefaultPrompts`: ST adds whichever of these a preset lacks */
const ST_DEFAULT_PROMPTS: readonly Dict[] = [
  stSystem(
    'main',
    'Main Prompt',
    "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.",
  ),
  stSystem('nsfw', 'Auxiliary Prompt', ''),
  stMarker('dialogueExamples', 'Chat Examples'),
  stSystem('jailbreak', 'Post-History Instructions', ''),
  stMarker('chatHistory', 'Chat History'),
  stMarker('worldInfoAfter', 'World Info (after)'),
  stMarker('worldInfoBefore', 'World Info (before)'),
  stSystem(
    'enhanceDefinitions',
    'Enhance Definitions',
    "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.",
  ),
  stMarker('charDescription', 'Char Description'),
  stMarker('charPersonality', 'Char Personality'),
  stMarker('scenario', 'Scenario'),
  stMarker('personaDescription', 'Persona Description'),
];

/** PromptManager.js `promptManagerDefaultPromptOrder`: what ST uses while the global order is empty */
const ST_DEFAULT_ORDER: readonly Dict[] = [
  'main',
  'worldInfoBefore',
  'personaDescription',
  'charDescription',
  'charPersonality',
  'scenario',
  'enhanceDefinitions',
  'nsfw',
  'worldInfoAfter',
  'dialogueExamples',
  'chatHistory',
  'jailbreak',
].map((identifier) => ({ identifier, enabled: identifier !== 'enhanceDefinitions' }));

/** openai.js: the dummy character id the Chat Completion prompt manager keeps its global order under */
const GLOBAL_ORDER_ID = '100001';
const DEFAULT_DEPTH = 4;
const DEFAULT_ORDER = 100;
const UNNAMED = 'unnamed';

// ---- coercion ----

const isRecord = (v: unknown): v is Dict =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const record = (v: unknown): Dict => (isRecord(v) ? v : {});
const records = (v: unknown): Dict[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const bool = (v: unknown, fallback: boolean): boolean =>
  v === undefined || v === null ? fallback : Boolean(v);
const depthOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);
/** `crypto.randomUUID` is missing outside secure contexts, which a webview's scheme may not be */
const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function oneOf<T extends string>(allowed: readonly T[], v: unknown, fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** The parts of `source` this module does not own; nested values are cloned, never shared. */
function carryOver(source: Dict, owned?: ReadonlySet<string>): Dict {
  const out: Dict = {};
  for (const [key, value] of Object.entries(source)) {
    if (owned?.has(key)) continue;
    out[key] = typeof value === 'object' && value !== null ? structuredClone(value) : value;
  }
  return out;
}

/** First record per key wins, as with ST's own `find` lookups. */
function indexBy(list: unknown, key: string): Map<string, Dict> {
  const map = new Map<string, Dict>();
  for (const item of records(list)) {
    const id = item[key];
    if (typeof id === 'string' && !map.has(id)) map.set(id, item);
  }
  return map;
}

// ---- settings ----

type KeysOf<T> = {
  [K in keyof PresetSettings]: PresetSettings[K] extends T ? K : never;
}[keyof PresetSettings];

/** `[TavernHelper field, ST key, ST default]` (openai.js `default_settings`) */
const NUMBER_FIELDS: ReadonlyArray<readonly [KeysOf<number>, string, number]> = [
  ['max_context', 'openai_max_context', 4095],
  ['max_completion_tokens', 'openai_max_tokens', 300],
  ['reply_count', 'n', 1],
  ['seed', 'seed', -1],
];
const BOOLEAN_FIELDS: ReadonlyArray<readonly [KeysOf<boolean>, string, boolean]> = [
  ['should_stream', 'stream_openai', false],
  ['squash_system_messages', 'squash_system_messages', false],
  ['request_thoughts', 'show_thoughts', true],
  ['request_images', 'request_images', false],
  ['enable_function_calling', 'function_calling', false],
  ['enable_web_search', 'enable_web_search', false],
  // ST 1.18 no longer reads this key; it is kept so the value still round-trips
  ['wrap_user_messages_in_quotes', 'wrap_in_quotes', false],
];
/**
 * `[TavernHelper field, key in a preset file, key in oai_settings, ST default]`: the samplers are the
 * only fields ST spells differently in the two places (openai.js `settingsToUpdate`).
 */
const SAMPLER_FIELDS: ReadonlyArray<readonly [KeysOf<number>, string, string, number]> = [
  ['temperature', 'temperature', 'temp_openai', 1],
  ['frequency_penalty', 'frequency_penalty', 'freq_pen_openai', 0],
  ['presence_penalty', 'presence_penalty', 'pres_pen_openai', 0],
  ['repetition_penalty', 'repetition_penalty', 'repetition_penalty_openai', 1],
  ['top_p', 'top_p', 'top_p_openai', 1],
  ['min_p', 'min_p', 'min_p_openai', 0],
  ['top_k', 'top_k', 'top_k_openai', 0],
  ['top_a', 'top_a', 'top_a_openai', 0],
];

const REASONING_EFFORTS = ['auto', 'min', 'low', 'medium', 'high', 'max'] as const;
const IMAGE_QUALITIES = ['auto', 'low', 'high'] as const;
const IMAGE_MODES = ['disabled', ...IMAGE_QUALITIES] as const;
const ROLES = ['system', 'user', 'assistant'] as const;
/** openai.js `character_names_behavior` */
const NAME_BEHAVIORS = { none: -1, default: 0, completion: 1, content: 2 } as const;
const NAME_PREFIXES = Object.keys(NAME_BEHAVIORS) as Array<keyof typeof NAME_BEHAVIORS>;

/** Keys older ST versions wrote; `migrateChatCompletionSettings` lets them override the current ones. */
const LEGACY_KEYS = ['image_inlining', 'video_inlining', 'audio_inlining', 'names_in_completion'];

/**
 * Every ST key `fromPreset` may write: what a preset "owns" of `oai_settings`. A sampler comes back
 * under one spelling only (see `fromPreset`), so copy the keys that are present in the result.
 */
export const PRESET_ST_KEYS: readonly string[] = Object.freeze([
  ...NUMBER_FIELDS.map((field) => field[1]),
  ...BOOLEAN_FIELDS.map((field) => field[1]),
  ...SAMPLER_FIELDS.flatMap((field) => [field[1], field[2]]),
  'max_context_unlocked',
  'reasoning_effort',
  'media_inlining',
  'inline_image_quality',
  'names_behavior',
  'prompts',
  'prompt_order',
  'extensions',
]);
const OWNED_KEYS: ReadonlySet<string> = new Set([...PRESET_ST_KEYS, ...LEGACY_KEYS]);

/** ST 1.18 has one media switch; the older per-kind switches still win where a file carries them. */
function mediaInlining(st: Dict): boolean {
  if (st['video_inlining'] === true || st['audio_inlining'] === true) return true;
  if (typeof st['image_inlining'] === 'boolean') return st['image_inlining'];
  return bool(st['media_inlining'], true);
}

function readSettings(st: Dict): PresetSettings {
  const media = mediaInlining(st);
  const behavior = st['names_in_completion'] === true ? 1 : Number(st['names_behavior']);
  const settings: PresetSettings = {
    ...DEFAULT_PRESET.settings,
    reasoning_effort: oneOf(REASONING_EFFORTS, st['reasoning_effort'], 'auto'),
    allow_sending_images: media
      ? oneOf(IMAGE_QUALITIES, st['inline_image_quality'], 'auto')
      : 'disabled',
    allow_sending_videos: media,
    character_name_prefix:
      NAME_PREFIXES.find((prefix) => NAME_BEHAVIORS[prefix] === behavior) ?? 'default',
  };
  for (const [field, key, fallback] of NUMBER_FIELDS) settings[field] = num(st[key], fallback);
  for (const [field, key, fallback] of BOOLEAN_FIELDS) settings[field] = bool(st[key], fallback);
  // a file made by desktop TavernHelper may carry both spellings; there the file one is current
  for (const [field, fileKey, liveKey, fallback] of SAMPLER_FIELDS) {
    settings[field] = num(st[fileKey] ?? st[liveKey], fallback);
  }
  return settings;
}

function writeSettings(out: Dict, input: unknown, previous: unknown): void {
  const source = record(input);
  const prev = record(previous);
  const defaults = DEFAULT_PRESET.settings;
  for (const [field, key] of NUMBER_FIELDS) out[key] = num(source[field], defaults[field]);
  for (const [field, key] of BOOLEAN_FIELDS) out[key] = bool(source[field], defaults[field]);
  for (const [field, fileKey, liveKey] of SAMPLER_FIELDS) {
    const value = num(source[field], defaults[field]);
    const live = prev[liveKey] !== undefined;
    if (live) out[liveKey] = value;
    if (!live || prev[fileKey] !== undefined) out[fileKey] = value;
  }
  // the default context size is far beyond what ST's locked slider allows
  out['max_context_unlocked'] = true;
  out['reasoning_effort'] = oneOf(
    REASONING_EFFORTS,
    source['reasoning_effort'],
    defaults.reasoning_effort,
  );

  // Two TavernHelper switches, one ST switch: the one the script moved away from the old state wins.
  const images = oneOf(IMAGE_MODES, source['allow_sending_images'], defaults.allow_sending_images);
  const videos = bool(source['allow_sending_videos'], defaults.allow_sending_videos);
  const wasOn = isRecord(previous) && mediaInlining(previous);
  out['media_inlining'] = wasOn ? images !== 'disabled' && videos : images !== 'disabled' || videos;
  out['inline_image_quality'] =
    images === 'disabled' ? oneOf(IMAGE_QUALITIES, prev['inline_image_quality'], 'auto') : images;

  const prefix = oneOf(
    NAME_PREFIXES,
    source['character_name_prefix'],
    defaults.character_name_prefix,
  );
  out['names_behavior'] = NAME_BEHAVIORS[prefix];
}

// ---- prompts ----

function readPrompt(def: Dict, id: string, enabledInOrder?: unknown): PresetPrompt {
  const position: PresetPromptPosition =
    Number(def['injection_position']) === 1
      ? {
          type: 'in_chat',
          depth: num(def['injection_depth'], DEFAULT_DEPTH),
          order: num(def['injection_order'], DEFAULT_ORDER),
        }
      : { type: 'relative' };
  return {
    id,
    name: text(def['name'], UNNAMED),
    enabled: bool(enabledInOrder, bool(def['enabled'], true)),
    ...(SYSTEM_IDS.has(id) ? {} : { position }),
    role: oneOf(ROLES, def['role'], 'system'),
    ...(PLACEHOLDER_IDS.has(id) ? {} : { content: text(def['content']) }),
    ...(isRecord(def['extra']) ? { extra: structuredClone(def['extra']) } : {}),
  };
}

function readPrompts(st: Dict): Pick<Preset, 'prompts' | 'prompts_unused'> {
  // PromptManager `sanitizeServiceSettings`: no prompts → the default set, otherwise the missing
  // defaults are appended; a prompt without an identifier gets one
  const defs = new Map<string, Dict>();
  for (const def of records(st['prompts'])) {
    const id = text(def['identifier']) || newId();
    if (!defs.has(id)) defs.set(id, def);
  }
  for (const def of ST_DEFAULT_PROMPTS) {
    const id = text(def['identifier']);
    if (!defs.has(id)) defs.set(id, def);
  }

  const global = records(st['prompt_order']).find(
    (list) => String(list['character_id']) === GLOBAL_ORDER_ID,
  );
  const stored = records(global?.['order']);
  const order = stored.length > 0 ? stored : ST_DEFAULT_ORDER;

  const prompts: PresetPrompt[] = [];
  for (const entry of order) {
    const id = text(entry['identifier']);
    const def = defs.get(id);
    if (!def) continue; // orphaned or repeated reference
    prompts.push(readPrompt(def, id, entry['enabled']));
    defs.delete(id);
  }
  const prompts_unused = Array.from(defs, ([id, def]) => readPrompt(def, id));
  return { prompts, prompts_unused };
}

/** One TavernHelper prompt → ST prompt, on top of the ST prompt it replaces (if any). */
function writePrompt(prompt: Dict, id: string, previous: Dict | undefined): Dict {
  const isSystem = SYSTEM_IDS.has(id);
  const isPlaceholder = PLACEHOLDER_IDS.has(id);
  const out = previous ? carryOver(previous) : {};
  out['identifier'] = id;
  out['name'] = text(prompt['name'], UNNAMED);
  out['enabled'] = bool(prompt['enabled'], true);
  if (!isSystem && !UNPLACEABLE_IDS.has(id)) {
    const position = record(prompt['position']);
    const inChat = position['type'] === 'in_chat';
    out['injection_position'] = inChat ? 1 : 0;
    // a relative prompt keeps the depth and order it had: the TavernHelper shape has no say there
    out['injection_depth'] = inChat
      ? num(position['depth'], DEFAULT_DEPTH)
      : num(out['injection_depth'], DEFAULT_DEPTH);
    out['injection_order'] = inChat
      ? num(position['order'], DEFAULT_ORDER)
      : num(out['injection_order'], DEFAULT_ORDER);
  }
  out['role'] = oneOf(ROLES, prompt['role'], 'system');
  if (!isPlaceholder) out['content'] = text(prompt['content']);
  if (!previous) {
    out['system_prompt'] = isSystem || isPlaceholder;
    out['marker'] = isPlaceholder;
    out['forbid_overrides'] = false;
  }
  if (isRecord(prompt['extra'])) out['extra'] = structuredClone(prompt['extra']);
  else delete out['extra'];
  return out;
}

function writePromptOrder(previous: unknown, used: readonly Dict[]): Dict[] {
  const order = used.map((prompt) => ({
    identifier: prompt['identifier'],
    enabled: prompt['enabled'],
  }));
  let placed = false;
  const lists = records(previous).map((list) => {
    if (placed || String(list['character_id']) !== GLOBAL_ORDER_ID) return structuredClone(list);
    placed = true;
    return { ...carryOver(list, new Set(['order'])), order };
  });
  if (!placed) lists.push({ character_id: Number(GLOBAL_ORDER_ID), order });
  return lists;
}

// ---- extensions ----

/** `[TavernRegex source flag, regex engine `regex_placement` value]` */
const REGEX_PLACEMENTS = [
  ['user_input', 1],
  ['ai_output', 2],
  ['slash_command', 3],
  ['world_info', 5],
  ['reasoning', 6],
] as const;

/** ST regex script (`extensions.regex_scripts[]`) → `TavernRegex` */
export function toTavernRegex(raw: unknown): TavernRegex {
  const script = record(raw);
  const placement: unknown[] = Array.isArray(script['placement']) ? script['placement'] : [];
  const source = {} as TavernRegex['source'];
  for (const [flag, value] of REGEX_PLACEMENTS) source[flag] = placement.includes(value);
  return {
    id: text(script['id']) || newId(),
    script_name: text(script['scriptName']),
    enabled: !script['disabled'],
    find_regex: text(script['findRegex']),
    trim_strings: strings(script['trimStrings']),
    replace_string: text(script['replaceString']),
    source,
    destination: { display: !!script['markdownOnly'], prompt: !!script['promptOnly'] },
    run_on_edit: !!script['runOnEdit'],
    min_depth: depthOrNull(script['minDepth']),
    max_depth: depthOrNull(script['maxDepth']),
  };
}

/** `TavernRegex` → ST regex script; fields `TavernRegex` lacks come from the script it replaces. */
export function fromTavernRegex(regex: unknown, previous?: unknown): Record<string, unknown> {
  const input = record(regex);
  const source = record(input['source']);
  const destination = record(input['destination']);
  return {
    ...(isRecord(previous) ? carryOver(previous) : { substituteRegex: 0 }),
    id: text(input['id']) || newId(),
    scriptName: text(input['script_name']),
    findRegex: text(input['find_regex']),
    replaceString: text(input['replace_string']),
    trimStrings: strings(input['trim_strings']),
    placement: REGEX_PLACEMENTS.filter(([flag]) => !!source[flag]).map(([, value]) => value),
    disabled: input['enabled'] === false,
    markdownOnly: !!destination['display'],
    promptOnly: !!destination['prompt'],
    runOnEdit: !!input['run_on_edit'],
    minDepth: depthOrNull(input['min_depth']),
    maxDepth: depthOrNull(input['max_depth']),
  };
}

/** ST `extensions` (of a preset or a card) → the script API's: `TavernRegex` scripts, a whole `tavern_helper` */
export function readExtensions(raw: unknown): Record<string, unknown> {
  const extensions = isRecord(raw) ? structuredClone(raw) : {};
  extensions['regex_scripts'] = records(extensions['regex_scripts']).map(toTavernRegex);
  // older TavernHelper stored this field as its `Object.entries`
  const stored = extensions['tavern_helper'];
  const helper = Array.isArray(stored)
    ? Object.fromEntries(
        stored.filter((e): e is [string, unknown] => Array.isArray(e) && typeof e[0] === 'string'),
      )
    : record(stored);
  extensions['tavern_helper'] = {
    ...helper,
    scripts: Array.isArray(helper['scripts']) ? helper['scripts'] : [],
    variables: record(helper['variables']),
  };
  return extensions;
}

/** The reverse of {@link readExtensions}; `previous` is the stored `extensions` being replaced */
export function writeExtensions(input: unknown, previous: unknown): Dict {
  const extensions = structuredClone(isRecord(input) ? input : DEFAULT_PRESET.extensions);
  if (Array.isArray(extensions['regex_scripts'])) {
    const before = indexBy(record(previous)['regex_scripts'], 'id');
    // a script still in ST's own shape passes through
    extensions['regex_scripts'] = records(extensions['regex_scripts']).map((script) =>
      isRecord(script['source']) || 'script_name' in script
        ? fromTavernRegex(script, before.get(text(script['id'])))
        : script,
    );
  }
  return extensions;
}

// ---- converters ----

/**
 * ST preset → TavernHelper `Preset`. Accepts a preset file body or the live `oai_settings`; whatever
 * is missing or malformed reads as ST itself would treat it (its defaults, its default prompts and
 * prompt order). The result shares nothing with `raw`.
 */
export function toPreset(raw: unknown): Preset {
  const st = record(raw);
  return {
    settings: readSettings(st),
    ...readPrompts(st),
    extensions: readExtensions(st['extensions']),
  };
}

/**
 * TavernHelper `Preset` → ST preset. `preset` may be partial or junk: what is missing comes from
 * `DEFAULT_PRESET`. `previous` is the ST preset (or live `oai_settings`) being replaced; everything
 * of it the TavernHelper shape does not describe is kept: other top-level keys, the prompt orders of
 * other character ids, and the extra fields of prompts and regex scripts whose id is still there.
 *
 * Samplers are written under the spelling `previous` uses (`temp_openai` in `oai_settings`,
 * `temperature` in a file, which is also what a new preset gets), so pass the object being updated.
 *
 * @throws when a system or placeholder prompt id appears twice; a repeated normal id gets a new one
 */
export function fromPreset(preset: unknown, previous?: unknown): Record<string, unknown> {
  const input = record(preset);
  const prev = record(previous);
  const out = carryOver(prev, OWNED_KEYS);
  writeSettings(out, input['settings'], previous);

  const before = indexBy(prev['prompts'], 'identifier');
  const taken = new Set<string>();
  const convert = (list: unknown, fallback: readonly PresetPrompt[]): Dict[] =>
    records(Array.isArray(list) ? list : fallback).map((prompt) => {
      let id = text(prompt['id']) || newId();
      if (taken.has(id)) {
        if (SYSTEM_IDS.has(id) || PLACEHOLDER_IDS.has(id)) {
          throw new Error(`预设里的系统/占位提示词 '${id}' 不能出现两次`);
        }
        id = newId();
      }
      taken.add(id);
      return writePrompt(prompt, id, before.get(id));
    });
  const used = convert(input['prompts'], DEFAULT_PRESET.prompts);
  const unused = convert(input['prompts_unused'], DEFAULT_PRESET.prompts_unused);

  out['prompts'] = [...used, ...unused];
  out['prompt_order'] = writePromptOrder(prev['prompt_order'], used);
  out['extensions'] = writeExtensions(input['extensions'], prev['extensions']);
  return out;
}
