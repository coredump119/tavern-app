/**
 * Runs a parsed slash script: scopes, the pipe, argument substitution, closures. The behaviour
 * follows ST's `SlashCommandClosure` / `SlashCommandScope`; commands themselves live in a registry
 * (`commands.ts` for the ones that need nothing from the app, the app registers the rest).
 */
import {
  parseSlash,
  SlashError,
  type ClosureNode,
  type CommandNode,
  type CommandShape,
  type ValueNode,
} from './parser.js';

/** ST's `isTrueBoolean` / `isFalseBoolean` */
export const isTrue = (value: unknown): boolean =>
  ['on', 'true', '1'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
export const isFalse = (value: unknown): boolean =>
  ['off', 'false', '0'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );

/** ST's number-or-string reading of a stored value */
export function readValue(value: unknown): unknown {
  const blank = typeof value === 'string' && value.trim() === '';
  return blank || isNaN(Number(value)) ? value || '' : Number(value);
}

/** ST `convertValueType` (the `as=` argument) */
export function convertValue(value: unknown, type: unknown): unknown {
  if (value instanceof SlashClosure || typeof type !== 'string') return value;
  const parse = (fallback: unknown, accept: (v: unknown) => boolean) => {
    try {
      const parsed: unknown = JSON.parse(String(value));
      return accept(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  };
  switch (type.trim().toLowerCase()) {
    case 'string':
    case 'str':
      return String(value);
    case 'null':
      return null;
    case 'undefined':
    case 'none':
      return undefined;
    case 'number':
      return Number(value);
    case 'int':
      return parseInt(String(value), 10);
    case 'float':
      return parseFloat(String(value));
    case 'boolean':
    case 'bool':
      return isTrue(value);
    case 'list':
    case 'array':
      return parse([], Array.isArray);
    case 'object':
    case 'dict':
    case 'dictionary':
      return parse({}, (v) => typeof v === 'object' && v !== null && !Array.isArray(v));
    default:
      return value;
  }
}

/** Read `value[index]` out of a JSON-encoded variable; objects come back re-encoded */
export function readIndexed(value: unknown, index: unknown): unknown {
  try {
    const parsed = JSON.parse(String(value)) as Record<string, unknown> | null;
    const item = parsed?.[String(index)];
    return typeof item === 'object' && item !== null ? JSON.stringify(item) : item;
  } catch {
    return value;
  }
}
/** Write `value[index]` into a JSON-encoded variable (created as a list or an object as needed) */
export function writeIndexed(current: unknown, index: unknown, value: unknown): string | null {
  try {
    const numeric = !Number.isNaN(Number(index));
    const parsed = (JSON.parse(String(current ?? 'null')) ?? (numeric ? [] : {})) as Record<
      string,
      unknown
    >;
    parsed[String(index)] = value;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

export class Scope {
  private readonly variables = new Map<string, unknown>();
  private readonly macros = new Map<string, unknown>();
  private ownPipe: unknown = undefined;

  constructor(readonly parent: Scope | null = null) {}

  get pipe(): unknown {
    return this.ownPipe ?? this.parent?.pipe;
  }
  set pipe(value: unknown) {
    this.ownPipe = value;
  }

  setMacro(name: string, value: unknown): void {
    this.macros.set(name, value);
  }
  macro(name: string): { value: unknown } | undefined {
    if (this.macros.has(name)) return { value: this.macros.get(name) };
    return this.parent?.macro(name);
  }

  exists(name: string): boolean {
    return this.variables.has(name) || (this.parent?.exists(name) ?? false);
  }
  /** `/let` */
  declare(name: string, value?: unknown): void {
    if (this.variables.has(name)) throw new SlashError(`变量 "${name}" 已经存在`);
    this.variables.set(name, value);
  }
  /** `/var name value` */
  assign(name: string, value: unknown, index?: unknown, type?: unknown): unknown {
    if (!this.variables.has(name)) {
      if (this.parent) return this.parent.assign(name, value, index, type);
      throw new SlashError(`没有这个变量："${name}"`);
    }
    if (index === undefined || index === null) {
      this.variables.set(name, value);
    } else {
      const next = writeIndexed(this.variables.get(name), index, convertValue(value, type));
      if (next !== null) this.variables.set(name, next);
    }
    return value;
  }
  /** `/var name` and `{{var::name}}` */
  read(name: string, index?: unknown): unknown {
    if (!this.variables.has(name)) {
      if (this.parent) return this.parent.read(name, index);
      throw new SlashError(`没有这个变量："${name}"`);
    }
    const value = this.variables.get(name);
    if (index === undefined || index === null) {
      return value instanceof SlashClosure ? value : readValue(value);
    }
    return readIndexed(value, index) ?? '';
  }
}

interface Breaker {
  broken: boolean;
}

/** A closure as a value: the code plus the scope it was written in */
export class SlashClosure {
  constructor(
    readonly node: ClosureNode,
    readonly scope: Scope,
    /** where a `/break` inside lands unless the caller starts a new loop */
    readonly breaker: Breaker,
  ) {}
}

export interface SlashResult {
  pipe: unknown;
  aborted: boolean;
  /** ended by `/break` */
  broke: boolean;
}

export interface CallOptions {
  /** values for the closure's parameters (`/run name a=1`) */
  args?: Record<string, unknown>;
  /** scope macros such as `{{timesIndex}}` */
  macros?: Record<string, unknown>;
  /** loops and `/run`: a `/break` inside ends this call only */
  loop?: boolean;
}

export interface CommandContext {
  scope: Scope;
  /** an unnamed argument was written, or the pipe stood in for it */
  hasUnnamed: boolean;
  readonly aborted: boolean;
  abort(): void;
  /** Run a closure, or command text as a sub-script of this scope */
  call(target: SlashClosure | string, options?: CallOptions): Promise<SlashResult>;
}

export type Named = Record<string, unknown>;
export interface SlashCommand extends CommandShape {
  /** named arguments that may be written more than once; each arrives as a list (ST `acceptsMultiple`) */
  repeatable?: readonly string[];
  run(named: Named, unnamed: unknown, context: CommandContext): unknown;
}
export type CommandRegistry = Pick<ReadonlyMap<string, SlashCommand>, 'get'>;

interface RunState {
  aborted: boolean;
}

const SCOPE_MACRO = /\{\{(?:(pipe)|var::([^\s:}]+)(?:::((?:(?!\}\}).)+))?|([\w-]+))\}\}/g;
const unescapeBraces = (text: string) => text.replace(/\\\{/g, '{').replace(/\\\}/g, '}');

export class SlashRunner {
  constructor(
    private readonly commands: CommandRegistry,
    /** ST macro substitution for argument text (`{{user}}`, `{{getvar::x}}`…) */
    private readonly substitute: (text: string) => string = (text) => text,
  ) {}

  /** Run a script. Throws `SlashError` for a syntax error or an unknown command. */
  async run(text: string, parent: Scope | null = null): Promise<SlashResult> {
    return this.runText(text, parent, { aborted: false });
  }

  private lookup = (name: string) => this.commands.get(name);

  private async runText(text: string, parent: Scope | null, state: RunState): Promise<SlashResult> {
    const node = parseSlash(text, this.lookup);
    return this.execute(node, new Scope(parent), { broken: false }, state);
  }

  private async call(
    target: SlashClosure | string,
    scope: Scope,
    state: RunState,
    options: CallOptions,
  ): Promise<SlashResult> {
    if (typeof target === 'string') {
      const quoted = target.length > 1 && target.startsWith('"') && target.endsWith('"');
      return this.runText(quoted ? target.slice(1, -1) : target, scope, state);
    }
    const inner = new Scope(target.scope);
    for (const [name, value] of Object.entries(options.macros ?? {})) inner.setMacro(name, value);
    for (const param of target.node.params) {
      inner.declare(param.name, await this.value(param.value, inner, target.breaker, state));
    }
    for (const [name, value] of Object.entries(options.args ?? {})) {
      if (target.node.params.some((p) => p.name === name)) inner.assign(name, value);
    }
    const breaker = options.loop ? { broken: false } : target.breaker;
    return this.execute(target.node, inner, breaker, state);
  }

  /** A named value, a parameter default, or one part of the unnamed argument */
  private async value(
    node: ValueNode,
    scope: Scope,
    breaker: Breaker,
    state: RunState,
  ): Promise<unknown> {
    if (typeof node === 'string') {
      const value = this.substituteIn(node, scope);
      return typeof value === 'string' ? unescapeBraces(value) : value;
    }
    const closure = new SlashClosure(node, scope, breaker);
    return node.immediate ? (await this.call(closure, scope, state, {})).pipe : closure;
  }

  /** `{{pipe}}`, `{{var::name}}`, scope macros, then the host's macros. A lone closure macro stays a closure. */
  private substituteIn(text: string, scope: Scope): unknown {
    if (!text.includes('{{')) return text;
    let closure: SlashClosure | null = null;
    const out = text.replace(SCOPE_MACRO, (match, pipe, name, index, macro) => {
      let value: unknown;
      if (pipe) value = scope.pipe;
      else if (name) value = scope.read(name as string, index as string | undefined);
      else {
        const found = scope.macro(macro as string);
        if (!found) return match;
        value = found.value;
      }
      if (value instanceof SlashClosure) {
        closure = value;
        return '';
      }
      return String(value ?? '');
    });
    if (closure && out.trim() === '') return closure;
    return this.substitute(out);
  }

  private async unnamed(
    command: CommandNode,
    scope: Scope,
    breaker: Breaker,
    state: RunState,
  ): Promise<{ value: unknown; has: boolean }> {
    if (command.unnamed.length === 0) {
      if (!command.injectPipe) return { value: undefined, has: false };
      const pipe = scope.pipe;
      return { value: pipe, has: pipe !== null && pipe !== undefined };
    }
    const values: unknown[] = [];
    for (const part of command.unnamed) values.push(await this.value(part, scope, breaker, state));
    const split = this.commands.get(command.name)?.split === true;
    if (split) return { value: values, has: true };
    if (values.length === 1) return { value: values[0], has: true };
    if (values.some((v) => v instanceof SlashClosure)) return { value: values, has: true };
    return { value: values.join(''), has: true };
  }

  private async execute(
    node: ClosureNode,
    scope: Scope,
    breaker: Breaker,
    state: RunState,
  ): Promise<SlashResult> {
    if (node.commands.length === 0) scope.pipe = '';
    for (const command of node.commands) {
      if (state.aborted || breaker.broken) break;
      const { value, has } = await this.unnamed(command, scope, breaker, state);
      if (command.name === 'break') {
        breaker.broken = true;
        if (has) scope.pipe = value;
        break;
      }
      const spec = this.commands.get(command.name);
      if (!spec) throw new SlashError(`未支持的 slash 命令：/${command.name}`);
      const named: Named = {};
      for (const arg of command.named) {
        const given = await this.value(arg.value, scope, breaker, state);
        if (!spec.repeatable?.includes(arg.name)) named[arg.name] = given;
        else if (Array.isArray(named[arg.name])) (named[arg.name] as unknown[]).push(given);
        else named[arg.name] = [given];
      }
      const context: CommandContext = {
        scope,
        hasUnnamed: has,
        get aborted() {
          return state.aborted;
        },
        abort: () => {
          state.aborted = true;
        },
        call: (target, options = {}) => this.call(target, scope, state, options),
      };
      scope.pipe = await spec.run(named, value ?? '', context);
    }
    return { pipe: scope.pipe, aborted: state.aborted, broke: breaker.broken };
  }
}
