// ST MacroEnv.types.js + MacroEnvBuilder.js 移植。全局量（name1/name2/groups/characters…）改为从 CoreState 读取。
import type { CoreState } from '../state.js';
import { getStringHash } from '../util/hash.js';
import { logMacroGeneralError, type MacroLogger } from './diagnostics.js';
import type { MacroDefinitionOptions, MacroHandler } from './registry.js';
import {
  getCharacterCardFieldsLazy,
  type CharacterCardFields,
} from '../prompt/character-fields.js';

export type DynamicMacroValue = string | number | boolean | MacroHandler | MacroDefinitionOptions;

export interface MacroEnvNames {
  user: string;
  char: string;
  group: string;
  groupNotMuted: string;
  notChar: string;
}

export interface MacroEnvCharacter {
  description?: string;
  personality?: string;
  scenario?: string;
  persona?: string;
  charPrompt?: string;
  charInstruction?: string;
  mesExamplesRaw?: string;
  charDepthPrompt?: string;
  creatorNotes?: string;
  version?: string;
  firstMessage?: string;
  alternateGreetings?: string[];
}

export interface MacroEnvSystem {
  model: string;
}

export interface MacroEnvFunctions {
  original?: () => string;
  postProcess: (text: string) => string;
}

export interface MacroEnv {
  content: string;
  contentHash: number;
  names: MacroEnvNames;
  character: MacroEnvCharacter;
  system: MacroEnvSystem;
  functions: MacroEnvFunctions;
  dynamicMacros: Record<string, DynamicMacroValue>;
  extra: Record<string, unknown>;
  /** core 扩展：宿主运行时状态（变量、聊天、设置等） */
  runtime: CoreState;
}

export interface MacroEnvRawContext {
  content: string;
  name1Override?: string | null | undefined;
  name2Override?: string | null | undefined;
  original?: string | null | undefined;
  groupOverride?: string | null | undefined;
  replaceCharacterCard?: boolean | undefined;
  dynamicMacros?: Record<string, DynamicMacroValue> | null | undefined;
  postProcessFn?: ((value: string) => string) | undefined;
}

export type MacroEnvProvider = (env: MacroEnv, ctx: MacroEnvRawContext, state: CoreState) => void;

export const env_provider_order = {
  EARLIEST: 0,
  EARLY: 10,
  NORMAL: 50,
  LATE: 90,
  LATEST: 100,
} as const;

/** baseChatReplace 需要引擎本身，这里用回调解耦 */
export type SubstituteFn = (
  content: string,
  state: CoreState,
  options: {
    name1Override?: string | null;
    name2Override?: string | null;
    replaceCharacterCard?: boolean;
  },
) => string;

export class MacroEnvBuilder {
  readonly #providers: { fn: MacroEnvProvider; order: number }[] = [];
  readonly #logger: MacroLogger;
  readonly #substitute: SubstituteFn;

  constructor(logger: MacroLogger, substitute: SubstituteFn) {
    this.#logger = logger;
    this.#substitute = substitute;
  }

  registerProvider(provider: MacroEnvProvider, order: number = env_provider_order.NORMAL): void {
    if (typeof provider !== 'function') throw new Error('Provider must be a function');
    this.#providers.push({ fn: provider, order });
  }

  buildFromRawEnv(state: CoreState, ctx: MacroEnvRawContext): MacroEnv {
    const env: MacroEnv = {
      content: ctx.content,
      contentHash: getStringHash(ctx.content),
      names: { user: '', char: '', group: '', groupNotMuted: '', notChar: '' },
      character: {},
      system: { model: '' },
      functions: { postProcess: (x) => x },
      dynamicMacros: {},
      extra: {},
      runtime: state,
    };

    if (ctx.replaceCharacterCard) {
      const fields = getCharacterCardFieldsLazy(state, (value, n1, n2) =>
        this.#substitute(value, state, {
          name1Override: n1,
          name2Override: n2,
          replaceCharacterCard: false,
        }),
      );
      const fieldMappings: ReadonlyArray<[keyof MacroEnvCharacter, keyof CharacterCardFields]> = [
        ['charPrompt', 'system'],
        ['charInstruction', 'jailbreak'],
        ['description', 'description'],
        ['personality', 'personality'],
        ['scenario', 'scenario'],
        ['persona', 'persona'],
        ['mesExamplesRaw', 'mesExamples'],
        ['version', 'version'],
        ['charDepthPrompt', 'charDepthPrompt'],
        ['creatorNotes', 'creatorNotes'],
        ['firstMessage', 'firstMessage'],
        ['alternateGreetings', 'alternateGreetings'],
      ];
      for (const [envKey, fieldKey] of fieldMappings) {
        Object.defineProperty(env.character, envKey, {
          get() {
            const value = fields[fieldKey];
            if (envKey === 'alternateGreetings') return Array.isArray(value) ? value : [];
            return value || '';
          },
          enumerable: true,
          configurable: true,
        });
      }
    }

    env.names.user = ctx.name1Override ?? state.userName ?? '';
    env.names.char = ctx.name2Override ?? state.charName ?? '';
    env.names.group = getGroupValue(state, ctx, {
      currentChar: env.names.char,
      includeMuted: true,
    });
    env.names.groupNotMuted = getGroupValue(state, ctx, {
      currentChar: env.names.char,
      includeMuted: false,
    });
    env.names.notChar = getGroupValue(state, ctx, {
      currentChar: env.names.char,
      filterOutChar: true,
      includeUser: env.names.user,
    });

    env.system.model = state.model;

    if (typeof ctx.original === 'string') {
      let originalSubstituted = false;
      const original = ctx.original;
      env.functions.original = () => {
        if (originalSubstituted) return '';
        originalSubstituted = true;
        return original;
      };
    }
    env.functions.postProcess =
      typeof ctx.postProcessFn === 'function' ? ctx.postProcessFn : (x) => x;

    if (ctx.dynamicMacros && typeof ctx.dynamicMacros === 'object') {
      for (const [key, value] of Object.entries(ctx.dynamicMacros)) {
        env.dynamicMacros[key.toLowerCase()] = value;
      }
    }

    const orderedProviders = this.#providers.slice().sort((a, b) => a.order - b.order);
    for (const { fn } of orderedProviders) {
      try {
        fn(env, ctx, state);
      } catch (e) {
        logMacroGeneralError(this.#logger, {
          message: 'MacroEnvBuilder: Provider error',
          error: e,
        });
      }
    }
    return env;
  }
}

function getGroupValue(
  state: CoreState,
  ctx: MacroEnvRawContext,
  {
    currentChar = null,
    includeMuted = false,
    filterOutChar = false,
    includeUser = null,
  }: {
    currentChar?: string | null;
    includeMuted?: boolean;
    filterOutChar?: boolean;
    includeUser?: string | null;
  },
): string {
  if (typeof ctx.groupOverride === 'string') return ctx.groupOverride;
  if (!state.selectedGroup) return filterOutChar ? includeUser || '' : (currentChar ?? '');
  const groupEntry = state.groups.find((x) => x && x.id === state.selectedGroup);
  const members = groupEntry?.members ?? [];
  const disabledMembers = groupEntry?.disabled_members ?? [];
  if (!Array.isArray(members)) return '';
  return members
    .filter((id) => (includeMuted ? true : !disabledMembers.includes(id)))
    .map((m) => state.characters.find((c) => c && c.avatar === m))
    .filter((c): c is NonNullable<typeof c> => !!c && typeof c.name === 'string')
    .filter((c) => !filterOutChar || c.name !== currentChar)
    .map((c) => c.name)
    .join(', ');
}
