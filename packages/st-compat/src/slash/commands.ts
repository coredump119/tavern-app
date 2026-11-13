/**
 * The slash commands that need nothing from the app: flow control, script variables, math, and
 * chat / global variables through a small host interface. Semantics follow ST 1.18.0
 * (`variables.js`, `slash-commands.js`); see DEV_NOTES §9.5 第 2 轮 for the supported subset.
 */
import {
  convertValue,
  isFalse,
  isTrue,
  readIndexed,
  readValue,
  SlashClosure,
  writeIndexed,
  type CommandContext,
  type Named,
  type Scope,
  type SlashCommand,
} from './executor.js';
import { SlashError } from './parser.js';

export type VariableKind = 'local' | 'global';
/** Chat (`local`) and global variables as the app stores them */
export interface VariableHost {
  get(kind: VariableKind, name: string): unknown;
  set(kind: VariableKind, name: string, value: unknown): void;
  delete(kind: VariableKind, name: string): void;
}

export interface CoreCommandHost {
  variables: VariableHost;
  /** `/delay`; injected so tests need no timers */
  wait?: (ms: number) => Promise<void>;
  /** `/rand`; injected so tests are deterministic */
  random?: () => number;
}

/** ST `resolveVariable`: script variable → chat variable → global variable → the name itself */
export function resolveVariable(variables: VariableHost, name: string, scope: Scope): unknown {
  if (scope.exists(name)) return scope.read(name);
  for (const kind of ['local', 'global'] as const) {
    const value = variables.get(kind, name);
    if (value !== undefined && value !== null) return readValue(value);
  }
  return name;
}

/** `/while` and `/times` stop here unless `guard=off` */
export const MAX_LOOPS = 100;

const text = (value: unknown): string => (value instanceof SlashClosure ? '' : String(value ?? ''));
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
/** The script of a split command: a closure, or its words joined back into command text */
const script = (parts: unknown[]): SlashClosure | string => {
  const closure = parts.find((part) => part instanceof SlashClosure);
  return closure ?? parts.map(text).join(' ');
};
const variableName = (named: Named, unnamed: unknown): string => {
  const name = text(named['key'] ?? named['name'] ?? unnamed).trim();
  if (!name) throw new SlashError('变量名不能为空');
  return name;
};

function evalBoolean(rule: unknown, a: unknown, b: unknown): boolean {
  if (a === undefined) throw new SlashError('没有给出左操作数');
  if (b === undefined) {
    if (rule !== undefined && rule !== 'not') {
      throw new SlashError(`只有一个操作数时 rule 只能省略或为 not：${text(rule)}`);
    }
    const truthy = rule !== 'not';
    if (isTrue(a)) return truthy;
    if (isFalse(a)) return !truthy;
    return a ? truthy : !truthy;
  }
  const op = rule ?? 'eq';
  if (typeof a === 'number' && typeof b === 'number') {
    switch (op) {
      case 'gt':
        return a > b;
      case 'gte':
        return a >= b;
      case 'lt':
        return a < b;
      case 'lte':
        return a <= b;
      case 'eq':
        return a === b;
      case 'neq':
        return a !== b;
      case 'in':
      case 'nin':
        break;
      default:
        throw new SlashError(`数字不支持这个比较规则：${text(op)}`);
    }
  }
  const lower = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)).toLowerCase();
  const left = lower(a);
  const right = lower(b);
  switch (op) {
    case 'in':
      return left.includes(right);
    case 'nin':
      return !left.includes(right);
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
    default:
      throw new SlashError(`文本不支持这个比较规则：${text(op)}`);
  }
}

/**
 * ST `getLocalVariable` / `setLocalVariable` / `addLocalVariable` (variables.js) and their global
 * twins: what `/getvar` `/setvar` `/addvar` run, and what `getContext().variables` hands out.
 */
export function variableOps(variables: VariableHost) {
  const getVariable = (kind: VariableKind, name: string, index?: unknown) => {
    const value = variables.get(kind, name);
    return readValue(index === undefined ? value : readIndexed(value, index));
  };
  const setVariable = (kind: VariableKind, name: string, value: unknown, named: Named = {}) => {
    if (named['index'] === undefined) {
      variables.set(kind, name, value);
    } else {
      const next = writeIndexed(
        variables.get(kind, name),
        named['index'],
        convertValue(value, named['as']),
      );
      if (next !== null) variables.set(kind, name, next);
    }
    return value;
  };
  const addVariable = (kind: VariableKind, name: string, value: unknown) => {
    const current = getVariable(kind, name) || 0;
    try {
      const parsed: unknown = JSON.parse(String(current));
      if (Array.isArray(parsed)) {
        parsed.push(value);
        variables.set(kind, name, JSON.stringify(parsed));
        return JSON.stringify(parsed);
      }
    } catch {
      /* not a list */
    }
    const increment = Number(value);
    if (Number.isNaN(increment) || Number.isNaN(Number(current))) {
      const joined = String(current || '') + text(value);
      variables.set(kind, name, joined);
      return joined;
    }
    const sum = Number(current) + increment;
    if (Number.isNaN(sum)) return '';
    variables.set(kind, name, sum);
    return sum;
  };
  return { getVariable, setVariable, addVariable };
}

export function coreCommands(host: CoreCommandHost): Map<string, SlashCommand> {
  const { variables } = host;
  const wait = host.wait ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  const random = host.random ?? Math.random;
  const commands = new Map<string, SlashCommand>();
  const add = (names: string | string[], command: SlashCommand) => {
    for (const name of list(names) as string[]) commands.set(name, command);
  };

  const { getVariable, setVariable, addVariable } = variableOps(variables);
  const resolve = (name: string, scope: Scope): unknown => resolveVariable(variables, name, scope);

  // ── chat / global variables ────────────────────────────────────────────
  for (const [kind, infix] of [
    ['local', ''],
    ['global', 'global'],
  ] as const) {
    add(`set${infix}var`, {
      run: (named, value) => text(setVariable(kind, variableName(named, undefined), value, named)),
    });
    add(`get${infix}var`, {
      run: (named, value) => text(getVariable(kind, variableName(named, value), named['index'])),
    });
    add(`add${infix}var`, {
      run: (named, value) => text(addVariable(kind, variableName(named, undefined), value)),
    });
    add(`inc${infix}var`, {
      run: (_named, value) => text(addVariable(kind, variableName({}, value), 1)),
    });
    add(`dec${infix}var`, {
      run: (_named, value) => text(addVariable(kind, variableName({}, value), -1)),
    });
    add(`flush${infix}var`, {
      run: (_named, value) => {
        variables.delete(kind, variableName({}, value));
        return '';
      },
    });
  }

  // ── script variables ───────────────────────────────────────────────────
  const scoped = (declare: boolean): SlashCommand => ({
    split: true,
    splitCount: 1,
    run: (named, unnamed, { scope, hasUnnamed }) => {
      const parts = hasUnnamed ? [...list(unnamed)] : [];
      const key = named['key'] !== undefined ? named['key'] : parts.shift();
      if (typeof key !== 'string' || !key) throw new SlashError('变量名必须是文本');
      const has = parts.length > 0;
      const value = typeof parts[0] === 'string' ? parts.map(text).join(' ') : parts[0];
      if (declare) {
        scope.declare(key, has ? value : undefined);
        return has ? value : '';
      }
      if (!has) return scope.read(key, named['index']);
      scope.assign(key, value, named['index'], named['as']);
      return value;
    },
  });
  add('let', scoped(true));
  add('var', scoped(false));

  // ── flow ───────────────────────────────────────────────────────────────
  const operands = (named: Named, scope: Scope) => {
    const operand = (value: unknown): unknown => {
      if (value === undefined || value === '') return value;
      if (typeof value !== 'string') return value;
      if (value.trim() && !Number.isNaN(Number(value))) return Number(value);
      const resolved = resolve(value, scope);
      return resolved ?? '';
    };
    return {
      a: operand(named['a'] ?? named['left'] ?? named['first'] ?? named['x']),
      b: operand(named['b'] ?? named['right'] ?? named['second'] ?? named['y']),
    };
  };
  const test = (named: Named, scope: Scope) => {
    const { a, b } = operands(named, scope);
    return evalBoolean(named['rule'], a, b);
  };

  add('if', {
    split: true,
    run: async (named, unnamed, context) => {
      const branch = test(named, context.scope)
        ? script(list(unnamed))
        : (named['else'] as SlashClosure | string | undefined);
      if (!branch) return '';
      return (await context.call(branch)).pipe ?? '';
    },
  });
  add('while', {
    split: true,
    run: async (named, unnamed, context) => {
      const body = script(list(unnamed));
      const limit = isFalse(named['guard']) ? Number.MAX_SAFE_INTEGER : MAX_LOOPS;
      let pipe: unknown = '';
      for (let i = 0; i < limit && body && test(named, context.scope); i++) {
        const result = await context.call(body, { loop: true });
        pipe = result.pipe;
        if (result.aborted || result.broke) break;
      }
      return pipe ?? '';
    },
  });
  add('times', {
    split: true,
    splitCount: 1,
    run: async (named, unnamed, context) => {
      const [repeats, ...rest] = list(unnamed);
      const body = script(rest);
      const limit = isFalse(named['guard']) ? Number.MAX_SAFE_INTEGER : MAX_LOOPS;
      const count = Math.min(Number(repeats), limit);
      let pipe: unknown = '';
      for (let i = 0; i < count; i++) {
        const result =
          typeof body === 'string'
            ? await context.call(body.replace(/\{\{timesIndex\}\}/g, String(i)), { loop: true })
            : await context.call(body, { loop: true, macros: { timesIndex: i } });
        pipe = result.pipe;
        if (result.aborted || result.broke) break;
      }
      return pipe ?? '';
    },
  });
  add(['run', 'call', 'exec'], {
    run: async (named, unnamed, context) => {
      const target = list(unnamed)[0];
      const closure =
        target instanceof SlashClosure
          ? target
          : context.scope.exists(text(target))
            ? context.scope.read(text(target))
            : undefined;
      if (!(closure instanceof SlashClosure)) {
        throw new SlashError(`/run 找不到闭包变量："${text(target)}"（快速回复暂不支持）`);
      }
      return (await context.call(closure, { args: named, loop: true })).pipe ?? '';
    },
  });
  add(['pass', 'return'], { run: (_named, value) => value });
  add('abort', {
    run: (_named, _value, context) => {
      context.abort();
      return '';
    },
  });
  add(['delay', 'wait', 'sleep'], {
    run: async (_named, value) => {
      const ms = Number(value);
      if (ms > 0) await wait(ms);
      return '';
    },
  });

  // ── math ───────────────────────────────────────────────────────────────
  const series = (value: unknown, scope: Scope): number[] => {
    if (typeof value === 'number') return [value];
    let values = Array.isArray(value) ? (value as unknown[]) : text(value).split(' ');
    const only = values[0];
    if (values.length === 1 && typeof only === 'string' && only.trim().startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(only);
        if (Array.isArray(parsed)) values = parsed;
      } catch {
        /* not a JSON list */
      }
    }
    return values
      .map((item) => (typeof item === 'string' ? item.trim() : item))
      .filter((item) => item !== '')
      .map((item) => {
        const n = Number(item);
        return Number.isNaN(n) && typeof item === 'string' ? Number(resolve(item, scope)) : n;
      })
      .filter((n) => !Number.isNaN(n));
  };
  const math = (operation: (numbers: number[]) => number): SlashCommand => ({
    split: true,
    run: (_named, value, { scope }) => {
      const numbers = series(value, scope);
      if (numbers.length === 0) return '0';
      const result = operation(numbers);
      return Number.isFinite(result) ? String(result) : '0';
    },
  });
  const [first, rest] = [(n: number[]) => n[0]!, (n: number[]) => n.slice(1)];
  add(
    'add',
    math((n) => n.reduce((a, b) => a + b, 0)),
  );
  add(
    'mul',
    math((n) => n.reduce((a, b) => a * b, 1)),
  );
  add(
    'max',
    math((n) => Math.max(...n)),
  );
  add(
    'min',
    math((n) => Math.min(...n)),
  );
  add(
    'sub',
    math((n) => rest(n).reduce((a, b) => a - b, first(n))),
  );
  add(
    'div',
    math((n) => (n[1] === 0 ? 0 : first(n) / (n[1] ?? 1))),
  );
  add(
    'mod',
    math((n) => (n[1] === 0 ? 0 : first(n) % (n[1] ?? 1))),
  );
  add(
    'pow',
    math((n) => Math.pow(first(n), n[1] ?? 1)),
  );
  add(
    'round',
    math((n) => Math.round(first(n))),
  );
  add(
    'abs',
    math((n) => Math.abs(first(n))),
  );
  add(
    'sqrt',
    math((n) => Math.sqrt(first(n))),
  );
  add('rand', {
    run: (named, value) => {
      const from = Number(named['from'] ?? 0);
      const to = Number(named['to'] ?? (value || 1));
      const result = from + random() * (to - from);
      const round = named['round'];
      if (round === 'round') return String(Math.round(result));
      if (round === 'ceil') return String(Math.ceil(result));
      if (round === 'floor') return String(Math.floor(result));
      return String(result);
    },
  });
  add(['len', 'length'], {
    run: (_named, value) => {
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(text(value));
      } catch {
        /* plain text */
      }
      if (Array.isArray(parsed)) return String(parsed.length);
      if (typeof parsed === 'string') return String(parsed.length);
      if (typeof parsed === 'number') return String(String(parsed).length);
      if (typeof parsed === 'object' && parsed !== null) return String(Object.keys(parsed).length);
      return '0';
    },
  });
  add('upper', { run: (_named, value) => (typeof value === 'string' ? value.toUpperCase() : '') });
  add('lower', { run: (_named, value) => (typeof value === 'string' ? value.toLowerCase() : '') });
  add('trim', { run: (_named, value) => (typeof value === 'string' ? value.trim() : '') });

  return commands;
}

export type { CommandContext };
