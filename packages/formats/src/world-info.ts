/**
 * World Info (lorebook) files: `worlds/<name>.json` = `{ entries: { [uid]: entry } }`.
 * Field set from public/scripts/world-info.js newWorldInfoEntryDefinition (COMPAT_TARGET).
 * Also the V2 card `character_book` ⇄ world info conversion ST does on import/export.
 */
import { z } from 'zod';
import type { CharacterBook, CharacterBookEntry } from './card.js';

const str = z.string();
const num = z.number();
const bool = z.boolean();
const numish = z.union([z.number(), z.string()]);

/** world_info_position */
export const WI_POSITION = {
  BEFORE: 0,
  AFTER: 1,
  AN_TOP: 2,
  AN_BOTTOM: 3,
  AT_DEPTH: 4,
  EM_TOP: 5,
  EM_BOTTOM: 6,
  OUTLET: 7,
} as const;
/** world_info_logic */
export const WI_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 } as const;
/** extension_prompt_roles */
export const WI_ROLE = { SYSTEM: 0, USER: 1, ASSISTANT: 2 } as const;

export const WorldInfoEntrySchema = z.looseObject({
  uid: num.optional(),
  key: z.array(str),
  keysecondary: z.array(str).optional(),
  comment: str.optional(),
  content: str,
  constant: bool.optional(),
  vectorized: bool.optional(),
  selective: bool.optional(),
  selectiveLogic: num.optional(),
  addMemo: bool.optional(),
  order: num.optional(),
  position: num.optional(),
  disable: bool.optional(),
  ignoreBudget: bool.optional(),
  excludeRecursion: bool.optional(),
  preventRecursion: bool.optional(),
  /** ST default is 0 (number) but older files hold booleans. */
  delayUntilRecursion: z.union([num, bool]).optional(),
  matchPersonaDescription: bool.optional(),
  matchCharacterDescription: bool.optional(),
  matchCharacterPersonality: bool.optional(),
  matchCharacterDepthPrompt: bool.optional(),
  matchScenario: bool.optional(),
  matchCreatorNotes: bool.optional(),
  probability: numish.nullable().optional(),
  useProbability: bool.optional(),
  depth: num.optional(),
  outletName: str.optional(),
  group: str.optional(),
  groupOverride: bool.optional(),
  groupWeight: num.nullable().optional(),
  scanDepth: num.nullable().optional(),
  caseSensitive: bool.nullable().optional(),
  matchWholeWords: bool.nullable().optional(),
  useGroupScoring: bool.nullable().optional(),
  automationId: str.optional(),
  role: num.nullable().optional(),
  sticky: num.nullable().optional(),
  cooldown: num.nullable().optional(),
  delay: num.nullable().optional(),
  displayIndex: num.optional(),
  triggers: z.array(str).optional(),
  characterFilter: z
    .looseObject({
      isExclude: bool.optional(),
      names: z.array(str).optional(),
      tags: z.array(str).optional(),
    })
    .optional(),
  extensions: z.record(str, z.unknown()).optional(),
});

export const WorldInfoBookSchema = z.looseObject({
  entries: z.record(str, WorldInfoEntrySchema),
  name: str.optional(),
  description: str.optional(),
  /** ST keeps the untouched imported book here so re-export is lossless. */
  originalData: z.unknown().optional(),
});

export type WorldInfoEntry = z.infer<typeof WorldInfoEntrySchema>;
export type WorldInfoBook = z.infer<typeof WorldInfoBookSchema>;

export function parseWorldInfo(raw: unknown): WorldInfoBook {
  return WorldInfoBookSchema.parse(raw);
}

/** Entries in ST's display order (displayIndex, then uid). */
export function worldInfoEntries(book: WorldInfoBook): WorldInfoEntry[] {
  return Object.values(book.entries).sort(
    (a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0) || (a.uid ?? 0) - (b.uid ?? 0),
  );
}

/** ST convertWorldInfoToCharacterBook (src/endpoints/characters.js). */
export function worldInfoToCharacterBook(name: string, book: WorldInfoBook): CharacterBook {
  const entries: CharacterBookEntry[] = [];
  for (const entry of Object.values(book.entries)) {
    const {
      uid,
      key,
      keysecondary,
      comment,
      content,
      constant,
      selective,
      order,
      disable,
      position,
      ...rest
    } = entry;
    const ext = rest.extensions ?? {};
    entries.push({
      ...(uid !== undefined ? { id: uid } : {}),
      keys: key,
      secondary_keys: keysecondary ?? [],
      comment: comment ?? '',
      content,
      constant: constant ?? false,
      selective: selective ?? true,
      insertion_order: order ?? 100,
      enabled: !(disable ?? false),
      position: position === 0 ? 'before_char' : 'after_char',
      use_regex: true,
      extensions: {
        ...ext,
        position: position ?? 0,
        exclude_recursion: rest.excludeRecursion ?? false,
        display_index: rest.displayIndex ?? 0,
        probability: rest.probability ?? null,
        useProbability: rest.useProbability ?? false,
        depth: rest.depth ?? 4,
        selectiveLogic: rest.selectiveLogic ?? 0,
        outlet_name: rest.outletName ?? '',
        group: rest.group ?? '',
        group_override: rest.groupOverride ?? false,
        group_weight: rest.groupWeight ?? null,
        prevent_recursion: rest.preventRecursion ?? false,
        delay_until_recursion: rest.delayUntilRecursion ?? false,
        scan_depth: rest.scanDepth ?? null,
        match_whole_words: rest.matchWholeWords ?? null,
        use_group_scoring: rest.useGroupScoring ?? false,
        case_sensitive: rest.caseSensitive ?? null,
        automation_id: rest.automationId ?? '',
        role: rest.role ?? 0,
        vectorized: rest.vectorized ?? false,
        sticky: rest.sticky ?? null,
        cooldown: rest.cooldown ?? null,
        delay: rest.delay ?? null,
        match_persona_description: rest.matchPersonaDescription ?? false,
        match_character_description: rest.matchCharacterDescription ?? false,
        match_character_personality: rest.matchCharacterPersonality ?? false,
        match_character_depth_prompt: rest.matchCharacterDepthPrompt ?? false,
        match_scenario: rest.matchScenario ?? false,
        match_creator_notes: rest.matchCreatorNotes ?? false,
        triggers: rest.triggers ?? [],
        ignore_budget: rest.ignoreBudget ?? false,
      },
    });
  }
  return { entries, name };
}

const n = (v: unknown, d: number | null) => (typeof v === 'number' ? v : d);
const b = (v: unknown, d: boolean | null) => (typeof v === 'boolean' ? v : d);
const s = (v: unknown, d: string) => (typeof v === 'string' ? v : d);

/** Inverse of ST's conversion (public/scripts/world-info.js convertCharacterBook): card book → world file. */
export function characterBookToWorldInfo(book: CharacterBook): WorldInfoBook {
  const entries: Record<string, WorldInfoEntry> = {};
  book.entries.forEach((e, index) => {
    const x = e.extensions ?? {};
    const uid = e.id ?? index;
    entries[String(uid)] = {
      uid,
      key: e.keys,
      keysecondary: e.secondary_keys ?? [],
      comment: e.comment ?? '',
      content: e.content,
      constant: e.constant ?? false,
      selective: e.selective ?? false,
      order: e.insertion_order ?? 100,
      position: n(x['position'], e.position === 'before_char' ? 0 : 1) as number,
      disable: !(e.enabled ?? true),
      addMemo: Boolean(e.comment),
      excludeRecursion: b(x['exclude_recursion'], false) as boolean,
      displayIndex: n(x['display_index'], index) as number,
      probability: n(x['probability'], 100),
      useProbability: b(x['useProbability'], true) as boolean,
      depth: n(x['depth'], 4) as number,
      selectiveLogic: n(x['selectiveLogic'], 0) as number,
      outletName: s(x['outlet_name'], ''),
      group: s(x['group'], ''),
      groupOverride: b(x['group_override'], false) as boolean,
      groupWeight: n(x['group_weight'], 100),
      preventRecursion: b(x['prevent_recursion'], false) as boolean,
      delayUntilRecursion: (typeof x['delay_until_recursion'] === 'number' ||
      typeof x['delay_until_recursion'] === 'boolean'
        ? x['delay_until_recursion']
        : false) as number | boolean,
      scanDepth: n(x['scan_depth'], null),
      matchWholeWords: b(x['match_whole_words'], null),
      useGroupScoring: b(x['use_group_scoring'], null),
      caseSensitive: b(x['case_sensitive'], null),
      automationId: s(x['automation_id'], ''),
      role: n(x['role'], 0),
      vectorized: b(x['vectorized'], false) as boolean,
      sticky: n(x['sticky'], null),
      cooldown: n(x['cooldown'], null),
      delay: n(x['delay'], null),
      matchPersonaDescription: b(x['match_persona_description'], false) as boolean,
      matchCharacterDescription: b(x['match_character_description'], false) as boolean,
      matchCharacterPersonality: b(x['match_character_personality'], false) as boolean,
      matchCharacterDepthPrompt: b(x['match_character_depth_prompt'], false) as boolean,
      matchScenario: b(x['match_scenario'], false) as boolean,
      matchCreatorNotes: b(x['match_creator_notes'], false) as boolean,
      triggers: Array.isArray(x['triggers']) ? (x['triggers'] as string[]) : [],
      ignoreBudget: b(x['ignore_budget'], false) as boolean,
    };
  });
  return { entries, ...(book.name ? { name: book.name } : {}) };
}
