// ST MacroRegistry.js 移植：宏定义、别名、参数数量/类型校验、执行上下文。
import type { CstNode } from 'chevrotain';
import { MACRO_IDENTIFIER_PATTERN } from './lexer.js';
import { isFalseBoolean, isTrueBoolean } from '../util/booleans.js';
import {
  createMacroRuntimeError,
  logMacroRegisterError,
  logMacroRegisterWarning,
  logMacroRuntimeWarning,
  type MacroLogger,
} from './diagnostics.js';
import type { MacroFlags } from './flags.js';
import type { MacroEnv } from './env.js';
import type { MacroCall } from './walker.js';

export const MacroCategory = Object.freeze({
  UTILITY: 'utility',
  RANDOM: 'random',
  NAMES: 'names',
  CHARACTER: 'character',
  CHAT: 'chat',
  TIME: 'time',
  VARIABLE: 'variable',
  PROMPTS: 'prompts',
  STATE: 'state',
  MISC: 'misc',
  UNCATEGORIZED: 'uncategorized',
});

export const MacroValueType = Object.freeze({
  STRING: 'string',
  INTEGER: 'integer',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
});
export type MacroValueTypeName = 'string' | 'integer' | 'number' | 'boolean';

export interface MacroAliasDef {
  alias: string;
  visible?: boolean;
}
export interface MacroResolvedAlias {
  alias: string;
  visible: boolean;
}
export interface MacroUnnamedArgDef {
  name: string;
  optional?: boolean;
  defaultValue?: string | undefined;
  type?: MacroValueTypeName | MacroValueTypeName[] | undefined;
  sampleValue?: string | undefined;
  description?: string | undefined;
}
export interface MacroListSpec {
  min?: number;
  max?: number;
}
export interface MacroSource {
  name: string;
  isExtension: boolean;
  isThirdParty: boolean;
}

export interface MacroExecutionContext {
  name: string;
  args: string[];
  unnamedArgs: string[];
  list: string[] | null;
  namedArgs: Record<string, string> | null;
  flags: MacroFlags;
  isScoped: boolean;
  raw: string;
  rawOriginal: string;
  rawArgs: string[];
  env: MacroEnv;
  cstNode: CstNode;
  range: { startOffset: number; endOffset: number };
  globalOffset: number;
  normalize: (value: unknown) => string;
  trimContent: (content: string, options?: { trimIndent?: boolean }) => string;
  resolve: (text: string, options?: { offsetDelta?: number }) => string;
  warn: (message: string, error?: unknown) => void;
  /** core 扩展：当前注册表（{{if}} 需要查宏定义） */
  registry: MacroRegistry;
}

export type MacroHandler = (context: MacroExecutionContext) => unknown;

export interface MacroDefinitionOptions {
  aliases?: MacroAliasDef[] | undefined;
  category?: string | undefined;
  unnamedArgs?: number | MacroUnnamedArgDef[] | undefined;
  list?: boolean | MacroListSpec | undefined;
  strictArgs?: boolean | undefined;
  description?: string | undefined;
  returns?: string | undefined;
  returnType?: MacroValueTypeName | MacroValueTypeName[] | undefined;
  displayOverride?: string | undefined;
  exampleUsage?: string | string[] | undefined;
  delayArgResolution?: boolean | undefined;
  handler: MacroHandler;
}

export interface MacroDefinition {
  name: string;
  aliases: MacroResolvedAlias[];
  category: string;
  minArgs: number;
  maxArgs: number;
  unnamedArgDefs: MacroUnnamedArgDef[];
  list: { min: number; max: number | null } | null;
  strictArgs: boolean;
  description: string;
  returns: string | null;
  returnType: MacroValueTypeName | MacroValueTypeName[];
  displayOverride: string | null;
  exampleUsage: string[];
  delayArgResolution: boolean;
  handler: MacroHandler;
  source: MacroSource;
  aliasOf: string | null;
  aliasVisible: boolean | null;
}

/** 执行宏时注册表需要的引擎能力 */
export interface MacroExecutionHelpers {
  normalize: (value: unknown) => string;
  trimContent: (content: string, options?: { trimIndent?: boolean }) => string;
  evaluate: (text: string, env: MacroEnv, options?: { contextOffset?: number }) => string;
}

const VALID_TYPES: readonly string[] = ['string', 'integer', 'number', 'boolean'];
const DEFAULT_SOURCE: MacroSource = { name: 'core', isExtension: false, isThirdParty: false };

export class MacroRegistry {
  readonly #macros = new Map<string, MacroDefinition>();
  readonly logger: MacroLogger;

  constructor(logger: MacroLogger) {
    this.logger = logger;
  }

  registerMacro(
    name: string,
    options: MacroDefinitionOptions,
    source?: MacroSource,
  ): MacroDefinition | null {
    name = typeof name === 'string' ? name.trim() : String(name);
    try {
      const definition = this.buildMacroDefFromOptions(name, options, {
        source: source ?? DEFAULT_SOURCE,
      });
      this.#registerMacroEntry(name, definition);
      for (const { alias, visible } of definition.aliases) {
        this.#registerMacroEntry(alias, definition, {
          primaryMacroName: name,
          aliasVisible: visible,
        });
      }
      return definition;
    } catch (error) {
      logMacroRegisterError(this.logger, {
        message: `Failed to register macro "${name}". The macro will not be available.`,
        macroName: name,
        error,
      });
      return null;
    }
  }

  registerMacroAlias(
    targetMacroName: string,
    aliasName: string,
    { visible = true, source }: { visible?: boolean; source?: MacroSource } = {},
  ): boolean {
    targetMacroName =
      typeof targetMacroName === 'string' ? targetMacroName.trim() : String(targetMacroName);
    aliasName = typeof aliasName === 'string' ? aliasName.trim() : String(aliasName);
    try {
      if (!isIdentifierValid(aliasName)) {
        throw new Error(
          `Alias name "${aliasName}" is invalid. Must start with a letter, followed by alphanumeric characters or hyphens.`,
        );
      }
      if (aliasName.toLowerCase() === targetMacroName.toLowerCase()) {
        throw new Error(
          `Alias name "${aliasName}" cannot be the same as the target macro name (case insensitive).`,
        );
      }
      const targetDefinition = this.getMacro(targetMacroName);
      if (!targetDefinition)
        throw new Error(`Target macro "${targetMacroName}" is not registered.`);
      const primaryDefinition = targetDefinition.aliasOf
        ? this.getMacro(targetDefinition.aliasOf)
        : targetDefinition;
      if (!primaryDefinition) {
        throw new Error(
          `Could not resolve primary definition for target macro "${targetMacroName}".`,
        );
      }
      const aliasDefinition: MacroDefinition = {
        ...primaryDefinition,
        source: { ...(source ?? DEFAULT_SOURCE) },
      };
      this.#registerMacroEntry(aliasName, aliasDefinition, {
        primaryMacroName: primaryDefinition.name,
        aliasVisible: visible,
      });
      return true;
    } catch (error) {
      logMacroRegisterError(this.logger, {
        message: `Failed to register alias "${aliasName}" for macro "${targetMacroName}". The alias will not be available.`,
        macroName: aliasName,
        error,
      });
      return false;
    }
  }

  #registerMacroEntry(
    name: string,
    definition: MacroDefinition,
    {
      primaryMacroName = null,
      aliasVisible = null,
    }: { primaryMacroName?: string | null; aliasVisible?: boolean | null } = {},
  ) {
    const nameKey = name.toLowerCase();
    if (this.#macros.has(nameKey)) {
      const warningType = primaryMacroName
        ? `Alias "${name}" for macro "${primaryMacroName}"`
        : `Macro "${name}"`;
      const warningMessage = primaryMacroName
        ? 'overwrites an existing macro.'
        : 'is already registered and will be overwritten.';
      logMacroRegisterWarning(this.logger, {
        macroName: primaryMacroName || name,
        message: `${warningType} ${warningMessage}`,
      });
    }
    const entry: MacroDefinition = primaryMacroName
      ? { ...definition, name, aliasOf: primaryMacroName, aliasVisible }
      : definition;
    this.#macros.set(nameKey, entry);
  }

  unregisterMacro(name: string): boolean {
    if (typeof name !== 'string' || !name.trim())
      throw new Error('Macro name must be a non-empty string');
    return this.#macros.delete(name.trim().toLowerCase());
  }

  hasMacro(name: string): boolean {
    if (typeof name !== 'string' || !name.trim()) return false;
    return this.#macros.has(name.trim().toLowerCase());
  }

  getMacro(name: string): MacroDefinition | undefined {
    if (typeof name !== 'string' || !name.trim()) return undefined;
    return this.#macros.get(name.trim().toLowerCase());
  }

  getPrimaryMacro(name: string): MacroDefinition | undefined {
    const def = this.getMacro(name);
    if (!def) return undefined;
    return def.aliasOf ? this.getMacro(def.aliasOf) : def;
  }

  getAllMacros({ excludeAliases = false, excludeHiddenAliases = false } = {}): MacroDefinition[] {
    let macros = Array.from(this.#macros.values());
    if (excludeAliases) macros = macros.filter((m) => !m.aliasOf);
    else if (excludeHiddenAliases)
      macros = macros.filter((m) => !m.aliasOf || m.aliasVisible !== false);
    return macros;
  }

  executeMacro(
    call: MacroCall,
    helpers: MacroExecutionHelpers,
    { defOverride }: { defOverride?: MacroDefinition | null } = {},
  ): string {
    const name = call.name;
    const def = defOverride || this.getMacro(name);
    if (!def) throw new Error(`Macro "${name}" is not registered`);

    const args = Array.isArray(call.args) ? call.args : [];

    if (!isArgsValid(def, args)) {
      const expectedMin = def.list ? def.minArgs + def.list.min : def.minArgs;
      const expectedMax =
        def.list && def.list.max !== null
          ? def.maxArgs + def.list.max
          : def.list
            ? null
            : def.maxArgs;
      const expectation = (() => {
        if (expectedMax !== null && expectedMax !== expectedMin)
          return `between ${expectedMin} and ${expectedMax}`;
        if (expectedMax !== null && expectedMax === expectedMin) return `${expectedMin}`;
        return `at least ${expectedMin}`;
      })();
      const message = `Macro "${def.name}" called with ${args.length} unnamed arguments but expects ${expectation}.`;
      if (def.strictArgs) throw createMacroRuntimeError({ message, call, def });
      logMacroRuntimeWarning(this.logger, { message, call, def });
    }

    const unnamedArgsCount = Math.min(args.length, def.maxArgs);
    const unnamedArgsValues = args.slice(0, unnamedArgsCount);
    const listValues = !def.list ? null : args.length > def.maxArgs ? args.slice(def.maxArgs) : [];

    this.#validateArgTypes(call, def, unnamedArgsValues);

    const executionContext: MacroExecutionContext = {
      name: def.name,
      args,
      unnamedArgs: unnamedArgsValues,
      list: listValues,
      namedArgs: null,
      flags: call.flags,
      isScoped: call.isScoped,
      raw: call.rawInner,
      rawOriginal: call.rawWithBraces,
      rawArgs: call.rawArgs,
      env: call.env,
      cstNode: call.cstNode,
      range: call.range,
      globalOffset: call.globalOffset,
      normalize: helpers.normalize,
      trimContent: helpers.trimContent,
      resolve: (text, { offsetDelta = 0 } = {}) =>
        helpers.evaluate(text, call.env, { contextOffset: call.globalOffset + offsetDelta }),
      warn: (message, error = undefined) =>
        logMacroRuntimeWarning(this.logger, { message, call, def, error }),
      registry: this,
    };

    const result = def.handler(executionContext);
    return executionContext.normalize(result);
  }

  buildMacroDefFromOptions(
    name: string,
    options: MacroDefinitionOptions | null | undefined,
    { source }: { source?: MacroSource } = {},
  ): MacroDefinition {
    name = typeof name === 'string' ? name.trim() : String(name);
    if (!isIdentifierValid(name)) {
      throw new Error(
        `Macro name "${name}" is invalid. Must start with a letter, followed by alphanumeric characters or hyphens.`,
      );
    }
    if (!options || typeof options !== 'object')
      throw new Error(`Macro "${name}" options must be a non-null object.`);

    const {
      aliases: rawAliases,
      category: rawCategory,
      unnamedArgs: rawUnnamedArgs,
      list: rawList,
      strictArgs: rawStrictArgs,
      description: rawDescription,
      returns: rawReturns,
      returnType: rawReturnType,
      displayOverride: rawDisplayOverride,
      exampleUsage: rawExampleUsage,
      delayArgResolution: rawDelayArgResolution,
      handler,
    } = options as Record<string, unknown> & MacroDefinitionOptions;

    if (typeof handler !== 'function')
      throw new Error(`Macro "${name}" options.handler must be a function.`);

    const aliases: MacroResolvedAlias[] = [];
    if (rawAliases !== undefined && rawAliases !== null) {
      if (!Array.isArray(rawAliases))
        throw new Error(`Macro "${name}" options.aliases must be an array.`);
      for (const [i, aliasDef] of rawAliases.entries()) {
        if (!aliasDef || typeof aliasDef !== 'object')
          throw new Error(`Macro "${name}" options.aliases[${i}] must be an object.`);
        if (typeof aliasDef.alias !== 'string' || !aliasDef.alias.trim()) {
          throw new Error(
            `Macro "${name}" options.aliases[${i}].alias must be a non-empty string.`,
          );
        }
        const aliasName = aliasDef.alias.trim();
        if (!isIdentifierValid(aliasName)) {
          throw new Error(
            `Macro "${name}" options.aliases[${i}].alias "${aliasName}" is invalid. Must start with a letter, followed by word chars or hyphens.`,
          );
        }
        if (aliasName.toLowerCase() === name.toLowerCase()) {
          throw new Error(
            `Macro "${name}" options.aliases[${i}].alias cannot be the same as the macro name (insensitive).`,
          );
        }
        aliases.push({ alias: aliasName, visible: aliasDef.visible !== false });
      }
    }

    let category: string = MacroCategory.UNCATEGORIZED;
    if (typeof rawCategory === 'string' && rawCategory.trim()) category = rawCategory.trim();

    let minArgs = 0;
    let maxArgs = 0;
    let unnamedArgDefs: MacroUnnamedArgDef[] = [];
    if (rawUnnamedArgs !== undefined) {
      if (Array.isArray(rawUnnamedArgs)) {
        let foundOptional = false;
        unnamedArgDefs = rawUnnamedArgs.map((def, index) => {
          if (!def || typeof def !== 'object') {
            throw new Error(
              `Macro "${name}" options.unnamedArgs[${index}] must be an object when using argument definitions.`,
            );
          }
          if (typeof def.name !== 'string' || !def.name.trim()) {
            throw new Error(
              `Macro "${name}" options.unnamedArgs[${index}].name must be a non-empty string when using argument definitions.`,
            );
          }
          if (foundOptional && !def.optional) {
            throw new Error(
              `Macro "${name}" options.unnamedArgs[${index}] is required but follows an optional argument. Optional args must be a suffix.`,
            );
          }
          if (def.optional) foundOptional = true;
          const rawType = def.type;
          const type: MacroValueTypeName | MacroValueTypeName[] =
            Array.isArray(rawType) && rawType.length === 0 ? 'string' : (rawType ?? 'string');
          const normalized: MacroUnnamedArgDef = {
            name: def.name.trim(),
            optional: def.optional || false,
            defaultValue: def.defaultValue?.trim(),
            type,
            sampleValue: def.sampleValue?.trim(),
            description: typeof def.description === 'string' ? def.description : undefined,
          };
          const types = Array.isArray(type) ? type : [type];
          if (types.some((t) => !VALID_TYPES.includes(t))) {
            throw new Error(
              `Macro "${name}" options.unnamedArgs[${index}].type must be one of "string", "integer", "number", or "boolean" when provided.`,
            );
          }
          return normalized;
        });
        maxArgs = unnamedArgDefs.length;
        minArgs = unnamedArgDefs.findIndex((d) => d.optional);
        if (minArgs === -1) minArgs = maxArgs;
      } else if (typeof rawUnnamedArgs === 'number') {
        if (!Number.isInteger(rawUnnamedArgs) || rawUnnamedArgs < 0) {
          throw new Error(
            `Macro "${name}" options.unnamedArgs must be a non-negative integer when provided.`,
          );
        }
        minArgs = rawUnnamedArgs;
        maxArgs = rawUnnamedArgs;
        unnamedArgDefs = Array.from({ length: rawUnnamedArgs }, (_, i) => ({
          name: `arg${i + 1}`,
          optional: false,
          type: 'string' as const,
          sampleValue: `arg${i + 1}`,
        }));
      } else {
        throw new Error(
          `Macro "${name}" options.unnamedArgs must be a non-negative integer or an array of argument definitions when provided.`,
        );
      }
    }

    let list: { min: number; max: number | null } | null = null;
    if (rawList !== undefined) {
      if (typeof rawList === 'boolean') {
        list = rawList ? { min: 0, max: null } : null;
      } else if (typeof rawList === 'object' && rawList !== null) {
        if (typeof rawList.min !== 'number' || rawList.min < 0) {
          throw new Error(
            `Macro "${name}" options.list.min must be a non-negative integer when provided.`,
          );
        }
        if (rawList.max !== undefined && typeof rawList.max !== 'number') {
          throw new Error(`Macro "${name}" options.list.max must be a number when provided.`);
        }
        if (rawList.max !== undefined && rawList.max < rawList.min) {
          throw new Error(
            `Macro "${name}" options.list.max must be greater than or equal to options.list.min.`,
          );
        }
        list = { min: rawList.min, max: rawList.max ?? null };
      } else {
        throw new Error(
          `Macro "${name}" options.list must be a boolean or an object with numeric min/max when provided.`,
        );
      }
    }

    let strictArgs = true;
    if (rawStrictArgs !== undefined) {
      if (typeof rawStrictArgs !== 'boolean')
        throw new Error(`Macro "${name}" options.strictArgs must be a boolean when provided.`);
      strictArgs = rawStrictArgs;
    }

    let description = '<no description>';
    if (rawDescription !== undefined) {
      if (typeof rawDescription !== 'string')
        throw new Error(`Macro "${name}" options.description must be a string when provided.`);
      description = rawDescription;
    }

    let returns: string | null = null;
    if (rawReturns !== undefined && rawReturns !== null) {
      if (typeof rawReturns !== 'string')
        throw new Error(`Macro "${name}" options.returns must be a string when provided.`);
      returns = rawReturns || '<empty string>';
    }

    let returnType: MacroValueTypeName | MacroValueTypeName[] = 'string';
    if (rawReturnType !== undefined && rawReturnType !== null) {
      returnType =
        Array.isArray(rawReturnType) && rawReturnType.length === 0 ? 'string' : rawReturnType;
      const typesToValidate = Array.isArray(returnType) ? returnType : [returnType];
      if (typesToValidate.some((t) => !VALID_TYPES.includes(t))) {
        throw new Error(
          `Macro "${name}" options.returnType must be one of "string", "integer", "number", or "boolean" (or an array of these) when provided.`,
        );
      }
    }

    let displayOverride: string | null = null;
    if (rawDisplayOverride !== undefined && rawDisplayOverride !== null) {
      if (typeof rawDisplayOverride !== 'string')
        throw new Error(`Macro "${name}" options.displayOverride must be a string when provided.`);
      displayOverride = rawDisplayOverride.trim();
      if (displayOverride && !displayOverride.startsWith('{{')) {
        logMacroRegisterWarning(this.logger, {
          macroName: name,
          message: `Macro "${name}" options.displayOverride should include curly braces. Auto-wrapping.`,
        });
        displayOverride = `{{${displayOverride}}}`;
      }
    }

    const exampleUsage: string[] = [];
    if (rawExampleUsage !== undefined && rawExampleUsage !== null) {
      const examples = Array.isArray(rawExampleUsage) ? rawExampleUsage : [rawExampleUsage];
      for (const [i, ex] of examples.entries()) {
        if (typeof ex !== 'string')
          throw new Error(`Macro "${name}" options.exampleUsage[${i}] must be a string.`);
        let trimmed = ex.trim();
        if (trimmed && !trimmed.startsWith('{{')) {
          logMacroRegisterWarning(this.logger, {
            macroName: name,
            message: `Macro "${name}" options.exampleUsage[${i}] should include curly braces. Auto-wrapping.`,
          });
          trimmed = `{{${trimmed}}}`;
        }
        if (trimmed) exampleUsage.push(trimmed);
      }
    }

    let delayArgResolution = false;
    if (rawDelayArgResolution !== undefined) {
      if (typeof rawDelayArgResolution !== 'boolean') {
        throw new Error(
          `Macro "${name}" options.delayArgResolution must be a boolean when provided.`,
        );
      }
      delayArgResolution = rawDelayArgResolution;
    }

    return {
      name,
      aliases,
      category,
      minArgs,
      maxArgs,
      unnamedArgDefs,
      list,
      strictArgs,
      description,
      returns,
      returnType,
      displayOverride,
      exampleUsage,
      delayArgResolution,
      handler: handler as MacroHandler,
      source: source ?? { name: 'dynamic', isExtension: false, isThirdParty: false },
      aliasOf: null,
      aliasVisible: null,
    };
  }

  #validateArgTypes(call: MacroCall, def: MacroDefinition, unnamedArgs: string[]) {
    if (def.unnamedArgDefs.length === 0) return;
    const defs = def.unnamedArgDefs;
    const count = Math.min(defs.length, unnamedArgs.length);
    for (let i = 0; i < count; i++) {
      const argDef = defs[i];
      const value = unnamedArgs[i];
      if (!argDef || !argDef.type || typeof value !== 'string') {
        throw new Error(`Macro "${call.name}" (position ${i + 1}) has invalid definition or type.`);
      }
      const types = Array.isArray(argDef.type) ? argDef.type : [argDef.type];
      if (!types.some((type) => isValueOfType(value, type))) {
        const argName = argDef.name || `Argument ${i + 1}`;
        const optionalLabel = argDef.optional ? ' (optional)' : '';
        const message = `Macro "${call.name}" (position ${i + 1}${optionalLabel}) argument "${argName}" expected type ${String(argDef.type)} but got value "${value}".`;
        if (def.strictArgs) throw createMacroRuntimeError({ message, call, def });
        logMacroRuntimeWarning(this.logger, { message, call, def });
      }
    }
  }
}

export function isIdentifierValid(name: string, { allowComment = true } = {}): boolean {
  if (typeof name !== 'string' || !name.trim()) return false;
  if (allowComment && name === '//') return true;
  return MACRO_IDENTIFIER_PATTERN.test(name);
}

function isArgsValid(def: MacroDefinition, args: unknown[]): boolean {
  if (def.list === null) return args.length >= def.minArgs && args.length <= def.maxArgs;
  const minRequired = def.minArgs + def.list.min;
  if (args.length < minRequired) return false;
  const listCount = Math.max(0, args.length - def.maxArgs);
  if (def.list.max !== null && listCount > def.list.max) return false;
  return true;
}

function isValueOfType(value: string, type: string): boolean {
  const trimmed = value.trim();
  if (type === 'string') return true;
  if (type === 'integer') return /^-?\d+$/.test(trimmed);
  if (type === 'number') return Number.isFinite(Number(trimmed));
  if (type === 'boolean') return isTrueBoolean(trimmed) || isFalseBoolean(trimmed);
  return false;
}
