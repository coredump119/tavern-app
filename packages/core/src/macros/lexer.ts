// ST MacroLexer.js 的 chevrotain 多模式词法器移植。token 名与模式名保持一致，便于对照 ST 的 e2e 测试。
import { createToken, Lexer, type IMultiModeLexerDefinition, type TokenType } from 'chevrotain';

/** 全字符串校验用标识符模式（注册宏名时使用） */
export const MACRO_IDENTIFIER_PATTERN = /^[a-zA-Z][\w-_]*$/;
/** 变量简写标识符：不能以连字符结尾，避免与 -- 冲突 */
export const MACRO_VARIABLE_SHORTHAND_PATTERN = /[a-zA-Z](?:[\w\-_]*[\w])?/;
const IDENTIFIER_LEXER_PATTERN = /[a-zA-Z][\w-_]*/;

export const modes = Object.freeze({
  plaintext: 'plaintext_mode',
  macro_def: 'macro_def_mode',
  macro_identifier_end: 'macro_identifier_end_mode',
  macro_args: 'macro_args_mode',
  macro_filter_modifer: 'macro_filter_modifer_mode',
  macro_filter_modifier_end: 'macro_filter_modifier_end_mode',
  var_identifier: 'var_identifier_mode',
  var_after_identifier: 'var_after_identifier_mode',
  var_value: 'var_value_mode',
});

const modePopperPattern = () => [''] as [string];

export const Tokens = Object.freeze({
  Plaintext: createToken({ name: 'Plaintext', pattern: /(?:[^{]|\{(?!\{))+/u, line_breaks: true }),
  PlaintextOpenBrace: createToken({ name: 'Plaintext.OpenBrace', pattern: /\{(?=\{\{)/ }),
  Macro: {
    Start: createToken({ name: 'Macro.Start', pattern: /\{\{/ }),
    Flags: createToken({ name: 'Macro.Flag', pattern: /[!?~#/]/ }),
    FilterFlag: createToken({ name: 'Macro.FilterFlag', pattern: />/ }),
    DoubleSlash: createToken({ name: 'Macro.DoubleSlash', pattern: /\/\// }),
    Identifier: createToken({ name: 'Macro.Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
    EndOfIdentifier: createToken({
      name: 'Macro.EndOfIdentifier',
      pattern: /(?:\s+|(?=:{1,2})|(?=[|}]))/,
      group: Lexer.SKIPPED,
    }),
    BeforeEnd: createToken({ name: 'Macro.BeforeEnd', pattern: /(?=\}\})/, group: Lexer.SKIPPED }),
    End: createToken({ name: 'Macro.End', pattern: /\}\}/ }),
  },
  Args: {
    DoubleColon: createToken({ name: 'Args.DoubleColon', pattern: /::/ }),
    Colon: createToken({ name: 'Args.Colon', pattern: /:/ }),
    Equals: createToken({ name: 'Args.Equals', pattern: /=/ }),
    Quote: createToken({ name: 'Args.Quote', pattern: /"/ }),
  },
  Filter: {
    EscapedPipe: createToken({ name: 'Filter.EscapedPipe', pattern: /\\\|/ }),
    Pipe: createToken({ name: 'Filter.Pipe', pattern: /\|/ }),
    Identifier: createToken({ name: 'Filter.Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
    EndOfIdentifier: createToken({
      name: 'Filter.EndOfIdentifier',
      pattern: /(?:\s+|(?=:{1,2})|(?=[|}]))/,
      group: Lexer.SKIPPED,
    }),
  },
  Identifier: createToken({ name: 'Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
  WhiteSpace: createToken({ name: 'WhiteSpace', pattern: /\s+/, group: Lexer.SKIPPED }),
  Var: {
    LocalPrefix: createToken({ name: 'Var.LocalPrefix', pattern: /\./ }),
    GlobalPrefix: createToken({ name: 'Var.GlobalPrefix', pattern: /\$/ }),
    Identifier: createToken({ name: 'Var.Identifier', pattern: MACRO_VARIABLE_SHORTHAND_PATTERN }),
    Operators: {
      Increment: createToken({ name: 'Var.Increment', pattern: /\+\+/ }),
      Decrement: createToken({ name: 'Var.Decrement', pattern: /--/ }),
      NullishCoalescingEquals: createToken({
        name: 'Var.NullishCoalescingEquals',
        pattern: /\?\?=/,
      }),
      NullishCoalescing: createToken({ name: 'Var.NullishCoalescing', pattern: /\?\?/ }),
      LogicalOrEquals: createToken({ name: 'Var.LogicalOrEquals', pattern: /\|\|=/ }),
      LogicalOr: createToken({ name: 'Var.LogicalOr', pattern: /\|\|/ }),
      MinusEquals: createToken({ name: 'Var.MinusEquals', pattern: /-=/ }),
      DoubleEquals: createToken({ name: 'Var.DoubleEquals', pattern: /==/ }),
      NotEquals: createToken({ name: 'Var.NotEquals', pattern: /!=/ }),
      GreaterThanOrEqual: createToken({ name: 'Var.GreaterThanOrEqual', pattern: />=/ }),
      GreaterThan: createToken({ name: 'Var.GreaterThan', pattern: />/ }),
      LessThanOrEqual: createToken({ name: 'Var.LessThanOrEqual', pattern: /<=/ }),
      LessThan: createToken({ name: 'Var.LessThan', pattern: /</ }),
      PlusEquals: createToken({ name: 'Var.PlusEquals', pattern: /\+=/ }),
      Equals: createToken({ name: 'Var.Equals', pattern: /=/ }),
    },
  },
  Unknown: createToken({ name: 'Unknown', pattern: /([^}]|\}(?!\}))/ }),
  /** 其它 token 都不匹配时用于弹出当前模式的空匹配。必须是模式中的最后一个 token。 */
  ModePopper: createToken({
    name: 'ModePopper',
    pattern: modePopperPattern,
    line_breaks: false,
    group: Lexer.SKIPPED,
  }),
});

const enterModesMap = new Map<string, string>();

function enter(
  token: TokenType,
  mode: string,
  { andExits }: { andExits?: string } = {},
): TokenType {
  const existing = enterModesMap.get(token.name);
  if (existing !== undefined && existing !== mode) {
    throw new Error(`Token ${token.name} already is set to enter mode ${existing}.`);
  }
  if (andExits) exits(token, andExits);
  token.PUSH_MODE = mode;
  enterModesMap.set(token.name, mode);
  return token;
}
function exits(token: TokenType, _mode: string): TokenType {
  token.POP_MODE = true;
  return token;
}
function using(token: TokenType): TokenType {
  if (enterModesMap.has(token.name)) {
    throw new Error(
      `Token ${token.name} is already marked to enter a mode (${enterModesMap.get(token.name)}).`,
    );
  }
  return token;
}

const V = Tokens.Var.Operators;

export const lexerDefinition: IMultiModeLexerDefinition = {
  modes: {
    [modes.plaintext]: [
      using(Tokens.Plaintext),
      using(Tokens.PlaintextOpenBrace),
      enter(Tokens.Macro.Start, modes.macro_def),
    ],
    [modes.macro_def]: [
      exits(Tokens.Macro.End, modes.macro_def),
      enter(Tokens.Macro.DoubleSlash, modes.macro_args),
      enter(Tokens.Var.LocalPrefix, modes.var_identifier),
      enter(Tokens.Var.GlobalPrefix, modes.var_identifier),
      using(Tokens.Macro.Flags),
      using(Tokens.Macro.FilterFlag),
      using(Tokens.WhiteSpace),
      enter(Tokens.Macro.Identifier, modes.macro_identifier_end),
      exits(Tokens.ModePopper, modes.macro_def),
    ],
    [modes.macro_identifier_end]: [
      exits(Tokens.Macro.BeforeEnd, modes.macro_identifier_end),
      enter(Tokens.Macro.EndOfIdentifier, modes.macro_args, {
        andExits: modes.macro_identifier_end,
      }),
    ],
    [modes.macro_args]: [
      enter(Tokens.Macro.Start, modes.macro_def),
      using(Tokens.Filter.EscapedPipe),
      enter(Tokens.Filter.Pipe, modes.macro_filter_modifer),
      using(Tokens.Args.DoubleColon),
      using(Tokens.Args.Colon),
      using(Tokens.Args.Equals),
      using(Tokens.Args.Quote),
      using(Tokens.Identifier),
      using(Tokens.WhiteSpace),
      using(Tokens.Unknown),
      exits(Tokens.ModePopper, modes.macro_args),
    ],
    [modes.macro_filter_modifer]: [
      using(Tokens.WhiteSpace),
      enter(Tokens.Filter.Identifier, modes.macro_filter_modifier_end, {
        andExits: modes.macro_filter_modifer,
      }),
    ],
    [modes.macro_filter_modifier_end]: [
      exits(Tokens.Macro.BeforeEnd, modes.macro_identifier_end),
      exits(Tokens.Filter.EndOfIdentifier, modes.macro_filter_modifer),
    ],
    [modes.var_identifier]: [
      using(Tokens.WhiteSpace),
      enter(Tokens.Var.Identifier, modes.var_after_identifier, { andExits: modes.var_identifier }),
      exits(Tokens.ModePopper, modes.var_identifier),
    ],
    [modes.var_after_identifier]: [
      using(Tokens.WhiteSpace),
      using(V.Increment),
      using(V.Decrement),
      enter(V.NullishCoalescingEquals, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(V.NullishCoalescing, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(V.LogicalOrEquals, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(V.LogicalOr, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(V.MinusEquals, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(V.DoubleEquals, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(V.NotEquals, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(V.GreaterThanOrEqual, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(V.GreaterThan, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(V.LessThanOrEqual, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(V.LessThan, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(V.PlusEquals, modes.var_value, { andExits: modes.var_after_identifier }),
      enter(V.Equals, modes.var_value, { andExits: modes.var_after_identifier }),
      exits(Tokens.Macro.BeforeEnd, modes.var_after_identifier),
      exits(Tokens.ModePopper, modes.var_after_identifier),
    ],
    [modes.var_value]: [
      enter(Tokens.Macro.Start, modes.macro_def),
      using(Tokens.Identifier),
      using(Tokens.WhiteSpace),
      using(Tokens.Unknown),
      exits(Tokens.ModePopper, modes.var_value),
    ],
  },
  defaultMode: modes.plaintext,
};

export const macroLexer = new Lexer(lexerDefinition, {
  traceInitPerf: false,
  skipValidations: false,
  ensureOptimizations: false,
});

/** 调试/测试：返回 { type, text } 列表 */
export function tokenizeForTest(input: string): {
  tokens: { type: string; text: string }[];
  errors: string[];
} {
  const result = macroLexer.tokenize(input);
  return {
    tokens: result.tokens.map((t) => ({ type: t.tokenType.name, text: t.image })),
    errors: result.errors.map((e) => e.message),
  };
}
