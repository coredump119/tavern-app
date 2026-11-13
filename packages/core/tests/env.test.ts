// 移植自 SillyTavern tests/frontend/MacroEnvBuilder.e2e.js
import { describe, expect, it } from 'vitest';
import { env_provider_order } from '../src/macros/index.js';
import { createHarness, createTestState } from './helpers.js';

describe('MacroEnvBuilder', () => {
  it('builds names from overrides', () => {
    const h = createHarness();
    const env = h.engine.buildEnv(h.state, {
      content: 'ignored',
      name1Override: 'UserOverride',
      name2Override: 'CharOverride',
    });
    expect({ user: env.names.user, char: env.names.char }).toEqual({
      user: 'UserOverride',
      char: 'CharOverride',
    });
  });
  it('falls back to state names when overrides are not provided', () => {
    const h = createHarness({ userName: 'N1', charName: 'N2' });
    const env = h.engine.buildEnv(h.state, { content: '' });
    expect(env.names.user).toBe('N1');
    expect(env.names.char).toBe('N2');
  });
  it('does not populate character fields when replaceCharacterCard is false', () => {
    const h = createHarness();
    expect(
      Object.keys(
        h.engine.buildEnv(h.state, { content: '', replaceCharacterCard: false }).character,
      ),
    ).toEqual([]);
  });
  it('populates character fields when replaceCharacterCard is true', () => {
    const h = createHarness();
    expect(
      Object.keys(
        h.engine.buildEnv(h.state, { content: '', replaceCharacterCard: true }).character,
      ),
    ).toEqual(
      expect.arrayContaining([
        'charPrompt',
        'charInstruction',
        'description',
        'personality',
        'scenario',
        'persona',
        'mesExamplesRaw',
        'version',
        'charDepthPrompt',
        'creatorNotes',
        'firstMessage',
        'alternateGreetings',
      ]),
    );
  });
  it('wraps original into a one-shot helper', () => {
    const h = createHarness();
    const env = h.engine.buildEnv(h.state, { content: '', original: 'ORIGINAL_VALUE' });
    expect(typeof env.functions.original).toBe('function');
    expect(env.functions.original!()).toBe('ORIGINAL_VALUE');
    expect(env.functions.original!()).toBe('');
    expect(
      typeof h.engine.buildEnv(h.state, { content: '', original: undefined }).functions.original,
    ).toBe('undefined');
  });
  it('uses groupOverride for all group-related fields', () => {
    const h = createHarness();
    const env = h.engine.buildEnv(h.state, { content: '', groupOverride: 'Group One, Group Two' });
    expect({
      group: env.names.group,
      groupNotMuted: env.names.groupNotMuted,
      notChar: env.names.notChar,
    }).toEqual({
      group: 'Group One, Group Two',
      groupNotMuted: 'Group One, Group Two',
      notChar: 'Group One, Group Two',
    });
  });
  it('uses solo-chat semantics when no group is selected', () => {
    const h = createHarness();
    const env = h.engine.buildEnv(h.state, {
      content: '',
      name1Override: 'UserSolo',
      name2Override: 'CharSolo',
    });
    expect({
      group: env.names.group,
      groupNotMuted: env.names.groupNotMuted,
      notChar: env.names.notChar,
    }).toEqual({
      group: 'CharSolo',
      groupNotMuted: 'CharSolo',
      notChar: 'UserSolo',
    });
  });
  it('computes group names from the selected group', () => {
    const state = createTestState({
      characters: [
        { name: 'Alice', avatar: 'a.png' },
        { name: 'Bob', avatar: 'b.png' },
        { name: 'Cara', avatar: 'c.png' },
      ],
      groups: [{ id: 'g1', members: ['a.png', 'b.png', 'c.png'], disabled_members: ['b.png'] }],
      selectedGroup: 'g1',
    });
    const h = createHarness();
    const env = h.engine.buildEnv(state, {
      content: '',
      name1Override: 'Me',
      name2Override: 'Alice',
    });
    expect(env.names.group).toBe('Alice, Bob, Cara');
    expect(env.names.groupNotMuted).toBe('Alice, Cara');
    // 新引擎的 notChar 不含 muted 成员也不追加 user（与旧 getNotCharValue 不同）
    expect(env.names.notChar).toBe('Cara');
    expect(
      h.engine.evaluate('{{group}}|{{groupNotMuted}}|{{notChar}}|{{charIfNotGroup}}', env),
    ).toBe('Alice, Bob, Cara|Alice, Cara|Cara|Alice, Bob, Cara');
  });
  describe('Dynamic macros in env', () => {
    it('merges and lowercases dynamicMacros keys', () => {
      const h = createHarness();
      const env = h.engine.buildEnv(h.state, {
        content: '',
        dynamicMacros: { MyMacro: 'value1', UPPERCASE: 'value2', lowercase: 'value3', number: 42 },
      });
      expect(env.dynamicMacros['mymacro']).toBe('value1');
      expect(env.dynamicMacros['uppercase']).toBe('value2');
      expect(env.dynamicMacros['lowercase']).toBe('value3');
      expect(env.dynamicMacros['number']).toBe(42);
    });
    it('accepts strings, handlers and option objects', () => {
      const h = createHarness();
      const env = h.engine.buildEnv(h.state, {
        content: '',
        dynamicMacros: {
          stringVal: 'direct string',
          funcVal: () => 'from function',
          optionsVal: { handler: () => 'from options', unnamedArgs: 1 },
        },
      });
      expect(typeof env.dynamicMacros['stringval']).toBe('string');
      expect(typeof env.dynamicMacros['funcval']).toBe('function');
      expect(typeof env.dynamicMacros['optionsval']).toBe('object');
    });
    it('handles null/undefined dynamicMacros', () => {
      const h = createHarness();
      expect(
        Object.keys(h.engine.buildEnv(h.state, { content: '', dynamicMacros: null }).dynamicMacros),
      ).toEqual([]);
      expect(Object.keys(h.engine.buildEnv(h.state, { content: '' }).dynamicMacros)).toEqual([]);
    });
  });
  it('sets system.model from state', () => {
    const h = createHarness({ model: 'gpt-x' });
    expect(h.engine.buildEnv(h.state, { content: '' }).system.model).toBe('gpt-x');
  });
  it('applies providers in order buckets and tolerates errors', () => {
    const h = createHarness();
    h.engine.envBuilder.registerProvider(
      (env) => void (env.extra['order'] = [...((env.extra['order'] as string[]) || []), 'EARLY']),
      env_provider_order.EARLY,
    );
    h.engine.envBuilder.registerProvider(
      (env) => void (env.extra['order'] = [...((env.extra['order'] as string[]) || []), 'LATE']),
      env_provider_order.LATE,
    );
    h.engine.envBuilder.registerProvider(
      (env) => void (env.extra['order'] = [...((env.extra['order'] as string[]) || []), 'NORMAL']),
      env_provider_order.NORMAL,
    );
    h.engine.envBuilder.registerProvider(() => {
      throw new Error('intentional test error');
    }, env_provider_order.NORMAL);
    const env = h.engine.buildEnv(h.state, {
      content: '',
      name1Override: 'User',
      dynamicMacros: { marker: 'value' },
    });
    expect(env.extra['order']).toEqual(['EARLY', 'NORMAL', 'LATE']);
    expect(env.names.user).toBe('User');
    expect(env.dynamicMacros['marker']).toBe('value');
    expect(h.errors().length).toBe(1);
  });
});
