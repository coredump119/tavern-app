// 由 ST src/endpoints/backends/chat-completions.js 与 src/constants.js 生成（COMPAT_TARGET），勿手改
export const API_URLS = {
  API_OPENAI: 'https://api.openai.com/v1',
  API_CLAUDE: 'https://api.anthropic.com/v1',
  API_MISTRAL: 'https://api.mistral.ai/v1',
  API_COHERE_V1: 'https://api.cohere.ai/v1',
  API_COHERE_V2: 'https://api.cohere.ai/v2',
  API_PERPLEXITY: 'https://api.perplexity.ai',
  API_GROQ: 'https://api.groq.com/openai/v1',
  API_MAKERSUITE: 'https://generativelanguage.googleapis.com',
  API_VERTEX_AI: 'https://us-central1-aiplatform.googleapis.com',
  API_AI21: 'https://api.ai21.com/studio/v1',
  API_CHUTES: 'https://llm.chutes.ai/v1',
  API_ELECTRONHUB: 'https://api.electronhub.ai/v1',
  API_NANOGPT: 'https://nano-gpt.com/api/v1',
  API_DEEPSEEK: 'https://api.deepseek.com/beta',
  API_XAI: 'https://api.x.ai/v1',
  API_AIMLAPI: 'https://api.aimlapi.com/v1',
  API_POLLINATIONS: 'https://gen.pollinations.ai/v1',
  API_MOONSHOT: 'https://api.moonshot.ai/v1',
  API_FIREWORKS: 'https://api.fireworks.ai/inference/v1',
  API_COMETAPI: 'https://api.cometapi.com/v1',
  API_ZAI_COMMON: 'https://api.z.ai/api/paas/v4',
  API_ZAI_CODING: 'https://api.z.ai/api/coding/paas/v4',
  API_SILICONFLOW: 'https://api.siliconflow.com/v1',
  API_SILICONFLOW_CN: 'https://api.siliconflow.cn/v1',
  API_MINIMAX: 'https://api.minimax.io/v1',
  API_MINIMAX_CN: 'https://api.minimaxi.com/v1',
  API_OPENROUTER: 'https://openrouter.ai/api/v1',
  API_WORKERS_AI: 'https://api.cloudflare.com/client/v4/accounts',
} as const;
export const ZAI_ENDPOINT = { COMMON: 'common', CODING: 'coding' } as const;
export const SILICONFLOW_ENDPOINT = { GLOBAL: 'global', CN: 'cn' } as const;
export const MINIMAX_ENDPOINT = { GLOBAL: 'global', CN: 'cn' } as const;
export const NANOGPT_REASONING_EFFORT_MAP: Readonly<Record<string, string>> = {
  min: 'none',
  low: 'minimal',
  medium: 'low',
  high: 'medium',
  max: 'high',
};
export const GEMINI_SAFETY: ReadonlyArray<{ category: string; threshold: string }> = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
];
export const VERTEX_SAFETY: ReadonlyArray<{ category: string; threshold: string }> = [
  { category: 'HARM_CATEGORY_IMAGE_HATE', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_IMAGE_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_JAILBREAK', threshold: 'OFF' },
];
