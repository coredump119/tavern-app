export {
  MacroEngine,
  type MacroEngineOptions,
  type MacroProcessor,
  type SubstituteOptions,
} from './engine.js';
export { MacroRegistry, MacroCategory, MacroValueType, isIdentifierValid } from './registry.js';
export type {
  MacroDefinition,
  MacroDefinitionOptions,
  MacroExecutionContext,
  MacroHandler,
  MacroUnnamedArgDef,
  MacroAliasDef,
  MacroListSpec,
  MacroSource,
  MacroValueTypeName,
} from './registry.js';
export { MacroEnvBuilder, env_provider_order } from './env.js';
export type {
  MacroEnv,
  MacroEnvRawContext,
  MacroEnvProvider,
  DynamicMacroValue,
  MacroEnvCharacter,
  MacroEnvNames,
} from './env.js';
export { MacroFlagType, parseFlags, createEmptyFlags, type MacroFlags } from './flags.js';
export {
  macroLexer,
  tokenizeForTest,
  MACRO_IDENTIFIER_PATTERN,
  MACRO_VARIABLE_SHORTHAND_PATTERN,
} from './lexer.js';
export { macroParser, type MacroParser, type ParseDocumentResult } from './parser.js';
export { MacroCstWalker, type MacroCall } from './walker.js';
export {
  consoleMacroLogger,
  createCapturingLogger,
  MacroRuntimeError,
  isMacroRuntimeError,
  type MacroLogger,
  type CapturedMacroLog,
} from './diagnostics.js';
export { createVariableScope, createVariableScopes, type VariableStore } from './variables.js';
export {
  registerBuiltinMacros,
  getChatIdHash,
  getLastMessageId,
  getTimeSinceLastMessage,
} from './definitions/index.js';
export { ELSE_MARKER } from './constants.js';
