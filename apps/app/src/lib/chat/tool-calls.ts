/**
 * Tool calls of one reply (ST script.js Generate, DEV_NOTES §9.34 第 8 轮): what happens to the
 * reply and how the calls are recorded in the chat. Rune-free so tests can import it.
 */
import { SYSTEM_USER_NAME } from '@tm/core';
import type { ChatMessage } from '@tm/formats';
import { toolInvocationMessage, type ToolInvocation, type ToolRunResult } from '@tm/st-compat';

/** ST: a reply that is nothing but tool calls leaves no message of its own (a swipe always stays) */
export function isBareToolReply(type: string, text: string, reasoning: string): boolean {
  return type !== 'swipe' && ['', '...'].includes(text) && !reasoning;
}

/**
 * The results go back to the model in a new generation. ST stops after a stealth tool; with no
 * result to send back there is nothing to follow up on either.
 */
export function followsUp(run: ToolRunResult): boolean {
  return run.invocations.length > 0 && run.stealthCalls.length === 0;
}

/** ST `saveFunctionToolInvocations`: the small system message that records the calls */
export function toolRecordMessage(
  invocations: ToolInvocation[],
  api: string,
  model: string,
): ChatMessage {
  return {
    name: SYSTEM_USER_NAME,
    is_user: false,
    is_system: true,
    send_date: new Date().toISOString(),
    mes: toolInvocationMessage(invocations),
    extra: { isSmallSys: true, tool_invocations: invocations, api, model },
  };
}
