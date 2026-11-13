// ST MacroDiagnostics.js 移植。日志走可注入的 MacroLogger，默认 console；
// 前缀与 ST 完全一致（'[Macro] Warning:' / '[Macro] Error:' / '[Macro] Registration Error:'），测试据此断言。
import type { MacroCall } from './walker.js';
import type { MacroDefinition } from './registry.js';

export interface MacroLogger {
  warn(message: string, payload?: unknown): void;
  error(message: string, payload?: unknown): void;
  registerError(message: string, payload?: unknown): void;
}

export const consoleMacroLogger: MacroLogger = {
  warn: (message, payload) => console.warn('[Macro] Warning:', message, payload),
  error: (message, payload) => console.error('[Macro] Error:', message, payload),
  registerError: (message, payload) =>
    console.error('[Macro] Registration Error:', message, payload),
};

/** 测试/诊断面板用：把日志收进数组 */
export interface CapturedMacroLog {
  level: 'warn' | 'error' | 'registerError';
  message: string;
  payload?: unknown;
}
export function createCapturingLogger(sink: CapturedMacroLog[]): MacroLogger {
  return {
    warn: (message, payload) => void sink.push({ level: 'warn', message, payload }),
    error: (message, payload) => void sink.push({ level: 'error', message, payload }),
    registerError: (message, payload) =>
      void sink.push({ level: 'registerError', message, payload }),
  };
}

export interface MacroErrorContext {
  macroName?: string | undefined;
  call?: MacroCall | undefined;
  def?: MacroDefinition | undefined;
}

export class MacroRuntimeError extends Error {
  override readonly name = 'MacroRuntimeError';
  readonly isMacroRuntimeError = true;
  macroName: string;
  macroRange: { startOffset: number; endOffset: number } | null;
  macroCall: MacroCall | undefined;
  macroDefinition: MacroDefinition | undefined;
  constructor(message: string, ctx: MacroErrorContext) {
    super(message);
    this.macroName = inferMacroName(ctx.call, ctx.def, ctx.macroName);
    this.macroRange = ctx.call?.range ?? null;
    this.macroCall = ctx.call;
    this.macroDefinition = ctx.def;
  }
}

export function createMacroRuntimeError(
  opts: MacroErrorContext & { message: string },
): MacroRuntimeError {
  return new MacroRuntimeError(opts.message, opts);
}

export function isMacroRuntimeError(error: unknown): error is MacroRuntimeError {
  return (
    !!error &&
    typeof error === 'object' &&
    ((error as { name?: string }).name === 'MacroRuntimeError' ||
      (error as { isMacroRuntimeError?: boolean }).isMacroRuntimeError === true)
  );
}

type LogOptions = MacroErrorContext & { message: string; error?: unknown };

export function logMacroRuntimeWarning(
  logger: MacroLogger,
  { message, call, def, macroName, error }: LogOptions,
) {
  logger.warn(message, buildMacroPayload({ call, def, macroName, error }));
}
export function logMacroInternalError(
  logger: MacroLogger,
  { message, call, macroName, error }: LogOptions,
) {
  logger.error(message, buildMacroPayload({ call, macroName, error }));
}
export function logMacroRegisterWarning(
  logger: MacroLogger,
  {
    message,
    macroName,
    error,
  }: { message: string; macroName?: string | undefined; error?: unknown },
) {
  logger.warn(message, buildMacroPayload({ macroName, error }));
}
export function logMacroRegisterError(
  logger: MacroLogger,
  {
    message,
    macroName,
    error,
  }: { message: string; macroName?: string | undefined; error?: unknown },
) {
  logger.registerError(message, buildMacroPayload({ macroName, error }));
}
export function logMacroGeneralError(
  logger: MacroLogger,
  { message, error }: { message: string; error?: unknown },
) {
  logger.error(message, error);
}

export interface SyntaxIssueLike {
  message: string;
  line?: number | undefined;
  column?: number | undefined;
  length?: number | undefined;
  token?:
    | { startLine?: number; startColumn?: number; startOffset?: number; endOffset?: number }
    | undefined;
}

export function logMacroSyntaxWarning(
  logger: MacroLogger,
  {
    phase,
    input,
    errors,
  }: { phase: 'lexing' | 'parsing'; input: string; errors: SyntaxIssueLike[] },
) {
  if (!errors || errors.length === 0) return;
  const issues = errors.map((err) => {
    const token = err.token;
    const line = typeof err.line === 'number' ? err.line : (token?.startLine ?? null);
    const column = typeof err.column === 'number' ? err.column : (token?.startColumn ?? null);
    let length: number | null = null;
    if (typeof err.length === 'number') length = err.length;
    else if (typeof token?.startOffset === 'number' && typeof token?.endOffset === 'number')
      length = token.endOffset - token.startOffset + 1;
    return { message: err.message, line, column, length };
  });
  const label = phase === 'lexing' ? 'Lexing' : 'Parsing';
  logger.warn(`${label} errors detected`, { phase, count: issues.length, issues, input });
}

function buildMacroPayload({
  call,
  def,
  macroName,
  error,
}: MacroErrorContext & { error?: unknown }) {
  const payload: Record<string, unknown> = { macroName: inferMacroName(call, def, macroName) };
  if (call?.range) payload['range'] = call.range;
  if (call && typeof call.rawInner === 'string') payload['raw'] = call.rawInner;
  if (call) payload['call'] = call;
  if (def) payload['def'] = def;
  if (error) payload['error'] = error;
  return payload;
}

function inferMacroName(call?: MacroCall, def?: MacroDefinition, explicit?: string): string {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (call && typeof call.name === 'string' && call.name.trim()) return call.name.trim();
  if (def && typeof def.name === 'string' && def.name.trim()) return def.name.trim();
  return 'unknown';
}
