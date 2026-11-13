/**
 * Logit bias for a chat-completion request (ST openai.js `calculateLogitBias` + `biasCache`,
 * DEV_NOTES §9.36): the selected bias preset's entries are tokenized with the current model's
 * tokenizer. Rune-free so tests can import it.
 */
import {
  LOGIT_BIAS_SOURCES,
  calculateLogitBias,
  isLocalServerTokenizer,
  logitBiasEntries,
  resolveServerTokenizerModel,
} from '@tm/core';
import { tokenizerEncode, type TokenizerName } from '../ipc';

/** ST `biasCache`: keyed by tokenizer model + preset content, so edits invalidate it */
let cache: { key: string; bias: Record<string, number> } | null = null;

/** `undefined` when no preset applies; `{}` when the tokenizer has no token ids to offer */
export async function chatCompletionLogitBias(
  oai: Record<string, unknown>,
  clientTokenizerModel: string,
): Promise<Record<string, number> | undefined> {
  const selected = String(oai['bias_preset_selected'] ?? '');
  if (!selected || !LOGIT_BIAS_SOURCES.includes(String(oai['chat_completion_source']))) {
    return undefined;
  }
  const presets = oai['bias_presets'] as Record<string, unknown> | undefined;
  const entries = logitBiasEntries(presets?.[selected]).filter((e) => e.text);
  if (!entries.length) return undefined;

  const model = resolveServerTokenizerModel(clientTokenizerModel);
  // ST's server answers `{}` for Claude: it has no logit bias
  if (model === 'claude') return {};
  const key = JSON.stringify([model, entries.map((e) => [e.text, e.value])]);
  if (cache?.key === key) return cache.bias;

  const local = isLocalServerTokenizer(model);
  const bias = await calculateLogitBias(entries, async (text) => {
    const result = local
      ? await tokenizerEncode(model as TokenizerName, text)
      : await tokenizerEncode('openai', text, model);
    return result.ids;
  });
  cache = { key, bias };
  return bias;
}
