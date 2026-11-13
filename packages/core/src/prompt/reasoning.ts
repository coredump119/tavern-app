import { escapeRegex } from '../util/regex.js';
// ST reasoning.js PromptReasoning：把历史消息的推理块按设置拼回消息正文。
export interface ReasoningSettings {
  add_to_prompts: boolean;
  prefix: string;
  suffix: string;
  separator: string;
  max_additions: number;
  [key: string]: unknown;
}

export const DEFAULT_REASONING_SETTINGS: ReasoningSettings = {
  add_to_prompts: false,
  prefix: '<think>',
  suffix: '</think>',
  separator: '\n',
  max_additions: 1,
};
export const REASONING_PLACEHOLDER = '​';

/** ST reasoning.js ReasoningType */
export const REASONING_TYPE = {
  MODEL: 'model',
  PARSED: 'parsed',
  MANUAL: 'manual',
  EDITED: 'edited',
} as const;

export interface ParsedReasoning {
  reasoning: string;
  content: string;
}

/**
 * ST parseReasoningFromString：按 prefix/suffix 从消息里切出推理块。
 * `strict` 要求推理块在开头（允许前导空白）；`trimSpaces` 对应 power_user.trim_spaces。
 * prefix 或 suffix 为空、或没匹配到时返回 null / 原文。
 */
export function parseReasoningFromString(
  str: string,
  template: Pick<ReasoningSettings, 'prefix' | 'suffix'>,
  { strict = true, trimSpaces = true }: { strict?: boolean; trimSpaces?: boolean } = {},
): ParsedReasoning | null {
  if (!template.prefix || !template.suffix) return null;
  const regex = new RegExp(
    `${strict ? '^\\s*?' : ''}${escapeRegex(template.prefix)}(.*?)${escapeRegex(template.suffix)}`,
    's',
  );
  let didReplace = false;
  let reasoning = '';
  let content = String(str).replace(regex, (_match, captureGroup: string) => {
    didReplace = true;
    reasoning = captureGroup;
    return '';
  });
  if (didReplace && trimSpaces) {
    reasoning = reasoning.trim();
    content = content.trim();
  }
  return { reasoning, content };
}

export class PromptReasoning {
  counter = 0;
  prefixLength = -1;
  prefixReasoning = '';
  prefixReasoningFormatted = '';
  prefixDuration: number | null = null;
  prefixIncomplete = false;
  readonly #settings: ReasoningSettings;
  readonly #substitute: (text: string) => string;

  constructor(settings: ReasoningSettings, substitute: (text: string) => string) {
    this.#settings = settings;
    this.#substitute = substitute;
  }

  isLimitReached(): boolean {
    if (!this.#settings.add_to_prompts) return true;
    return this.counter >= this.#settings.max_additions;
  }

  addToMessage(
    content: string,
    reasoning: string,
    isPrefix: boolean,
    duration: number | null | undefined,
  ): string {
    if (
      !isPrefix &&
      (!this.#settings.add_to_prompts || this.counter >= this.#settings.max_additions)
    )
      return content;
    if (!reasoning || reasoning === REASONING_PLACEHOLDER) return content;
    this.counter++;
    const prefix = this.#substitute(this.#settings.prefix || '');
    const separator = this.#substitute(this.#settings.separator || '');
    const suffix = this.#substitute(this.#settings.suffix || '');
    if (isPrefix && !content) {
      const formattedReasoning = `${prefix}${reasoning}`;
      this.prefixReasoning = reasoning;
      this.prefixReasoningFormatted = formattedReasoning;
      this.prefixLength = formattedReasoning.length;
      this.prefixDuration = duration ?? null;
      this.prefixIncomplete = true;
      return formattedReasoning;
    }
    const formattedReasoning = `${prefix}${reasoning}${suffix}${separator}`;
    if (isPrefix) {
      this.prefixReasoning = reasoning;
      this.prefixReasoningFormatted = formattedReasoning;
      this.prefixLength = formattedReasoning.length;
      this.prefixDuration = duration ?? null;
      this.prefixIncomplete = false;
    }
    return `${formattedReasoning}${content}`;
  }

  removePrefix(content: string): string {
    return this.prefixLength > 0 ? content.slice(this.prefixLength) : content;
  }
}
