// ST state-macros.js 移植：lastGenerationType、hasExtension。
import { MacroCategory, type MacroRegistry } from '../registry.js';

export function registerStateMacros(registry: MacroRegistry): void {
  registry.registerMacro('lastGenerationType', {
    category: MacroCategory.STATE,
    description:
      'Type of the last queued generation request (e.g. "normal", "impersonate", "regenerate", "quiet", "swipe", "continue"). Empty if none yet or chat was switched.',
    returns: 'Type of the last queued generation request.',
    handler: ({ env }) => env.runtime.lastGenerationType ?? '',
  });
  registry.registerMacro('hasExtension', {
    category: MacroCategory.STATE,
    unnamedArgs: [
      { name: 'extensionName', type: 'string', description: 'The name of the extension to check' },
    ],
    description:
      'Checks if a specific extension is enabled. If the extension does not exist, returns false.',
    returns: 'true if the extension is enabled, false otherwise.',
    handler: ({ unnamedArgs: [extensionName = ''], env }) =>
      String(env.runtime.hasExtension?.(extensionName) ?? false),
  });
}
