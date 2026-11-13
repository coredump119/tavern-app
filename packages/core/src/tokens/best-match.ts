/**
 * ST tokenizers.getTokenizerBestMatch(forApi) 的纯函数版：所有全局状态都从 input 读。
 */
import {
  TEXTGEN_TOKENIZERS,
  TEXTGEN_TYPES,
  TOKENIZERS,
  type TextgenType,
  type TokenizerType,
} from './types.js';

export interface BestMatchInput {
  /** main_api */
  api: string;
  /** nai_settings.model_novel */
  novelModel?: string | undefined;
  /** textgenerationwebui_settings.type */
  textgenType?: TextgenType | string | undefined;
  /** getTextGenModel()（已选模型名） */
  textgenModel?: string | undefined;
  /** online_status；'no_connection' 表示未连接 */
  onlineStatus?: string | undefined;
  /** sessionStorage[TOKENIZER_WARNING_KEY] 是否存在 */
  hasTokenizerError?: boolean | undefined;
  /** sessionStorage[TOKENIZER_SUPPORTED_KEY] 是否存在（OOBA 需要通过端点探测） */
  hasValidEndpoint?: boolean | undefined;
  /** kai_flags.can_use_tokenization */
  koboldCanTokenize?: boolean | undefined;
  /** getCurrentOpenRouterModelTokenizer() */
  openRouterTokenizer?: TokenizerType | undefined;
  /** getCurrentDreamGenModelTokenizer() */
  dreamGenTokenizer?: TokenizerType | undefined;
}

export function getTokenizerBestMatch(input: BestMatchInput): TokenizerType {
  const forApi = input.api;

  if (forApi === 'novel') {
    const novel = input.novelModel ?? '';
    if (novel.includes('clio')) return TOKENIZERS.NERD;
    if (novel.includes('kayra')) return TOKENIZERS.NERD2;
    if (novel.includes('erato')) return TOKENIZERS.LLAMA3;
  }
  if (forApi === 'kobold' || forApi === 'textgenerationwebui' || forApi === 'koboldhorde') {
    const type = input.textgenType;
    const isConnected = input.onlineStatus !== 'no_connection';
    const isTokenizerSupported =
      TEXTGEN_TOKENIZERS.includes(type as TextgenType) &&
      (type !== TEXTGEN_TYPES.OOBA || !!input.hasValidEndpoint);

    if (!input.hasTokenizerError && isConnected) {
      if (forApi === 'kobold' && input.koboldCanTokenize) return TOKENIZERS.API_KOBOLD;
      if (forApi === 'textgenerationwebui' && isTokenizerSupported) {
        return TOKENIZERS.API_TEXTGENERATIONWEBUI;
      }
      if (forApi === 'textgenerationwebui' && type === TEXTGEN_TYPES.OPENROUTER) {
        return input.openRouterTokenizer ?? TOKENIZERS.LLAMA;
      }
      if (forApi === 'textgenerationwebui' && type === TEXTGEN_TYPES.DREAMGEN) {
        return input.dreamGenTokenizer ?? TOKENIZERS.LLAMA;
      }
    }

    if (forApi === 'textgenerationwebui') {
      const model = String(input.textgenModel || input.onlineStatus || '').toLowerCase();
      if (model.includes('llama3') || model.includes('llama-3')) return TOKENIZERS.LLAMA3;
      if (model.includes('mistral') || model.includes('mixtral')) return TOKENIZERS.MISTRAL;
      if (model.includes('gemma')) return TOKENIZERS.GEMMA;
      if (model.includes('nemo') || model.includes('pixtral')) return TOKENIZERS.NEMO;
      if (model.includes('deepseek')) return TOKENIZERS.DEEPSEEK;
      if (model.includes('yi')) return TOKENIZERS.YI;
      if (model.includes('jamba')) return TOKENIZERS.JAMBA;
      if (model.includes('command-r')) return TOKENIZERS.COMMAND_R;
      if (model.includes('command-a')) return TOKENIZERS.COMMAND_A;
      if (model.includes('qwen2')) return TOKENIZERS.QWEN2;
    }

    return TOKENIZERS.LLAMA;
  }

  return TOKENIZERS.NONE;
}
