import type { CommandRegistry, SlashCommand } from '@tm/st-compat';

/** Commands ST extensions registered (DEV_NOTES §9.34 第 2 轮); one table for every slash host. */
export const extensionCommands = new Map<string, SlashCommand>();

/** `builtin` with the extension commands in front: ST lets an extension replace a built-in command */
export function withExtensionCommands(builtin: CommandRegistry): CommandRegistry {
  return { get: (name) => extensionCommands.get(name) ?? builtin.get(name) };
}
