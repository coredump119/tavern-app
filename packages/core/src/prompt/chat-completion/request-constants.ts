// 由 ST src/constants.js 与 src/endpoints/tokenizers.js 生成（COMPAT_TARGET），勿手改
export const OPENAI_REASONING_EFFORT_MODELS: readonly string[] = [
  'o1',
  'o3-mini',
  'o3-mini-2025-01-31',
  'o4-mini',
  'o4-mini-2025-04-16',
  'o3',
  'o3-2025-04-16',
  'gpt-5',
  'gpt-5-2025-08-07',
  'gpt-5-mini',
  'gpt-5-mini-2025-08-07',
  'gpt-5-nano',
  'gpt-5-nano-2025-08-07',
  'gpt-5.1',
  'gpt-5.1-2025-11-13',
  'gpt-5.1-chat-latest',
  'gpt-5.2',
  'gpt-5.2-2025-12-11',
  'gpt-5.2-chat-latest',
  'gpt-5.3-chat-latest',
  'gpt-5.4',
  'gpt-5.4-2026-03-05',
  'gpt-5.4-mini',
  'gpt-5.4-mini-2026-03-17',
  'gpt-5.4-nano',
  'gpt-5.4-nano-2026-03-17',
  'gpt-5.5',
  'gpt-5.5-2026-04-23',
];
export const OPENAI_REASONING_EFFORT_MAP: Readonly<Record<string, string>> = { min: 'minimal' };
export const OPENAI_FIXED_REASONING_EFFORT: Readonly<Record<string, string>> = {
  'gpt-5.3-chat-latest': 'medium',
};
export const OPENAI_VERBOSITY_MODELS = /^gpt-5/;
