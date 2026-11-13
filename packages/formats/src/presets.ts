/**
 * Preset & template files. One loose schema per ST preset kind; folder mapping follows
 * src/endpoints/presets.js. Samplers are deliberately typed as optional numbers/booleans —
 * ST itself tolerates missing keys and fills from its defaults.
 */
import { z } from 'zod';

const str = z.string();
const num = z.number();
const bool = z.boolean();
const numish = z.union([z.number(), z.string()]);

/** api name (as ST's /api/presets uses) → data folder */
export const PRESET_FOLDERS = {
  openai: 'OpenAI Settings',
  textgenerationwebui: 'TextGen Settings',
  kobold: 'KoboldAI Settings',
  koboldhorde: 'KoboldAI Settings',
  novel: 'NovelAI Settings',
  instruct: 'instruct',
  context: 'context',
  sysprompt: 'sysprompt',
  reasoning: 'reasoning',
} as const;
export type PresetKind = keyof typeof PRESET_FOLDERS;

/** oai_settings.prompts[] — prompt manager entries */
export const CcPromptSchema = z.looseObject({
  identifier: str,
  name: str.optional(),
  role: z.enum(['system', 'user', 'assistant']).optional(),
  content: str.optional(),
  system_prompt: bool.optional(),
  marker: bool.optional(),
  enabled: bool.optional(),
  injection_position: num.optional(),
  injection_depth: num.optional(),
  injection_order: num.optional(),
  injection_trigger: z.array(str).optional(),
  forbid_overrides: bool.optional(),
});

export const CcPromptOrderSchema = z.looseObject({
  character_id: z.union([num, str]),
  order: z.array(z.looseObject({ identifier: str, enabled: bool })),
});

/** OpenAI Settings/*.json — Chat Completion preset */
export const ChatCompletionPresetSchema = z.looseObject({
  chat_completion_source: str.optional(),
  openai_model: str.optional(),
  claude_model: str.optional(),
  custom_model: str.optional(),
  custom_url: str.optional(),
  temperature: num.optional(),
  frequency_penalty: num.optional(),
  presence_penalty: num.optional(),
  top_p: num.optional(),
  top_k: num.optional(),
  top_a: num.optional(),
  min_p: num.optional(),
  repetition_penalty: num.optional(),
  openai_max_context: num.optional(),
  openai_max_tokens: num.optional(),
  names_behavior: num.optional(),
  send_if_empty: str.optional(),
  impersonation_prompt: str.optional(),
  new_chat_prompt: str.optional(),
  new_group_chat_prompt: str.optional(),
  new_example_chat_prompt: str.optional(),
  continue_nudge_prompt: str.optional(),
  group_nudge_prompt: str.optional(),
  bias_preset_selected: str.optional(),
  reverse_proxy: str.optional(),
  proxy_password: str.optional(),
  max_context_unlocked: bool.optional(),
  wi_format: str.optional(),
  scenario_format: str.optional(),
  personality_format: str.optional(),
  stream_openai: bool.optional(),
  prompts: z.array(CcPromptSchema).optional(),
  prompt_order: z.array(CcPromptOrderSchema).optional(),
  assistant_prefill: str.optional(),
  assistant_impersonation: str.optional(),
  use_sysprompt: bool.optional(),
  squash_system_messages: bool.optional(),
  continue_prefill: bool.optional(),
  continue_postfix: str.optional(),
  seed: num.optional(),
  n: num.optional(),
});

/** TextGen Settings/*.json — Text Completion preset (samplers only; all optional) */
export const TextCompletionPresetSchema = z.looseObject({
  temp: num.optional(),
  temperature_last: bool.optional(),
  top_p: num.optional(),
  top_k: num.optional(),
  top_a: num.optional(),
  tfs: num.optional(),
  typical_p: num.optional(),
  min_p: num.optional(),
  rep_pen: num.optional(),
  rep_pen_range: num.optional(),
  rep_pen_slope: num.optional(),
  no_repeat_ngram_size: num.optional(),
  freq_pen: num.optional(),
  presence_pen: num.optional(),
  do_sample: bool.optional(),
  dynatemp: bool.optional(),
  min_temp: num.optional(),
  max_temp: num.optional(),
  dynatemp_exponent: num.optional(),
  smoothing_factor: num.optional(),
  smoothing_curve: num.optional(),
  dry_allowed_length: num.optional(),
  dry_multiplier: num.optional(),
  dry_base: num.optional(),
  dry_sequence_breakers: str.optional(),
  dry_penalty_last_n: num.optional(),
  add_bos_token: bool.optional(),
  ban_eos_token: bool.optional(),
  skip_special_tokens: bool.optional(),
  mirostat_mode: num.optional(),
  mirostat_tau: num.optional(),
  mirostat_eta: num.optional(),
  guidance_scale: num.optional(),
  negative_prompt: str.optional(),
  grammar_string: str.optional(),
  json_schema: z.unknown().optional(),
  banned_tokens: str.optional(),
  sampler_priority: z.array(str).optional(),
  samplers: z.array(str).optional(),
  samplers_priorities: z.array(str).optional(),
  sampler_order: z.array(num).optional(),
  logit_bias: z.array(z.unknown()).optional(),
  xtc_threshold: num.optional(),
  xtc_probability: num.optional(),
  nsigma: num.optional(),
  min_keep: num.optional(),
});

export const KoboldPresetSchema = z.looseObject({
  temp: num.optional(),
  rep_pen: num.optional(),
  rep_pen_range: num.optional(),
  top_p: num.optional(),
  min_p: num.optional(),
  top_a: num.optional(),
  top_k: num.optional(),
  typical: num.optional(),
  tfs: num.optional(),
  rep_pen_slope: num.optional(),
  sampler_order: z.array(num).optional(),
  mirostat: num.optional(),
  mirostat_tau: num.optional(),
  mirostat_eta: num.optional(),
  use_default_badwordsids: bool.optional(),
  grammar: str.optional(),
});

export const NovelPresetSchema = z.looseObject({
  order: z.array(num).optional(),
  temperature: num.optional(),
  max_length: num.optional(),
  min_length: num.optional(),
  top_a: num.optional(),
  top_k: num.optional(),
  top_p: num.optional(),
  typical_p: num.optional(),
  tail_free_sampling: num.optional(),
  repetition_penalty: num.optional(),
  repetition_penalty_range: num.optional(),
  repetition_penalty_slope: num.optional(),
  repetition_penalty_frequency: num.optional(),
  repetition_penalty_presence: num.optional(),
  prefix: str.optional(),
  phrase_rep_pen: str.optional(),
  max_context: num.optional(),
  min_p: num.optional(),
});

/** context/*.json */
export const ContextTemplateSchema = z.looseObject({
  name: str.optional(),
  story_string: str,
  example_separator: str.optional(),
  chat_start: str.optional(),
  use_stop_strings: bool.optional(),
  names_as_stop_strings: bool.optional(),
  story_string_position: num.optional(),
  story_string_depth: num.optional(),
  story_string_role: num.optional(),
  always_force_name2: bool.optional(),
  trim_sentences: bool.optional(),
  single_line: bool.optional(),
});

/** instruct/*.json */
export const InstructTemplateSchema = z.looseObject({
  name: str.optional(),
  input_sequence: str.optional(),
  output_sequence: str.optional(),
  last_output_sequence: str.optional(),
  system_sequence: str.optional(),
  stop_sequence: str.optional(),
  wrap: bool.optional(),
  macro: bool.optional(),
  names_behavior: z.union([str, bool]).optional(),
  activation_regex: str.optional(),
  first_output_sequence: str.optional(),
  skip_examples: bool.optional(),
  output_suffix: str.optional(),
  input_suffix: str.optional(),
  system_suffix: str.optional(),
  user_alignment_message: str.optional(),
  system_same_as_user: bool.optional(),
  last_system_sequence: str.optional(),
  first_input_sequence: str.optional(),
  last_input_sequence: str.optional(),
  sequences_as_stop_strings: bool.optional(),
  story_string_prefix: str.optional(),
  story_string_suffix: str.optional(),
});

/** sysprompt/*.json */
export const SystemPromptTemplateSchema = z.looseObject({
  name: str,
  content: str,
  post_history: str.optional(),
});

/** reasoning/*.json */
export const ReasoningTemplateSchema = z.looseObject({
  name: str,
  prefix: str.optional(),
  suffix: str.optional(),
  separator: str.optional(),
});

export type CcPrompt = z.infer<typeof CcPromptSchema>;
export type ChatCompletionPreset = z.infer<typeof ChatCompletionPresetSchema>;
export type TextCompletionPreset = z.infer<typeof TextCompletionPresetSchema>;
export type KoboldPreset = z.infer<typeof KoboldPresetSchema>;
export type NovelPreset = z.infer<typeof NovelPresetSchema>;
export type ContextTemplate = z.infer<typeof ContextTemplateSchema>;
export type InstructTemplate = z.infer<typeof InstructTemplateSchema>;
export type SystemPromptTemplate = z.infer<typeof SystemPromptTemplateSchema>;
export type ReasoningTemplate = z.infer<typeof ReasoningTemplateSchema>;

export const PRESET_SCHEMAS = {
  openai: ChatCompletionPresetSchema,
  textgenerationwebui: TextCompletionPresetSchema,
  kobold: KoboldPresetSchema,
  koboldhorde: KoboldPresetSchema,
  novel: NovelPresetSchema,
  instruct: InstructTemplateSchema,
  context: ContextTemplateSchema,
  sysprompt: SystemPromptTemplateSchema,
  reasoning: ReasoningTemplateSchema,
} as const;

export function parsePreset<K extends PresetKind>(
  kind: K,
  raw: unknown,
): z.infer<(typeof PRESET_SCHEMAS)[K]> {
  return PRESET_SCHEMAS[kind].parse(raw) as z.infer<(typeof PRESET_SCHEMAS)[K]>;
}

/** Enabled prompt-manager entries for a character id (or the default `100000` set), in order. */
export function orderedPrompts(
  preset: ChatCompletionPreset,
  characterId: number | string = 100000,
): CcPrompt[] {
  const byId = new Map((preset.prompts ?? []).map((p) => [p.identifier, p]));
  const order =
    preset.prompt_order?.find((o) => String(o.character_id) === String(characterId)) ??
    preset.prompt_order?.find((o) => String(o.character_id) === '100000') ??
    preset.prompt_order?.[0];
  if (!order) return preset.prompts ?? [];
  return order.order
    .filter((o) => o.enabled)
    .flatMap((o) => (byId.has(o.identifier) ? [byId.get(o.identifier)!] : []));
}
