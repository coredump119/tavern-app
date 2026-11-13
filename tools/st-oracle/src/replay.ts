/** 用 @tm/core 回放同一场景，产出与 ST 服务端发给上游完全相同的请求体字符串。 */
import { encoding_for_model, get_encoding, type Tiktoken, type TiktokenModel } from 'tiktoken';
import {
  MacroEngine,
  RegexEngine,
  TOKENIZERS,
  buildChatCompletionPrompt,
  buildUpstreamRequest,
  convertClaudePrompt,
  getChatCompletionModel,
  getTokenizerModel,
  collectLore,
  createApplyRegex,
  createCapturingLogger,
  createGenerationParameters,
  createTokenCounter,
  createVariableScopes,
  extractMessageBias,
  getCustomStoppingStrings,
  getGroupNames,
  getSortedEntries,
  removeMacros,
  resolveServerTokenizerModel,
  serializeRequestBody,
  OPENAI_MAX_STOP_STRINGS,
  DEFAULT_WORLD_INFO_SETTINGS,
  type ChatCompletionPipelineDeps,
  type ChatCompletionSettings,
  type ChatMessageLike,
  type CharacterLike,
  type CoreState,
  type GenerationSettings,
  type RegexScript,
  type TokenizerBackend,
  type WIBook,
  type WorldInfoSettings,
} from '@tm/core';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { locateSillyTavern } from './locate.js';
import type { Materialized } from './materialize.js';

const encoders = new Map<string, Tiktoken>();

/** ST 服务端的 Claude 分词器：同一份 @agnai/web-tokenizers + src/tokenizers/claude.json（来自 ST 目录） */
type WebTok = { encode: (text: string) => ArrayLike<number> };
let claudeTok: Promise<WebTok> | undefined;
function claudeTokenizer(stDir: string): Promise<WebTok> {
  claudeTok ??= (async () => {
    const req = createRequire(join(stDir, 'package.json'));
    const mod = req('@agnai/web-tokenizers') as {
      Tokenizer: { fromJSON: (buf: Uint8Array) => Promise<WebTok> };
    };
    const buf = await readFile(join(stDir, 'src', 'tokenizers', 'claude.json'));
    return mod.Tokenizer.fromJSON(new Uint8Array(buf));
  })();
  return claudeTok;
}
function encoder(serverModel: string): Tiktoken {
  let e = encoders.get(serverModel);
  if (!e) {
    try {
      e = encoding_for_model(serverModel as TiktokenModel);
    } catch {
      // 非 tiktoken 模型（gemma / mistral / deepseek…）：ST 走 sentencepiece / web-tokenizer；场景不触发裁剪时计数无关，用 cl100k 兜底
      e = get_encoding('cl100k_base');
    }
    encoders.set(serverModel, e);
  }
  return e;
}

/** ST 服务端 /api/tokenizers 的 tiktoken 口径（与 crates/tm-tokenizers 同一套规则） */
export function stTokenizerBackend(stDir: string): TokenizerBackend {
  return {
    count: (_name, text, model) =>
      encoder(resolveServerTokenizerModel(model ?? 'gpt-3.5-turbo')).encode(text).length,
    countOpenAI: async (queryModel, messages) => {
      const model = resolveServerTokenizerModel(queryModel);
      if (model === 'claude') {
        // countWebTokenizerTokens：旧文本格式拼接后数 token（convertClaudePrompt 会改写入参，传副本）
        const text = convertClaudePrompt(
          structuredClone(messages) as Array<
            Record<string, unknown> & { role: string; content: unknown }
          >,
        );
        const tok = await claudeTokenizer(stDir);
        return tok.encode(text).length;
      }
      return countTiktokenMessages(queryModel, messages);
    },
  };
}

function countTiktokenMessages(queryModel: string, messages: Record<string, unknown>[]): number {
  {
    const model = resolveServerTokenizerModel(queryModel);
    const legacy = queryModel.includes('gpt-3.5-turbo-0301');
    const tokensPerName = legacy ? -1 : 1;
    const tokensPerMessage = legacy ? 4 : 3;
    const enc = encoder(model);
    let n = 0;
    for (const msg of messages) {
      try {
        n += tokensPerMessage;
        for (const [key, value] of Object.entries(msg)) {
          if (typeof value !== 'string') throw new Error('non-string field');
          n += enc.encode(value).length;
          if (key === 'name') n += tokensPerName;
        }
      } catch {
        /* ST 服务端：warn 并跳过该条剩余字段 */
      }
    }
    n += 3;
    if (legacy) n += 9;
    return n;
  }
}

export interface ReplayResult {
  body: string;
  requestBody: Record<string, unknown>;
  chat: unknown[];
  error: Error | null;
  warnings: string[];
}

export interface ReplayOptions {
  /** ST 目录（Claude 分词器来源）；缺省 locate */
  stDir?: string | undefined;
}

export async function replay(m: Materialized, options: ReplayOptions = {}): Promise<ReplayResult> {
  const sc = m.scenario;
  const type = sc.type ?? 'normal';
  const settings = m.settings;
  const pu = settings['power_user'] as Record<string, unknown>;
  const oai = settings['oai_settings'] as Record<string, unknown>;
  const ext = settings['extension_settings'] as Record<string, unknown>;
  const wiRaw = settings['world_info_settings'] as Record<string, unknown>;

  const logs: never[] = [];
  const engine = new MacroEngine({ logger: createCapturingLogger(logs) });

  const { _avatar, ...cardRest } = m.card;
  const character = { ...cardRest, avatar: String(_avatar) } as unknown as CharacterLike;
  const chat: ChatMessageLike[] = structuredClone(m.messages) as ChatMessageLike[];
  const chatMetadata = structuredClone(m.chatMetadata);

  const state: CoreState = {
    userName: m.userName,
    charName: character.name,
    characters: [character],
    characterId: 0,
    groups: [],
    selectedGroup: null,
    chat,
    chatMetadata,
    variables: createVariableScopes(chatMetadata, {}),
    mainApi: 'openai',
    model: String(oai['openai_model']),
    powerUser: {
      ...(pu as object),
      instruct: pu['instruct'] as CoreState['powerUser']['instruct'],
      sysprompt: pu['sysprompt'] as CoreState['powerUser']['sysprompt'],
      context: pu['context'] as CoreState['powerUser']['context'],
      prefer_character_prompt: !!pu['prefer_character_prompt'],
      prefer_character_jailbreak: !!pu['prefer_character_jailbreak'],
      collapse_newlines: !!pu['collapse_newlines'],
      persona_description: String(pu['persona_description'] ?? ''),
    } as CoreState['powerUser'],
    tokens: {
      maxContext: () => Number(oai['openai_max_context']),
      maxResponse: () => Number(oai['openai_max_tokens']),
      maxPrompt: () => Number(oai['openai_max_context']) - Number(oai['openai_max_tokens']),
    },
    extensionPrompts: {},
    isMobile: false,
    lastGenerationType: '',
    input: '',
    firstDisplayedMessageId: null,
    bannedWords: [],
  };
  const sub = (t: string) => engine.substituteParams(t, state);

  // 正则脚本（全局）
  const regexScripts = (ext['regex'] as RegexScript[] | undefined) ?? [];
  const regexEngine = new RegexEngine({
    substitute: (t, opts) => engine.substituteParams(t, state, opts),
    sources: () => ({ global: regexScripts, preset: [], scoped: [], extensionDisabled: false }),
  });
  const applyRegex = createApplyRegex(regexEngine);

  // 模拟 Generate() 里的 sendMessageAsUser
  let textareaText = '';
  if (type !== 'regenerate' && type !== 'swipe' && type !== 'impersonate' && type !== 'quiet')
    textareaText = sc.input;
  const pushUser = (text: string, bias: string) => {
    let mes = sub(applyRegex(text, 'user', { isPrompt: false, depth: null }));
    const extra: Record<string, unknown> = { isSmallSys: false };
    if (bias) {
      extra['bias'] = bias;
      mes = removeMacros(mes);
    }
    chat.push({
      name: m.userName,
      is_user: true,
      is_system: false,
      send_date: new Date().toISOString(),
      mes,
      extra,
    });
  };
  const messageBias = sub(extractMessageBias(textareaText));
  if (textareaText !== '') {
    if (!(messageBias && !removeMacros(textareaText))) pushUser(textareaText, messageBias);
  } else if (type === 'normal' && String(oai['send_if_empty'] ?? '').trim().length > 0) {
    pushUser(String(oai['send_if_empty']).trim(), messageBias);
  }

  // 世界书
  const wiSettings: WorldInfoSettings = {
    ...DEFAULT_WORLD_INFO_SETTINGS,
    ...(wiRaw as Partial<WorldInfoSettings>),
  };
  const globalBooks = (
    (wiRaw['world_info'] as { globalSelect?: string[] })?.globalSelect ?? []
  ).filter((n) => n in m.worlds);
  const loadBook = (name: string): WIBook | undefined =>
    m.worlds[name] as unknown as WIBook | undefined;
  const lore = collectLore(
    {
      globalBooks,
      characterBook: (character.data?.extensions?.['world'] as string | undefined) || null,
    },
    loadBook,
  );
  const sortedEntries = getSortedEntries(lore, Number(wiSettings.world_info_character_strategy));

  // 分词：ST 前端 getTokenCountAsync / countTokensOpenAIAsync 语义
  const stDir = options.stDir ?? locateSillyTavern() ?? '';
  const ccSource = String(oai['chat_completion_source']);
  const ccModel = getChatCompletionModel(oai as unknown as GenerationSettings);
  const clientTokenizerModel = getTokenizerModel({
    mainApi: 'openai',
    source: ccSource,
    openaiModel: String(oai['openai_model'] ?? ''),
    customModel: String(oai['custom_model'] ?? ''),
  });
  const counter = createTokenCounter(stTokenizerBackend(stDir), {
    tokenizer: Number(pu['tokenizer'] ?? TOKENIZERS.BEST_MATCH) as 99,
    tokenPadding: Number(pu['token_padding'] ?? 64),
    mainApi: 'openai',
    openaiModel: clientTokenizerModel,
    bestMatch: { api: 'openai' },
  });

  const ccSettings = oai as unknown as ChatCompletionSettings & GenerationSettings;
  const deps: ChatCompletionPipelineDeps = {
    engine,
    settings: ccSettings,
    countText: (t) => counter.countText(t),
    countMessages: (msgs, full) =>
      counter.countOpenAIMessages(msgs as Record<string, unknown>[], full),
    tokenizerModel: resolveServerTokenizerModel(clientTokenizerModel),
    worldInfo: { settings: wiSettings, sortedEntries, random: () => 0.5 },
    note: (ext['note'] as ChatCompletionPipelineDeps['note']) ?? { allowWIScan: false },
    powerUser: {
      persona_description: String(pu['persona_description'] ?? ''),
      persona_description_position: Number(pu['persona_description_position'] ?? 0),
      persona_description_role: Number(pu['persona_description_role'] ?? 0),
      persona_description_depth: Number(pu['persona_description_depth'] ?? 2),
      pin_examples: !!pu['pin_examples'],
      strip_examples: !!pu['strip_examples'],
      user_prompt_bias: String(pu['user_prompt_bias'] ?? ''),
      reasoning: pu['reasoning'] as ChatCompletionPipelineDeps['powerUser']['reasoning'],
    },
    applyRegex,
  };

  const result = await buildChatCompletionPrompt(state, deps, {
    type,
    textareaText,
    quietPrompt: sc.quietPrompt,
  });

  const { generate_data } = createGenerationParameters({
    settings: ccSettings,
    model: ccModel,
    type,
    messages: result.chat,
    userName: state.userName,
    charName: state.charName,
    groupNames: getGroupNames(state),
    customStoppingStrings: getCustomStoppingStrings(state, (t) => sub(t), {
      limit: OPENAI_MAX_STOP_STRINGS,
    }),
    requestTokenProbabilities: !!pu['request_token_probabilities'],
    allCustomStoppingStrings: getCustomStoppingStrings(state, (t) => sub(t)),
    substitute: (t) => sub(t),
  });
  const requestBody = buildUpstreamRequest(generate_data).body;
  return {
    body: serializeRequestBody(requestBody),
    requestBody,
    chat: result.chat,
    error: result.error,
    warnings: (logs as Array<{ message?: string }>).map((l) => String(l.message ?? l)),
  };
}
