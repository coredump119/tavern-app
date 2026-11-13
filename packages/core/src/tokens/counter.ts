/**
 * ST getTokenCountAsync / countTokensOpenAIAsync 的宿主无关实现。
 * 真正的计数由 TokenizerBackend 提供（App 侧用 Rust 命令，测试用假后端）。
 */
import { getStringHash } from '../util/hash.js';
import { getTokenizerBestMatch, type BestMatchInput } from './best-match.js';
import { guesstimate } from './guesstimate.js';
import {
  TOKENIZERS,
  TOKENIZER_NAMES,
  type LocalTokenizerName,
  type TokenizerType,
} from './types.js';

export interface TokenizerBackend {
  /** `/api/tokenizers/<name>/encode` 的 count；`openai` 需要 model */
  count(name: LocalTokenizerName, text: string, model?: string): Promise<number> | number;
  /** `/api/tokenizers/openai/count?model=`（服务端口径） */
  countOpenAI(model: string, messages: Record<string, unknown>[]): Promise<number> | number;
  /** `/api/tokenizers/remote/kobold/count` */
  countKobold?: ((text: string) => Promise<number> | number) | undefined;
  /** `/api/tokenizers/remote/textgenerationwebui/encode` 的 count */
  countTextgen?: ((text: string) => Promise<number> | number) | undefined;
}

export interface TokenCounterConfig {
  /** power_user.tokenizer */
  tokenizer: TokenizerType;
  /** power_user.token_padding */
  tokenPadding: number;
  /** main_api */
  mainApi: string;
  /** getTokenizerModel() 的结果（CC 用） */
  openaiModel: string;
  /** getTokenizerBestMatch 的输入（BEST_MATCH 时用） */
  bestMatch: BestMatchInput;
  /** API_TEXTGENERATIONWEBUI 缓存键里的模型哈希来源：getTextGenModel() || online_status */
  textgenModelKey?: string | undefined;
  /** 后端报错时的回退（ST apiFailureTokenCount → guesstimate）；默认 guesstimate */
  onFailure?: ((text: string, error: unknown) => number) | undefined;
}

export interface TokenCounter {
  /** getTokenCountAsync(str, padding) */
  countText(text: string, padding?: number): Promise<number>;
  /** countTokensOpenAIAsync(messages, full) */
  countOpenAIMessages(
    messages: Record<string, unknown> | Record<string, unknown>[],
    full?: boolean,
  ): Promise<number>;
  /** 当前实际使用的分词器类型（BEST_MATCH 已解析） */
  resolveTokenizer(): TokenizerType;
  /** 清空缓存（ST resetTokenCache） */
  resetCache(): void;
  readonly cache: Map<string, number>;
}

export function createTokenCounter(
  backend: TokenizerBackend,
  config: TokenCounterConfig,
): TokenCounter {
  const cache = new Map<string, number>();
  const onFailure = config.onFailure ?? ((text) => guesstimate(text));

  const resolveTokenizer = (): TokenizerType =>
    config.tokenizer === TOKENIZERS.BEST_MATCH
      ? getTokenizerBestMatch(config.bestMatch)
      : config.tokenizer;

  const currentRemoteTokenizerAPI = (): TokenizerType => {
    switch (config.mainApi) {
      case 'kobold':
        return TOKENIZERS.API_KOBOLD;
      case 'textgenerationwebui':
        return TOKENIZERS.API_TEXTGENERATIONWEBUI;
      default:
        return TOKENIZERS.NONE;
    }
  };

  const callTokenizer = async (type: TokenizerType, str: string): Promise<number> => {
    if (type === TOKENIZERS.NONE) return guesstimate(str);
    try {
      switch (type) {
        case TOKENIZERS.API_CURRENT:
          return await callTokenizer(currentRemoteTokenizerAPI(), str);
        case TOKENIZERS.API_KOBOLD:
          if (!backend.countKobold)
            return onFailure(str, new Error('kobold tokenizer unavailable'));
          return await backend.countKobold(str);
        case TOKENIZERS.API_TEXTGENERATIONWEBUI:
          if (!backend.countTextgen)
            return onFailure(str, new Error('textgen tokenizer unavailable'));
          return await backend.countTextgen(str);
        default: {
          const name = TOKENIZER_NAMES[type];
          if (!name) return onFailure(str, new Error(`Unknown tokenizer type ${type}`));
          return await backend.count(name, str, name === 'openai' ? config.openaiModel : undefined);
        }
      }
    } catch (error) {
      return onFailure(str, error);
    }
  };

  const countOpenAIMessages: TokenCounter['countOpenAIMessages'] = async (
    messages,
    full = false,
  ) => {
    const list = Array.isArray(messages) ? messages : [messages];
    const model = config.openaiModel;
    let tokenCount = -1;
    for (const message of list) {
      if (model === 'claude') full = true;
      const hash = getStringHash(JSON.stringify(message));
      const cacheKey = `${model}-${hash}`;
      const cached = cache.get(cacheKey);
      if (typeof cached === 'number') {
        tokenCount += cached;
      } else {
        const n = Number(await backend.countOpenAI(model, [message]));
        tokenCount += n;
        cache.set(cacheKey, n);
      }
    }
    if (!full) tokenCount -= 2;
    return tokenCount;
  };

  const countText: TokenCounter['countText'] = async (str, padding) => {
    if (typeof str !== 'string' || !str.length) return 0;

    let tokenizerType = config.tokenizer;
    let modelHash = '';

    if (config.mainApi === 'openai') {
      if (padding === config.tokenPadding) {
        // 主 "shadow" 提示词组装：用字节估算
        tokenizerType = TOKENIZERS.NONE;
      } else {
        // 扩展与世界书：走 OpenAI 计数（system 消息，full=true）
        return countOpenAIMessages({ role: 'system', content: str }, true);
      }
    }

    if (tokenizerType === TOKENIZERS.BEST_MATCH) {
      tokenizerType = getTokenizerBestMatch(config.bestMatch);
    }
    if (tokenizerType === TOKENIZERS.API_TEXTGENERATIONWEBUI) {
      modelHash = getStringHash(config.textgenModelKey ?? '').toString();
    }
    padding ??= 0;

    const hash = getStringHash(str);
    const cacheKey = `${tokenizerType}-${hash}${modelHash}+${padding}`;
    const cached = cache.get(cacheKey);
    if (typeof cached === 'number') return cached;

    const result = (await callTokenizer(tokenizerType, str)) + padding;
    if (Number.isNaN(result)) return 0;
    cache.set(cacheKey, result);
    return result;
  };

  return {
    countText,
    countOpenAIMessages,
    resolveTokenizer,
    resetCache: () => cache.clear(),
    cache,
  };
}

/** 永远用字节估算的后端（无 Rust 时的浏览器回退） */
export const estimateBackend: TokenizerBackend = {
  count: (_name, text) => guesstimate(text),
  countOpenAI: (_model, messages) => {
    // 近似服务端 tiktoken 口径：每条 3 + Σ字段 + name 1，整次 +3
    let n = 3;
    for (const m of messages) {
      n += 3;
      for (const [k, v] of Object.entries(m)) {
        if (v === undefined || v === null) continue;
        n += guesstimate(typeof v === 'string' ? v : JSON.stringify(v));
        if (k === 'name') n += 1;
      }
    }
    return n;
  },
};
