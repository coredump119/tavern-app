/**
 * ST `ToolManager` (public/scripts/tool-calling.js): the function tools extensions register and
 * the calls a model makes to them. DEV_NOTES §9.34 第 8 轮. Pure: showing a call's message and
 * writing the result into the chat are the caller's.
 */

/** ST `registerFunctionTool` argument */
export interface FunctionToolInput {
  name: string;
  displayName?: string;
  description?: string;
  /** JSON schema of the arguments */
  parameters?: unknown;
  action: (parameters: unknown) => unknown;
  /** The line shown while the tool runs; an empty string shows nothing */
  formatMessage?: (parameters: unknown) => unknown;
  /** Asked before every request; a falsy answer leaves the tool out of it */
  shouldRegister?: () => unknown;
  /** The call is not written into the chat and no follow-up generation runs */
  stealth?: boolean;
}

/** ST `ToolInvocation` (`extra.tool_invocations`); no signatures and no tool reasoning here */
export interface ToolInvocation {
  id: string;
  displayName: string;
  name: string;
  /** the arguments as a JSON string */
  parameters: string;
  result: string;
  error: boolean;
  signature: null;
  reasoning: null;
}

/** ST `ToolInvocationResult` */
export interface ToolRunResult {
  invocations: ToolInvocation[];
  errors: Error[];
  stealthCalls: string[];
}

interface ToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown } | null;
}

/** ST `ToolManager.#parseParameters` */
function parseParameters(parameters: unknown): unknown {
  if (parameters === '') return {};
  return typeof parameters === 'string' ? JSON.parse(parameters) : parameters;
}

const stringify = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

export class ToolRegistry {
  readonly #tools = new Map<string, FunctionToolInput>();
  readonly #warn: (text: string) => void;

  constructor(warn: (text: string) => void = () => {}) {
    this.#warn = warn;
  }

  /** ST `registerFunctionTool`: one object, or the early `(name, description, parameters, action)` */
  register = (first: unknown, ...rest: unknown[]): void => {
    const tool = (
      typeof first === 'object' && first !== null
        ? { ...first }
        : { name: first, description: rest[0], parameters: rest[1], action: rest[2] }
    ) as FunctionToolInput;
    if (this.#tools.has(tool.name))
      this.#warn(
        `[ToolManager] A tool with the name "${tool.name}" has already been registered. The definition will be overwritten.`,
      );
    this.#tools.set(tool.name, tool);
  };

  /** ST `unregisterFunctionTool` */
  unregister = (name: string): void => {
    if (!this.#tools.delete(name))
      this.#warn(`[ToolManager] A tool with the name "${name}" has not been registered.`);
  };

  get size(): number {
    return this.#tools.size;
  }

  /** ST `registerFunctionToolsOpenAI`: the `tools` of a request, each tool's `shouldRegister` asked */
  definitions = async (): Promise<unknown[]> => {
    const out: unknown[] = [];
    for (const tool of this.#tools.values()) {
      if (tool.shouldRegister && !(await tool.shouldRegister())) continue;
      out.push({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      });
    }
    return out;
  };

  /** ST `invokeFunctionTool`: the result as a string, or the error (its `cause` is the tool name) */
  invoke = async (name: string, parameters: unknown): Promise<string | Error> => {
    try {
      const tool = this.#tools.get(name);
      if (!tool) throw new Error(`No tool with the name "${name}" has been registered.`);
      return stringify(await tool.action(parseParameters(parameters)));
    } catch (error) {
      if (error instanceof Error) {
        error.cause = name;
        return error;
      }
      return new Error('Unknown error occurred while invoking the tool.', { cause: name });
    }
  };

  isStealth = (name: string): boolean => this.#tools.get(name)?.stealth === true;

  displayName = (name: string): string => this.#tools.get(name)?.displayName || name;

  /** ST `formatToolCallMessage`: the line shown while the tool runs */
  formatMessage = async (name: string, parameters: unknown): Promise<string> => {
    const tool = this.#tools.get(name);
    if (!tool) return `Invoked unknown tool: ${name}`;
    try {
      if (!tool.formatMessage) return `Invoking tool: ${tool.displayName || name}`;
      return String(await tool.formatMessage(parseParameters(parameters)));
    } catch {
      return `Invoking tool: ${name}`;
    }
  };

  /** ST `invokeFunctionTools`: run the calls of one reply in order; `notify` shows each call's line */
  run = async (toolCalls: unknown, notify?: (text: string) => void): Promise<ToolRunResult> => {
    const result: ToolRunResult = { invocations: [], errors: [], stealthCalls: [] };
    if (!Array.isArray(toolCalls)) return result;
    for (const call of toolCalls as ToolCall[]) {
      if (typeof call?.function !== 'object' || call.function === null) continue;
      const name = String(call.function.name);
      const parameters = call.function.arguments;
      const stealth = this.isStealth(name);
      const message = await this.formatMessage(name, parameters);
      if (message) notify?.(message);
      const output = await this.invoke(name, parameters);
      const failed = output instanceof Error;
      if (failed) result.errors.push(output);
      if (stealth) {
        result.stealthCalls.push(name);
        continue;
      }
      result.invocations.push({
        id: String(call.id ?? ''),
        displayName: this.displayName(name),
        name,
        parameters: stringify(parameters),
        result: failed ? output.toString() : output,
        error: failed,
        signature: null,
        reasoning: null,
      });
    }
    return result;
  };
}

/** ST `ToolManager.isToolCallingSupported` source list (per-model checks are not made) */
const TOOL_SOURCES = new Set([
  'openai',
  'custom',
  'mistralai',
  'claude',
  'openrouter',
  'aimlapi',
  'groq',
  'cohere',
  'deepseek',
  'makersuite',
  'vertexai',
  'ai21',
  'xai',
  'pollinations',
  'moonshot',
  'fireworks',
  'cometapi',
  'chutes',
  'electronhub',
  'azure_openai',
  'zai',
  'siliconflow',
  'nanogpt',
  'workers_ai',
  'minimax',
]);
/** ST `custom_prompt_post_processing` values that keep tool messages */
const TOOL_POST_PROCESSING = new Set(['', 'merge_tools', 'semi_tools', 'strict_tools']);

/** ST `ToolManager.isToolCallingSupported` */
export function isToolCallingSupported(mainApi: string, oai: Record<string, unknown>): boolean {
  if (mainApi !== 'openai' || !oai['function_calling']) return false;
  if (!TOOL_POST_PROCESSING.has(String(oai['custom_prompt_post_processing'] ?? ''))) return false;
  return TOOL_SOURCES.has(String(oai['chat_completion_source'] ?? ''));
}

/** ST `ToolManager.canPerformToolCalls` */
export function canPerformToolCalls(
  type: string,
  mainApi: string,
  oai: Record<string, unknown>,
): boolean {
  return (
    !['impersonate', 'quiet', 'continue'].includes(type) && isToolCallingSupported(mainApi, oai)
  );
}

const tryParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** ST `#formatToolInvocationMessage`: the text of the small system message that records the calls */
export function toolInvocationMessage(invocations: readonly ToolInvocation[]): string {
  const data = invocations.map((i) => ({
    ...i,
    parameters: tryParse(i.parameters),
    result: tryParse(i.result),
  }));
  const counts = new Map<string, number>();
  for (const i of data) {
    const name = i.displayName || i.name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([name, n]) => (n > 1 ? `${name} (${n})` : name)).join(', ');
  const json = escapeText(JSON.stringify(data, null, 2));
  return `<details><summary>${escapeText(`Tool calls: ${names}`)}</summary><pre><code class="language-json">${json}</code></pre></details>`;
}
