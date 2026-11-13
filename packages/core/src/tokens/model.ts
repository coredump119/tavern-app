/**
 * 两段模型名 → 分词器名的映射：
 * - getTokenizerModel：ST 前端按 chat_completion_source 选出传给 /openai/count?model= 的名字
 * - resolveServerTokenizerModel：ST 服务端 getTokenizerModel(requestModel) 的归一化（与 Rust model.rs 同源）
 */
import { CHAT_COMPLETION_SOURCES } from '../prompt/chat-completion/types.js';
import { TEXTGEN_TYPES, TEXT_COMPLETION_MODELS } from './types.js';

export type ChatCompletionSource =
  (typeof CHAT_COMPLETION_SOURCES)[keyof typeof CHAT_COMPLETION_SOURCES];

/** OpenRouter 模型列表项里用到的字段 */
export interface OpenRouterModelMeta {
  id: string;
  architecture?: { tokenizer?: string | undefined } | undefined;
}

export interface TokenizerModelInput {
  mainApi: string;
  source: ChatCompletionSource | string;
  openaiModel?: string | undefined;
  azureOpenaiModel?: string | undefined;
  openrouterModel?: string | undefined;
  /** oai model_list 中与 openrouterModel 匹配的条目 */
  openrouterModelMeta?: OpenRouterModelMeta | undefined;
  textgenType?: string | undefined;
  textgenOpenrouterModel?: string | undefined;
  textgenOpenrouterModelMeta?: OpenRouterModelMeta | undefined;
  electronhubModel?: string | undefined;
  chutesModel?: string | undefined;
  workersAiModel?: string | undefined;
  cohereModel?: string | undefined;
  mistralaiModel?: string | undefined;
  customModel?: string | undefined;
  perplexityModel?: string | undefined;
  groqModel?: string | undefined;
}

const S = CHAT_COMPLETION_SOURCES;

export function getTokenizerModel(input: TokenizerModelInput): string {
  const src = input.source;
  if (src === S.OPENAI) return input.openaiModel ?? '';

  const turbo = 'gpt-3.5-turbo';
  const gpt4 = 'gpt-4';
  const gpt4o = 'gpt-4o';
  const gpt2 = 'gpt2';
  const claude = 'claude';
  const llama = 'llama';
  const llama3 = 'llama3';
  const mistral = 'mistral';
  const yi = 'yi';
  const gemma = 'gemma';
  const jamba = 'jamba';
  const qwen2 = 'qwen2';
  const commandR = 'command-r';
  const commandA = 'command-a';
  const nemo = 'nemo';
  const deepseek = 'deepseek';

  if (src === S.AZURE_OPENAI) return input.azureOpenaiModel || turbo;
  if (src === S.DEEPSEEK) return deepseek;

  const oaiOpenrouter = input.mainApi === 'openai' && src === S.OPENROUTER && input.openrouterModel;
  const tgOpenrouter =
    input.mainApi === 'textgenerationwebui' &&
    input.textgenType === TEXTGEN_TYPES.OPENROUTER &&
    input.textgenOpenrouterModel;
  if (oaiOpenrouter || tgOpenrouter) {
    const model =
      input.mainApi === 'openai' ? input.openrouterModelMeta : input.textgenOpenrouterModelMeta;
    const orModel = input.openrouterModel ?? '';
    const tok = model?.architecture?.tokenizer;
    if (tok === 'Llama2') return llama;
    else if (tok === 'Llama3') return llama3;
    else if (tok === 'Mistral') return mistral;
    else if (tok === 'Yi') return yi;
    else if (tok === 'Gemini') return gemma;
    else if (tok === 'Qwen') return qwen2;
    else if (tok === 'Cohere') {
      if (model?.id && model.id.includes('command-a')) return commandA;
      return commandR;
    } else if (orModel.includes('gpt-4o')) return gpt4o;
    else if (orModel.includes('gpt-4')) return gpt4;
    else if (orModel.includes('gpt-3.5-turbo')) return turbo;
    else if (orModel.includes('claude')) return claude;
    else if (orModel.includes('GPT-NeoXT')) return gpt2;
    else if (orModel.includes('jamba')) return jamba;
    else if (orModel.includes('deepseek')) return deepseek;
  }

  if (src === S.ELECTRONHUB && input.electronhubModel) {
    const m = input.electronhubModel;
    if (m.includes('gpt-4o') || m.includes('gpt-5')) return gpt4o;
    else if (m.includes('gpt-4.1') || m.includes('gpt-4.5')) return gpt4o;
    else if (m.includes('gpt-4')) return gpt4;
    else if (m.includes('gpt-3.5-turbo')) return turbo;
    else if (m.includes('claude')) return claude;
    else if (m.includes('jamba')) return jamba;
    else if (m.includes('deepseek') || m.includes('sonar-reasoning') || m.includes('r1')) {
      return deepseek;
    } else if (m.includes('qwen')) return qwen2;
    else if (m.includes('gemma')) return gemma;
    else if (m.includes('mistral')) return mistral;
    else if (m.includes('yi')) return yi;
    else if (m.includes('llama3') || m.includes('llama-3') || m.startsWith('l3')) return llama3;
    else if (m.includes('llama')) return llama;
    else if (m.includes('command-a')) return commandA;
    else if (m.includes('command-r')) return commandR;
    else if (m.includes('nemo')) return nemo;
  }

  if (src === S.CHUTES && input.chutesModel) {
    const m = input.chutesModel.toLowerCase();
    if (m.includes('deepseek') || m.includes('mai-ds')) return deepseek;
    else if (
      m.includes('qwen') ||
      m.includes('qwq') ||
      m.includes('tongyi') ||
      m.includes('kimi')
    ) {
      return qwen2;
    } else if (m.includes('llama') || m.includes('longcat') || m.includes('hermes')) return llama3;
    else if (m.includes('gemma')) return gemma;
    else if (m.includes('nemo')) return nemo;
    else if (m.includes('mistral')) return mistral;
    else if (m.includes('gpt-oss')) return gpt4o;
  }

  if (src === S.MINIMAX) return 'gpt-3.5-turbo';

  if (src === S.WORKERS_AI && input.workersAiModel) {
    const m = input.workersAiModel.toLowerCase();
    if (m.includes('deepseek')) return deepseek;
    else if (m.includes('qwen') || m.includes('qwq') || m.includes('kimi')) return qwen2;
    else if (m.includes('llama-3') || m.includes('llama-4')) return llama3;
    else if (m.includes('llama')) return llama;
    else if (m.includes('gemma')) return gemma;
    else if (m.includes('mistral')) return mistral;
    else if (m.includes('phi')) return turbo;
    else if (m.includes('gpt-oss')) return gpt4o;
  }

  if (src === S.COHERE) {
    if ((input.cohereModel ?? '').includes('command-a')) return commandA;
    return commandR;
  }
  if (src === S.MAKERSUITE) return gemma;
  if (src === S.VERTEXAI) return gemma;
  if (src === S.AI21) return jamba;
  if (src === S.CLAUDE) return claude;
  if (src === S.MISTRALAI) {
    const m = input.mistralaiModel ?? '';
    if (m.includes('nemo') || m.includes('pixtral')) return nemo;
    return mistral;
  }
  if (src === S.CUSTOM) return input.customModel ?? '';
  if (src === S.PERPLEXITY) {
    const m = input.perplexityModel ?? '';
    if (m.includes('sonar-reasoning') || m.includes('r1-1776')) return deepseek;
    if (m.includes('llama-3') || m.includes('llama3')) return llama3;
    if (m.includes('llama')) return llama;
    if (m.includes('mistral') || m.includes('mixtral')) return mistral;
  }
  if (src === S.GROQ) {
    const m = input.groqModel ?? '';
    if (m.includes('qwen')) return qwen2;
    if (m.includes('llama-3') || m.includes('llama3')) return llama3;
    if (m.includes('mistral') || m.includes('mixtral')) return mistral;
    if (m.includes('gemma')) return gemma;
  }

  return turbo;
}

/** 服务端 getTokenizerModel(requestModel)：请求里的 model → tiktoken 模型名或本地分词器名 */
export function resolveServerTokenizerModel(requestModel: string): string {
  const m = requestModel;
  if (m === 'o1' || m.includes('o1-preview') || m.includes('o1-mini') || m.includes('o3-mini')) {
    return 'o1';
  }
  if (m.includes('gpt-5') || m.includes('o3') || m.includes('o4-mini')) return 'o1';
  if (m.includes('gpt-4o') || m.includes('chatgpt-4o-latest')) return 'gpt-4o';
  if (m.includes('gpt-4.1') || m.includes('gpt-4.5')) return 'gpt-4o';
  if (m.includes('gpt-4-32k')) return 'gpt-4-32k';
  if (m.includes('gpt-4')) return 'gpt-4';
  if (m.includes('gpt-3.5-turbo-0301')) return 'gpt-3.5-turbo-0301';
  if (m.includes('gpt-3.5-turbo')) return 'gpt-3.5-turbo';
  if (TEXT_COMPLETION_MODELS.includes(m)) return m;
  if (m.includes('claude')) return 'claude';
  if (m.includes('llama3') || m.includes('llama-3')) return 'llama3';
  if (m.includes('llama')) return 'llama';
  if (m.includes('mistral')) return 'mistral';
  if (m.includes('yi')) return 'yi';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('gemma') || m.includes('gemini') || m.includes('learnlm')) return 'gemma';
  if (m.includes('jamba')) return 'jamba';
  if (m.includes('qwen2')) return 'qwen2';
  if (m.includes('command-r')) return 'command-r';
  if (m.includes('command-a')) return 'command-a';
  if (m.includes('nemo')) return 'nemo';
  return 'gpt-3.5-turbo';
}

const LOCAL_SERVER_MODELS = new Set([
  'claude',
  'llama3',
  'llama',
  'mistral',
  'yi',
  'deepseek',
  'gemma',
  'jamba',
  'qwen2',
  'command-r',
  'command-a',
  'nemo',
]);

/** 服务端会走本地（HF / sentencepiece）分词器而不是 tiktoken 的模型名 */
export function isLocalServerTokenizer(serverModel: string): boolean {
  return LOCAL_SERVER_MODELS.has(serverModel);
}
