/** Function tools registered by ST extensions (ST `ToolManager`, DEV_NOTES §9.34 第 8 轮) */
import { ToolRegistry, canPerformToolCalls, isToolCallingSupported } from '@tm/st-compat';
import { plainChat } from '../chat/plain.svelte';
import { extState } from './state.svelte';

export const toolRegistry = new ToolRegistry((text) => console.warn(text));

const oai = (): Record<string, unknown> =>
  (plainChat.settings?.['oai_settings'] as Record<string, unknown> | undefined) ?? {};

export const toolCallingSupported = (): boolean => isToolCallingSupported(extState.mainApi, oai());

export const toolCallsAllowed = (type: unknown): boolean =>
  canPerformToolCalls(String(type), extState.mainApi, oai());

/** The `tools` of one request; none once the follow-up depth reaches `tool_call_recurse_limit` */
export async function toolsForRequest(type: string, depth: number): Promise<unknown[]> {
  const limit = Number(oai()['tool_call_recurse_limit'] ?? 5);
  return toolCallsAllowed(type) && depth < limit ? toolRegistry.definitions() : [];
}

/** ST `ToolManager` as extensions see it */
export const ToolManager = {
  registerFunctionTool: toolRegistry.register,
  unregisterFunctionTool: toolRegistry.unregister,
  invokeFunctionTool: toolRegistry.invoke,
  isStealthTool: toolRegistry.isStealth,
  getDisplayName: toolRegistry.displayName,
  formatToolCallMessage: toolRegistry.formatMessage,
  isToolCallingSupported: toolCallingSupported,
  canPerformToolCalls: toolCallsAllowed,
};
