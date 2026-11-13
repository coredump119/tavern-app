// ST MacroEngine.js 移植。一个 MacroEngine 实例拥有自己的注册表、环境构建器与前后处理器（ST 里是单例）。
import type { CoreState } from '../state.js';
import { ELSE_MARKER } from './constants.js';
import {
  consoleMacroLogger,
  isMacroRuntimeError,
  logMacroGeneralError,
  logMacroInternalError,
  logMacroRuntimeWarning,
  logMacroSyntaxWarning,
  type MacroLogger,
} from './diagnostics.js';
import { MacroEnvBuilder, type MacroEnv, type MacroEnvRawContext } from './env.js';
import { macroParser } from './parser.js';
import {
  MacroRegistry,
  MacroValueType,
  type MacroDefinition,
  type MacroDefinitionOptions,
} from './registry.js';
import { MacroCstWalker, type MacroCall } from './walker.js';
import { registerBuiltinMacros } from './definitions/index.js';

export type MacroProcessor = (text: string, env: MacroEnv) => string;
interface RegisteredProcessor {
  handler: MacroProcessor;
  priority: number;
  source: string;
}

export interface SubstituteOptions {
  name1Override?: string | null | undefined;
  name2Override?: string | null | undefined;
  original?: string | null | undefined;
  groupOverride?: string | null | undefined;
  replaceCharacterCard?: boolean | undefined;
  dynamicMacros?: Record<string, import('./env.js').DynamicMacroValue> | null | undefined;
  postProcessFn?: ((x: string) => string) | undefined;
}

export interface MacroEngineOptions {
  logger?: MacroLogger;
  /** 默认 true：注册 ST 全部内建宏 */
  registerBuiltins?: boolean;
}

export class MacroEngine {
  readonly logger: MacroLogger;
  readonly registry: MacroRegistry;
  readonly envBuilder: MacroEnvBuilder;
  readonly #walker: MacroCstWalker;
  #preProcessors: RegisteredProcessor[] = [];
  #postProcessors: RegisteredProcessor[] = [];

  constructor({ logger = consoleMacroLogger, registerBuiltins = true }: MacroEngineOptions = {}) {
    this.logger = logger;
    this.registry = new MacroRegistry(logger);
    this.envBuilder = new MacroEnvBuilder(logger, (content, state, options) =>
      this.substituteParams(content, state, options),
    );
    this.#walker = new MacroCstWalker({
      registry: this.registry,
      logger,
      normalize: (v) => this.normalizeMacroResult(v),
    });
    this.#registerCorePreProcessors();
    this.#registerCorePostProcessors();
    if (registerBuiltins) registerBuiltinMacros(this.registry);
  }

  addPreProcessor(handler: MacroProcessor, { priority = 100, source = 'unknown' } = {}): void {
    this.#preProcessors.push({ handler, priority, source });
    this.#preProcessors.sort((a, b) => a.priority - b.priority);
  }
  removePreProcessor(handler: MacroProcessor): boolean {
    const index = this.#preProcessors.findIndex((p) => p.handler === handler);
    if (index !== -1) {
      this.#preProcessors.splice(index, 1);
      return true;
    }
    return false;
  }
  addPostProcessor(handler: MacroProcessor, { priority = 100, source = 'unknown' } = {}): void {
    this.#postProcessors.push({ handler, priority, source });
    this.#postProcessors.sort((a, b) => a.priority - b.priority);
  }
  removePostProcessor(handler: MacroProcessor): boolean {
    const index = this.#postProcessors.findIndex((p) => p.handler === handler);
    if (index !== -1) {
      this.#postProcessors.splice(index, 1);
      return true;
    }
    return false;
  }

  /** 对应 ST script.js substituteParams（仅新引擎路径） */
  substituteParams(content: string, state: CoreState, options: SubstituteOptions = {}): string {
    if (!content) return '';
    if (typeof content !== 'string') content = String(content);
    const ctx: MacroEnvRawContext = {
      content,
      name1Override: options.name1Override,
      name2Override: options.name2Override,
      original: options.original,
      groupOverride: options.groupOverride,
      replaceCharacterCard: options.replaceCharacterCard ?? true,
      dynamicMacros: options.dynamicMacros ?? {},
      postProcessFn: options.postProcessFn ?? ((x) => x),
    };
    const env = this.envBuilder.buildFromRawEnv(state, ctx);
    return this.evaluate(content, env);
  }

  buildEnv(state: CoreState, ctx: MacroEnvRawContext): MacroEnv {
    return this.envBuilder.buildFromRawEnv(state, ctx);
  }

  evaluate(input: string, env: MacroEnv, { contextOffset = 0 } = {}): string {
    if (!input) return '';
    const safeEnv = Object.freeze({ ...env }) as MacroEnv;
    const preProcessed = this.#runPreProcessors(input, safeEnv);
    const { cst, lexingErrors, parserErrors } = macroParser.parseDocument(preProcessed);

    if (lexingErrors && lexingErrors.length > 0) {
      logMacroSyntaxWarning(this.logger, { phase: 'lexing', input, errors: lexingErrors });
    }
    if (parserErrors && parserErrors.length > 0) {
      logMacroSyntaxWarning(this.logger, { phase: 'parsing', input, errors: parserErrors });
    }
    if (!cst || typeof cst !== 'object' || !cst.children) {
      logMacroGeneralError(this.logger, {
        message: 'Macro parser produced an invalid CST. Returning original input.',
        error: { input, lexingErrors, parserErrors },
      });
      return input;
    }

    let evaluated: string;
    try {
      evaluated = this.#walker.evaluateDocument({
        text: preProcessed,
        contextOffset,
        cst,
        env: safeEnv,
        resolveMacro: (call) => this.#resolveMacro(call),
        trimContent: (content, options) => this.trimScopedContent(content, options),
      });
    } catch (error) {
      logMacroGeneralError(this.logger, {
        message: 'Macro evaluation failed. Returning original input.',
        error: { input, error },
      });
      return input;
    }
    return this.#runPostProcessors(evaluated, safeEnv);
  }

  #resolveMacro(call: MacroCall): string {
    const { name, env } = call;
    const raw = `{{${call.rawInner}}}`;
    if (!name) return raw;

    let defOverride: MacroDefinition | null = null;
    const nameLower = name.toLowerCase();
    if (Object.hasOwn(env.dynamicMacros, nameLower)) {
      const impl = env.dynamicMacros[nameLower];
      const looksLikeOptions =
        !!impl &&
        typeof impl === 'object' &&
        'handler' in impl &&
        typeof (impl as MacroDefinitionOptions).handler === 'function';
      if (looksLikeOptions) {
        try {
          defOverride = this.registry.buildMacroDefFromOptions(
            name,
            impl as MacroDefinitionOptions,
          );
        } catch (error) {
          logMacroRuntimeWarning(this.logger, {
            message: `Dynamic macro "${name}" has invalid options: ${(error as Error).message}`,
            call,
          });
        }
      } else if (['string', 'number', 'boolean', 'function'].includes(typeof impl)) {
        if (['number', 'boolean'].includes(typeof impl)) {
          logMacroRuntimeWarning(this.logger, {
            message: `Dynamic macro "${name}" uses unsupported number/boolean format.`,
            call,
          });
        }
        defOverride = this.registry.buildMacroDefFromOptions(name, {
          handler: typeof impl === 'function' ? impl : () => String(impl ?? ''),
          category: 'dynamic',
          description: 'Dynamic macro',
          returnType: MacroValueType.STRING,
        });
      } else {
        logMacroRuntimeWarning(this.logger, {
          message: `Dynamic macro "${name}" is not defined correctly (must be string, a handler function, or a macro def options object with handler property).`,
          call,
        });
      }
    }

    if (!defOverride && !this.registry.hasMacro(name)) return raw;

    try {
      const result = this.registry.executeMacro(
        call,
        {
          normalize: (v) => this.normalizeMacroResult(v),
          trimContent: (c, o) => this.trimScopedContent(c, o),
          evaluate: (text, e, o) => this.evaluate(text, e, o),
        },
        { defOverride },
      );
      try {
        return call.env.functions.postProcess(result);
      } catch (error) {
        logMacroInternalError(this.logger, {
          message: `Macro "${name}" postProcess function failed.`,
          call,
          error,
        });
        return result;
      }
    } catch (error) {
      if (isMacroRuntimeError(error)) {
        logMacroRuntimeWarning(this.logger, {
          message: error.message || `Macro "${name}" execution failed.`,
          call,
          error,
        });
      } else {
        logMacroInternalError(this.logger, {
          message: `Macro "${name}" internal execution error.`,
          call,
          error,
        });
      }
      return raw;
    }
  }

  #runPreProcessors(text: string, env: MacroEnv): string {
    let result = text;
    for (const { handler } of this.#preProcessors) result = handler(result, env);
    return result;
  }
  #runPostProcessors(text: string, env: MacroEnv): string {
    let result = text;
    for (const { handler } of this.#postProcessors) result = handler(result, env);
    return result;
  }

  #registerCorePreProcessors() {
    // {{time_UTC-10}} => {{time::UTC-10}}
    this.addPreProcessor(
      (text) =>
        text.replace(
          /{{time_(UTC[+-]\d+)}}/gi,
          (_m, utcOffset: string) => `{{time::${utcOffset}}}`,
        ),
      {
        priority: 10,
        source: 'core:legacy-time-syntax',
      },
    );
    this.addPreProcessor(
      (text) =>
        text
          .replace(/<USER>/gi, '{{user}}')
          .replace(/<BOT>/gi, '{{char}}')
          .replace(/<CHAR>/gi, '{{char}}')
          .replace(/<GROUP>/gi, '{{group}}')
          .replace(/<CHARIFNOTGROUP>/gi, '{{charIfNotGroup}}'),
      { priority: 20, source: 'core:legacy-markers' },
    );
  }

  #registerCorePostProcessors() {
    this.addPostProcessor((text) => text.replace(/\\([{}])/g, '$1'), {
      priority: 10,
      source: 'core:unescape-braces',
    });
    this.addPostProcessor((text) => text.replace(/(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, ''), {
      priority: 20,
      source: 'core:legacy-trim',
    });
    this.addPostProcessor((text) => text.replaceAll(ELSE_MARKER, ''), {
      priority: 30,
      source: 'core:cleanup-else-marker',
    });
  }

  normalizeMacroResult(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  trimScopedContent(content: string, { trimIndent = true }: { trimIndent?: boolean } = {}): string {
    if (!content) return '';
    if (!trimIndent) return content.trim();
    const lines = content.split('\n');
    let baseIndent = 0;
    for (const line of lines) {
      if (line.trim() !== '') {
        baseIndent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
        break;
      }
    }
    if (baseIndent === 0) return content.trim();
    const dedentedLines = lines.map((line) => {
      const lineIndent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
      return lineIndent >= baseIndent ? line.slice(baseIndent) : line.trimStart();
    });
    return dedentedLines.join('\n').trim();
  }
}
