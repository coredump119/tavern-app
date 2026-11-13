// 移植自 SillyTavern tests/frontend/MacroEngine.e2e.js（COMPAT_TARGET 8172dcd）。期望值保持原样。
import { describe, expect, it } from 'vitest';
import { createHarness } from './helpers.js';
import { getStringHash } from '../src/util/hash.js';
import seedrandom from 'seedrandom';

const ev = (input: string) => createHarness().evaluate(input);
const evVars = (
  input: string,
  vars: { local?: Record<string, string>; global?: Record<string, string> },
) => createHarness().evaluateWithVariables(input, vars);
const evLogs = (input: string) => {
  const h = createHarness();
  const output = h.evaluate(input);
  return { output, hasMacroWarnings: h.hasMacroWarnings(), hasMacroErrors: h.hasMacroErrors() };
};

describe('MacroEngine', () => {
  describe('Basic evaluation', () => {
    it('returns input unchanged when there are no macros', () => {
      expect(ev('Hello world, no macros here.')).toBe('Hello world, no macros here.');
    });
    it('evaluates a simple macro without arguments', () => {
      expect(ev('Start {{newline}} end.')).toBe('Start \n end.');
    });
    it('evaluates multiple macros in order', () => {
      expect(
        ev('A {{setvar::test::4}}{{getvar::test}} B {{setvar::test::2}}{{getvar::test}} C'),
      ).toBe('A 4 B 2 C');
    });
  });

  describe('Unnamed arguments', () => {
    it.each([
      ['Reversed: {{reverse::abc}}!', 'Reversed: cba!'],
      ['Reversed: {{reverse:abc}}!', 'Reversed: cba!'],
      ['Reversed: {{reverse:abc::def}}!', 'Reversed: fed::cba!'],
      ['Reversed: {{reverse:abc:def}}!', 'Reversed: fed:cba!'],
      ['Values: {{roll 1d1}}!', 'Values: 1!'],
      ['Values: {{reverse abc def}}!', 'Values: fed cba!'],
    ])('%s → %s', (input, expected) => expect(ev(input)).toBe(expected));
    it('supports multi-line arguments', () => {
      const original = 'first line\nsecond line';
      expect(ev('Result: {{reverse::first line\nsecond line}}')).toBe(
        `Result: ${Array.from(original).reverse().join('')}`,
      );
    });
  });

  describe('Nested macros', () => {
    it('resolves nested macros inside arguments inside-out', () => {
      expect(
        ev(
          'Result: {{setvar::test::0}}{{reverse::{{addvar::test::100}}{{getvar::test}}}}{{setvar::test::0}}',
        ),
      ).toBe('Result: 001');
    });
    it('resolves nested macros across multiple arguments', () => {
      expect(
        ev(
          'Result: {{setvar::addvname::test}}{{addvar::{{getvar::addvname}}::{{setvar::test::5}}{{getvar::test}}}}{{getvar::test}}',
        ),
      ).toBe('Result: 10');
    });
  });

  describe('Unknown macros', () => {
    it('keeps unknown macro syntax but resolves nested macros inside it', () => {
      expect(ev('Test: {{unknown::{{newline}}}}')).toBe('Test: {{unknown::\n}}');
    });
    it('keeps surrounding text inside unknown macros intact', () => {
      expect(ev('Test: {{unknown::my {{newline}} example}}')).toBe(
        'Test: {{unknown::my \n example}}',
      );
    });
  });

  describe('Comment macro', () => {
    it.each([
      ['Hello{{// comment}}World', 'HelloWorld'],
      ['A{{//!@#$%^&*()_+}}B', 'AB'],
      ['X{{//comment with // extra // slashes}}Y', 'XY'],
      ['Start{{// line one\nline two\nline three}}End', 'StartEnd'],
    ])('%s → %s', (input, expected) => expect(ev(input)).toBe(expected));
  });

  describe('Trim macro', () => {
    it.each([
      ['{{trim}}  hello world  {{/trim}}', 'hello world'],
      ['{{trim}}\n\n  content{{/trim}}', 'content'],
      ['{{trim}}content  \n\n{{/trim}}', 'content'],
      ['{{trim}}  Hello {{user}}  {{/trim}}', 'Hello User'],
      ['{{trim}}  outer {{trim}}  inner  {{/trim}} outer  {{/trim}}', 'outer inner outer'],
    ])('%s → %s', (input, expected) => expect(ev(input)).toBe(expected));
  });

  describe('Legacy compatibility', () => {
    it.each([
      ['foo\n\n{{trim}}\n\nbar', 'foobar'],
      ['A\n\n{{trim}}\n\nB\n\n{{trim}}\n\nC', 'ABC'],
      ['Hello <USER>!', 'Hello User!'],
      ['Bot: <BOT>, Char: <CHAR>.', 'Bot: Character, Char: Character.'],
      [
        'Group: <GROUP>, CharIfNotGroup: <CHARIFNOTGROUP>.',
        'Group: Character, CharIfNotGroup: Character.',
      ],
    ])('%s → %s', (input, expected) => expect(ev(input)).toBe(expected));
    it('supports legacy time macro offsets via pre-processing', () => {
      for (const input of ['Time: {{time_UTC+2}}', 'Time: {{time_UTC-10}}']) {
        const output = ev(input);
        expect(output).not.toBe(input);
        expect(output.startsWith('Time: ')).toBe(true);
        expect(output.length).toBeGreaterThan('Time: '.length);
      }
    });
  });

  describe('Bracket handling around macros', () => {
    const cases: [string, string, boolean][] = [
      ['Test§ {{reverse::my { test}}', 'Test§ tset { ym', false],
      ['Test§ {{reverse::my } test}}', 'Test§ tset } ym', false],
      ['Test {{ hehe', 'Test {{ hehe', true],
      ['Test {{§§ hehe', 'Test {{§§ hehe', false],
      ['Before {{ hehe After', 'Before {{ hehe After', true],
      ['Test {{ hehe {{user}}', 'Test {{ hehe User', true],
      ['Test {{&& hehe {{user}}', 'Test {{&& hehe User', false],
      ['{{{char}}', '{Character', false],
      ['{{char}}}', 'Character}', false],
      ['{{{char}}}', '{Character}', false],
      ['{{{{char}}', '{{Character', false],
      ['{{char}}}}', 'Character}}', false],
      ['{{{{char}}}}', '{{Character}}', false],
      ['Result: {{reverse::pre-{ {{user}} }-post}}', 'Result: tsop-} resU {-erp', false],
      ['{{char}}{{user}}', 'CharacterUser', false],
      ['{{char}}{ {{user}} }', 'Character{ User }', false],
      ['Line1 {{char}}\r\n{Line2}', 'Line1 Character\r\n{Line2}', false],
      ['Foo }} bar', 'Foo }} bar', false],
      ['Foo }} {{user}}', 'Foo }} User', false],
      ['Foo {{user}} }}', 'Foo User }}', false],
    ];
    it.each(cases)('%j → %j (warnings: %s)', (input, expected, expectWarnings) => {
      const { output, hasMacroWarnings, hasMacroErrors } = evLogs(input);
      expect(output).toBe(expected);
      expect(hasMacroWarnings).toBe(expectWarnings);
      expect(hasMacroErrors).toBe(false);
    });
  });

  describe('Arity errors', () => {
    it('does not resolve macro without arguments when called with arguments', () => {
      const h = createHarness();
      expect(h.evaluate('Start {{char::extra}} end.')).toBe('Start {{char::extra}} end.');
      expect(
        h.warnings().some((w) => w.includes('Macro "char"') && w.includes('unnamed arguments')),
      ).toBe(true);
    });
    it('does not resolve reverse without arguments', () => {
      const h = createHarness();
      expect(h.evaluate('Result: {{reverse}}')).toBe('Result: {{reverse}}');
      expect(
        h.warnings().some((w) => w.includes('Macro "reverse"') && w.includes('unnamed arguments')),
      ).toBe(true);
    });
    it('does not resolve reverse with too many arguments', () => {
      const h = createHarness();
      expect(h.evaluate('Result: {{reverse::a::b}}')).toBe('Result: {{reverse::a::b}}');
      expect(
        h.warnings().some((w) => w.includes('Macro "reverse"') && w.includes('unnamed arguments')),
      ).toBe(true);
    });
    it('does not resolve list-bounded macro outside list bounds', () => {
      const h = createHarness();
      h.engine.registry.registerMacro('test-list-bounds', {
        unnamedArgs: 1,
        list: { min: 1, max: 2 },
        description: 'Test macro for list bounds.',
        handler: ({ unnamedArgs, list }) => [...unnamedArgs, ...(list ?? [])].join('|'),
      });
      const input = 'A {{test-list-bounds::base}} B {{test-list-bounds::base::x::y::z}}';
      expect(h.evaluate(input)).toBe(input);
      expect(
        h
          .warnings()
          .filter((w) => w.includes('Macro "test-list-bounds"') && w.includes('unnamed arguments'))
          .length,
      ).toBe(2);
    });
    it('resolves nested macros even when the outer macro has wrong arity', () => {
      expect(ev('Result: {{user Something {{char}}}}')).toBe(
        'Result: {{user Something Character}}',
      );
    });
  });

  describe('Type validation', () => {
    it('strict typed macro stays raw on invalid type', () => {
      const h = createHarness();
      h.engine.registry.registerMacro('test-int-strict', {
        unnamedArgs: [{ name: 'value', type: 'integer', description: 'Must be an integer.' }],
        strictArgs: true,
        description: 'Strict integer macro.',
        handler: ({ unnamedArgs: [value] }) => `#${value}#`,
      });
      expect(h.evaluate('Value: {{test-int-strict::abc}}')).toBe('Value: {{test-int-strict::abc}}');
      expect(
        h
          .warnings()
          .some(
            (w) => w.includes('Macro "test-int-strict"') && w.includes('expected type integer'),
          ),
      ).toBe(true);
    });
    it('non-strict typed macro resolves but warns', () => {
      const h = createHarness();
      h.engine.registry.registerMacro('test-int-nonstrict', {
        unnamedArgs: [{ name: 'value', type: 'integer' }],
        strictArgs: false,
        handler: ({ unnamedArgs: [value] }) => `#${value}#`,
      });
      expect(h.evaluate('Value: {{test-int-nonstrict::abc}}')).toBe('Value: #abc#');
      expect(
        h
          .warnings()
          .some(
            (w) => w.includes('Macro "test-int-nonstrict"') && w.includes('expected type integer'),
          ),
      ).toBe(true);
    });
  });

  describe('Environment', () => {
    it('exposes original content as env.content', () => {
      const h = createHarness();
      h.engine.registry.registerMacro('env-content', { handler: ({ env }) => env.content });
      const env = h.engine.buildEnv(h.state, {
        content: 'This is the full original input string.',
      });
      expect(h.engine.evaluate('{{env-content}}', env)).toBe(
        'This is the full original input string.',
      );
    });
  });

  describe('Deterministic pick macro', () => {
    const TEST_CHAT_ID_HASH = 123456;
    const mk = () => createHarness({ chatMetadata: { chat_id_hash: TEST_CHAT_ID_HASH } });
    const registerTestablePick = (h: ReturnType<typeof createHarness>) =>
      h.engine.registry.registerMacro('testablePick', {
        list: true,
        handler: ({ list, globalOffset, env }) => {
          const items = list ?? [];
          const chatIdHash = (env.runtime.chatMetadata['chat_id_hash'] as number) ?? 0;
          const rerollSeed = (env.runtime.chatMetadata['pick_reroll_seed'] as string) || null;
          const combinedSeedString = [chatIdHash, env.contentHash, globalOffset, rerollSeed]
            .filter((it) => it !== null)
            .join('-');
          const rng = seedrandom(String(getStringHash(combinedSeedString)));
          return `seed:${combinedSeedString}|pick:${items[Math.floor(rng() * items.length)]}`;
        },
      });
    const seeds = (output: string) => output.split('###').map((p) => /seed:([^|]+)/.exec(p)?.[1]);

    it('returns stable results for the same chat and content', () => {
      const h = mk();
      const input = 'Choices: {{pick::red::green::blue}}, {{pick::red::green::blue}}.';
      const o1 = h.evaluate(input);
      expect(o1).toBe(h.evaluate(input));
      const m = /Choices: ([^,]+), ([^.]+)\./.exec(o1)!;
      expect(['red', 'green', 'blue']).toContain(m[1]!.trim());
      expect(['red', 'green', 'blue']).toContain(m[2]!.trim());
    });
    it('uses different seeds for identical picks at different positions', () => {
      const h = mk();
      registerTestablePick(h);
      const [s1, s2] = seeds(h.evaluate('{{testablePick::A::B::C}}###{{testablePick::A::B::C}}'));
      expect(s1).toBeTruthy();
      expect(s1).not.toBe(s2);
    });
    it('uses different seeds inside different scoped macros', () => {
      const h = mk();
      registerTestablePick(h);
      const [s1, s2] = seeds(
        h.evaluate(
          '{{setvar::first}}{{testablePick::A::B::C}}{{/setvar}}{{setvar::second}}{{testablePick::A::B::C}}{{/setvar}}{{.first}}###{{.second}}',
        ),
      );
      expect(s1).toBeTruthy();
      expect(s1).not.toBe(s2);
    });
    it('uses different seeds in inline arguments', () => {
      const h = mk();
      registerTestablePick(h);
      const [s1, s2] = seeds(
        h.evaluate(
          '{{setvar::first::{{testablePick::A::B::C}}}}{{setvar::second::{{testablePick::A::B::C}}}}{{.first}}###{{.second}}',
        ),
      );
      expect(s1).toBeTruthy();
      expect(s1).not.toBe(s2);
    });
    it('is stable for picks in scoped content', () => {
      const h = mk();
      const input = '{{setvar::val}}{{pick::X::Y::Z}}{{/setvar}}{{.val}}';
      const r1 = h.evaluate(input);
      expect(r1).toBe(h.evaluate(input));
      expect(['X', 'Y', 'Z']).toContain(r1);
    });
    it('uses different seeds inside different if blocks (delayArgResolution)', () => {
      const h = mk();
      registerTestablePick(h);
      const [s1, s2] = seeds(
        h.evaluate(
          '{{if true}}{{testablePick::A::B::C}}{{/if}}###{{if true}}{{testablePick::A::B::C}}{{/if}}',
        ),
      );
      expect(s1).toBeTruthy();
      expect(s1).not.toBe(s2);
    });
    it('is stable for picks inside if blocks', () => {
      const h = mk();
      const input = '{{if true}}{{pick::X::Y::Z}}{{/if}}';
      const r1 = h.evaluate(input);
      expect(r1).toBe(h.evaluate(input));
      expect(['X', 'Y', 'Z']).toContain(r1);
    });
  });

  describe('Dynamic macros', () => {
    const dyn = (
      input: string,
      dynamicMacros: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => {
      const h = createHarness();
      const env = h.engine.buildEnv(h.state, {
        content: input,
        dynamicMacros: dynamicMacros as never,
        ...extra,
      });
      return { output: h.engine.evaluate(input, env), warnings: h.warnings() };
    };
    it('resolves string value', () =>
      expect(dyn('Test: {{myvalue}}', { myvalue: 'hello world' }).output).toBe(
        'Test: hello world',
      ));
    it('converts numeric value to string', () =>
      expect(dyn('Value: {{num}}', { num: 42 }).output).toBe('Value: 42'));
    it('does not resolve string dynamic macro with arguments', () => {
      const r = dyn('Dyn: {{myvalue::extra}}', { myvalue: 'hello' });
      expect(r.output).toBe('Dyn: {{myvalue::extra}}');
      expect(
        r.warnings.some((w) => w.includes('Macro "myvalue"') && w.includes('unnamed arguments')),
      ).toBe(true);
    });
    it('resolves handler function', () =>
      expect(dyn('Result: {{dyn}}', { dyn: () => 'handler result' }).output).toBe(
        'Result: handler result',
      ));
    it('passes execution context to handler', () => {
      const h = createHarness();
      const env = h.engine.buildEnv(h.state, {
        content: 'full content here',
        dynamicMacros: { dyn: (ctx) => `name=${ctx.name}, content=${ctx.env.content}` },
      });
      expect(h.engine.evaluate('{{dyn}}', env)).toBe('name=dyn, content=full content here');
    });
    it('does not resolve handler dynamic macro with arguments', () => {
      const r = dyn('Dyn: {{dyn::extra}}', { dyn: () => 'OK' });
      expect(r.output).toBe('Dyn: {{dyn::extra}}');
      expect(
        r.warnings.some((w) => w.includes('Macro "dyn"') && w.includes('unnamed arguments')),
      ).toBe(true);
    });
    it('resolves MacroDefinitionOptions', () => {
      expect(
        dyn('{{greet}}', {
          greet: { description: 'A greeting macro', handler: () => 'Hello from options!' },
        }).output,
      ).toBe('Hello from options!');
    });
    it('supports unnamed arguments in options', () => {
      expect(
        dyn('{{greet::World}}', {
          greet: {
            unnamedArgs: [{ name: 'name' }],
            handler: ({ unnamedArgs: [name] }: { unnamedArgs: string[] }) => `Hello, ${name}!`,
          },
        }).output,
      ).toBe('Hello, World!');
    });
    it('supports multiple unnamed arguments', () => {
      const wrap = {
        unnamedArgs: [{ name: 'content' }, { name: 'prefix' }, { name: 'suffix' }],
        handler: ({ unnamedArgs: [content, prefix, suffix] }: { unnamedArgs: string[] }) =>
          `${prefix}${content}${suffix}`,
      };
      expect(dyn('{{wrap::hello::[::]}}', { wrap }).output).toBe('[hello]');
    });
    it('supports optional arguments', () => {
      const greet = {
        unnamedArgs: [
          { name: 'name' },
          { name: 'greeting', optional: true, defaultValue: 'Hello' },
        ],
        handler: ({ unnamedArgs: [name, greeting] }: { unnamedArgs: string[] }) =>
          `${greeting || 'Hello'}, ${name}!`,
      };
      expect(dyn('{{greet::World}}', { greet }).output).toBe('Hello, World!');
      expect(dyn('{{greet::World::Hi}}', { greet }).output).toBe('Hi, World!');
    });
    it('supports list arguments', () => {
      const join = {
        unnamedArgs: [{ name: 'separator' }],
        list: true,
        handler: ({ unnamedArgs: [sep], list }: { unnamedArgs: string[]; list: string[] | null }) =>
          (list ?? []).join(sep),
      };
      expect(dyn('{{join::-::a::b::c}}', { join }).output).toBe('a-b-c');
    });
    it('enforces type validation in options', () => {
      const calc = {
        unnamedArgs: [{ name: 'value', type: 'integer' }],
        strictArgs: true,
        handler: ({ unnamedArgs: [val] }: { unnamedArgs: string[] }) => `#${val}#`,
      };
      const r = dyn('{{calc::abc}}', { calc });
      expect(r.output).toBe('{{calc::abc}}');
      expect(
        r.warnings.some((w) => w.includes('calc') && w.includes('expected type integer')),
      ).toBe(true);
    });
    it('respects strictArgs false in options', () => {
      const calc = {
        unnamedArgs: [{ name: 'value', type: 'integer' }],
        strictArgs: false,
        handler: ({ unnamedArgs: [val] }: { unnamedArgs: string[] }) => `#${val}#`,
      };
      const r = dyn('{{calc::abc}}', { calc });
      expect(r.output).toBe('#abc#');
      expect(
        r.warnings.some((w) => w.includes('calc') && w.includes('expected type integer')),
      ).toBe(true);
    });
    it('fails arity check with too few / too many args', () => {
      const greet = {
        unnamedArgs: [{ name: 'name' }],
        handler: ({ unnamedArgs: [name] }: { unnamedArgs: string[] }) => `Hello, ${name}!`,
      };
      for (const input of ['{{greet}}', '{{greet::one::two}}']) {
        const r = dyn(input, { greet });
        expect(r.output).toBe(input);
        expect(r.warnings.some((w) => w.includes('greet') && w.includes('unnamed arguments'))).toBe(
          true,
        );
      }
    });
    it('handles invalid MacroDefinitionOptions gracefully', () => {
      const r = dyn('{{bad}}', { bad: { unnamedArgs: 1 } });
      expect(r.output).toBe('{{bad}}');
      expect(
        r.warnings.some((w) => w.includes('bad') && w.includes('is not defined correctly')),
      ).toBe(true);
    });
    it('overrides registered macro with dynamic macro of same name', () => {
      expect(dyn('{{user}}', { user: 'DynamicUser' }, { name1Override: 'User' }).output).toBe(
        'DynamicUser',
      );
    });
    it('matches dynamic macro names case-insensitively', () => {
      const h = createHarness();
      const env = h.engine.buildEnv(h.state, { content: '', dynamicMacros: { MyMacro: 'value' } });
      expect(h.engine.evaluate('{{MyMacro}}', env)).toBe('value');
      expect(h.engine.evaluate('{{mymacro}}', env)).toBe('value');
      expect(h.engine.evaluate('{{MYMACRO}}', env)).toBe('value');
    });
    it('resolves multiple different dynamic macros', () => {
      expect(
        dyn('{{a}}-{{b}}-{{c}}', { a: 'alpha', b: () => 'beta', c: { handler: () => 'gamma' } })
          .output,
      ).toBe('alpha-beta-gamma');
    });
  });

  describe('Macro flags', () => {
    it.each([
      ['Hello {{#user}}!', 'Hello User!'],
      ['{{/unknown}}', '{{/unknown}}'],
      ['{{/user}}', '{{/user}}'],
      ['{{/getvar::test}}', '{{/getvar::test}}'],
      [
        'Hello {{user}}, this {{/char}} is raw, bye {{char}}!',
        'Hello User, this {{/char}} is raw, bye Character!',
      ],
      ['{{setvar::x}}value{{/setvar}}{{/user}}{{getvar::x}}', '{{/user}}value'],
      ['{{!reverse::hello}}', 'olleh'],
    ])('%s → %s', (input, expected) => expect(ev(input)).toBe(expected));
    it('passes flags to macro handler', () => {
      const h = createHarness();
      h.engine.registry.registerMacro('test-flags', {
        handler: ({ flags }) => `[${flags.raw.join(',') || 'none'}]`,
      });
      expect(h.evaluate('{{test-flags}} / {{!test-flags}} / {{!?test-flags}}')).toBe(
        '[none] / [!] / [!,?]',
      );
    });
    it('identifies individual flags in handler', () => {
      const h = createHarness();
      h.engine.registry.registerMacro('test-flag-check', {
        handler: ({ flags }) => {
          const parts: string[] = [];
          if (flags.immediate) parts.push('immediate');
          if (flags.delayed) parts.push('delayed');
          if (flags.filter) parts.push('filter');
          if (flags.closingBlock) parts.push('closingBlock');
          if (flags.preserveWhitespace) parts.push('preserveWhitespace');
          return parts.join('+') || 'noflags';
        },
      });
      const results = [
        '{{test-flag-check}}',
        '{{!test-flag-check}}',
        '{{?test-flag-check}}',
        '{{>test-flag-check}}',
        '{{#test-flag-check}}',
        '{{!?>test-flag-check}}',
      ].map((i) => h.evaluate(i));
      expect(results.join(' | ')).toBe(
        'noflags | immediate | delayed | filter | preserveWhitespace | immediate+delayed+filter',
      );
    });
    it('handles multiple flags with whitespace', () => {
      const h = createHarness();
      h.engine.registry.registerMacro('test-flags-ws', {
        handler: ({ flags }) => flags.raw.length.toString(),
      });
      expect(h.evaluate('{{ ! ? > test-flags-ws }}')).toBe('3');
    });
  });

  describe('Scoped macros', () => {
    it.each([
      ['{{setvar::myvar}}Hello World{{/setvar}}{{getvar::myvar}}', 'Hello World'],
      ['{{setvar::myvar}}Hello {{user}}!{{/setvar}}{{getvar::myvar}}', 'Hello User!'],
      [
        '{{setvar::outer}}before {{setvar::inner}}nested{{/setvar}} after{{/setvar}}{{getvar::outer}} | {{getvar::inner}}',
        'before  after | nested',
      ],
      [
        '{{setvar::a}}first{{/setvar}}{{setvar::b}}second{{/setvar}}[{{getvar::a}}][{{getvar::b}}]',
        '[first][second]',
      ],
      ['Before {{/setvar}} After', 'Before {{/setvar}} After'],
      ['{{setvar::myvar}}content{{/setvar}}{{/setvar}}{{getvar::myvar}}', '{{/setvar}}content'],
      ['{{setvar::empty}}{{/setvar}}[{{getvar::empty}}]', '[]'],
      [
        '{{setvar::multi}}Line 1\nLine 2\nLine 3{{/setvar}}{{getvar::multi}}',
        'Line 1\nLine 2\nLine 3',
      ],
      ['Before {{setvar::x}}value{{/setvar}} After {{getvar::x}}', 'Before  After value'],
      [
        '{{setvar::l1}}A{{setvar::l2}}B{{setvar::l3}}C{{/setvar}}B{{/setvar}}A{{/setvar}}{{getvar::l1}}|{{getvar::l2}}|{{getvar::l3}}',
        'AA|BB|C',
      ],
      ['{{reverse}}hello{{/reverse}}', 'olleh'],
      ['{{setvar::x}}content{{/getvar}}{{getvar::x}}', '{{setvar::x}}content{{/getvar}}'],
      [
        '{{setvar::special}}Hello { world } :: test{{/setvar}}{{getvar::special}}',
        'Hello { world } :: test',
      ],
      ['{{user}}Hello {{char}}!{{/user}}', '{{user}}Hello Character!{{/user}}'],
      [
        '{{setvar::myvar::existing}}extra{{/setvar}}{{getvar::myvar}}',
        '{{setvar::myvar::existing}}extra{{/setvar}}',
      ],
      [
        '{{setvar::outer}}A{{setvar::inner}}B{{/setvar}}C{{/setvar}}{{getvar::outer}}|{{getvar::inner}}',
        'AC|B',
      ],
      ['{{setvar::ws}}   {{/setvar}}[{{getvar::ws}}]', '[]'],
      ['{{#setvar::ws}}   {{/setvar}}[{{getvar::ws}}]', '[   ]'],
      ['{{setvar::x}}value{{/setvar}}result:{{getvar::x}}', 'result:value'],
      ['prefix {{setvar::x}}value{{/setvar}}', 'prefix '],
      [
        '{{setvar::a}}1{{/setvar}}{{setvar::b}}2{{/setvar}}{{setvar::c}}3{{/setvar}}{{getvar::a}}{{getvar::b}}{{getvar::c}}',
        '123',
      ],
      ['{{setvar::x}}{{user}}{{/setvar}}{{getvar::x}}', 'User'],
      [
        '{{setvar::a}}first{{/setvar}}middle{{setvar::b}}second{{/setvar}}[{{getvar::a}}][{{getvar::b}}]',
        'middle[first][second]',
      ],
    ])('%j → %j', (input, expected) => expect(ev(input)).toBe(expected));

    it('scoped is equivalent to inline argument syntax', () => {
      expect(ev('{{setvar::myvar::test value}}{{getvar::myvar}}')).toBe(
        ev('{{setvar::myvar}}test value{{/setvar}}{{getvar::myvar}}'),
      );
    });
    it('sets isScoped accordingly', () => {
      const h = createHarness();
      h.engine.registry.registerMacro('test-isscoped', {
        unnamedArgs: [{ name: 'content' }],
        handler: ({ isScoped }) => `isScoped:${isScoped}`,
      });
      expect(h.evaluate('{{test-isscoped}}content{{/test-isscoped}}')).toBe('isScoped:true');
      expect(h.evaluate('{{test-isscoped::content}}')).toBe('isScoped:false');
    });
    it('keeps scoped macro raw when argument count is below minimum', () => {
      const h = createHarness();
      h.engine.registry.registerMacro('test-3args', {
        unnamedArgs: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
        handler: ({ unnamedArgs: [a, b, c] }) => `${a}-${b}-${c}`,
      });
      expect(h.evaluate('{{test-3args::first}}second{{/test-3args}}')).toBe(
        '{{test-3args::first}}second{{/test-3args}}',
      );
    });
    it('evaluates inner macros before outer macro in scoped content', () => {
      const h = createHarness();
      const order: string[] = [];
      h.engine.registry.registerMacro('test-outer', {
        unnamedArgs: [{ name: 'content' }],
        handler: ({ unnamedArgs: [content] }) => {
          order.push('outer');
          return `[outer:${content}]`;
        },
      });
      h.engine.registry.registerMacro('test-inner', {
        handler: () => {
          order.push('inner');
          return 'INNER';
        },
      });
      expect(h.evaluate('{{test-outer}}before {{test-inner}} after{{/test-outer}}')).toBe(
        '[outer:before INNER after]',
      );
      expect(order.join(',')).toBe('inner,outer');
    });

    describe('scoped macros nested inside arguments', () => {
      it.each([
        ['{{setvar::testvar::{{reverse}}hello{{/reverse}}}} {{getvar::testvar}}', ' olleh'],
        ['{{setvar::testvar::{{if true}}true branch{{/if}}}} {{getvar::testvar}}', ' true branch'],
        [
          '{{setvar::testvar::{{if 0}}wrong{{else}}correct{{/if}}}} {{getvar::testvar}}',
          ' correct',
        ],
        [
          '{{setvar::testvar::{{reverse}}ab{{/reverse}}-{{reverse}}cd{{/reverse}}}} {{getvar::testvar}}',
          ' ba-dc',
        ],
        [
          '{{setvar::outer::{{setvar::inner::{{reverse}}xyz{{/reverse}}}}{{getvar::inner}}}} {{getvar::outer}}',
          ' zyx',
        ],
        [
          '{{setvar::testvar::before {{reverse}}mid{{/reverse}} after}} {{getvar::testvar}}',
          ' before dim after',
        ],
        [
          '{{setvar::myvar::prefix-{{reverse}}abc{{/reverse}}-suffix}}{{getvar::myvar}}',
          'prefix-cba-suffix',
        ],
        [
          '{{setvar::testvar::{{if true}}\ntrue\nbranch\n{{/if}}}} {{getvar::testvar}}',
          ' true\nbranch',
        ],
      ])('%j → %j', (input, expected) => expect(ev(input)).toBe(expected));
    });
  });

  describe('{{if}} conditional macro', () => {
    it.each([
      ['{{if::hello::shown}}', 'shown'],
      ['{{if::::hidden}}', ''],
      ['{{if::false::hidden}}', ''],
      ['{{if::off::hidden}}', ''],
      ['{{if::0::hidden}}', ''],
      ['{{if::true::shown}}', 'shown'],
      ['{{if::1::shown}}', 'shown'],
      ['{{if char}}Name: {{char}}{{/if}}', 'Name: Character'],
      ['{{if noop}}should not show{{/if}}[end]', '[end]'],
      ['{{if::notamacro::shown}}', 'shown'],
      ['{{if user}}Hello {{user}}{{/if}}', 'Hello User'],
      ['{{setvar::flag::yes}}{{if {{getvar::flag}}}}shown{{/if}}', 'shown'],
      ['{{setvar::flag::}}{{if {{getvar::flag}}}}hidden{{/if}}[end]', '[end]'],
      ['{{setvar::flag::false}}{{if {{getvar::flag}}}}hidden{{/if}}[end]', '[end]'],
      ['{{if yes}}This is the content{{/if}}', 'This is the content'],
      ['{{if::}}This should not show{{/if}}[after]', '[after]'],
      ['{{if yes}}Hello {{user}}!{{/if}}', 'Hello User!'],
      ['{{if yes}}outer{{if yes}}inner{{/if}}{{/if}}', 'outerinner'],
      ['{{if::}}outer{{if yes}}inner{{/if}}{{/if}}[end]', '[end]'],
      ['{{if yes}}outer{{if::}}inner{{/if}}end{{/if}}', 'outerend'],
      ['{{if something}}content{{/if}}', 'content'],
      ['{{if char}}{{char}} exists{{/if}}', 'Character exists'],
      ['{{if yes}}then{{else}}else{{/if}}', 'then'],
      ['{{if::}}then{{else}}else{{/if}}', 'else'],
      ['{{if::false}}yes{{else}}no{{/if}}', 'no'],
      ['{{if yes}}Hello {{user}}{{else}}Goodbye {{char}}{{/if}}', 'Hello User'],
      ['{{if::}}Hello {{user}}{{else}}Goodbye {{char}}{{/if}}', 'Goodbye Character'],
      [
        '{{if yes}}outer-then{{if yes}}inner-then{{else}}inner-else{{/if}}{{else}}outer-else{{/if}}',
        'outer-theninner-then',
      ],
      [
        '{{if::}}outer-then{{else}}outer-else{{if yes}}inner-then{{else}}inner-else{{/if}}{{/if}}',
        'outer-elseinner-then',
      ],
      ['{{if::}}A{{else}}B{{if::}}C{{else}}D{{/if}}{{/if}}', 'BD'],
      ['{{if::}}content{{/if}}[end]', '[end]'],
      ['{{if yes}}  then  {{else}}  else  {{/if}}', 'then'],
      ['{{if yes}}\n  then\n{{else}}\n  else\n{{/if}}', 'then'],
      ['{{if::}}\n  then\n{{else}}\n  else\n{{/if}}', 'else'],
      ['{{if char}}Has char{{else}}No char{{/if}}', 'Has char'],
      ['{{if noop}}Has value{{else}}Empty{{/if}}', 'Empty'],
      ['{{if !yes}}shown{{/if}}[end]', '[end]'],
      ['{{if !false}}shown{{/if}}', 'shown'],
      ['{{if::!}}not shown{{else}}shown{{/if}}', 'not shown'],
      ['{{if !noop}}No value{{/if}}', 'No value'],
      ['{{if !char}}No char{{else}}Has char{{/if}}', 'Has char'],
      ['{{setvar::emptyVar::}}{{if !{{getvar::emptyVar}}}}Empty var{{/if}}', 'Empty var'],
      [
        '{{setvar::bangVar::!hello}}{{if {{getvar::bangVar}}}}Has value{{else}}No value{{/if}}',
        'Has value',
      ],
      ['{{if !yes}}then{{else}}else{{/if}}', 'else'],
      ['{{if::!something}}shown{{/if}}[end]', '[end]'],
    ])('%j → %j', (input, expected) => expect(ev(input)).toBe(expected));
  });

  describe('scoped content auto-trim', () => {
    it.each([
      [
        '{{setvar::myvar}}\n  content with whitespace  \n{{/setvar}}[{{getvar::myvar}}]',
        '[content with whitespace]',
      ],
      ['{{setvar::myvar}}\n\n\ntext{{/setvar}}[{{getvar::myvar}}]', '[text]'],
      ['{{setvar::myvar}}text\n\n\n{{/setvar}}[{{getvar::myvar}}]', '[text]'],
      ['{{setvar::myvar}}\n  line1\n  line2  \n{{/setvar}}[{{getvar::myvar}}]', '[line1\nline2]'],
      ['{{#setvar::myvar}}\n  content  \n{{/setvar}}[{{getvar::myvar}}]', '[\n  content  \n]'],
      ['{{#setvar::myvar}}\n\ntext{{/setvar}}[{{getvar::myvar}}]', '[\n\ntext]'],
      ['{{#setvar::myvar}}text\n\n{{/setvar}}[{{getvar::myvar}}]', '[text\n\n]'],
      ['{{#setvar::myvar}}\n  {{char}}  \n{{/setvar}}[{{getvar::myvar}}]', '[\n  Character  \n]'],
      ['{{setvar::myvar}}\n  {{char}}  \n{{/setvar}}[{{getvar::myvar}}]', '[Character]'],
      ['{{if yes}}\n  trimmed  \n{{/if}}', 'trimmed'],
      ['{{#if yes}}\n  preserved  \n{{/if}}', '\n  preserved  \n'],
      ['{{reverse}}\n  abc  \n{{/reverse}}', 'cba'],
      ['{{#reverse}}\n  abc  \n{{/reverse}}', '\n  cba  \n'],
      [
        '{{setvar::myvar}}\n  # Heading\n  Content here\n{{/setvar}}[{{getvar::myvar}}]',
        '[# Heading\nContent here]',
      ],
      [
        '{{setvar::myvar}}\n    line1\n    line2\n    line3\n{{/setvar}}[{{getvar::myvar}}]',
        '[line1\nline2\nline3]',
      ],
      [
        '{{setvar::myvar}}\n  parent\n    child\n  sibling\n{{/setvar}}[{{getvar::myvar}}]',
        '[parent\n  child\nsibling]',
      ],
      [
        '{{setvar::myvar}}\n  # Header\n    - item1\n    - item2\n  Paragraph\n{{/setvar}}[{{getvar::myvar}}]',
        '[# Header\n  - item1\n  - item2\nParagraph]',
      ],
      ['{{if yes}}\n  # Title\n  Body text\n{{/if}}', '# Title\nBody text'],
      [
        '{{if false}}\n  Then branch\n{{else}}\n  # Else Title\n  Else body\n{{/if}}',
        '# Else Title\nElse body',
      ],
      [
        '{{#setvar::myvar}}\n  # Heading\n  Content\n{{/setvar}}[{{getvar::myvar}}]',
        '[\n  # Heading\n  Content\n]',
      ],
      ['{{setvar::myvar}}\n  single line\n{{/setvar}}[{{getvar::myvar}}]', '[single line]'],
      ['{{setvar::myvar}}\n  line1\n\n  line2\n{{/setvar}}[{{getvar::myvar}}]', '[line1\n\nline2]'],
      [
        '{{setvar::myvar}}\n  First Line\n    Second Line, more indented\n  Third line\n    Fourth line, also more indented\n{{/setvar}}[{{getvar::myvar}}]',
        '[First Line\n  Second Line, more indented\nThird line\n  Fourth line, also more indented]',
      ],
    ])('%j → %j', (input, expected) => expect(ev(input)).toBe(expected));
  });

  describe('Pre/Post Processor Registration', () => {
    it('runs custom pre-processor before evaluation', () => {
      const h = createHarness();
      h.engine.addPreProcessor((text) => text.replace(/\[\[USER\]\]/g, '{{user}}'), {
        priority: 100,
        source: 'test',
      });
      expect(h.evaluate('Hello [[USER]]!', { name1Override: 'TestUser' })).toBe('Hello TestUser!');
    });
    it('runs custom post-processor after evaluation', () => {
      const h = createHarness();
      h.engine.addPostProcessor((text) => `[${text}]`, { priority: 100, source: 'test' });
      expect(h.evaluate('Hello {{user}}!', { name1Override: 'TestUser' })).toBe(
        '[Hello TestUser!]',
      );
    });
    it('executes pre-processors in priority order', () => {
      const h = createHarness();
      h.engine.addPreProcessor((t) => t + 'B', { priority: 200 });
      h.engine.addPreProcessor((t) => t + 'A', { priority: 100 });
      expect(h.evaluate('X')).toBe('XAB');
    });
    it('executes post-processors in priority order', () => {
      const h = createHarness();
      h.engine.addPostProcessor((t) => `(${t})`, { priority: 200 });
      h.engine.addPostProcessor((t) => `[${t}]`, { priority: 100 });
      expect(h.evaluate('X')).toBe('([X])');
    });
    it('removes a registered pre-processor', () => {
      const h = createHarness();
      const handler = (t: string) => t + '-ADDED';
      h.engine.addPreProcessor(handler);
      expect(h.engine.removePreProcessor(handler)).toBe(true);
      expect(h.evaluate('Test')).toBe('Test');
      expect(h.engine.removePreProcessor(() => 'never')).toBe(false);
    });
    it('passes env to processors', () => {
      const h = createHarness();
      h.engine.addPreProcessor((text, env) => text.replace('__NAME__', env.names.user));
      expect(h.evaluate('Hello __NAME__!', { name1Override: 'EnvUser' })).toBe('Hello EnvUser!');
      const h2 = createHarness();
      h2.engine.addPostProcessor((text, env) => `${text} (by ${env.names.char})`);
      expect(h2.evaluate('Message', { name2Override: 'EnvChar' })).toBe('Message (by EnvChar)');
    });
  });

  describe('Variable Shorthand Syntax', () => {
    const cases: [
      string,
      { local?: Record<string, string>; global?: Record<string, string> },
      string,
    ][] = [
      ['{{.myvar}}', { local: { myvar: 'hello' } }, 'hello'],
      ['{{$myvar}}', { global: { myvar: 'world' } }, 'world'],
      ['{{.myvar = test}}Value: {{.myvar}}', { local: {} }, 'Value: test'],
      ['{{.counter++}}', { local: { counter: '5' } }, '6'],
      ['{{$counter--}}', { global: { counter: '10' } }, '9'],
      ['{{.myvar += 3}}Then: {{.myvar}}', { local: { myvar: '7' } }, 'Then: 10'],
      ['{{.greeting = Hello {{user}}}}{{.greeting}}', { local: {} }, 'Hello User'],
      ['{{ .myvar = spaced }}{{.myvar}}', { local: {} }, 'spaced'],
      ['{{.my-var}}', { local: { 'my-var': 'hyphenated' } }, 'hyphenated'],
      ['{{.my_var}}', { local: { my_var: 'underscored' } }, 'underscored'],
      ['Value:[{{.nonexistent}}]', { local: {} }, 'Value:[]'],
      ['{{.newcounter++}}', { local: {} }, '1'],
      ['{{.x = 5}}{{.x++}}{{.x += 10}}{{.x}}', { local: {} }, '616'],
      ['{{.myvar -= 3}}Then: {{.myvar}}', { local: { myvar: '10' } }, 'Then: 7'],
      ['{{$myvar -= 5}}{{$myvar}}', { global: { myvar: '20' } }, '15'],
      ['{{.myvar || fallback}}', { local: { myvar: '' } }, 'fallback'],
      ['{{.myvar || fallback}}', { local: { myvar: '0' } }, 'fallback'],
      ['{{.myvar || fallback}}', { local: { myvar: 'existing' } }, 'existing'],
      ['{{.nonexistent || default}}', { local: {} }, 'default'],
      ['{{.myvar ?? fallback}}', { local: {} }, 'fallback'],
      ['[{{.myvar ?? fallback}}]', { local: { myvar: '' } }, '[]'],
      ['{{.myvar ?? fallback}}', { local: { myvar: '0' } }, '0'],
      ['{{.myvar ?? fallback}}', { local: { myvar: 'value' } }, 'value'],
      ['{{.myvar ||= newval}}{{.myvar}}', { local: { myvar: '' } }, 'newvalnewval'],
      ['{{.myvar ||= newval}}{{.myvar}}', { local: { myvar: 'existing' } }, 'existingexisting'],
      ['{{.myvar ||= created}}{{.myvar}}', { local: {} }, 'createdcreated'],
      ['{{.myvar ??= created}}{{.myvar}}', { local: {} }, 'createdcreated'],
      ['[{{.myvar ??= newval}}][{{.myvar}}]', { local: { myvar: '' } }, '[][]'],
      ['{{.myvar ??= newval}}{{.myvar}}', { local: { myvar: '0' } }, '00'],
      ['{{.myvar == hello}}', { local: { myvar: 'hello' } }, 'true'],
      ['{{.myvar == world}}', { local: { myvar: 'hello' } }, 'false'],
      ['{{.myvar ==}}', { local: { myvar: '' } }, 'true'],
      ['{{.myvar == 42}}', { local: { myvar: '42' } }, 'true'],
      ['{{.myvar != world}}', { local: { myvar: 'hello' } }, 'true'],
      ['{{.myvar != hello}}', { local: { myvar: 'hello' } }, 'false'],
      ['{{.myvar !=}}', { local: { myvar: '' } }, 'false'],
      ['{{.myvar != }}', { local: { myvar: 'value' } }, 'true'],
      ['{{.myvar != 99}}', { local: { myvar: '42' } }, 'true'],
      ['{{.myvar > 5}}', { local: { myvar: '10' } }, 'true'],
      ['{{.myvar > 10}}', { local: { myvar: '5' } }, 'false'],
      ['{{.myvar > 10}}', { local: { myvar: '10' } }, 'false'],
      ['{{.myvar > 5}}', { local: { myvar: 'abc' } }, 'false'],
      ['{{.myvar >= 5}}', { local: { myvar: '10' } }, 'true'],
      ['{{.myvar >= 10}}', { local: { myvar: '10' } }, 'true'],
      ['{{.myvar >= 10}}', { local: { myvar: '5' } }, 'false'],
      ['{{.myvar < 10}}', { local: { myvar: '5' } }, 'true'],
      ['{{.myvar < 5}}', { local: { myvar: '10' } }, 'false'],
      ['{{.myvar < 10}}', { local: { myvar: '10' } }, 'false'],
      ['{{.myvar < 5}}', { local: { myvar: 'abc' } }, 'false'],
      ['{{.myvar <= 10}}', { local: { myvar: '5' } }, 'true'],
      ['{{.myvar <= 10}}', { local: { myvar: '10' } }, 'true'],
      ['{{.myvar <= 5}}', { local: { myvar: '10' } }, 'false'],
      ['{{.myvar > -5}}', { local: { myvar: '0' } }, 'true'],
      ['{{.myvar < 0}}', { local: { myvar: '-5' } }, 'true'],
      ['{{.myvar >= 3.14}}', { local: { myvar: '3.14' } }, 'true'],
      ['{{.myvar <= 2.5}}', { local: { myvar: '2.49' } }, 'true'],
      ['{{$myvar || globaldefault}}', { global: { myvar: '' } }, 'globaldefault'],
      ['{{$myvar ?? globaldefault}}', { global: {} }, 'globaldefault'],
      ['{{$myvar ||= gset}}{{$myvar}}', { global: { myvar: '' } }, 'gsetgset'],
      ['{{$myvar ??= gcreated}}{{$myvar}}', { global: {} }, 'gcreatedgcreated'],
      ['{{$myvar == test}}', { global: { myvar: 'test' } }, 'true'],
      ['{{.myvar || Hello {{user}}}}', { local: {} }, 'Hello User'],
      ['{{.myvar ?? Hello {{user}}}}', { local: {} }, 'Hello User'],
      ['{{ .myvar || spaced }}', { local: {} }, 'spaced'],
      ['{{ .myvar ?? spaced }}', { local: {} }, 'spaced'],
      // lazy evaluation
      [
        '{{.myvar ?? {{.tracker = evaluated}}fallback}}[{{.tracker}}]',
        { local: { myvar: 'exists' } },
        'exists[]',
      ],
      [
        '{{.myvar ?? {{.tracker = evaluated}}fallback}}[{{.tracker}}]',
        { local: {} },
        'fallback[evaluated]',
      ],
      [
        '{{.myvar || {{.tracker = evaluated}}fallback}}[{{.tracker}}]',
        { local: { myvar: 'truthy' } },
        'truthy[]',
      ],
      [
        '{{.myvar || {{.tracker = evaluated}}fallback}}[{{.tracker}}]',
        { local: { myvar: '' } },
        'fallback[evaluated]',
      ],
      [
        '{{.myvar ??= {{.tracker = evaluated}}newval}}[{{.tracker}}]',
        { local: { myvar: 'exists' } },
        'exists[]',
      ],
      [
        '{{.myvar ??= {{.tracker = evaluated}}newval}}[{{.tracker}}]',
        { local: {} },
        'newval[evaluated]',
      ],
      [
        '{{.myvar ||= {{.tracker = evaluated}}newval}}[{{.tracker}}]',
        { local: { myvar: 'truthy' } },
        'truthy[]',
      ],
      [
        '{{.myvar ||= {{.tracker = evaluated}}newval}}[{{.tracker}}]',
        { local: { myvar: '' } },
        'newval[evaluated]',
      ],
      ['{{.myvar = {{.tracker = evaluated}}value}}[{{.tracker}}]', { local: {} }, '[evaluated]'],
      [
        '{{.myvar += {{.tracker = evaluated}}5}}[{{.tracker}}]',
        { local: { myvar: '10' } },
        '[evaluated]',
      ],
      [
        '{{.myvar == {{.tracker = evaluated}}test}}[{{.tracker}}]',
        { local: { myvar: 'test' } },
        'true[evaluated]',
      ],
      [
        '{{.counter = 0}}{{.myvar ??= {{.counter += 1}}value}}{{.counter}}',
        { local: {} },
        'value1',
      ],
      // edge cases
      ['{{.myvar = }}[{{.myvar}}]', { local: {} }, '[]'],
      ['{{.myvar += }}[{{.myvar}}]', { local: { myvar: 'existing' } }, '[existing]'],
      ['{{.myvar -= }}[{{.myvar}}]', { local: { myvar: '10' } }, '[10]'],
      ['[{{.myvar || }}]', { local: { myvar: '' } }, '[]'],
      ['[{{.myvar ?? }}]', { local: {} }, '[]'],
      ['{{.myvar == }}', { local: { myvar: '' } }, 'true'],
      ['{{.myvar == }}', { local: { myvar: 'value' } }, 'false'],
      ['{{.myvar++5}}', { local: { myvar: '5' } }, '{{.myvar++5}}'],
      ['{{.myvar--5}}', { local: { myvar: '10' } }, ''],
      ['{{.myvar -- 5}}', { local: { myvar: '10' } }, '{{.myvar -- 5}}'],
      // in {{if}}
      ['{{if .flag}}Yes{{/if}}', { local: { flag: '1' } }, 'Yes'],
      ['{{if .flag}}Yes{{/if}}', { local: { flag: '' } }, ''],
      ['{{if $enabled}}Active{{/if}}', { global: { enabled: 'true' } }, 'Active'],
      ['{{if !.flag}}Not set{{/if}}', { local: { flag: '' } }, 'Not set'],
      ['{{if !$disabled}}Enabled{{/if}}', { global: { disabled: '' } }, 'Enabled'],
      ['{{if ! .empty}}Empty{{/if}}', { local: { empty: '' } }, 'Empty'],
      ['{{if .nonexistent}}Yes{{else}}No{{/if}}', { local: {} }, 'No'],
      ['{{if .active}}On{{else}}Off{{/if}}', { local: { active: 'yes' } }, 'On'],
      ['{{if .is-valid}}Valid{{/if}}', { local: { 'is-valid': '1' } }, 'Valid'],
      ['{{.ready = yes}}{{if .ready}}Ready!{{/if}}', { local: {} }, 'Ready!'],
      ['{{if .count}}Has count{{else}}No count{{/if}}', { local: { count: '0' } }, 'No count'],
      ['{{if .count}}Count: {{.count}}{{/if}}', { local: { count: '42' } }, 'Count: 42'],
      // hasvar / deletevar
      ['{{hasvar::myvar}}', { local: { myvar: 'value' } }, 'true'],
      ['{{hasvar::nonexistent}}', { local: {} }, 'false'],
      ['{{hasvar::myvar}}', { local: { myvar: '' } }, 'true'],
      ['{{hasglobalvar::myvar}}', { global: { myvar: 'value' } }, 'true'],
      ['{{hasglobalvar::nonexistent}}', { global: {} }, 'false'],
      [
        '{{hasvar::myvar}}{{deletevar::myvar}}{{hasvar::myvar}}',
        { local: { myvar: 'value' } },
        'truefalse',
      ],
      [
        '{{hasglobalvar::myvar}}{{deleteglobalvar::myvar}}{{hasglobalvar::myvar}}',
        { global: { myvar: 'value' } },
        'truefalse',
      ],
      [
        '{{if {{hasvar::myvar}} == true}}exists{{else}}missing{{/if}}',
        { local: { myvar: '' } },
        'exists',
      ],
    ];
    it.each(cases)('%j with %j → %j', (input, vars, expected) =>
      expect(evVars(input, vars)).toBe(expected),
    );
  });

  describe('Delayed Argument Resolution ({{if}} branch isolation)', () => {
    const run = (input: string) => {
      const h = createHarness();
      h.evaluate(input);
      return h.state.variables.local;
    };
    it('does NOT execute setvar in false branch', () =>
      expect(run('{{if 0}}{{setvar::v::should-not-set}}{{/if}}').get('v')).toBe(''));
    it('executes setvar in true branch', () =>
      expect(run('{{if 1}}{{setvar::v::was-set}}{{/if}}').get('v')).toBe('was-set'));
    it('only executes setvar in chosen else branch', () =>
      expect(
        run('{{if 0}}{{setvar::v::then-branch}}{{else}}{{setvar::v::else-branch}}{{/if}}').get('v'),
      ).toBe('else-branch'));
    it('only executes setvar in chosen then branch', () =>
      expect(
        run('{{if 1}}{{setvar::v::then-branch}}{{else}}{{setvar::v::else-branch}}{{/if}}').get('v'),
      ).toBe('then-branch'));
    it('executes multiple setvars only in chosen branch', () => {
      const vars = run(
        '{{if 0}}{{setvar::a::wrong}}{{setvar::b::wrong}}{{else}}{{setvar::a::right}}{{setvar::b::right}}{{/if}}',
      );
      expect(`a=${vars.get('a')},b=${vars.get('b')}`).toBe('a=right,b=right');
    });
    it('handles nested if with delayed resolution', () => {
      const vars = run(
        '{{if 1}}{{setvar::outer::yes}}{{if 0}}{{setvar::inner::wrong}}{{else}}{{setvar::inner::correct}}{{/if}}{{/if}}',
      );
      expect(`outer=${vars.get('outer')},inner=${vars.get('inner')}`).toBe(
        'outer=yes,inner=correct',
      );
    });
    it('works with variable shorthand condition', () => {
      const h = createHarness();
      h.state.variables.local.set('flag', '');
      h.evaluate('{{if .flag}}{{setvar::result::truthy}}{{else}}{{setvar::result::falsy}}{{/if}}');
      expect(h.state.variables.local.get('result')).toBe('falsy');
    });
    it('inline if does not break outer else detection', () => {
      expect(ev('{{if 0}}{{if::1::inner}}{{else}}outer-else{{/if}}')).toBe('outer-else');
      expect(ev('{{if 0}}{{if::1::a}}{{if::1::b}}{{else}}found{{/if}}')).toBe('found');
    });
  });
});
