import { describe, expect, it, vi } from 'vitest';
import {
  ARGUMENT_TYPE,
  SlashCommandArgument,
  SlashCommandNamedArgument,
  SlashRunner,
  StSlashCommand,
  createSlashCommandParser,
  legacyMacroKey,
  legacyMacroValue,
  runGenerationInterceptors,
  type SlashCommand,
} from '../src/index.js';

describe('extension slash commands', () => {
  const setup = () => {
    const registry = new Map<string, SlashCommand>();
    const parser = createSlashCommandParser(registry);
    return { registry, parser, runner: new SlashRunner(registry) };
  };

  it('runs a command registered the ST way, with named and unnamed arguments', async () => {
    const { parser, runner } = setup();
    const seen: unknown[] = [];
    parser.addCommandObject(
      StSlashCommand.fromProps({
        name: 'sample-get',
        aliases: ['sg'],
        callback: (named: Record<string, unknown>, unnamed: unknown) => {
          seen.push([named['format'], unnamed, named['_hasUnnamedArgument']]);
          return `${String(named['format'])}:${String(unnamed)}`;
        },
        namedArgumentList: [
          SlashCommandNamedArgument.fromProps({
            name: 'format',
            aliasList: ['f'],
            typeList: [ARGUMENT_TYPE.STRING],
            defaultValue: 'json',
          }),
        ],
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'what' })],
      }),
    );
    expect((await runner.run('/sample-get format=raw items')).pipe).toBe('raw:items');
    expect((await runner.run('/sg f=text npcs')).pipe).toBe('text:npcs');
    expect(seen).toEqual([
      ['raw', 'items', true],
      ['text', 'npcs', true],
    ]);
    expect(parser.commands['sg']).toBe(parser.commands['sample-get']);
  });

  it('keeps ST argument defaults and constructor order', () => {
    const plain = SlashCommandArgument.fromProps({ description: 'd' });
    expect(plain).toMatchObject({ typeList: ['string'], isRequired: false, enumList: [] });
    const named = new SlashCommandNamedArgument('n', 'd', ARGUMENT_TYPE.NUMBER, true);
    expect(named).toMatchObject({ name: 'n', typeList: ['number'], isRequired: true });
    expect(named).toBeInstanceOf(SlashCommandArgument);
  });

  it('supports the legacy addCommand form and refuses reserved names', async () => {
    const { parser, runner } = setup();
    parser.addCommand('old-style', (_named, unnamed) => `got ${String(unnamed)}`, ['os']);
    expect((await runner.run('/os x')).pipe).toBe('got x');
    expect(() => parser.addCommand('#bad', () => '')).toThrow(/Illegal Name/);
    expect(() =>
      parser.addCommandObject(StSlashCommand.fromProps({ name: 'no-callback', callback: 1 })),
    ).toThrow();
  });

  it('gives a repeatable named argument as a list', async () => {
    const { parser, runner } = setup();
    parser.addCommandObject(
      StSlashCommand.fromProps({
        name: 'multi',
        callback: (named: Record<string, unknown>) => JSON.stringify(named['tag']),
        namedArgumentList: [
          SlashCommandNamedArgument.fromProps({ name: 'tag', acceptsMultiple: true }),
        ],
      }),
    );
    expect((await runner.run('/multi tag=a tag=b')).pipe).toBe('["a","b"]');
  });
});

describe('generation interceptors', () => {
  const manifest = (generate_interceptor?: string) =>
    ({ display_name: 'x', generate_interceptor }) as never;

  it('runs them in order over the same chat and reports an abort', async () => {
    const chat: unknown[] = [{ mes: 'a' }, { mes: 'b' }];
    const calls: string[] = [];
    const globals = {
      first: (list: unknown[], size: number, _abort: unknown, type: string) => {
        calls.push(`first ${size} ${type}`);
        list.shift();
      },
      second: async (list: unknown[], _size: number, abort: () => void) => {
        calls.push(`second ${list.length}`);
        abort();
      },
    };
    const aborted = await runGenerationInterceptors(
      [manifest('first'), manifest(), manifest('missing'), manifest('second')],
      globals,
      chat,
      4096,
      'normal',
    );
    expect(aborted).toBe(true);
    expect(calls).toEqual(['first 4096 normal', 'second 1']);
    expect(chat).toEqual([{ mes: 'b' }]);
  });

  it('stops at abort(true) and survives a throwing interceptor', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const later = vi.fn();
    const globals = {
      boom: () => {
        throw new Error('x');
      },
      stop: (_c: unknown, _s: unknown, abort: (now: boolean) => void) => abort(true),
      later,
    };
    expect(await runGenerationInterceptors([manifest('boom')], globals, [], 1, 'normal')).toBe(
      false,
    );
    expect(
      await runGenerationInterceptors(
        [manifest('stop'), manifest('later')],
        globals,
        [],
        1,
        'swipe',
      ),
    ).toBe(true);
    expect(later).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('legacy macros', () => {
  it('reads values the way MacrosParser does', () => {
    expect(legacyMacroValue('text', () => 'n')).toBe('text');
    expect(
      legacyMacroValue(
        (nonce: string) => `v-${nonce}`,
        () => 'n',
      ),
    ).toBe('v-n');
    expect(legacyMacroValue(undefined, () => 'n')).toBe('');
    expect(legacyMacroValue({ a: 1 }, () => 'n')).toBe('{"a":1}');
    expect(legacyMacroKey('  name ')).toBe('name');
    expect(() => legacyMacroKey('{{name}}')).toThrow();
    expect(() => legacyMacroKey(' ')).toThrow();
  });
});
