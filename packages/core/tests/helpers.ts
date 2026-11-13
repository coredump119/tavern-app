import {
  MacroEngine,
  createCapturingLogger,
  createVariableScopes,
  type CapturedMacroLog,
} from '../src/macros/index.js';
import type { CoreState, ChatMessageLike, CharacterLike, GroupLike } from '../src/state.js';

export interface TestStateOverrides {
  userName?: string;
  charName?: string;
  characters?: CharacterLike[];
  characterId?: number;
  groups?: GroupLike[];
  selectedGroup?: string | null;
  chat?: ChatMessageLike[];
  chatMetadata?: Record<string, unknown>;
  globalVariables?: Record<string, unknown>;
  mainApi?: string;
  model?: string;
  powerUser?: Partial<CoreState['powerUser']>;
  now?: () => Date | number;
  input?: string;
  extensionPrompts?: CoreState['extensionPrompts'];
  isMobile?: boolean;
  lastGenerationType?: string;
  hasExtension?: (name: string) => boolean;
  firstDisplayedMessageId?: number | null;
  locale?: string;
  tokens?: CoreState['tokens'];
}

/** ST 默认 power_user 子集（来自 default settings.json） */
export function defaultPowerUser(): CoreState['powerUser'] {
  return {
    instruct: {
      enabled: false,
      preset: 'Alpaca',
      input_sequence: '### Instruction:',
      output_sequence: '### Response:',
      last_output_sequence: '',
      system_sequence: '### Input:',
      stop_sequence: '',
      wrap: true,
      macro: true,
      names_behavior: 'force',
      activation_regex: '',
      first_output_sequence: '',
      skip_examples: false,
      output_suffix: '\n\n',
      input_suffix: '\n\n',
      system_suffix: '\n\n',
      user_alignment_message: '',
      system_same_as_user: false,
    },
    context: {
      preset: 'Default',
      story_string:
        "{{#if system}}{{system}}\n{{/if}}{{#if wiBefore}}{{wiBefore}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if personality}}{{char}}'s personality: {{personality}}\n{{/if}}{{#if scenario}}Scenario: {{scenario}}\n{{/if}}{{#if wiAfter}}{{wiAfter}}\n{{/if}}{{#if persona}}{{persona}}\n{{/if}}",
      chat_start: '***',
      example_separator: '***',
      use_stop_strings: true,
    },
    sysprompt: {
      enabled: true,
      name: 'Neutral - Chat',
      content: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
    },
    prefer_character_prompt: true,
    prefer_character_jailbreak: true,
    collapse_newlines: false,
    persona_description: '',
  };
}

export function createTestState(o: TestStateOverrides = {}): CoreState {
  const chatMetadata = o.chatMetadata ?? {};
  const globalVariables = o.globalVariables ?? {};
  return {
    userName: o.userName ?? 'DefaultUser',
    charName: o.charName ?? 'DefaultChar',
    characters: o.characters ?? [],
    characterId: o.characterId,
    groups: o.groups ?? [],
    selectedGroup: o.selectedGroup ?? null,
    chat: o.chat ?? [],
    chatMetadata,
    variables: createVariableScopes(chatMetadata, globalVariables),
    mainApi: o.mainApi ?? 'openai',
    model: o.model ?? 'test-model',
    powerUser: { ...defaultPowerUser(), ...(o.powerUser ?? {}) },
    tokens: o.tokens ?? { maxContext: () => 4096, maxResponse: () => 300, maxPrompt: () => 3796 },
    extensionPrompts: o.extensionPrompts ?? {},
    isMobile: o.isMobile ?? false,
    lastGenerationType: o.lastGenerationType ?? '',
    hasExtension: o.hasExtension,
    input: o.input ?? '',
    firstDisplayedMessageId: o.firstDisplayedMessageId ?? null,
    bannedWords: [],
    locale: o.locale,
    now: o.now,
  };
}

export interface TestHarness {
  engine: MacroEngine;
  state: CoreState;
  logs: CapturedMacroLog[];
  warnings: () => string[];
  errors: () => string[];
  hasMacroWarnings: () => boolean;
  hasMacroErrors: () => boolean;
  /** 等价于 ST e2e 的 evaluateWithEngine：name1Override 'User'，name2Override 'Character' */
  evaluate: (
    input: string,
    extra?: Partial<import('../src/macros/index.js').MacroEnvRawContext>,
  ) => string;
  evaluateWithVariables: (
    input: string,
    vars: { local?: Record<string, string>; global?: Record<string, string> },
  ) => string;
}

export function createHarness(stateOverrides: TestStateOverrides = {}): TestHarness {
  const logs: CapturedMacroLog[] = [];
  const engine = new MacroEngine({ logger: createCapturingLogger(logs) });
  const state = createTestState(stateOverrides);
  const evaluate: TestHarness['evaluate'] = (input, extra = {}) => {
    const env = engine.buildEnv(state, {
      content: input,
      name1Override: 'User',
      name2Override: 'Character',
      replaceCharacterCard: true,
      ...extra,
    });
    return engine.evaluate(input, env);
  };
  return {
    engine,
    state,
    logs,
    warnings: () => logs.filter((l) => l.level === 'warn').map((l) => l.message),
    errors: () => logs.filter((l) => l.level !== 'warn').map((l) => l.message),
    hasMacroWarnings: () => logs.some((l) => l.level === 'warn'),
    hasMacroErrors: () => logs.some((l) => l.level === 'error'),
    evaluate,
    evaluateWithVariables: (input, vars) => {
      for (const [k, v] of Object.entries(vars.local ?? {})) state.variables.local.set(k, v);
      for (const [k, v] of Object.entries(vars.global ?? {})) state.variables.global.set(k, v);
      return evaluate(input);
    },
  };
}
