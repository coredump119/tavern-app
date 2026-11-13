// ST script.js 的 extension_prompts 注入表：setExtensionPrompt / getExtensionPrompt / inject_ids。
export const EXTENSION_PROMPT_TYPES = {
  NONE: -1,
  IN_PROMPT: 0,
  IN_CHAT: 1,
  BEFORE_PROMPT: 2,
} as const;
import { EXTENSION_PROMPT_ROLES } from '../world-info/types.js';
export { EXTENSION_PROMPT_ROLES };
export const MAX_INJECTION_DEPTH = 10000;

export const INJECT_IDS = {
  STORY_STRING: '__STORY_STRING__',
  QUIET_PROMPT: 'QUIET_PROMPT',
  DEPTH_PROMPT: 'DEPTH_PROMPT',
  DEPTH_PROMPT_INDEX: (index: number) => `DEPTH_PROMPT_${index}`,
  CUSTOM_WI_DEPTH: 'customDepthWI',
  CUSTOM_WI_DEPTH_ROLE: (depth: number | undefined, role: number) =>
    `customDepthWI_${depth}_${role}`,
  CUSTOM_WI_OUTLET: (key: string) => `customWIOutlet_${key}`,
} as const;

export interface ExtensionPrompt {
  value: string;
  position: number;
  depth: number;
  scan: boolean;
  role: number;
  filter?: (() => boolean | Promise<boolean>) | null | undefined;
}
export type ExtensionPrompts = Record<string, ExtensionPrompt>;

export function setExtensionPrompt(
  prompts: ExtensionPrompts,
  key: string,
  value: unknown,
  position: number,
  depth: number | undefined,
  scan = false,
  role: number = EXTENSION_PROMPT_ROLES.SYSTEM,
  filter: ExtensionPrompt['filter'] = null,
): void {
  prompts[key] = {
    value: String(value),
    position: Number(position),
    depth: Number(depth),
    scan: !!scan,
    role: Number(role ?? EXTENSION_PROMPT_ROLES.SYSTEM),
    filter,
  };
}

/** ST getExtensionPrompt：按 key 排序，过滤 position / depth / role / filter()，trim 后用 separator 连接，可包裹 */
export async function getExtensionPrompt(
  prompts: ExtensionPrompts,
  substitute: (text: string) => string,
  position: number = EXTENSION_PROMPT_TYPES.IN_PROMPT,
  depth?: number,
  separator = '\n',
  role?: number,
  wrap = true,
): Promise<string> {
  const candidates = Object.keys(prompts)
    .sort()
    .map((k) => prompts[k]!)
    .filter((x) => x.position == position && x.value)
    .filter((x) => depth === undefined || x.depth === undefined || x.depth === depth)
    .filter((x) => role === undefined || x.role === undefined || x.role === role);
  const kept: ExtensionPrompt[] = [];
  for (const p of candidates) {
    if (typeof p.filter === 'function' && !(await p.filter())) continue;
    kept.push(p);
  }
  let values = kept.map((x) => x.value.trim()).join(separator);
  if (wrap && values.length && !values.startsWith(separator)) values = separator + values;
  if (wrap && values.length && !values.endsWith(separator)) values = values + separator;
  if (values.length) values = substitute(values);
  return values;
}

/** ST getExtensionPromptByName */
export async function getExtensionPromptByName(
  prompts: ExtensionPrompts,
  substitute: (text: string) => string,
  moduleName: string,
): Promise<string> {
  if (!moduleName) return '';
  const prompt = prompts[moduleName];
  if (!prompt) return '';
  if (typeof prompt.filter === 'function' && !(await prompt.filter())) return '';
  return substitute(prompt.value);
}

export function getExtensionPromptRoleByName(roleName: unknown): number {
  if (
    typeof roleName === 'number' &&
    (Object.values(EXTENSION_PROMPT_ROLES) as number[]).includes(roleName)
  )
    return roleName;
  switch (roleName) {
    case 'system':
      return EXTENSION_PROMPT_ROLES.SYSTEM;
    case 'user':
      return EXTENSION_PROMPT_ROLES.USER;
    case 'assistant':
      return EXTENSION_PROMPT_ROLES.ASSISTANT;
  }
  return EXTENSION_PROMPT_ROLES.SYSTEM;
}

export function flushWIInjections(prompts: ExtensionPrompts): void {
  const depthPrefix = INJECT_IDS.CUSTOM_WI_DEPTH;
  const outletPrefix = INJECT_IDS.CUSTOM_WI_OUTLET('');
  for (const key of Object.keys(prompts)) {
    if (key.startsWith(depthPrefix) || key.startsWith(outletPrefix)) delete prompts[key];
  }
}

export function removeDepthPrompts(prompts: ExtensionPrompts): void {
  for (const key of Object.keys(prompts)) {
    if (key.startsWith(INJECT_IDS.DEPTH_PROMPT)) delete prompts[key];
  }
}
