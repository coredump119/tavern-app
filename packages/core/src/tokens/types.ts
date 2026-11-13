/**
 * ST public/scripts/tokenizers.js 的常量：分词器枚举、本地分词器名、字节估算系数。
 */

export const BYTES_PER_TOKEN = 3.35;
export const CHARACTERS_PER_TOKEN_RATIO = BYTES_PER_TOKEN;

export const TOKENIZERS = {
  NONE: 0,
  GPT2: 1,
  OPENAI: 2,
  LLAMA: 3,
  NERD: 4,
  NERD2: 5,
  API_CURRENT: 6,
  MISTRAL: 7,
  YI: 8,
  API_TEXTGENERATIONWEBUI: 9,
  API_KOBOLD: 10,
  CLAUDE: 11,
  LLAMA3: 12,
  GEMMA: 13,
  JAMBA: 14,
  QWEN2: 15,
  COMMAND_R: 16,
  NEMO: 17,
  DEEPSEEK: 18,
  COMMAND_A: 19,
  BEST_MATCH: 99,
} as const;
export type TokenizerType = (typeof TOKENIZERS)[keyof typeof TOKENIZERS];

/** 支持 encode/decode 的本地分词器 */
export const ENCODE_TOKENIZERS: readonly TokenizerType[] = [
  TOKENIZERS.LLAMA,
  TOKENIZERS.MISTRAL,
  TOKENIZERS.YI,
  TOKENIZERS.LLAMA3,
  TOKENIZERS.GEMMA,
  TOKENIZERS.JAMBA,
  TOKENIZERS.QWEN2,
  TOKENIZERS.COMMAND_R,
  TOKENIZERS.COMMAND_A,
  TOKENIZERS.NEMO,
  TOKENIZERS.DEEPSEEK,
];

/** ST textgen_types */
export const TEXTGEN_TYPES = {
  OOBA: 'ooba',
  MANCER: 'mancer',
  VLLM: 'vllm',
  APHRODITE: 'aphrodite',
  TABBY: 'tabby',
  KOBOLDCPP: 'koboldcpp',
  TOGETHERAI: 'togetherai',
  LLAMACPP: 'llamacpp',
  OLLAMA: 'ollama',
  INFERMATICAI: 'infermaticai',
  DREAMGEN: 'dreamgen',
  OPENROUTER: 'openrouter',
  FEATHERLESS: 'featherless',
  HUGGINGFACE: 'huggingface',
  GENERIC: 'generic',
} as const;
export type TextgenType = (typeof TEXTGEN_TYPES)[keyof typeof TEXTGEN_TYPES];

/** 支持远端分词的 Text Completion 后端（ST initTokenizers 里填充） */
export const TEXTGEN_TOKENIZERS: readonly TextgenType[] = [
  TEXTGEN_TYPES.OOBA,
  TEXTGEN_TYPES.TABBY,
  TEXTGEN_TYPES.KOBOLDCPP,
  TEXTGEN_TYPES.LLAMACPP,
  TEXTGEN_TYPES.VLLM,
  TEXTGEN_TYPES.APHRODITE,
];

/** 服务端 /api/tokenizers/<name>/… 的本地分词器名（与 Rust LOCAL_TOKENIZER_NAMES 一致） */
export type LocalTokenizerName =
  | 'gpt2'
  | 'openai'
  | 'llama'
  | 'nerdstash'
  | 'nerdstash_v2'
  | 'mistral'
  | 'yi'
  | 'claude'
  | 'llama3'
  | 'gemma'
  | 'jamba'
  | 'qwen2'
  | 'command-r'
  | 'command-a'
  | 'nemo'
  | 'deepseek';

/** TOKENIZER_URLS 的 type → 本地名映射；API_* 与 NONE/BEST_MATCH 没有对应条目 */
export const TOKENIZER_NAMES: Partial<Record<TokenizerType, LocalTokenizerName>> = {
  [TOKENIZERS.GPT2]: 'gpt2',
  [TOKENIZERS.OPENAI]: 'openai',
  [TOKENIZERS.LLAMA]: 'llama',
  [TOKENIZERS.NERD]: 'nerdstash',
  [TOKENIZERS.NERD2]: 'nerdstash_v2',
  [TOKENIZERS.MISTRAL]: 'mistral',
  [TOKENIZERS.YI]: 'yi',
  [TOKENIZERS.CLAUDE]: 'claude',
  [TOKENIZERS.LLAMA3]: 'llama3',
  [TOKENIZERS.GEMMA]: 'gemma',
  [TOKENIZERS.JAMBA]: 'jamba',
  [TOKENIZERS.QWEN2]: 'qwen2',
  [TOKENIZERS.COMMAND_R]: 'command-r',
  [TOKENIZERS.COMMAND_A]: 'command-a',
  [TOKENIZERS.NEMO]: 'nemo',
  [TOKENIZERS.DEEPSEEK]: 'deepseek',
};

/** 服务端 TEXT_COMPLETION_MODELS（原样透传给 tiktoken 的模型名） */
export const TEXT_COMPLETION_MODELS: readonly string[] = [
  'gpt-3.5-turbo-instruct',
  'gpt-3.5-turbo-instruct-0914',
  'text-davinci-003',
  'text-davinci-002',
  'text-davinci-001',
  'text-curie-001',
  'text-babbage-001',
  'text-ada-001',
  'code-davinci-002',
  'code-davinci-001',
  'code-cushman-002',
  'code-cushman-001',
  'text-davinci-edit-001',
  'code-davinci-edit-001',
  'text-embedding-ada-002',
  'text-similarity-davinci-001',
  'text-similarity-curie-001',
  'text-similarity-babbage-001',
  'text-similarity-ada-001',
  'text-search-davinci-doc-001',
  'text-search-curie-doc-001',
  'text-search-babbage-doc-001',
  'text-search-ada-doc-001',
  'code-search-babbage-code-001',
  'code-search-ada-code-001',
];
