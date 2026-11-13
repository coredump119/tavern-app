// ST instruct-macros.js 移植：instruct 模板序列、系统提示、context 模板宏。
import { MacroCategory, type MacroRegistry } from '../registry.js';
import type { CoreState } from '../../state.js';

export function registerInstructMacros(registry: MacroRegistry): void {
  function registerSimple(
    names: string[],
    getValue: (s: CoreState) => string | undefined,
    isEnabled: (s: CoreState) => boolean,
    description: string,
    category: string = MacroCategory.PROMPTS,
  ) {
    const [primary, ...aliasNames] = names;
    const aliases = aliasNames.map((alias) => ({ alias }));
    registry.registerMacro(primary!, {
      category,
      description,
      aliases: aliases.length > 0 ? aliases : undefined,
      handler: ({ env }) => (isEnabled(env.runtime) ? (getValue(env.runtime) ?? '') : ''),
    });
  }
  const inst = (s: CoreState) => s.powerUser.instruct;
  const instEnabled = (s: CoreState) => !!s.powerUser.instruct.enabled;
  const sysEnabled = (s: CoreState) => !!s.powerUser.sysprompt.enabled;

  registerSimple(
    ['instructStoryStringPrefix'],
    (s) => inst(s).story_string_prefix,
    instEnabled,
    'Instruct story string prefix.',
  );
  registerSimple(
    ['instructStoryStringSuffix'],
    (s) => inst(s).story_string_suffix,
    instEnabled,
    'Instruct story string suffix.',
  );
  registerSimple(
    ['instructUserPrefix', 'instructInput'],
    (s) => inst(s).input_sequence,
    instEnabled,
    'Instruct input / user prefix sequence.',
  );
  registerSimple(
    ['instructUserSuffix'],
    (s) => inst(s).input_suffix,
    instEnabled,
    'Instruct input / user suffix sequence.',
  );
  registerSimple(
    ['instructAssistantPrefix', 'instructOutput'],
    (s) => inst(s).output_sequence,
    instEnabled,
    'Instruct output / assistant prefix sequence.',
  );
  registerSimple(
    ['instructAssistantSuffix', 'instructSeparator'],
    (s) => inst(s).output_suffix,
    instEnabled,
    'Instruct output / assistant suffix sequence.',
  );
  registerSimple(
    ['instructSystemPrefix'],
    (s) => inst(s).system_sequence,
    instEnabled,
    'Instruct system prefix sequence.',
  );
  registerSimple(
    ['instructSystemSuffix'],
    (s) => inst(s).system_suffix,
    instEnabled,
    'Instruct system suffix sequence.',
  );
  registerSimple(
    ['instructFirstAssistantPrefix', 'instructFirstOutputPrefix'],
    (s) => inst(s).first_output_sequence || inst(s).output_sequence,
    instEnabled,
    'Instruct first assistant / output prefix sequence',
  );
  registerSimple(
    ['instructLastAssistantPrefix', 'instructLastOutputPrefix'],
    (s) => inst(s).last_output_sequence || inst(s).output_sequence,
    instEnabled,
    'Instruct last assistant / output prefix sequence.',
  );
  registerSimple(
    ['instructStop'],
    (s) => inst(s).stop_sequence,
    instEnabled,
    'Instruct stop sequence.',
  );
  registerSimple(
    ['instructUserFiller'],
    (s) => inst(s).user_alignment_message,
    instEnabled,
    'Instruct user alignment filler.',
  );
  registerSimple(
    ['instructSystemInstructionPrefix'],
    (s) => inst(s).last_system_sequence,
    instEnabled,
    'Instruct system instruction prefix sequence.',
  );
  registerSimple(
    ['instructFirstUserPrefix', 'instructFirstInput'],
    (s) => inst(s).first_input_sequence || inst(s).input_sequence,
    instEnabled,
    'Instruct first user / input prefix sequence.',
  );
  registerSimple(
    ['instructLastUserPrefix', 'instructLastInput'],
    (s) => inst(s).last_input_sequence || inst(s).input_sequence,
    instEnabled,
    'Instruct last user / input prefix sequence.',
  );

  registerSimple(
    ['defaultSystemPrompt', 'instructSystem', 'instructSystemPrompt'],
    (s) => s.powerUser.sysprompt.content,
    sysEnabled,
    'Default system prompt.',
  );

  registry.registerMacro('systemPrompt', {
    category: MacroCategory.PROMPTS,
    description: 'Active system prompt text (optionally overridden by character prompt)',
    handler: ({ env }) => {
      const s = env.runtime;
      if (!s.powerUser.sysprompt.enabled) return '';
      if (s.powerUser.prefer_character_prompt && env.character.charPrompt)
        return env.character.charPrompt;
      return s.powerUser.sysprompt.content ?? '';
    },
  });

  registerSimple(
    ['exampleSeparator', 'chatSeparator'],
    (s) => s.powerUser.context.example_separator,
    () => true,
    'Separator used between example chat blocks in text completion prompts.',
  );
  registerSimple(
    ['chatStart'],
    (s) => s.powerUser.context.chat_start,
    () => true,
    'Chat start marker used in text completion prompts.',
  );
}
