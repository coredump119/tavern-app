// ST macro-system.js initRegisterMacros 的顺序：core → env → state → chat → time → variables → instruct
import type { MacroRegistry } from '../registry.js';
import { MacroCstWalker } from '../walker.js';
import { registerCoreMacros } from './core.js';
import { registerEnvMacros } from './env.js';
import { registerStateMacros } from './state.js';
import { registerChatMacros } from './chat.js';
import { registerTimeMacros } from './time.js';
import { registerVariableMacros } from './variables.js';
import { registerInstructMacros } from './instruct.js';

export function registerBuiltinMacros(registry: MacroRegistry): void {
  // {{if}} 的 else 拆分只需要 extractMacroInfo，用一个轻量 walker 即可
  const infoWalker = new MacroCstWalker({
    registry,
    logger: registry.logger,
    normalize: (v) => String(v ?? ''),
  });
  registerCoreMacros(registry, (node) => infoWalker.extractMacroInfo(node));
  registerEnvMacros(registry);
  registerStateMacros(registry);
  registerChatMacros(registry);
  registerTimeMacros(registry);
  registerVariableMacros(registry);
  registerInstructMacros(registry);
}

export { getChatIdHash } from './core.js';
export { getLastMessageId } from './chat.js';
export { getTimeSinceLastMessage } from './time.js';
