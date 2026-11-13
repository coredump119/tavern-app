/**
 * Character Card V1 / V2 / V3 — as SillyTavern reads and writes them (COMPAT_TARGET).
 * Loose at every level: unknown keys survive, no defaults are injected while parsing, so
 * parse → serialize is deep-equal to the input. Use `toV2` / `toV3` for canonical shapes.
 */
import { z } from 'zod';
import { RegexScriptSchema } from './regex.js';

const str = z.string();
const strArr = z.array(z.string());
/** ST sometimes stores numbers as strings ("0.5") — accept both, never rewrite. */
const numish = z.union([z.number(), z.string()]);
const boolish = z.union([z.boolean(), z.string()]);
const role = z.enum(['system', 'user', 'assistant']);

export const CharacterBookEntrySchema = z.looseObject({
  id: z.number().optional(),
  keys: strArr,
  secondary_keys: strArr.optional(),
  comment: str.optional(),
  content: str,
  constant: z.boolean().optional(),
  selective: z.boolean().optional(),
  insertion_order: z.number().optional(),
  enabled: z.boolean().optional(),
  position: str.optional(), // 'before_char' | 'after_char' in spec; ST also writes others
  use_regex: z.boolean().optional(),
  name: str.optional(),
  priority: z.number().optional(),
  case_sensitive: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export const CharacterBookSchema = z.looseObject({
  name: str.optional(),
  description: str.optional(),
  scan_depth: z.number().optional(),
  token_budget: z.number().optional(),
  recursive_scanning: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
  entries: z.array(CharacterBookEntrySchema),
});

export const DepthPromptSchema = z.looseObject({
  prompt: str.optional(),
  depth: z.number().optional(),
  role: role.optional(),
});

/** data.extensions — ST's own keys plus whatever other frontends left there. */
export const CardExtensionsSchema = z.looseObject({
  talkativeness: numish.optional(),
  fav: boolish.optional(),
  world: str.optional(),
  depth_prompt: DepthPromptSchema.optional(),
  regex_scripts: z.array(RegexScriptSchema).optional(),
});

const dataCore = {
  name: str,
  description: str.optional(),
  personality: str.optional(),
  scenario: str.optional(),
  first_mes: str.optional(),
  mes_example: str.optional(),
  creator_notes: str.optional(),
  system_prompt: str.optional(),
  post_history_instructions: str.optional(),
  alternate_greetings: strArr.optional(),
  character_book: CharacterBookSchema.optional(),
  tags: strArr.optional(),
  creator: str.optional(),
  character_version: str.optional(),
  extensions: CardExtensionsSchema.optional(),
};

export const CardDataV2Schema = z.looseObject(dataCore);

export const CardAssetSchema = z.looseObject({
  type: str,
  uri: str,
  name: str,
  ext: str,
});

export const CardDataV3Schema = z.looseObject({
  ...dataCore,
  nickname: str.optional(),
  creator_notes_multilingual: z.record(z.string(), z.string()).optional(),
  source: strArr.optional(),
  group_only_greetings: strArr.optional(),
  creation_date: z.number().optional(),
  modification_date: z.number().optional(),
  assets: z.array(CardAssetSchema).optional(),
});

/** Legacy top-level V1 fields that ST keeps writing beside `data`. */
const v1Fields = {
  name: str.optional(),
  description: str.optional(),
  personality: str.optional(),
  scenario: str.optional(),
  first_mes: str.optional(),
  mes_example: str.optional(),
  creatorcomment: str.optional(),
  avatar: str.optional(),
  chat: str.optional(),
  talkativeness: numish.optional(),
  fav: boolish.optional(),
  tags: z.union([strArr, z.string()]).optional(),
  create_date: str.optional(),
  creator: str.optional(),
};

export const CharacterCardV1Schema = z.looseObject({ ...v1Fields, name: str });

export const CharacterCardV2Schema = z.looseObject({
  ...v1Fields,
  spec: z.literal('chara_card_v2'),
  spec_version: str, // '2.0'
  data: CardDataV2Schema,
});

export const CharacterCardV3Schema = z.looseObject({
  ...v1Fields,
  spec: z.literal('chara_card_v3'),
  spec_version: str, // '3.0'
  data: CardDataV3Schema,
});

export type CharacterBookEntry = z.infer<typeof CharacterBookEntrySchema>;
export type CharacterBook = z.infer<typeof CharacterBookSchema>;
export type CardDataV2 = z.infer<typeof CardDataV2Schema>;
export type CardDataV3 = z.infer<typeof CardDataV3Schema>;
export type CharacterCardV1 = z.infer<typeof CharacterCardV1Schema>;
export type CharacterCardV2 = z.infer<typeof CharacterCardV2Schema>;
export type CharacterCardV3 = z.infer<typeof CharacterCardV3Schema>;
export type CharacterCard = CharacterCardV1 | CharacterCardV2 | CharacterCardV3;
export type CardSpec = 'v1' | 'chara_card_v2' | 'chara_card_v3';

export function isV2(card: CharacterCard): card is CharacterCardV2 {
  return (card as { spec?: unknown }).spec === 'chara_card_v2';
}
export function isV3(card: CharacterCard): card is CharacterCardV3 {
  return (card as { spec?: unknown }).spec === 'chara_card_v3';
}

export function detectSpec(raw: unknown): CardSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const spec = (raw as { spec?: unknown }).spec;
  if (spec === 'chara_card_v2' || spec === 'chara_card_v3') return spec;
  if (spec === undefined && typeof (raw as { name?: unknown }).name === 'string') return 'v1';
  return null;
}

/** Validate a card of any spec. Throws ZodError with field paths on invalid input. */
export function parseCard(raw: unknown): CharacterCard {
  switch (detectSpec(raw)) {
    case 'chara_card_v3':
      return CharacterCardV3Schema.parse(raw);
    case 'chara_card_v2':
      return CharacterCardV2Schema.parse(raw);
    case 'v1':
      return CharacterCardV1Schema.parse(raw);
    default:
      throw new Error('card: not a character card (no spec and no name)');
  }
}

export function parseCardJson(json: string): CharacterCard {
  return parseCard(JSON.parse(json));
}

const splitTags = (t: string[] | string | undefined): string[] =>
  Array.isArray(t)
    ? t
    : typeof t === 'string'
      ? t
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

/**
 * V1 → V2, following ST's convertToV2/charaFormatData: top-level fields are kept, `data` is
 * built from them, ST extension fields (talkativeness / fav / world / depth_prompt) get defaults.
 * V2/V3 input is returned as-is (V3 keeps its spec; callers wanting strict V2 should drop V3 keys).
 */
export function toV2(card: CharacterCard): CharacterCardV2 | CharacterCardV3 {
  if (isV2(card) || isV3(card)) return card;
  const c = card as CharacterCardV1 & Record<string, unknown>;
  const ext = c['extensions'];
  const data: CardDataV2 = {
    name: c.name,
    description: c.description ?? '',
    personality: c.personality ?? '',
    scenario: c.scenario ?? '',
    first_mes: c.first_mes ?? '',
    mes_example: c.mes_example ?? '',
    creator_notes: c.creatorcomment ?? '',
    system_prompt: '',
    post_history_instructions: '',
    tags: splitTags(c.tags),
    creator: c.creator ?? '',
    character_version: '',
    alternate_greetings: [],
    extensions: {
      ...(ext && typeof ext === 'object' ? (ext as Record<string, unknown>) : {}),
      talkativeness: c.talkativeness ?? 0.5,
      fav: c.fav === true || c.fav === 'true',
      world: '',
      depth_prompt: { prompt: '', depth: 4, role: 'system' },
    },
  };
  return {
    ...c,
    creatorcomment: c.creatorcomment ?? '',
    talkativeness: c.talkativeness ?? 0.5,
    fav: c.fav === true || c.fav === 'true',
    tags: splitTags(c.tags),
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data,
  };
}

/** Any spec → V3 (what the `ccv3` chunk holds). Idempotent. */
export function toV3(card: CharacterCard): CharacterCardV3 {
  const v2 = toV2(card);
  const data: CardDataV3 = {
    ...v2.data,
    group_only_greetings: (v2.data as CardDataV3).group_only_greetings ?? [],
  };
  return { ...v2, spec: 'chara_card_v3', spec_version: '3.0', data };
}

/** Display name: V2/V3 data.name wins over the legacy top-level name. */
export function cardName(card: CharacterCard): string {
  return isV2(card) || isV3(card) ? card.data.name : card.name;
}

// ---- character editing: ST `charaFormatData` + `/api/characters/edit` (DEV_NOTES §9.17) ----

/**
 * The fields of ST's `#form_create` as `/api/characters/edit` receives them. FormData posts
 * strings; hosts may pass numbers / booleans / arrays — the coercions below are ST's own.
 */
export interface CharacterEditForm {
  ch_name: string;
  description?: string | undefined;
  personality?: string | undefined;
  scenario?: string | undefined;
  first_mes?: string | undefined;
  mes_example?: string | undefined;
  creator_notes?: string | undefined;
  system_prompt?: string | undefined;
  post_history_instructions?: string | undefined;
  /** The tags textarea (comma-separated) or an array */
  tags?: string | string[] | undefined;
  creator?: string | undefined;
  character_version?: string | undefined;
  alternate_greetings?: string | string[] | undefined;
  /** Range input ⇒ "0.5"; ST stores whatever string it got, `"0"` included (truthy) */
  talkativeness?: string | number | undefined;
  /** ST posts `String(fav_ch_checked)` and tests `== 'true'` */
  fav?: string | boolean | undefined;
  world?: string | undefined;
  depth_prompt_prompt?: string | undefined;
  depth_prompt_depth?: string | number | undefined;
  depth_prompt_role?: string | undefined;
  /** JSON object deep-merged into `data.extensions` (the `extensions` form field) */
  extensions?: Record<string, unknown> | undefined;
}

export interface FormatCharacterOptions {
  /** `json_data`: the card as stored; every key ST does not touch survives. */
  existing?: unknown;
  /** ST's server reads `worlds/<world>.json` and embeds it; hosts pass the converted book. */
  characterBook?: CharacterBook | undefined;
  /** `/edit` copies these two hidden fields verbatim (undefined ⇒ dropped by JSON.stringify). */
  chat?: string | undefined;
  create_date?: string | undefined;
  /** `humanizedDateTime()` for the default `chat` name */
  now?: (() => string) | undefined;
}

export const TALKATIVENESS_DEFAULT = 0.5;
export const DEPTH_PROMPT_DEPTH_DEFAULT = 4;
export const DEPTH_PROMPT_ROLE_DEFAULT = 'system';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** ST `humanizedDateTime()`: `2026-11-2@9h5m7s` */
export function humanizedDateTime(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}@${d.getHours()}h${d.getMinutes()}m${d.getSeconds()}s`;
}

/** ST `src/util.js` deepMerge: nested plain objects merge recursively, everything else is replaced. */
export function deepMerge(target: unknown, source: unknown): Record<string, unknown> {
  const output = Object.assign({}, target as object) as Record<string, unknown>;
  if (isPlainObject(target) && isPlainObject(source)) {
    for (const key of Object.keys(source)) {
      const value = source[key];
      if (isPlainObject(value)) {
        output[key] = key in target ? deepMerge(target[key], value) : value;
      } else {
        output[key] = value;
      }
    }
  }
  return output;
}

const splitFormTags = (t: string | string[] | undefined): string[] =>
  typeof t === 'string'
    ? t
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x)
    : t || [];

/**
 * ST `charaFormatData` followed by the `/edit` route: the form is written over `existing`
 * (`json_data`) with ST's exact coercions and defaults. Returns the card object to embed.
 * ST forces `spec: chara_card_v2` here; the PNG writer re-tags the `ccv3` chunk as V3.
 */
export function formatCharacterData(
  form: CharacterEditForm,
  opts: FormatCharacterOptions = {},
): Record<string, unknown> {
  const now = opts.now ?? (() => humanizedDateTime());
  const char: Record<string, unknown> = isPlainObject(opts.existing)
    ? structuredClone(opts.existing)
    : {};
  delete char['json_data'];

  const greetings = Array.isArray(form.alternate_greetings)
    ? form.alternate_greetings
    : typeof form.alternate_greetings === 'string'
      ? [form.alternate_greetings]
      : [];
  const tags = splitFormTags(form.tags);
  const talkativeness = form.talkativeness || TALKATIVENESS_DEFAULT;
  const fav = String(form.fav) === 'true';

  // Spec V1 fields + old ST extension fields
  char['name'] = form.ch_name;
  char['description'] = form.description || '';
  char['personality'] = form.personality || '';
  char['scenario'] = form.scenario || '';
  char['first_mes'] = form.first_mes || '';
  char['mes_example'] = form.mes_example || '';
  char['creatorcomment'] = form.creator_notes || '';
  char['avatar'] = 'none';
  char['chat'] = `${form.ch_name} - ${now()}`;
  char['talkativeness'] = talkativeness;
  char['fav'] = fav;
  char['tags'] = tags;

  // Spec V2 fields
  char['spec'] = 'chara_card_v2';
  char['spec_version'] = '2.0';
  const data: Record<string, unknown> = isPlainObject(char['data']) ? char['data'] : {};
  char['data'] = data;
  data['name'] = form.ch_name;
  data['description'] = form.description || '';
  data['personality'] = form.personality || '';
  data['scenario'] = form.scenario || '';
  data['first_mes'] = form.first_mes || '';
  data['mes_example'] = form.mes_example || '';
  data['creator_notes'] = form.creator_notes || '';
  data['system_prompt'] = form.system_prompt || '';
  data['post_history_instructions'] = form.post_history_instructions || '';
  data['tags'] = tags;
  data['creator'] = form.creator || '';
  data['character_version'] = form.character_version || '';
  data['alternate_greetings'] = greetings;

  // ST extension fields
  const ext: Record<string, unknown> = isPlainObject(data['extensions']) ? data['extensions'] : {};
  data['extensions'] = ext;
  ext['talkativeness'] = talkativeness;
  ext['fav'] = fav;
  ext['world'] = form.world || '';
  const depth = Number(form.depth_prompt_depth);
  const dp: Record<string, unknown> = isPlainObject(ext['depth_prompt']) ? ext['depth_prompt'] : {};
  ext['depth_prompt'] = dp;
  dp['prompt'] = form.depth_prompt_prompt ?? '';
  dp['depth'] = !Number.isNaN(depth) ? depth : DEPTH_PROMPT_DEPTH_DEFAULT;
  dp['role'] = form.depth_prompt_role ?? DEPTH_PROMPT_ROLE_DEFAULT;

  if (form.world && opts.characterBook) data['character_book'] = opts.characterBook;
  if (form.extensions) data['extensions'] = deepMerge(data['extensions'], form.extensions);

  // `/edit`: hidden fields win; undefined is dropped on serialization, so drop it here too
  if (opts.chat !== undefined) char['chat'] = opts.chat;
  else delete char['chat'];
  if (opts.create_date !== undefined) char['create_date'] = opts.create_date;
  else delete char['create_date'];
  return char;
}

/** Populate the form from a stored card the way ST fills `#form_create` (`data.*` first, V1 fallback). */
export function characterFormFromCard(raw: unknown): CharacterEditForm {
  const card = isPlainObject(raw) ? raw : {};
  const data = isPlainObject(card['data']) ? card['data'] : {};
  const ext = isPlainObject(data['extensions']) ? data['extensions'] : {};
  const dp = isPlainObject(ext['depth_prompt']) ? ext['depth_prompt'] : {};
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const pick = (k: string): string => str(data[k] ?? card[k]);
  const talk = ext['talkativeness'] ?? card['talkativeness'];
  const favRaw = ext['fav'] ?? card['fav'];
  const greetings = data['alternate_greetings'];
  return {
    ch_name: pick('name'),
    description: pick('description'),
    personality: pick('personality'),
    scenario: pick('scenario'),
    first_mes: pick('first_mes'),
    mes_example: pick('mes_example'),
    creator_notes: str(data['creator_notes'] ?? card['creatorcomment']),
    system_prompt: str(data['system_prompt']),
    post_history_instructions: str(data['post_history_instructions']),
    tags: splitFormTags((data['tags'] ?? card['tags']) as string | string[] | undefined),
    creator: pick('creator'),
    character_version: str(data['character_version']),
    alternate_greetings: Array.isArray(greetings) ? greetings.map((g) => str(g)) : [],
    talkativeness:
      typeof talk === 'number' || typeof talk === 'string' ? talk : TALKATIVENESS_DEFAULT,
    fav: favRaw === true || favRaw === 'true',
    world: str(ext['world']),
    depth_prompt_prompt: str(dp['prompt']),
    depth_prompt_depth: typeof dp['depth'] === 'number' ? dp['depth'] : DEPTH_PROMPT_DEPTH_DEFAULT,
    depth_prompt_role: str(dp['role']) || DEPTH_PROMPT_ROLE_DEFAULT,
  };
}
