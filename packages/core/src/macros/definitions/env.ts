// ST env-macros.js 移植：名字、角色卡字段、model/original/isMobile。
import { MacroCategory, MacroValueType, type MacroRegistry } from '../registry.js';
import { formatInstructModeExamples, parseMesExamples } from '../../prompt/examples.js';

export function registerEnvMacros(registry: MacroRegistry): void {
  registry.registerMacro('user', {
    category: MacroCategory.NAMES,
    description: 'Your current Persona username.',
    returns: 'Persona username.',
    handler: ({ env }) => env.names.user,
  });
  registry.registerMacro('char', {
    category: MacroCategory.NAMES,
    description: "The character's name.",
    returns: 'Character name.',
    handler: ({ env }) => env.names.char,
  });
  registry.registerMacro('group', {
    aliases: [{ alias: 'charIfNotGroup', visible: false }],
    category: MacroCategory.NAMES,
    description:
      'Comma-separated list of group member names (including muted) or the character name in solo chats.',
    returns: 'List of group member names.',
    handler: ({ env }) => env.names.group ?? '',
  });
  registry.registerMacro('groupNotMuted', {
    category: MacroCategory.NAMES,
    description: 'Comma-separated list of group member names excluding muted members.',
    returns: 'List of group member names excluding muted members.',
    handler: ({ env }) => env.names.groupNotMuted ?? '',
  });
  registry.registerMacro('notChar', {
    category: MacroCategory.NAMES,
    description: 'Comma-separated list of all participants except the current speaker.',
    returns: 'List of all participants except the current speaker.',
    handler: ({ env }) => env.names.notChar ?? '',
  });

  registry.registerMacro('charPrompt', {
    category: MacroCategory.CHARACTER,
    description: "The character's Main Prompt override.",
    returns: 'Character Main Prompt override.',
    handler: ({ env }) => env.character.charPrompt ?? '',
  });
  registry.registerMacro('charInstruction', {
    category: MacroCategory.CHARACTER,
    description: "The character's Post-History Instructions override.",
    returns: 'Character Post-History Instructions override.',
    handler: ({ env }) => env.character.charInstruction ?? '',
  });
  registry.registerMacro('charDescription', {
    aliases: [{ alias: 'description' }],
    category: MacroCategory.CHARACTER,
    description: "The character's description.",
    returns: 'Character description.',
    handler: ({ env }) => env.character.description ?? '',
  });
  registry.registerMacro('charPersonality', {
    aliases: [{ alias: 'personality' }],
    category: MacroCategory.CHARACTER,
    description: "The character's personality.",
    returns: 'Character personality.',
    handler: ({ env }) => env.character.personality ?? '',
  });
  registry.registerMacro('charScenario', {
    aliases: [{ alias: 'scenario' }],
    category: MacroCategory.CHARACTER,
    description: "The character's scenario.",
    returns: 'Character scenario.',
    handler: ({ env }) => env.character.scenario ?? '',
  });
  registry.registerMacro('persona', {
    category: MacroCategory.CHARACTER,
    description: 'Your current Persona description.',
    returns: 'Persona description.',
    handler: ({ env }) => env.character.persona ?? '',
  });
  registry.registerMacro('mesExamplesRaw', {
    category: MacroCategory.CHARACTER,
    description: 'Unformatted dialogue examples from the character card.',
    returns: 'Unformatted dialogue examples.',
    handler: ({ env }) => env.character.mesExamplesRaw ?? '',
  });

  registry.registerMacro('mesExamples', {
    category: MacroCategory.CHARACTER,
    description: "The character's dialogue examples, formatted for instruct mode when enabled.",
    returns: 'Formatted dialogue examples.',
    handler: ({ env, resolve }) => {
      const raw = env.character.mesExamplesRaw ?? '';
      if (!raw) return '';
      const state = env.runtime;
      const isInstruct = !!state.powerUser.instruct?.enabled && state.mainApi !== 'openai';
      const parsed = parseMesExamples(state, (t) => resolve(t), raw, isInstruct);
      if (!Array.isArray(parsed) || parsed.length === 0) return '';
      if (!isInstruct) return parsed.join('');
      const formatted = formatInstructModeExamples(
        state,
        (t) => resolve(t),
        parsed,
        env.names.user,
        env.names.char,
      );
      return Array.isArray(formatted) ? formatted.join('') : '';
    },
  });

  registry.registerMacro('charDepthPrompt', {
    category: MacroCategory.CHARACTER,
    description: "The character's @ Depth Note.",
    returns: 'Character @ Depth Note.',
    handler: ({ env }) => env.character.charDepthPrompt ?? '',
  });
  registry.registerMacro('charCreatorNotes', {
    aliases: [{ alias: 'creatorNotes' }],
    category: MacroCategory.CHARACTER,
    description: 'Creator notes from the character card.',
    returns: 'Creator notes.',
    handler: ({ env }) => env.character.creatorNotes ?? '',
  });

  registry.registerMacro('charFirstMessage', {
    aliases: [{ alias: 'greeting' }],
    category: MacroCategory.CHARACTER,
    unnamedArgs: [
      {
        name: 'index',
        optional: true,
        defaultValue: '0',
        type: MacroValueType.INTEGER,
        description:
          '0-based index. 0 (default) returns the main greeting, 1 and up return alternate greetings.',
      },
    ],
    description:
      "The character's first message / greeting. Optionally specify an index to access alternate greetings.",
    returns: 'Character greeting at the given index, or empty string if out of bounds.',
    exampleUsage: ['{{greeting}}', '{{greeting::0}}', '{{greeting::1}}'],
    handler: ({ env, unnamedArgs: [index] }) => {
      const i = Number(index ?? 0);
      if (i === 0) return env.character.firstMessage ?? '';
      const alt = env.character.alternateGreetings;
      if (!Array.isArray(alt)) return '';
      return alt[i - 1] ?? '';
    },
  });

  registry.registerMacro('charVersion', {
    aliases: [
      { alias: 'version', visible: false },
      { alias: 'char_version', visible: false },
    ],
    category: MacroCategory.CHARACTER,
    description: "The character's version number.",
    returns: 'Character version number.',
    handler: ({ env }) => env.character.version ?? '',
  });

  registry.registerMacro('model', {
    category: MacroCategory.STATE,
    description: 'Model name for the currently selected API.',
    returns: 'Model name.',
    handler: ({ env }) => env.system.model,
  });

  registry.registerMacro('original', {
    category: MacroCategory.CHARACTER,
    description:
      'Original message content for {{original}} substitution in in character prompt overrides.',
    returns: 'Original message content.',
    // ST 在 functions.original 缺失时直接 TypeError → 引擎记内部错误并保留 {{original}} 原文，
    // 这样角色卡里的 {{original}} 能活过 baseChatReplace，等到 preparePrompt 再替换
    handler: ({ env }) => env.functions.original!(),
  });

  registry.registerMacro('isMobile', {
    category: MacroCategory.STATE,
    description: '"true" if currently running in a mobile environment, "false" otherwise.',
    returns: 'Whether the environment is mobile.',
    returnType: MacroValueType.BOOLEAN,
    handler: ({ env }) => String(env.runtime.isMobile),
  });
}
