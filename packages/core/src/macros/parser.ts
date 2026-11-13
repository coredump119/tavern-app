// ST MacroParser.js 的 chevrotain CstParser 移植。规则名与 LABEL 与 ST 一致（walker 依赖这些名字）。
import {
  CstParser,
  type CstNode,
  type ILexingError,
  type IRecognitionException,
  type ParserMethod,
} from 'chevrotain';
import { Tokens, lexerDefinition, macroLexer } from './lexer.js';

export interface ParseDocumentResult {
  cst: CstNode | null;
  errors: ({ message: string } | ILexingError | IRecognitionException)[];
  lexingErrors: ILexingError[];
  parserErrors: IRecognitionException[];
}

class MacroParserImpl extends CstParser {
  constructor() {
    super(lexerDefinition, {
      traceInitPerf: false,
      nodeLocationTracking: 'full',
      recoveryEnabled: true,
    });
    this.performSelfAnalysis();
  }

  public document: ParserMethod<[], CstNode> = this.RULE('document', () => {
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(Tokens.Plaintext, { LABEL: 'plaintext' }) },
        { ALT: () => this.CONSUME(Tokens.PlaintextOpenBrace, { LABEL: 'plaintext' }) },
        { ALT: () => this.SUBRULE(this.macro) },
        { ALT: () => this.CONSUME(Tokens.Macro.Start, { LABEL: 'plaintext' }) },
      ]);
    });
  });

  public macro: ParserMethod<[], CstNode> = this.RULE('macro', () => {
    this.CONSUME(Tokens.Macro.Start);
    this.MANY(() => {
      this.OR1([
        { ALT: () => this.CONSUME(Tokens.Macro.Flags, { LABEL: 'flags' }) },
        { ALT: () => this.CONSUME(Tokens.Macro.FilterFlag, { LABEL: 'flags' }) },
      ]);
    });
    this.OR([
      { ALT: () => this.SUBRULE(this.variableExpr) },
      { ALT: () => this.SUBRULE(this.macroBody) },
    ]);
    this.CONSUME(Tokens.Macro.End);
  });

  public macroBody: ParserMethod<[], CstNode> = this.RULE('macroBody', () => {
    this.OR2([
      { ALT: () => this.CONSUME(Tokens.Macro.DoubleSlash, { LABEL: 'Macro.identifier' }) },
      { ALT: () => this.CONSUME(Tokens.Macro.Identifier, { LABEL: 'Macro.identifier' }) },
    ]);
    this.OPTION(() => this.SUBRULE(this.arguments));
  });

  public variableExpr: ParserMethod<[], CstNode> = this.RULE('variableExpr', () => {
    this.OR3([
      { ALT: () => this.CONSUME(Tokens.Var.LocalPrefix, { LABEL: 'Var.scope' }) },
      { ALT: () => this.CONSUME(Tokens.Var.GlobalPrefix, { LABEL: 'Var.scope' }) },
    ]);
    this.CONSUME(Tokens.Var.Identifier, { LABEL: 'Var.identifier' });
    this.OPTION2(() => this.SUBRULE(this.variableOperator));
  });

  public variableOperator: ParserMethod<[], CstNode> = this.RULE('variableOperator', () => {
    const V = Tokens.Var.Operators;
    this.OR4([
      { ALT: () => this.CONSUME(V.Increment, { LABEL: 'Var.operator' }) },
      { ALT: () => this.CONSUME(V.Decrement, { LABEL: 'Var.operator' }) },
      {
        ALT: () => {
          this.OR5([
            { ALT: () => this.CONSUME(V.NullishCoalescingEquals, { LABEL: 'Var.operator' }) },
            { ALT: () => this.CONSUME(V.NullishCoalescing, { LABEL: 'Var.operator' }) },
            { ALT: () => this.CONSUME(V.LogicalOrEquals, { LABEL: 'Var.operator' }) },
            { ALT: () => this.CONSUME(V.LogicalOr, { LABEL: 'Var.operator' }) },
            { ALT: () => this.CONSUME(V.MinusEquals, { LABEL: 'Var.operator' }) },
            { ALT: () => this.CONSUME(V.DoubleEquals, { LABEL: 'Var.operator' }) },
            { ALT: () => this.CONSUME(V.NotEquals, { LABEL: 'Var.operator' }) },
            { ALT: () => this.CONSUME(V.GreaterThanOrEqual, { LABEL: 'Var.operator' }) },
            { ALT: () => this.CONSUME(V.GreaterThan, { LABEL: 'Var.operator' }) },
            { ALT: () => this.CONSUME(V.LessThanOrEqual, { LABEL: 'Var.operator' }) },
            { ALT: () => this.CONSUME(V.LessThan, { LABEL: 'Var.operator' }) },
            { ALT: () => this.CONSUME(V.PlusEquals, { LABEL: 'Var.operator' }) },
            { ALT: () => this.CONSUME(V.Equals, { LABEL: 'Var.operator' }) },
          ]);
          this.SUBRULE(this.variableValue, { LABEL: 'Var.value' });
        },
      },
    ]);
  });

  public variableValue: ParserMethod<[], CstNode> = this.RULE('variableValue', () => {
    this.MANY2(() => {
      this.OR5([
        { ALT: () => this.SUBRULE(this.macro) },
        { ALT: () => this.CONSUME(Tokens.Identifier) },
        { ALT: () => this.CONSUME(Tokens.Unknown) },
      ]);
    });
  });

  public arguments: ParserMethod<[], CstNode> = this.RULE('arguments', () => {
    this.OR([
      {
        ALT: () => {
          this.CONSUME(Tokens.Args.DoubleColon, { LABEL: 'separator' });
          this.AT_LEAST_ONE_SEP({
            SEP: Tokens.Args.DoubleColon,
            DEF: () => this.SUBRULE(this.argument, { LABEL: 'argument' }),
          });
        },
      },
      {
        ALT: () => {
          this.OPTION(() => {
            this.CONSUME(Tokens.Args.Colon, { LABEL: 'separator' });
          });
          this.SUBRULE(this.argumentAllowingColons, { LABEL: 'argument' });
        },
        IGNORE_AMBIGUITIES: true,
      },
    ]);
  });

  public argument: ParserMethod<[], CstNode> = this.RULE('argument', () => {
    this.MANY(() => {
      this.OR([
        { ALT: () => this.SUBRULE(this.macro) },
        { ALT: () => this.CONSUME(Tokens.Identifier) },
        { ALT: () => this.CONSUME(Tokens.Unknown) },
        { ALT: () => this.CONSUME(Tokens.Args.Colon) },
        { ALT: () => this.CONSUME(Tokens.Args.Equals) },
        { ALT: () => this.CONSUME(Tokens.Args.Quote) },
      ]);
    });
  });

  public argumentAllowingColons: ParserMethod<[], CstNode> = this.RULE(
    'argumentAllowingColons',
    () => {
      this.AT_LEAST_ONE(() => {
        this.OR([
          { ALT: () => this.SUBRULE(this.macro) },
          { ALT: () => this.CONSUME(Tokens.Identifier) },
          { ALT: () => this.CONSUME(Tokens.Unknown) },
          { ALT: () => this.CONSUME(Tokens.Args.Colon) },
          { ALT: () => this.CONSUME(Tokens.Args.Equals) },
          { ALT: () => this.CONSUME(Tokens.Args.Quote) },
          { ALT: () => this.CONSUME(Tokens.Args.DoubleColon) },
        ]);
      });
    },
  );

  parseDocument(input: string): ParseDocumentResult {
    if (!input) {
      return {
        cst: null,
        errors: [{ message: 'Input is empty' }],
        lexingErrors: [],
        parserErrors: [],
      };
    }
    const lexingResult = macroLexer.tokenize(input);
    this.input = lexingResult.tokens;
    const cst = this.document();
    const parserErrors = [...this.errors];
    return {
      cst,
      errors: [...lexingResult.errors, ...parserErrors],
      lexingErrors: lexingResult.errors,
      parserErrors,
    };
  }

  /** 测试用：以 macro 规则解析（输入必须以 {{ 开头） */
  parseMacro(input: string): {
    cst: CstNode | undefined;
    errors: { name: string; message: string }[];
  } {
    const lexingResult = macroLexer.tokenize(input);
    this.input = lexingResult.tokens;
    const cst = this.macro();
    const errors = this.errors.map((x) => ({ name: x.name, message: x.message }));
    return { cst, errors };
  }
}

export type MacroParser = MacroParserImpl;
export const macroParser: MacroParser = new MacroParserImpl();
