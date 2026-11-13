/**
 * Message HTML renderer = @tm/core messageFormatting port → @tm/ui DOMPurify sanitizer → decodeStyleTags,
 * with a cache keyed by message identity + text so re-renders (scroll, theme toggles) are free and
 * streaming only re-formats the row that changed.
 */
import {
  DEFAULT_FORMAT_POWER_USER,
  createMessageFormatter,
  decodeStyleTags,
  type FormatPowerUser,
  type MessageFormatter,
} from '@tm/core';
import { createMessageSanitizer, type MessageSanitizer } from '@tm/ui';
import type { ChatMessage } from '@tm/formats';

export interface RendererOptions {
  powerUser: Partial<FormatPowerUser> & { forbid_external_media?: boolean | undefined };
  substitute: (text: string, charName?: string) => string;
  applyRegex?: Parameters<typeof createMessageFormatter>[0]['applyRegex'];
}

export function formatPowerUserFrom(
  settings: Record<string, unknown> | null,
): RendererOptions['powerUser'] {
  const pu = (settings?.['power_user'] as Record<string, unknown> | undefined) ?? {};
  const reasoning = (pu['reasoning'] as Record<string, unknown> | undefined) ?? {};
  return {
    auto_fix_generated_markdown: pu['auto_fix_generated_markdown'] === true,
    encode_tags: pu['encode_tags'] === true,
    allow_name2_display: pu['allow_name2_display'] === true,
    show_user_prompt_bias: pu['show_user_prompt_bias'] !== false,
    user_prompt_bias: String(pu['user_prompt_bias'] ?? ''),
    markdown_escape_strings: String(pu['markdown_escape_strings'] ?? ''),
    reasoning: {
      prefix: String(reasoning['prefix'] ?? '<think>'),
      suffix: String(reasoning['suffix'] ?? '</think>'),
    },
    forbid_external_media: pu['forbid_external_media'] !== false,
  };
}

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

export class MessageRenderer {
  private formatter: MessageFormatter;
  private sanitize: MessageSanitizer;
  private mediaAllowed: boolean;
  private cache = new Map<string, string>();
  private readonly max = 1000;

  constructor(opts: RendererOptions) {
    const powerUser: FormatPowerUser = { ...DEFAULT_FORMAT_POWER_USER, ...opts.powerUser };
    this.mediaAllowed = !opts.powerUser.forbid_external_media;
    this.formatter = createMessageFormatter({
      powerUser,
      substitute: opts.substitute,
      applyRegex: opts.applyRegex,
    });
    this.sanitize = createMessageSanitizer(window, { mediaAllowed: () => this.mediaAllowed });
  }

  /** ST updateMessageBlock(): display_text wins over mes */
  static displayText(m: ChatMessage): string {
    return m.extra?.display_text ?? m.mes;
  }

  render(
    text: string,
    m: Pick<ChatMessage, 'name' | 'is_user' | 'is_system'>,
    index: number,
    chat: readonly ChatMessage[],
  ): string {
    const key = `${index}|${m.name}|${m.is_user ? 1 : 0}|${m.is_system ? 1 : 0}|${text.length}|${hash(text)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const pre = this.formatter.format(text, {
      chName: m.name,
      isSystem: !!m.is_system,
      isUser: m.is_user,
      messageId: index,
      chat,
    });
    const html = decodeStyleTags(this.sanitize(pre), { mediaAllowed: this.mediaAllowed });
    if (this.cache.size >= this.max) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, html);
    return html;
  }

  /** Streaming rows change every frame: format without caching */
  renderLive(
    text: string,
    m: Pick<ChatMessage, 'name' | 'is_user' | 'is_system'>,
    index: number,
    chat: readonly ChatMessage[],
  ): string {
    const pre = this.formatter.format(text, {
      chName: m.name,
      isSystem: !!m.is_system,
      isUser: m.is_user,
      messageId: index,
      chat,
    });
    return decodeStyleTags(this.sanitize(pre), { mediaAllowed: this.mediaAllowed });
  }

  renderReasoning(
    text: string,
    m: Pick<ChatMessage, 'name' | 'is_user' | 'is_system'>,
    index: number,
  ): string {
    const pre = this.formatter.format(text, {
      chName: m.name,
      isSystem: !!m.is_system,
      isUser: m.is_user,
      messageId: index,
      isReasoning: true,
    });
    return decodeStyleTags(this.sanitize(pre), { mediaAllowed: this.mediaAllowed });
  }
}
