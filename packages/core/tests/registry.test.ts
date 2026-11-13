// 移植自 SillyTavern tests/frontend/MacroRegistry.e2e.js
import { describe, expect, it } from 'vitest';
import {
  MacroRegistry,
  createCapturingLogger,
  type CapturedMacroLog,
  type MacroDefinitionOptions,
} from '../src/macros/index.js';

function reg() {
  const logs: CapturedMacroLog[] = [];
  const registry = new MacroRegistry(createCapturingLogger(logs));
  const regErrors = () =>
    logs
      .filter((l) => l.level === 'registerError')
      .map((l) => ({
        text: l.message,
        errorMessage: ((l.payload as { error?: Error })?.error as Error)?.message ?? null,
      }));
  const warnings = () => logs.filter((l) => l.level === 'warn').map((l) => l.message);
  return { registry, logs, regErrors, warnings };
}
const withHandler = (o: Record<string, unknown> | null) =>
  (o && !('handler' in o) ? { ...o, handler: () => '' } : o) as unknown as MacroDefinitionOptions;

describe('MacroRegistry', () => {
  it('registers a macro with valid options', () => {
    const { registry } = reg();
    registry.registerMacro('test-valid', {
      unnamedArgs: 2,
      list: { min: 1, max: 3 },
      strictArgs: false,
      description: 'Test macro for validation.',
      handler: ({ args }) => args.join(','),
    });
    const def = registry.getMacro('test-valid')!;
    expect({
      name: def.name,
      minArgs: def.minArgs,
      maxArgs: def.maxArgs,
      list: def.list,
      strictArgs: def.strictArgs,
      description: def.description,
    }).toEqual({
      name: 'test-valid',
      minArgs: 2,
      maxArgs: 2,
      list: { min: 1, max: 3 },
      strictArgs: false,
      description: 'Test macro for validation.',
    });
  });

  describe('register reject', () => {
    const cases: [string, Record<string, unknown> | null, string, string][] = [
      [
        '   ',
        {},
        'Failed to register macro ""',
        'Must start with a letter, followed by alphanumeric characters or hyphens.',
      ],
      [
        'invalid-options',
        null,
        'Failed to register macro "invalid-options"',
        'options must be a non-null object',
      ],
      [
        'no-handler',
        { handler: null },
        'Failed to register macro "no-handler"',
        'options.handler must be a function',
      ],
      [
        'bad-required',
        { unnamedArgs: -1 },
        'Failed to register macro "bad-required"',
        'options.unnamedArgs must be a non-negative integer',
      ],
      [
        'bad-strict',
        { strictArgs: 'yes' },
        'Failed to register macro "bad-strict"',
        'options.strictArgs must be a boolean',
      ],
      [
        'bad-list-type',
        { list: 'invalid' },
        'Failed to register macro "bad-list-type"',
        'options.list must be a boolean',
      ],
      [
        'bad-list-min',
        { list: { min: -1 } },
        'Failed to register macro "bad-list-min"',
        'options.list.min must be a non-negative integer',
      ],
      [
        'bad-list-max',
        { list: { min: 2, max: 1 } },
        'Failed to register macro "bad-list-max"',
        'options.list.max must be greater than or equal to options.list.min',
      ],
      [
        'bad-desc',
        { description: 123 },
        'Failed to register macro "bad-desc"',
        'options.description must be a string',
      ],
    ];
    it.each(cases)('rejects %j', (name, options, text, errorMessage) => {
      const { registry, regErrors } = reg();
      expect(registry.registerMacro(name, withHandler(options))).toBeNull();
      const e = regErrors().find((x) => x.text.includes(text));
      expect(e).toBeTruthy();
      expect(e?.errorMessage).toContain(errorMessage);
    });
  });

  describe('identifier validation', () => {
    it.each(['validMacro', 'my-macro-name', 'my_macro_name', 'macro123'])('accepts %s', (name) => {
      const { registry, regErrors } = reg();
      expect(registry.registerMacro(name, { handler: () => '' })).not.toBeNull();
      expect(regErrors()).toEqual([]);
    });
    it.each(['123macro', '-macro', 'macro@name', 'macro name'])('rejects %s', (name) => {
      const { registry, regErrors } = reg();
      expect(registry.registerMacro(name, { handler: () => '' })).toBeNull();
      expect(regErrors()[0]?.errorMessage).toContain('is invalid');
    });
    it('accepts valid alias identifier and rejects invalid', () => {
      const a = reg();
      expect(
        a.registry.registerMacro('primaryMacro', {
          aliases: [{ alias: 'valid-alias_123' }],
          handler: () => '',
        }),
      ).not.toBeNull();
      expect(a.regErrors()).toEqual([]);
      const b = reg();
      expect(
        b.registry.registerMacro('primaryMacro2', {
          aliases: [{ alias: '123-invalid' }],
          handler: () => '',
        }),
      ).toBeNull();
      expect(b.regErrors()[0]?.errorMessage).toContain('is invalid');
    });
  });

  describe('registerMacroAlias', () => {
    it('registers an alias for an existing macro', () => {
      const { registry } = reg();
      registry.registerMacro('alias-target', {
        description: 'Target',
        handler: () => 'target-result',
      });
      expect(registry.registerMacroAlias('alias-target', 'my-alias')).toBe(true);
      const aliasDef = registry.getMacro('my-alias')!;
      const targetDef = registry.getMacro('alias-target')!;
      expect(aliasDef.name).toBe('my-alias');
      expect(aliasDef.aliasOf).toBe('alias-target');
      expect(aliasDef.aliasVisible).toBe(true);
      expect(targetDef.name).toBe('alias-target');
      expect(aliasDef.handler).toBe(targetDef.handler);
      expect(targetDef.source).not.toBe(aliasDef.source);
    });
    it('registers alias with visible=false', () => {
      const { registry } = reg();
      registry.registerMacro('alias-target-hidden', { handler: () => 'result' });
      expect(
        registry.registerMacroAlias('alias-target-hidden', 'hidden-alias', { visible: false }),
      ).toBe(true);
      expect(registry.getMacro('hidden-alias')?.aliasVisible).toBe(false);
    });
    it('resolves alias of alias to primary', () => {
      const { registry } = reg();
      registry.registerMacro('primary-macro', { handler: () => 'primary-result' });
      registry.registerMacroAlias('primary-macro', 'first-alias');
      expect(registry.registerMacroAlias('first-alias', 'second-alias')).toBe(true);
      expect(registry.getMacro('second-alias')?.aliasOf).toBe('primary-macro');
    });
    it('is case-insensitive for lookup', () => {
      const { registry } = reg();
      registry.registerMacro('case-target', { handler: () => '' });
      registry.registerMacroAlias('case-target', 'CaseAlias');
      expect(!!registry.getMacro('casealias')).toBe(true);
      expect(!!registry.getMacro('CASEALIAS')).toBe(true);
      expect(!!registry.getMacro('CaseAlias')).toBe(true);
    });
    it.each([
      ['random', '123-invalid', 'is invalid'],
      ['random', 'RANDOM', 'cannot be the same as the target macro name'],
      ['non-existent-macro-xyz', 'my-alias', 'is not registered'],
      ['random', 'alias@name', 'is invalid'],
      ['random', '-alias', 'is invalid'],
    ])('rejects alias %s → %s', (target, alias, message) => {
      const { registry, regErrors } = reg();
      registry.registerMacro('random', { handler: () => '' });
      expect(registry.registerMacroAlias(target, alias)).toBe(false);
      const e = regErrors().find((x) => x.text.includes('[')) ?? regErrors()[0];
      expect(e?.errorMessage).toContain(message);
    });
    it('warns when alias overwrites existing macro / alias', () => {
      const { registry, warnings } = reg();
      registry.registerMacro('overwrite-target', { handler: () => 'target' });
      registry.registerMacro('overwrite-existing', { handler: () => 'existing' });
      expect(registry.registerMacroAlias('overwrite-target', 'overwrite-existing')).toBe(true);
      expect(
        warnings().some(
          (w) => w.includes('overwrites an existing macro') && w.includes('overwrite-existing'),
        ),
      ).toBe(true);

      registry.registerMacro('t1', { handler: () => '1' });
      registry.registerMacro('t2', { handler: () => '2' });
      registry.registerMacroAlias('t1', 'shared-alias-name');
      registry.registerMacroAlias('t2', 'shared-alias-name');
      expect(
        warnings().some(
          (w) => w.includes('overwrites an existing macro') && w.includes('shared-alias-name'),
        ),
      ).toBe(true);
    });
  });

  it('getAllMacros filters aliases', () => {
    const { registry } = reg();
    registry.registerMacro('a', {
      aliases: [{ alias: 'b' }, { alias: 'c', visible: false }],
      handler: () => '',
    });
    expect(
      registry
        .getAllMacros()
        .map((m) => m.name)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
    expect(registry.getAllMacros({ excludeAliases: true }).map((m) => m.name)).toEqual(['a']);
    expect(
      registry
        .getAllMacros({ excludeHiddenAliases: true })
        .map((m) => m.name)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(registry.unregisterMacro('b')).toBe(true);
    expect(registry.hasMacro('b')).toBe(false);
    expect(registry.getPrimaryMacro('c')?.name).toBe('a');
  });
});
