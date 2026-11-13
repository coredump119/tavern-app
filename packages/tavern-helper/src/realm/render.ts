/**
 * What the hub needs of the app's message renderer (DEV_NOTES §9.5 第 3 轮 → 显示接口). The
 * renderer itself lives with the app (`apps/app/src/th/render.ts`): it is built from `@tm/core`
 * and `@tm/ui`, which this package does not depend on. Tests pass a fake.
 */
export type RegexSource = 'user_input' | 'ai_output' | 'slash_command' | 'world_info' | 'reasoning';
export type RegexDestination = 'display' | 'prompt';

/** The message a text is rendered as */
export interface DisplayedAs {
  index: number;
  name: string;
  isUser: boolean;
  isSystem: boolean;
}

export interface HubRenderer {
  /** The user's regex scripts applied to `text`, as the app would for that source and destination */
  regex(
    text: string,
    source: RegexSource,
    destination: RegexDestination,
    option: { depth?: number; characterName?: string },
  ): string;
  /** The HTML the chat shows for a message with this text: regex, macros, Markdown, sanitizing */
  message(text: string, as: DisplayedAs): string;
  /** Markdown → HTML, nothing else */
  markdown(text: string): string;
}
