// 移植自 SillyTavern tests/frontend/MacroParser.e2e.js（含 simplifyCstNode 工具）与 MacroLexer.e2e.js 片段
import { describe, expect, it } from 'vitest';
import type { CstNode, IToken } from 'chevrotain';
import { macroParser, tokenizeForTest } from '../src/macros/index.js';

type Simple = string | string[] | SimpleNode | SimpleNode[] | null;
interface SimpleNode {
  [key: string]: Simple;
}
const DEFAULT_FLATTEN_KEYS = ['arguments.Args.DoubleColon'];

function simplifyCstNode(
  cst: CstNode | undefined,
  input: string,
  { flattenKeys = [] as string[], ignoreKeys = [] as string[] } = {},
): Simple | undefined {
  flattenKeys = [...flattenKeys, ...DEFAULT_FLATTEN_KEYS];
  const isNode = (n: unknown): n is CstNode =>
    !!n && typeof n === 'object' && 'children' in (n as object);
  function simplifyNode(
    node: CstNode | IToken | undefined,
    path: string[] = [],
  ): Simple | undefined {
    if (!node) return node as undefined;
    if (isNode(node)) {
      const children = { ...node.children } as Record<string, (CstNode | IToken)[]>;
      const body = children['macroBody'];
      if (body && body.length === 1 && isNode(body[0])) {
        for (const k in body[0].children) children[k] = body[0].children[k]!;
        delete children['macroBody'];
      }
      const simplified: SimpleNode = {};
      for (const key in children) {
        const simplifyChild = (
          child: (CstNode | IToken) | (CstNode | IToken)[],
          p: string[],
        ): Simple | undefined => {
          if (Array.isArray(child)) {
            if (child.length === 1) return simplifyChild(child[0]!, p.concat('[]'));
            return child.map((c) => simplifyChild(c, p.concat('[]'))) as Simple;
          }
          const flattenKey = p.filter((x) => x !== '[]').join('.');
          if (ignoreKeys.includes(flattenKey)) return null;
          if (flattenKeys.includes(flattenKey)) {
            if (!isNode(child) || !child.location) return null;
            return input.slice(
              child.location.startOffset,
              (child.location.endOffset ?? child.location.startOffset) + 1,
            );
          }
          return simplifyNode(child, p);
        };
        const value = simplifyChild(children[key]!, path.concat(key));
        if (value !== null && value !== undefined) simplified[key] = value;
      }
      if (Object.values(simplified).length === 0) return null;
      return simplified;
    }
    return node.image;
  }
  return simplifyNode(cst);
}

const run = (input: string, options = {}) => {
  const { cst, errors } = macroParser.parseMacro(input);
  if (errors.length > 0)
    throw new Error('Parser errors found\n' + errors.map((x) => x.message).join('\n'));
  return simplifyCstNode(cst, input, options);
};
const runErrors = (input: string) => {
  const { cst, errors } = macroParser.parseMacro(input);
  return { macroCst: simplifyCstNode(cst, input), errors };
};

describe('MacroParser', () => {
  it('parses a simple macro and handles whitespace', () => {
    const expected = { 'Macro.Start': '{{', 'Macro.identifier': 'user', 'Macro.End': '}}' };
    expect(run('{{user}}')).toEqual(expected);
    expect(run('{{  user  }}')).toEqual(expected);
  });
  it('errors on empty macro / invalid identifier / incomplete macro', () => {
    // 注：ST e2e 里断言 cst 为 undefined，那是 Playwright 对 recoveredNode 的序列化结果；
    // 在 Node 里直接跑 ST 原版 MacroParser.test() 得到的是带 recoveredNode:true 的部分 CST，这里按真实行为断言。
    const e1 = macroParser.parseMacro('{{}}');
    expect(e1.cst?.recoveredNode).toBe(true);
    expect(Object.keys(e1.cst?.children ?? {})).toEqual(['Macro.Start']);
    expect(e1.errors[0]?.name).toBe('NoViableAltException');
    expect(e1.errors[0]?.message).toMatch(
      /Expecting: one of these possible Token sequences:(.*?)\[Macro\.Identifier\](.*?)but found: '}}'/s,
    );
    const e2 = macroParser.parseMacro('{{§%€blah}}');
    expect(e2.cst?.recoveredNode).toBe(true);
    expect(e2.errors[0]?.name).toBe('NoViableAltException');
    expect(e2.errors[0]?.message).toMatch(/but found: '§%€blah}}'/s);
    const e3 = macroParser.parseMacro('{{user');
    expect(e3.cst?.recoveredNode).toBe(true);
    expect(e3.errors).toEqual([
      {
        name: 'MismatchedTokenException',
        message: "Expecting token of type --> Macro.End <-- but found --> '' <--",
      },
    ]);
    const e4 = macroParser.parseMacro('something{{user}}');
    expect(e4.errors).toEqual([
      {
        name: 'MismatchedTokenException',
        message: "Expecting token of type --> Macro.Start <-- but found --> 'something' <--",
      },
    ]);
  });
  describe('Arguments Handling', () => {
    const f = { flattenKeys: ['arguments.argument'] };
    it.each([
      [
        '{{getvar::myvar}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'getvar',
          arguments: { separator: '::', argument: 'myvar' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{roll:3d20}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'roll',
          arguments: { separator: ':', argument: '3d20' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{setvar::myvar::value}}',
        { flattenKeys: ['arguments.argument'], ignoreKeys: ['arguments.Args.DoubleColon'] },
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'setvar',
          arguments: { separator: '::', argument: ['myvar', 'value'] },
          'Macro.End': '}}',
        },
      ],
      [
        '{{something::  spaced  }}',
        {
          flattenKeys: ['arguments.argument'],
          ignoreKeys: ['arguments.separator', 'arguments.Args.DoubleColon'],
        },
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'something',
          arguments: { argument: 'spaced' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{something::with:single:colons}}',
        { flattenKeys: ['arguments.argument'], ignoreKeys: ['arguments.Args.DoubleColon'] },
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'something',
          arguments: { separator: '::', argument: 'with:single:colons' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{legacy:something:else}}',
        {
          flattenKeys: ['arguments.argument'],
          ignoreKeys: ['arguments.separator', 'arguments.Args.Colon'],
        },
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'legacy',
          arguments: { argument: 'something:else' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{something::}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'something',
          arguments: { separator: '::', argument: '' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{roll 1d5}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'roll',
          arguments: { argument: '1d5' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{roll 20}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'roll',
          arguments: { argument: '20' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{reverse:this contains::double::colons}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'reverse',
          arguments: { separator: ':', argument: 'this contains::double::colons' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{//comment-style macro}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': '//',
          arguments: { argument: 'comment-style macro' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{datetimeformat HH:mm}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'datetimeformat',
          arguments: { argument: 'HH:mm' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{banned "abannedword"}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'banned',
          arguments: { argument: '"abannedword"' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{banned ""}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'banned',
          arguments: { argument: '""' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{setvar::myvar::}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': 'setvar',
          arguments: { separator: '::', argument: ['myvar', ''] },
          'Macro.End': '}}',
        },
      ],
      [
        '{{//comment}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': '//',
          'Macro.End': '}}',
          arguments: { argument: 'comment' },
        },
      ],
      [
        '{{// comment}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': '//',
          'Macro.End': '}}',
          arguments: { argument: 'comment' },
        },
      ],
      [
        '{{//!@#$%^&*()_+}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': '//',
          'Macro.End': '}}',
          arguments: { argument: '!@#$%^&*()_+' },
        },
      ],
      [
        '{{//!@flags}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': '//',
          'Macro.End': '}}',
          arguments: { argument: '!@flags' },
        },
      ],
      [
        '{{// This is a multiline comment.\nThis is the second line\n}}',
        f,
        {
          'Macro.Start': '{{',
          'Macro.identifier': '//',
          'Macro.End': '}}',
          arguments: { argument: 'This is a multiline comment.\nThis is the second line' },
        },
      ],
    ])('%j', (input, options, expected) => expect(run(input, options)).toEqual(expected));
  });
  describe('Nested Macros', () => {
    it('parses nested macros inside arguments', () => {
      expect(run('{{outer::word {{inner}}}}')).toEqual({
        'Macro.Start': '{{',
        'Macro.identifier': 'outer',
        arguments: {
          argument: {
            Identifier: 'word',
            macro: { 'Macro.Start': '{{', 'Macro.identifier': 'inner', 'Macro.End': '}}' },
          },
          separator: '::',
        },
        'Macro.End': '}}',
      });
      expect(run('{{outer::word {{inner1}}{{inner2}}}}')).toEqual({
        'Macro.Start': '{{',
        'Macro.identifier': 'outer',
        arguments: {
          argument: {
            Identifier: 'word',
            macro: [
              { 'Macro.Start': '{{', 'Macro.identifier': 'inner1', 'Macro.End': '}}' },
              { 'Macro.Start': '{{', 'Macro.identifier': 'inner2', 'Macro.End': '}}' },
            ],
          },
          separator: '::',
        },
        'Macro.End': '}}',
      });
    });
    it('errors for nested macro as identifier or inside identifier', () => {
      expect(runErrors('{{{{macroindentifier}}::value}}').errors.map((e) => e.name)).toEqual([
        'MismatchedTokenException',
      ]);
      expect(runErrors('{{inside{{macro}}me}}').errors.map((e) => e.name)).toEqual([
        'NotAllInputParsedException',
      ]);
    });
  });
  describe('Macro Flags', () => {
    it.each([
      [
        '{{!user}}',
        { 'Macro.Start': '{{', flags: '!', 'Macro.identifier': 'user', 'Macro.End': '}}' },
      ],
      [
        '{{?delayed}}',
        { 'Macro.Start': '{{', flags: '?', 'Macro.identifier': 'delayed', 'Macro.End': '}}' },
      ],
      [
        '{{/closing}}',
        { 'Macro.Start': '{{', flags: '/', 'Macro.identifier': 'closing', 'Macro.End': '}}' },
      ],
      [
        '{{>filtered}}',
        { 'Macro.Start': '{{', flags: '>', 'Macro.identifier': 'filtered', 'Macro.End': '}}' },
      ],
      [
        '{{!?user}}',
        { 'Macro.Start': '{{', flags: ['!', '?'], 'Macro.identifier': 'user', 'Macro.End': '}}' },
      ],
      [
        '{{ ! > macro }}',
        { 'Macro.Start': '{{', flags: ['!', '>'], 'Macro.identifier': 'macro', 'Macro.End': '}}' },
      ],
      [
        '{{#legacy}}',
        { 'Macro.Start': '{{', flags: '#', 'Macro.identifier': 'legacy', 'Macro.End': '}}' },
      ],
    ])('%j', (input, expected) => expect(run(input)).toEqual(expected));
    it('parses flag with arguments', () => {
      expect(run('{{!setvar::value::test}}', { flattenKeys: ['arguments.argument'] })).toEqual({
        'Macro.Start': '{{',
        flags: '!',
        'Macro.identifier': 'setvar',
        arguments: { separator: '::', argument: ['value', 'test'] },
        'Macro.End': '}}',
      });
    });
  });
  describe('Variable Shorthand Syntax', () => {
    it.each([
      [
        '{{.myvar}}',
        {
          'Macro.Start': '{{',
          variableExpr: { 'Var.scope': '.', 'Var.identifier': 'myvar' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{$myvar}}',
        {
          'Macro.Start': '{{',
          variableExpr: { 'Var.scope': '$', 'Var.identifier': 'myvar' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{.my-var}}',
        {
          'Macro.Start': '{{',
          variableExpr: { 'Var.scope': '.', 'Var.identifier': 'my-var' },
          'Macro.End': '}}',
        },
      ],
      [
        '{{.myvar = hello}}',
        {
          'Macro.Start': '{{',
          variableExpr: {
            'Var.scope': '.',
            'Var.identifier': 'myvar',
            variableOperator: { 'Var.operator': '=', 'Var.value': { Identifier: 'hello' } },
          },
          'Macro.End': '}}',
        },
      ],
      [
        '{{.counter++}}',
        {
          'Macro.Start': '{{',
          variableExpr: {
            'Var.scope': '.',
            'Var.identifier': 'counter',
            variableOperator: { 'Var.operator': '++' },
          },
          'Macro.End': '}}',
        },
      ],
      [
        '{{$counter--}}',
        {
          'Macro.Start': '{{',
          variableExpr: {
            'Var.scope': '$',
            'Var.identifier': 'counter',
            variableOperator: { 'Var.operator': '--' },
          },
          'Macro.End': '}}',
        },
      ],
      [
        '{{.myvar += 5}}',
        {
          'Macro.Start': '{{',
          variableExpr: {
            'Var.scope': '.',
            'Var.identifier': 'myvar',
            variableOperator: { 'Var.operator': '+=', 'Var.value': { Unknown: '5' } },
          },
          'Macro.End': '}}',
        },
      ],
      [
        '{{.myvar = Hello {{user}}}}',
        {
          'Macro.Start': '{{',
          variableExpr: {
            'Var.scope': '.',
            'Var.identifier': 'myvar',
            variableOperator: {
              'Var.operator': '=',
              'Var.value': {
                Identifier: 'Hello',
                macro: { 'Macro.Start': '{{', 'Macro.identifier': 'user', 'Macro.End': '}}' },
              },
            },
          },
          'Macro.End': '}}',
        },
      ],
      [
        '{{ .myvar = spaced }}',
        {
          'Macro.Start': '{{',
          variableExpr: {
            'Var.scope': '.',
            'Var.identifier': 'myvar',
            variableOperator: { 'Var.operator': '=', 'Var.value': { Identifier: 'spaced' } },
          },
          'Macro.End': '}}',
        },
      ],
    ])('%j', (input, expected) => expect(run(input)).toEqual(expected));
  });
});

describe('MacroLexer', () => {
  it.each([
    [
      '{{user}}',
      [
        ['Macro.Start', '{{'],
        ['Macro.Identifier', 'user'],
        ['Macro.End', '}}'],
      ],
    ],
    [
      '{{}}',
      [
        ['Macro.Start', '{{'],
        ['Macro.End', '}}'],
      ],
    ],
    [
      '{{   user   }}',
      [
        ['Macro.Start', '{{'],
        ['Macro.Identifier', 'user'],
        ['Macro.End', '}}'],
      ],
    ],
    [
      '{{macro1}}{{macro2}}',
      [
        ['Macro.Start', '{{'],
        ['Macro.Identifier', 'macro1'],
        ['Macro.End', '}}'],
        ['Macro.Start', '{{'],
        ['Macro.Identifier', 'macro2'],
        ['Macro.End', '}}'],
      ],
    ],
    [
      '{{outerMacro {{innerMacro}}}}',
      [
        ['Macro.Start', '{{'],
        ['Macro.Identifier', 'outerMacro'],
        ['Macro.Start', '{{'],
        ['Macro.Identifier', 'innerMacro'],
        ['Macro.End', '}}'],
        ['Macro.End', '}}'],
      ],
    ],
    [
      'Hi {{user}}!',
      [
        ['Plaintext', 'Hi '],
        ['Macro.Start', '{{'],
        ['Macro.Identifier', 'user'],
        ['Macro.End', '}}'],
        ['Plaintext', '!'],
      ],
    ],
    [
      '{{{char}}',
      [
        ['Plaintext.OpenBrace', '{'],
        ['Macro.Start', '{{'],
        ['Macro.Identifier', 'char'],
        ['Macro.End', '}}'],
      ],
    ],
  ])('%j', (input, expected) => {
    const { tokens, errors } = tokenizeForTest(input);
    expect(errors).toEqual([]);
    expect(tokens.map((t) => [t.type, t.text])).toEqual(expected);
  });
});
