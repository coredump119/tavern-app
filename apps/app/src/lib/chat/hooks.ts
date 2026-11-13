import type { ExtensionPrompts } from '@tm/core';
import type { ToolRunResult } from '@tm/st-compat';

/**
 * What ST extensions add to a generation over the open chat (DEV_NOTES §9.34 第 2 轮). The
 * extension host fills these in when it starts; with no extension loaded they stay empty.
 */
export const generationHooks: {
  /** ST `generate_interceptor`s: may edit `chat` (a copy) in place; resolves true to cancel */
  intercept?: (chat: unknown[], type: string) => Promise<boolean>;
  /** ST `extension_prompts` as extensions set them (`setExtensionPrompt`) */
  prompts?: () => ExtensionPrompts;
  /**
   * Deliver one ST event to extensions, after the ones already queued; resolves when its
   * listeners have run (DEV_NOTES §9.34 第 8 轮: the events ST awaits inside Generate)
   */
  emit?: (name: string, ...args: unknown[]) => Promise<void>;
  /** ST `STREAM_TOKEN_RECEIVED`: the reply text so far, once per painted frame */
  token?: (text: string) => void;
  /** ST `ToolManager`: function tools registered by extensions */
  tools?: {
    /** ST `isToolCallingSupported()`: stored tool calls are replayed in the prompt */
    supported(): boolean;
    /** The `tools` of a request of this type at this follow-up depth; empty when off */
    definitions(type: string, depth: number): Promise<unknown[]>;
    /** Run the calls of one reply; `notify` gets the line of the tool being run */
    run(toolCalls: unknown[], notify: (text: string) => void): Promise<ToolRunResult>;
  };
} = {};
