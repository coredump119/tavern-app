/** Regex extension scripts (global: settings.extension_settings.regex; per-character: card data.extensions.regex_scripts). */
import { z } from 'zod';

/** public/scripts/extensions/regex/engine.js — regex_placement */
export const REGEX_PLACEMENT = {
  MD_DISPLAY: 0, // deprecated
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
} as const;

/** substitute_find_regex */
export const SUBSTITUTE_FIND_REGEX = { NONE: 0, RAW: 1, ESCAPED: 2 } as const;

export const RegexScriptSchema = z.looseObject({
  id: z.string().optional(),
  scriptName: z.string().optional(),
  findRegex: z.string().optional(),
  replaceString: z.string().optional(),
  trimStrings: z.array(z.string()).optional(),
  placement: z.array(z.number()).optional(),
  disabled: z.boolean().optional(),
  markdownOnly: z.boolean().optional(),
  promptOnly: z.boolean().optional(),
  runOnEdit: z.boolean().optional(),
  substituteRegex: z.union([z.number(), z.boolean()]).optional(),
  minDepth: z.number().nullable().optional(),
  maxDepth: z.number().nullable().optional(),
});
export type RegexScript = z.infer<typeof RegexScriptSchema>;

export const RegexScriptListSchema = z.array(RegexScriptSchema);

export function parseRegexScripts(raw: unknown): RegexScript[] {
  return RegexScriptListSchema.parse(raw);
}
