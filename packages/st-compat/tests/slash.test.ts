import { describe, expect, it } from 'vitest';
import {
  coreCommands,
  parseSlash,
  resolveVariable,
  SlashError,
  SlashRunner,
  type SlashCommand,
  type VariableKind,
} from '../src/index.js';

function setup(extra: Record<string, SlashCommand> = {}) {
  const store: Record<VariableKind, Map<string, unknown>> = { local: new Map(), global: new Map() };
  const waits: number[] = [];
  const echoed: unknown[] = [];
  const commands = coreCommands({
    variables: {
      get: (kind, name) => store[kind].get(name),
      set: (kind, name, value) => void store[kind].set(name, value),
      delete: (kind, name) => void store[kind].delete(name),
    },
    wait: async (ms) => void waits.push(ms),
    random: () => 0.5,
  });
  commands.set('echo', {
    run: (_named, value) => {
      echoed.push(value);
      return value;
    },
  });
  for (const [name, command] of Object.entries(extra)) commands.set(name, command);
  const runner = new SlashRunner(commands, (text) => text.replace(/\{\{user\}\}/g, 'Ann'));
  const run = async (text: string) => (await runner.run(text)).pipe;
  return { run, runner, store, waits, echoed, commands };
}

describe('parseSlash', () => {
  const lookup = (name: string) =>
    ({ echo: {}, times: { split: true, splitCount: 1 }, add: { split: true } })[name];

  it('splits commands on pipes and reads named and unnamed arguments', () => {
    const root = parseSlash('/echo a=1 b="two words" hello there | /echo', lookup);
    expect(root.commands).toHaveLength(2);
    expect(root.commands[0]).toEqual({
      name: 'echo',
      named: [
        { name: 'a', value: '1' },
        { name: 'b', value: 'two words' },
      ],
      unnamed: ['hello there'],
      injectPipe: true,
    });
    expect(root.commands[1]!.unnamed).toEqual([]);
  });

  it('marks the command after || as not taking the pipe', () => {
    const root = parseSlash('/echo a || /echo', lookup);
    expect(root.commands.map((c) => c.injectPipe)).toEqual([true, false]);
  });

  it('keeps escaped pipes and pipes inside macros as text', () => {
    const root = parseSlash('/echo a\\|b {{random::x|y}}', lookup);
    expect(root.commands).toHaveLength(1);
    expect(root.commands[0]!.unnamed).toEqual(['a|b {{random::x|y}}']);
  });

  it('parses closures with parameters and the immediate form', () => {
    const root = parseSlash('/times 2 {: x=1 /echo {{var::x}} :} | /echo {: /echo a :}()', lookup);
    const body = root.commands[0]!.unnamed[1];
    expect(typeof body).toBe('object');
    if (typeof body !== 'object') return;
    expect(body.params).toEqual([{ name: 'x', value: '1' }]);
    expect(body.commands[0]!.name).toBe('echo');
    const immediate = root.commands[1]!.unnamed[0];
    expect(typeof immediate === 'object' && immediate.immediate).toBe(true);
  });

  it('splits list arguments, keeping quoted items whole', () => {
    const root = parseSlash('/add 1 "2 3" [4,5]', lookup);
    expect(root.commands[0]!.unnamed).toEqual(['1', '2 3', '[4,5]']);
  });

  it('skips comments, parser flags and loose text', () => {
    const root = parseSlash(
      '// note | /parser-flag STRICT_ESCAPING on | hi | /* block */ /echo a | /# x',
      lookup,
    );
    expect(root.commands.map((c) => c.name)).toEqual(['echo']);
  });

  it('turns /:name into /run name', () => {
    const root = parseSlash('/:greet who=you', lookup);
    expect(root.commands[0]).toMatchObject({
      name: 'run',
      unnamed: ['greet'],
      named: [{ name: 'who', value: 'you' }],
    });
  });

  it('rejects unknown commands and unterminated input', () => {
    expect(() => parseSlash('/nope 1', lookup)).toThrow(SlashError);
    expect(() => parseSlash('/echo {: /echo a', lookup)).toThrow(SlashError);
    expect(() => parseSlash('/echo a="b', lookup)).toThrow(SlashError);
  });
});

describe('SlashRunner', () => {
  it('pipes a result into the next command and into {{pipe}}', async () => {
    const { run } = setup();
    expect(await run('/echo hi | /echo')).toBe('hi');
    expect(await run('/echo hi | /echo <{{pipe}}>')).toBe('<hi>');
    expect(await run('/echo hi || /echo')).toBe('');
  });

  it('substitutes host macros in arguments', async () => {
    const { run } = setup();
    expect(await run('/echo hello {{user}}')).toBe('hello Ann');
  });

  it('reads and writes chat and global variables', async () => {
    const { run, store } = setup();
    expect(await run('/setvar key=hp 10 | /addvar key=hp 5 | /getvar hp')).toBe('15');
    expect(await run('/incvar hp | /decvar hp | /decvar hp')).toBe('14');
    expect(await run('/setglobalvar key=name Bo | /getglobalvar name')).toBe('Bo');
    expect(await run('/addvar key=log a | /addvar key=log b | /getvar log')).toBe('ab');
    await run('/flushvar hp');
    expect(store.local.has('hp')).toBe(false);
    expect(await run('/getvar hp')).toBe('');
  });

  it('indexes into JSON variables', async () => {
    const { run, store } = setup();
    await run('/setvar key=bag index=0 sword | /setvar key=bag index=1 as=number 3');
    expect(store.local.get('bag')).toBe('["sword",3]');
    expect(await run('/getvar key=bag index=1')).toBe('3');
    await run('/setvar key=stat index=str as=number 7');
    expect(store.local.get('stat')).toBe('{"str":7}');
    expect(await run('/addvar key=bag shield | /len {{pipe}}')).toBe('3');
  });

  it('scopes /let variables to their closure', async () => {
    const { run } = setup();
    expect(await run('/let x 1 | /var x 2 | /echo {{var::x}}')).toBe('2');
    expect(await run('/let x outer | /if a=1 {: /let x inner | /echo {{var::x}} :}')).toBe('inner');
    expect(await run('/let x outer | /if a=1 {: /var x changed :} | /echo {{var::x}}')).toBe(
      'changed',
    );
    await expect(run('/var missing 1')).rejects.toThrow(SlashError);
    await expect(run('/let x 1 | /let x 2')).rejects.toThrow(SlashError);
  });

  it('does arithmetic over lists, resolving variable names', async () => {
    const { run } = setup();
    expect(await run('/add 1 2 3')).toBe('6');
    expect(await run('/setvar key=n 4 | /mul n 2.5')).toBe('10');
    expect(await run('/sub 10 3 2')).toBe('5');
    expect(await run('/div 9 0')).toBe('0');
    expect(await run('/mod 9 4')).toBe('1');
    expect(await run('/max [3,9,4]')).toBe('9');
    expect(await run('/round 2.6')).toBe('3');
    expect(await run('/abs -2')).toBe('2');
    expect(await run('/add nothing here')).toBe('0');
    expect(await run('/rand from=10 to=20 round=floor')).toBe('15');
    expect(await run('/len [1,2,3]')).toBe('3');
    expect(await run('/upper abc | /lower | /trim')).toBe('abc');
  });

  it('branches with /if', async () => {
    const { run } = setup();
    expect(await run('/if left=2 rule=gt right=1 "/echo yes"')).toBe('yes');
    expect(await run('/if left=1 rule=gt right=2 else="/echo no" /echo yes')).toBe('no');
    expect(await run('/if left=Cat rule=in right=a {: /echo has :}')).toBe('has');
    expect(await run('/if left=off /echo yes')).toBe('');
    expect(await run('/if left=off rule=not /echo yes')).toBe('yes');
    expect(await run('/setvar key=mood happy | /if left=mood right=happy /echo ok')).toBe('ok');
    await expect(run('/if left=a rule=gt right=b /echo x')).rejects.toThrow(SlashError);
  });

  it('loops with /while and /times, honouring the guard and /break', async () => {
    const { run, echoed } = setup();
    expect(await run('/setvar key=i 0 | /while left=i rule=lt right=3 {: /incvar i :}')).toBe('3');
    expect(await run('/setvar key=i 0 | /while left=1 {: /incvar i :} | /getvar i')).toBe('100');
    await run('/times 3 {: /echo {{timesIndex}} :}');
    expect(echoed.slice(-3)).toEqual(['0', '1', '2']);
    await run('/times 2 "/echo n{{timesIndex}}"');
    expect(echoed.slice(-2)).toEqual(['n0', 'n1']);
    expect(await run('/times 5 {: /if left={{timesIndex}} right=2 {: /break stop :} :}')).toBe(
      'stop',
    );
    expect(echoed.length).toBe(5);
  });

  it('runs closures stored in variables with arguments', async () => {
    const { run } = setup();
    const script = '/let greet {: who=world /echo hello {{var::who}} :} | ';
    expect(await run(`${script}/run greet`)).toBe('hello world');
    expect(await run(`${script}/:greet who=you`)).toBe('hello you');
    expect(await run('/run {: /echo direct :}')).toBe('direct');
    expect(await run('/echo {: /echo now :}()')).toBe('now');
    await expect(run('/run nobody')).rejects.toThrow(SlashError);
  });

  it('stops everything on /abort, nested or not', async () => {
    const { runner, echoed } = setup();
    const result = await runner.run('/echo a | /if left=1 {: /abort :} | /echo b');
    expect(result.aborted).toBe(true);
    expect(echoed).toEqual(['a']);
  });

  it('waits with /delay and passes values through /pass and /return', async () => {
    const { run, waits } = setup();
    expect(await run('/delay 250 | /pass kept | /return')).toBe('kept');
    expect(waits).toEqual([250]);
  });

  it('gives split commands their list and others the joined text', async () => {
    const seen: unknown[] = [];
    const { run } = setup({
      spy: { run: (_n, value) => (seen.push(value), '') },
      spylist: { split: true, run: (_n, value) => (seen.push(value), '') },
    });
    await run('/spy "a b" c | /spylist "a b" c | /echo p | /spy');
    expect(seen).toEqual(['a b c', ['a b', 'c'], 'p']);
  });

  it('collects a repeatable named argument into a list, and only that one', async () => {
    const seen: unknown[] = [];
    const { run } = setup({
      spy: { repeatable: ['tag'], run: (named) => (seen.push({ ...named }), '') },
    });
    await run('/spy tag=a name=x tag="b c" name=y | /spy tag=one | /spy');
    expect(seen).toEqual([{ tag: ['a', 'b c'], name: 'y' }, { tag: ['one'] }, {}]);
  });

  it('resolves a name as script, chat, then global variable', async () => {
    const tables: Record<VariableKind, Record<string, unknown>> = {
      local: {},
      global: { who: 'global' },
    };
    const variables = {
      get: (kind: VariableKind, name: string) => tables[kind][name],
      set: () => undefined,
      delete: () => undefined,
    };
    const seen: unknown[] = [];
    const { run } = setup({
      spy: {
        run: (_n, value, context) => {
          seen.push(resolveVariable(variables, String(value), context.scope));
          return '';
        },
      },
    });
    await run('/spy who');
    tables.local['who'] = '7';
    await run('/spy who | /let who script | /spy who | /spy nobody');
    expect(seen).toEqual(['global', 7, 'script', 'nobody']);
  });
});
