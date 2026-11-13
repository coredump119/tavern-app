// ST openai.js 的 Message / MessageCollection / ChatCompletion（token 预算）与 TokenHandler 移植。媒体与工具调用暂不支持。
import type { ChatCompletionMessage } from './types.js';
import {
  AUDIO_FALLBACK_SECONDS,
  AUDIO_TOKENS_PER_SECOND,
  imageTokenCost,
  TOKENS_PER_IMAGE,
  VIDEO_FALLBACK_SECONDS,
  VIDEO_TOKENS_PER_SECOND,
  type InlineMediaDeps,
  type ResolvedMedia,
} from './media.js';

export class IdentifierNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Identifier ${identifier} not found.`);
    this.name = 'IdentifierNotFoundError';
  }
}
export class TokenBudgetExceededError extends Error {
  constructor(identifier = '') {
    super(`Token budged exceeded. Message: ${identifier}`);
    this.name = 'TokenBudgetExceeded';
  }
}
export class InvalidCharacterNameError extends Error {
  constructor(identifier = '') {
    super(`Invalid character name. Message: ${identifier}`);
    this.name = 'InvalidCharacterName';
  }
}

/** 计数回调：等价 tokenHandler.countTokenAsyncFn(messages, full) */
export type CountMessagesTokens = (
  messages: Record<string, unknown> | Record<string, unknown>[],
  full?: boolean,
) => Promise<number> | number;

/**
 * ST 服务端 /api/tokenizers/openai/count 的 tiktoken 计费方案：
 * 每条消息 +tokensPerMessage(3)，每个字段编码长度累加，有 name 再 +1，整次请求 +3；客户端非 full 时再 -2。
 */
export function createOpenAITokenCounter(
  countText: (text: string) => Promise<number> | number,
  { model = 'gpt-4' } = {},
): CountMessagesTokens {
  const legacy = model.includes('gpt-3.5-turbo-0301');
  const tokensPerName = legacy ? -1 : 1;
  const tokensPerMessage = legacy ? 4 : 3;
  return async (messages, full = false) => {
    const list = Array.isArray(messages) ? messages : [messages];
    let total = -1;
    for (const msg of list) {
      let num = tokensPerMessage;
      for (const [key, value] of Object.entries(msg)) {
        if (value === undefined || value === null) continue;
        num += await countText(typeof value === 'string' ? value : JSON.stringify(value));
        if (key === 'name') num += tokensPerName;
      }
      num += 3;
      if (legacy) num += 9;
      total += num;
    }
    if (!full) total -= 2;
    return total;
  };
}

export class TokenHandler {
  counts: Record<string, number> = {
    start_chat: 0,
    prompt: 0,
    bias: 0,
    nudge: 0,
    jailbreak: 0,
    impersonate: 0,
    examples: 0,
    conversation: 0,
  };
  readonly #count: CountMessagesTokens;
  constructor(countFn: CountMessagesTokens) {
    this.#count = countFn;
  }
  resetCounts(): void {
    for (const k of Object.keys(this.counts)) this.counts[k] = 0;
  }
  async countAsync(
    messages: Record<string, unknown> | Record<string, unknown>[],
    full?: boolean,
    type?: string,
  ): Promise<number> {
    const n = await this.#count(messages, full);
    if (type) this.counts[type] = (this.counts[type] ?? 0) + n;
    return n;
  }
  getTotal(): number {
    return Object.values(this.counts).reduce((a, b) => a + (isNaN(b) ? 0 : b), 0);
  }
}

/** ST `ToolInvocation` as stored in `extra.tool_invocations`: one call the model made and its result */
export interface ToolInvocation {
  id: string;
  name: string;
  /** the arguments as the model sent them (a JSON string) */
  parameters: string;
  result: string;
}

export class Message {
  static tokensPerImage = 85;
  tokens = 0;
  identifier: string;
  role: string;
  content: string | unknown[];
  name: string | undefined;
  tool_calls: unknown[] | null = null;
  signature: string | null = null;
  reasoning: string | null = null;

  private constructor(
    role: string | undefined,
    content: string | unknown[] | undefined,
    identifier: string,
  ) {
    this.identifier = identifier;
    this.role = role || 'system';
    this.content = content as string | unknown[];
  }

  static async createAsync(
    tokenHandler: TokenHandler,
    role: string | undefined,
    content: string | undefined,
    identifier: string,
  ): Promise<Message> {
    const message = new Message(role, content, identifier);
    if (typeof message.content === 'string' && message.content.length > 0) {
      message.tokens = await tokenHandler.countAsync({
        role: message.role,
        content: message.content,
      });
    }
    return message;
  }

  static fromPromptAsync(
    tokenHandler: TokenHandler,
    prompt: { role?: string | undefined; content?: string | undefined; identifier: string },
  ): Promise<Message> {
    return Message.createAsync(tokenHandler, prompt.role, prompt.content, prompt.identifier);
  }

  /** ST `ensureContentIsArray`: a string body becomes `[{ type: 'text', text }]`. */
  ensureContentIsArray(): unknown[] {
    const textContent = this.content;
    if (!Array.isArray(this.content)) {
      this.content = [];
      if (typeof textContent === 'string') this.content.push({ type: 'text', text: textContent });
    }
    return this.content;
  }

  private static async resolve(
    inline: InlineMediaDeps,
    url: string,
    kind: 'image' | 'video' | 'audio',
  ): Promise<ResolvedMedia | null> {
    try {
      return await inline.resolve(url, kind);
    } catch {
      return null;
    }
  }

  /**
   * ST `Message.addImage`: append an `image_url` part (data URL) and add its token cost. The host
   * resolves and compresses the file (DEV_NOTES §9.30); a null resolution skips the image silently.
   */
  async addImage(inline: InlineMediaDeps, url: string): Promise<void> {
    const resolved = await Message.resolve(inline, url, 'image');
    if (!resolved) return;
    this.ensureContentIsArray().push({
      type: 'image_url',
      image_url: { url: resolved.dataUrl, detail: inline.quality },
    });
    try {
      this.tokens += imageTokenCost(resolved.width ?? 0, resolved.height ?? 0, inline.quality);
    } catch {
      this.tokens += TOKENS_PER_IMAGE;
    }
  }

  /** ST `Message.addVideo`: `video_url` part, 263 tokens per second (40 s when unknown). */
  async addVideo(inline: InlineMediaDeps, url: string): Promise<void> {
    const resolved = await Message.resolve(inline, url, 'video');
    if (!resolved) return;
    this.ensureContentIsArray().push({
      type: 'video_url',
      video_url: { url: resolved.dataUrl, detail: inline.quality },
    });
    const d = resolved.duration;
    this.tokens +=
      typeof d === 'number' && d > 0
        ? VIDEO_TOKENS_PER_SECOND * Math.ceil(d)
        : VIDEO_TOKENS_PER_SECOND * VIDEO_FALLBACK_SECONDS;
  }

  /** ST `Message.addAudio`: `audio_url` part, 32 tokens per second (300 s when unknown). */
  async addAudio(inline: InlineMediaDeps, url: string): Promise<void> {
    const resolved = await Message.resolve(inline, url, 'audio');
    if (!resolved) return;
    this.ensureContentIsArray().push({ type: 'audio_url', audio_url: { url: resolved.dataUrl } });
    const d = resolved.duration;
    this.tokens +=
      typeof d === 'number' && d > 0
        ? AUDIO_TOKENS_PER_SECOND * Math.ceil(d)
        : AUDIO_TOKENS_PER_SECOND * AUDIO_FALLBACK_SECONDS;
  }

  /** ST `Message.setToolCalls` (no signatures, no tool reasoning: DEV_NOTES §9.34 第 8 轮) */
  async setToolCalls(
    tokenHandler: TokenHandler,
    invocations: readonly ToolInvocation[],
  ): Promise<void> {
    this.tool_calls = invocations.map((i) => ({
      id: i.id,
      type: 'function',
      function: { arguments: i.parameters, name: i.name },
    }));
    this.tokens = await tokenHandler.countAsync({
      role: this.role,
      tool_calls: JSON.stringify(this.tool_calls),
    });
  }

  async setName(tokenHandler: TokenHandler, name: string): Promise<void> {
    this.name = name;
    this.tokens = await tokenHandler.countAsync({
      role: this.role,
      content: this.content,
      name: this.name,
    });
  }

  getTokens(): number {
    return this.tokens;
  }
}

export class MessageCollection {
  collection: (Message | MessageCollection)[] = [];
  identifier: string;
  constructor(identifier: string, ...items: (Message | MessageCollection)[]) {
    for (const item of items) {
      if (!(item instanceof Message || item instanceof MessageCollection))
        throw new Error(
          'Only Message and MessageCollection instances can be added to MessageCollection',
        );
    }
    this.collection.push(...items);
    this.identifier = identifier;
  }
  getChat(): ChatCompletionMessage[] {
    const acc: ChatCompletionMessage[] = [];
    for (const message of this.flatten()) {
      if (message.content || message.tool_calls) acc.push(toChatMessage(message));
    }
    return acc;
  }
  add(item: Message | MessageCollection): void {
    this.collection.push(item);
  }
  getItemByIdentifier(identifier: string): Message | MessageCollection | undefined {
    return this.collection.find((item) => item?.identifier === identifier);
  }
  hasItemWithIdentifier(identifier: string): boolean {
    return this.collection.some((m) => m?.identifier === identifier);
  }
  getTokens(): number {
    return this.collection.reduce((t, m) => t + m.getTokens(), 0);
  }
  flatten(): Message[] {
    // ST 用 reduce，稀疏数组（add 到超出长度的 index）里的空洞会被跳过
    return this.collection.reduce<Message[]>((acc, m) => {
      if (m instanceof MessageCollection) acc.push(...m.flatten());
      else if (m) acc.push(m);
      return acc;
    }, []);
  }
}

function toChatMessage(item: Message): ChatCompletionMessage {
  return {
    role: item.role,
    content: item.content,
    ...(item.name ? { name: item.name } : {}),
    ...(item.tool_calls ? { tool_calls: item.tool_calls } : {}),
    ...(item.role === 'tool' ? { tool_call_id: item.identifier } : {}),
    ...(item.signature ? { signature: item.signature } : {}),
    ...(item.reasoning ? { reasoning: item.reasoning } : {}),
  };
}

export class ChatCompletion {
  tokenBudget = 0;
  messages = new MessageCollection('root');
  overriddenPrompts: string[] = [];
  readonly #log: ((message: string) => void) | undefined;

  constructor(log?: (message: string) => void) {
    this.#log = log;
  }

  log(output: string): void {
    this.#log?.('[ChatCompletion] ' + output);
  }

  async squashSystemMessages(tokenHandler: TokenHandler): Promise<void> {
    const excludeList = ['newMainChat', 'newChat', 'groupNudge'];
    const flat = this.messages.flatten();
    let lastMessage: Message | null = null;
    const squashed: Message[] = [];
    const shouldSquash = (m: Message) =>
      !excludeList.includes(m.identifier) && m.role === 'system' && !m.name;
    for (const message of flat) {
      if (message.role === 'system' && !message.content) continue;
      if (shouldSquash(message)) {
        if (lastMessage && shouldSquash(lastMessage)) {
          lastMessage.content = `${String(lastMessage.content)}\n${String(message.content)}`;
          lastMessage.tokens = await tokenHandler.countAsync({
            role: lastMessage.role,
            content: lastMessage.content,
          });
        } else {
          squashed.push(message);
          lastMessage = message;
        }
      } else {
        squashed.push(message);
        lastMessage = message;
      }
    }
    this.messages.collection = squashed;
  }

  setTokenBudget(context: number, response: number): void {
    this.tokenBudget = context - response;
    this.log(`Token budget: ${this.tokenBudget}`);
  }

  add(collection: MessageCollection, position: number | null = null): this {
    if (!(collection instanceof MessageCollection))
      throw new Error('Argument must be an instance of MessageCollection');
    this.checkTokenBudget(collection, collection.identifier);
    if (position !== null && position !== -1) this.messages.collection[position] = collection;
    else this.messages.collection.push(collection);
    this.decreaseTokenBudgetBy(collection.getTokens());
    this.log(`Added ${collection.identifier}. Remaining tokens: ${this.tokenBudget}`);
    return this;
  }

  insertAtStart(message: Message, identifier: string): void {
    this.insert(message, identifier, 'start');
  }
  insertAtEnd(message: Message, identifier: string): void {
    this.insert(message, identifier, 'end');
  }
  insert(message: Message, identifier: string, position: string | number = 'end'): void {
    if (!(message instanceof Message)) throw new Error('Argument must be an instance of Message');
    this.checkTokenBudget(message, message.identifier);
    const index = this.findMessageIndex(identifier);
    const target = this.messages.collection[index] as MessageCollection;
    if (message.content || message.tool_calls) {
      if (position === 'start') target.collection.unshift(message);
      else if (position === 'end') target.collection.push(message);
      else if (typeof position === 'number') target.collection.splice(position, 0, message);
      this.decreaseTokenBudgetBy(message.getTokens());
      this.log(
        `Inserted ${message.identifier} into ${identifier}. Remaining tokens: ${this.tokenBudget}`,
      );
    }
  }

  removeLastFrom(identifier: string): void {
    const index = this.findMessageIndex(identifier);
    const message = (this.messages.collection[index] as MessageCollection).collection.pop();
    if (!message) return;
    this.increaseTokenBudgetBy(message.getTokens());
  }

  canAfford(message: Message | MessageCollection): boolean {
    return 0 <= this.tokenBudget - message.getTokens();
  }
  canAffordAll(messages: Message[]): boolean {
    return 0 <= this.tokenBudget - messages.reduce((t, m) => t + m.getTokens(), 0);
  }
  has(identifier: string): boolean {
    return this.messages.hasItemWithIdentifier(identifier);
  }
  getTotalTokenCount(): number {
    return this.messages.getTokens();
  }

  getChat(): ChatCompletionMessage[] {
    const chat: ChatCompletionMessage[] = [];
    for (const item of this.messages.collection) {
      if (item instanceof MessageCollection) chat.push(...item.getChat());
      else if (item instanceof Message && (item.content || item.tool_calls))
        chat.push(toChatMessage(item));
      else this.log(`Skipping invalid or empty message in collection: ${JSON.stringify(item)}`);
    }
    return chat;
  }

  checkTokenBudget(message: Message | MessageCollection, identifier: string): void {
    if (!this.canAfford(message)) throw new TokenBudgetExceededError(identifier);
  }
  reserveBudget(message: Message | MessageCollection | number): void {
    this.decreaseTokenBudgetBy(typeof message === 'number' ? message : message.getTokens());
  }
  freeBudget(message: Message | MessageCollection): void {
    this.increaseTokenBudgetBy(message.getTokens());
  }
  increaseTokenBudgetBy(tokens: number): void {
    this.tokenBudget += tokens;
  }
  decreaseTokenBudgetBy(tokens: number): void {
    this.tokenBudget -= tokens;
  }
  findMessageIndex(identifier: string): number {
    const index = this.messages.collection.findIndex((item) => item?.identifier === identifier);
    if (index < 0) throw new IdentifierNotFoundError(identifier);
    return index;
  }
  setOverriddenPrompts(list: string[]): void {
    this.overriddenPrompts = list;
  }
  getOverriddenPrompts(): string[] {
    return this.overriddenPrompts ?? [];
  }
}
