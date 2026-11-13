import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  canPerformToolCalls,
  isToolCallingSupported,
  toolInvocationMessage,
} from '../src/host/index.js';

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});

describe('ToolRegistry (ST ToolManager)', () => {
  it('lists registered tools as request definitions and honours shouldRegister', async () => {
    const warned: string[] = [];
    const tools = new ToolRegistry((t) => warned.push(t));
    tools.register({
      name: 'clock',
      description: 'time',
      parameters: { type: 'object', properties: {} },
      action: () => '12:00',
    });
    tools.register({ name: 'off', action: () => '', shouldRegister: async () => false });
    tools.register('old', 'early form', { type: 'object' }, () => 'x');
    expect(await tools.definitions()).toEqual([
      {
        type: 'function',
        function: {
          name: 'clock',
          description: 'time',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: { name: 'old', description: 'early form', parameters: { type: 'object' } },
      },
    ]);
    tools.register({ name: 'clock', action: () => '13:00' });
    expect(warned).toHaveLength(1);
    tools.unregister('clock');
    tools.unregister('off');
    tools.unregister('old');
    expect(tools.size).toBe(0);
  });

  it('invokes with parsed arguments and stringifies the result', async () => {
    const tools = new ToolRegistry();
    const seen: unknown[] = [];
    tools.register({
      name: 'echo',
      action: (p: unknown) => {
        seen.push(p);
        return { ok: true };
      },
    });
    expect(await tools.invoke('echo', '{"a":1}')).toBe('{"ok":true}');
    expect(await tools.invoke('echo', '')).toBe('{"ok":true}');
    expect(await tools.invoke('echo', { b: 2 })).toBe('{"ok":true}');
    expect(seen).toEqual([{ a: 1 }, {}, { b: 2 }]);
    const missing = await tools.invoke('nope', '{}');
    expect(missing).toBeInstanceOf(Error);
    expect((missing as Error).message).toBe('No tool with the name "nope" has been registered.');
    expect((missing as Error).cause).toBe('nope');
    const bad = await tools.invoke('echo', '{broken');
    expect((bad as Error).cause).toBe('echo');
  });

  it('formats the line shown while a tool runs', async () => {
    const tools = new ToolRegistry();
    tools.register({ name: 'a', displayName: 'Tool A', action: () => '' });
    tools.register({
      name: 'b',
      action: () => '',
      formatMessage: (p: unknown) => `b:${JSON.stringify(p)}`,
    });
    tools.register({
      name: 'c',
      action: () => '',
      formatMessage: () => {
        throw new Error('x');
      },
    });
    tools.register({ name: 'quiet', action: () => '', formatMessage: () => '' });
    expect(await tools.formatMessage('a', '{}')).toBe('Invoking tool: Tool A');
    expect(await tools.formatMessage('b', '{"k":1}')).toBe('b:{"k":1}');
    expect(await tools.formatMessage('c', '{}')).toBe('Invoking tool: c');
    expect(await tools.formatMessage('quiet', '{}')).toBe('');
    expect(await tools.formatMessage('zzz', '{}')).toBe('Invoked unknown tool: zzz');
  });

  it('runs the calls of one reply: results, errors and stealth tools', async () => {
    const tools = new ToolRegistry();
    tools.register({ name: 'clock', displayName: 'Clock', action: () => '12:00' });
    tools.register({
      name: 'boom',
      action: () => {
        throw new Error('no');
      },
    });
    tools.register({ name: 'ghost', stealth: true, action: () => 'hidden' });
    const shown: string[] = [];
    const r = await tools.run(
      [
        call('c1', 'clock', '{"zone":"utc"}'),
        { id: 'skip' },
        call('c2', 'boom', { a: 1 }),
        call('c3', 'ghost', ''),
      ],
      (t) => shown.push(t),
    );
    expect(r.invocations).toEqual([
      {
        id: 'c1',
        displayName: 'Clock',
        name: 'clock',
        parameters: '{"zone":"utc"}',
        result: '12:00',
        error: false,
        signature: null,
        reasoning: null,
      },
      {
        id: 'c2',
        displayName: 'boom',
        name: 'boom',
        parameters: '{"a":1}',
        result: 'Error: no',
        error: true,
        signature: null,
        reasoning: null,
      },
    ]);
    expect(r.errors.map((e) => e.cause)).toEqual(['boom']);
    expect(r.stealthCalls).toEqual(['ghost']);
    expect(shown).toEqual(['Invoking tool: Clock', 'Invoking tool: boom', 'Invoking tool: ghost']);
    expect((await tools.run(undefined)).invocations).toEqual([]);
  });
});

describe('tool calling support (ST isToolCallingSupported / canPerformToolCalls)', () => {
  const oai = { function_calling: true, chat_completion_source: 'custom' };
  it('needs Chat Completion, the preset switch, a known source and a tool-safe post-processing', () => {
    expect(isToolCallingSupported('openai', oai)).toBe(true);
    expect(isToolCallingSupported('textgenerationwebui', oai)).toBe(false);
    expect(isToolCallingSupported('openai', { ...oai, function_calling: false })).toBe(false);
    expect(isToolCallingSupported('openai', { ...oai, chat_completion_source: 'perplexity' })).toBe(
      false,
    );
    expect(
      isToolCallingSupported('openai', { ...oai, custom_prompt_post_processing: 'strict' }),
    ).toBe(false);
    expect(
      isToolCallingSupported('openai', { ...oai, custom_prompt_post_processing: 'semi_tools' }),
    ).toBe(true);
  });
  it('is off for impersonate, quiet and continue', () => {
    expect(canPerformToolCalls('normal', 'openai', oai)).toBe(true);
    expect(canPerformToolCalls('swipe', 'openai', oai)).toBe(true);
    for (const type of ['impersonate', 'quiet', 'continue'])
      expect(canPerformToolCalls(type, 'openai', oai)).toBe(false);
  });
});

describe('toolInvocationMessage (ST #formatToolInvocationMessage)', () => {
  it('groups names in the summary and escapes the JSON', () => {
    const base = { error: false, signature: null, reasoning: null } as const;
    const html = toolInvocationMessage([
      {
        ...base,
        id: '1',
        displayName: 'Clock',
        name: 'clock',
        parameters: '{"z":1}',
        result: 'a<b',
      },
      { ...base, id: '2', displayName: 'Clock', name: 'clock', parameters: '', result: '{"t":2}' },
      { ...base, id: '3', displayName: '', name: 'date', parameters: '{}', result: 'x&y' },
    ]);
    expect(html.startsWith('<details><summary>Tool calls: Clock (2), date</summary><pre>')).toBe(
      true,
    );
    expect(html).toContain('<code class="language-json">[\n  {\n    "error": false');
    expect(html).toContain('"parameters": {\n      "z": 1\n    }');
    expect(html).toContain('"result": "a&lt;b"');
    expect(html).toContain('"result": "x&amp;y"');
    expect(html.endsWith('</code></pre></details>')).toBe(true);
  });
});
