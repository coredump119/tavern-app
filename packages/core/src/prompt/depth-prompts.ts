// 角色深度提示（Character's Note / @ Depth）：script.js Generate() + group-chats.js getGroupDepthPrompts
import { GROUP_GENERATION_MODE, type CoreState } from '../state.js';
import { baseChatReplace, type BaseSubstitute } from './character-fields.js';
import {
  EXTENSION_PROMPT_TYPES,
  INJECT_IDS,
  getExtensionPromptRoleByName,
  removeDepthPrompts,
  setExtensionPrompt,
  type ExtensionPrompts,
} from './extension-prompts.js';

export const DEPTH_PROMPT_DEPTH_DEFAULT = 4;
export const DEPTH_PROMPT_ROLE_DEFAULT = 'system';

export interface DepthPrompt {
  text: string;
  depth: number;
  role: string | number;
}

export function getGroupDepthPrompts(
  state: CoreState,
  substitute: BaseSubstitute,
  groupId: string | null | undefined,
  characterId: number | undefined,
): DepthPrompt[] {
  if (!groupId) return [];
  const group = state.groups.find((x) => x.id === groupId);
  if (!group || !Array.isArray(group.members) || !group.members.length) return [];
  if (group.generation_mode === GROUP_GENERATION_MODE.SWAP) return [];
  const disabled = group.disabled_members ?? [];
  const out: DepthPrompt[] = [];
  for (const member of group.members) {
    const index = state.characters.findIndex((x) => x.avatar === member);
    const character = state.characters[index];
    if (index === -1 || !character) continue;
    if (disabled.includes(member) && characterId !== index) continue;
    const dp = character.data?.extensions?.depth_prompt;
    const text = baseChatReplace(state, substitute, dp?.prompt?.trim(), null, character.name) || '';
    if (text)
      out.push({
        text,
        depth: dp?.depth ?? DEPTH_PROMPT_DEPTH_DEFAULT,
        role: dp?.role ?? DEPTH_PROMPT_ROLE_DEFAULT,
      });
  }
  return out;
}

/** Generate()：removeDepthPrompts + 写入 DEPTH_PROMPT / DEPTH_PROMPT_<i> */
export function applyDepthPrompts(
  state: CoreState,
  substitute: BaseSubstitute,
  extensionPrompts: ExtensionPrompts,
  charDepthPrompt: string,
  allowWIScan: boolean,
): void {
  removeDepthPrompts(extensionPrompts);
  const groupDepthPrompts = getGroupDepthPrompts(
    state,
    substitute,
    state.selectedGroup,
    state.characterId,
  );
  if (state.selectedGroup && groupDepthPrompts.length > 0) {
    groupDepthPrompts.forEach((value, index) => {
      setExtensionPrompt(
        extensionPrompts,
        INJECT_IDS.DEPTH_PROMPT_INDEX(index),
        value.text,
        EXTENSION_PROMPT_TYPES.IN_CHAT,
        value.depth,
        allowWIScan,
        getExtensionPromptRoleByName(value.role),
      );
    });
    return;
  }
  const character =
    state.characterId !== undefined ? state.characters[state.characterId] : undefined;
  const dp = character?.data?.extensions?.depth_prompt;
  setExtensionPrompt(
    extensionPrompts,
    INJECT_IDS.DEPTH_PROMPT,
    charDepthPrompt || '',
    EXTENSION_PROMPT_TYPES.IN_CHAT,
    dp?.depth ?? DEPTH_PROMPT_DEPTH_DEFAULT,
    allowWIScan,
    getExtensionPromptRoleByName(dp?.role ?? DEPTH_PROMPT_ROLE_DEFAULT),
  );
}
