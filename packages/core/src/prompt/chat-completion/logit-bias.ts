/**
 * Logit bias presets (ST openai.js `calculateLogitBias` + server
 * `/api/backends/chat-completions/bias` — DEV_NOTES §9.36). Pure; the host supplies the encoder.
 */
export interface LogitBiasEntry {
  id: string;
  text: string;
  value: number;
}

export const LOGIT_BIAS_MIN = -100;
export const LOGIT_BIAS_MAX = 100;

/** `oai_settings.bias_presets[name]` as a clean entry list (drops malformed rows) */
export function logitBiasEntries(raw: unknown): LogitBiasEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: LogitBiasEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, text, value } = item as Record<string, unknown>;
    out.push({ id: String(id ?? ''), text: String(text ?? ''), value: Number(value) || 0 });
  }
  return out;
}

/**
 * ST `onLogitBiasPresetImportFileChange`: the file is an entry array, the preset is named after
 * the file. Entries need their own `text` and `value`; a missing `id` gets a fresh one.
 */
export function importLogitBiasPreset(
  raw: unknown,
  fileName: string,
  existing: readonly string[],
  uuid: () => string,
): { name: string; entries: LogitBiasEntry[] } | { error: 'duplicate' | 'invalid' } {
  const name = fileName.replace(/\.[^/.]+$/, '');
  if (existing.includes(name)) return { error: 'duplicate' };
  if (!Array.isArray(raw)) return { error: 'invalid' };
  const valid = raw.filter(
    (e): e is Record<string, unknown> =>
      typeof e === 'object' && e !== null && Object.hasOwn(e, 'text') && Object.hasOwn(e, 'value'),
  );
  const entries = logitBiasEntries(valid).map((e) => (e.id ? e : { ...e, id: uuid() }));
  return { name, entries };
}

/** ST `onLogitBiasPresetExportClick`: the entry array, 4-space JSON, saved as `<name>.json` */
export const exportLogitBiasPreset = (entries: readonly LogitBiasEntry[]): string =>
  JSON.stringify(entries, null, 4);

/** server `getEntryTokens`: a JSON array of numbers is used as raw token ids */
function rawTokenIds(text: string): number[] | null {
  const t = text.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  try {
    const json: unknown = JSON.parse(t);
    if (Array.isArray(json) && json.every((x) => typeof x === 'number')) return json as number[];
  } catch {
    /* not JSON: encode it as text */
  }
  return null;
}

/**
 * Every token of every entry maps to the entry's value (later entries win). Entries with no text
 * and entries the encoder fails on are skipped, as on ST's server.
 */
export async function calculateLogitBias(
  entries: readonly LogitBiasEntry[],
  encode: (text: string) => Promise<readonly number[]>,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const entry of entries) {
    if (!entry.text) continue;
    const value = Math.min(LOGIT_BIAS_MAX, Math.max(LOGIT_BIAS_MIN, Number(entry.value) || 0));
    let tokens: readonly number[];
    try {
      tokens = rawTokenIds(entry.text) ?? (await encode(entry.text));
    } catch {
      continue;
    }
    for (const token of tokens) result[String(token)] = value;
  }
  return result;
}
