import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScriptsState } from '../src/protocol.js';
import {
  buttonEvent,
  enabledScripts,
  guardScriptTrees,
  normalizeScriptSettings,
  normalizeScriptTrees,
  patchScript,
  runningScripts,
  sanitizeScriptPatch,
  scriptFrameName,
  visibleButtons,
  type Script,
  type ScriptTree,
} from '../src/scripts.js';
import { buildScriptDocument } from '../src/realm/srcdoc.js';
import { setup } from './harness.js';

const script = (id: string, over: Partial<Script> = {}): Script => ({
  type: 'script',
  enabled: true,
  name: id,
  id,
  content: `console.log('${id}')`,
  info: '',
  button: { enabled: true, buttons: [] },
  data: {},
  ...over,
});
const library = (global: ScriptTree[], running: string[]): ScriptsState => ({
  epoch: 'chat-a',
  trees: { global, character: [], preset: [] },
  running,
});

describe('script library helpers', () => {
  let n = 0;
  const newId = () => `id-${++n}`;
  beforeEach(() => (n = 0));

  it('normalizes a list, a single script and a folder, keeping unknown fields', () => {
    const single = normalizeScriptTrees({ name: 'solo', content: 'x', future: 1 }, newId);
    // a script that does not say it is on is off
    expect(single).toEqual([
      { ...script('id-1', { name: 'solo', content: 'x', enabled: false }), future: 1 },
    ]);

    const trees = normalizeScriptTrees(
      [
        {
          type: 'script',
          id: 'a',
          name: 'A',
          content: 'a',
          enabled: false,
          buttons: [{ name: 'go' }],
        },
        { type: 'folder', id: 'f', name: 'F', scripts: [{ id: 'b', name: 'B', content: 'b' }, 7] },
        null,
      ],
      newId,
    );
    expect(trees).toHaveLength(2);
    expect(trees[0]).toMatchObject({ id: 'a', enabled: false });
    expect(visibleButtons(trees[0] as Script)).toEqual([{ name: 'go', visible: true }]);
    expect(trees[1]).toMatchObject({ type: 'folder', id: 'f', scripts: [{ id: 'b' }] });
    expect(normalizeScriptTrees('nope', newId)).toEqual([]);
  });

  it('reads the settings blob with defaults', () => {
    const settings = normalizeScriptSettings(
      {
        enabled: { global: false, characters: ['a.png', 3] },
        scripts: [{ name: 'S', content: '' }],
      },
      newId,
    );
    expect(settings.enabled).toEqual({ global: false, presets: [], characters: ['a.png'] });
    expect(settings.popuped).toEqual({ presets: [], characters: [] });
    expect(settings.scripts).toHaveLength(1);
    expect(normalizeScriptSettings(undefined, newId).enabled.global).toBe(true);
  });

  it('a disabled folder switches its scripts off', () => {
    const trees = normalizeScriptTrees(
      [
        { type: 'folder', id: 'f', name: 'F', enabled: false, scripts: [script('in')] },
        script('out'),
        script('off', { enabled: false }),
      ],
      newId,
    );
    expect(enabledScripts(trees).map((s) => s.id)).toEqual(['out']);
  });

  it('running scripts honour the scope switches and drop duplicate ids', () => {
    const trees = {
      global: [script('g'), script('dup')],
      character: [script('c'), script('dup')],
      preset: [script('p')],
    };
    const ids = (scopes: Record<'global' | 'character' | 'preset', boolean>) =>
      runningScripts(trees, scopes).map((s) => s.id);
    expect(ids({ global: true, character: true, preset: true })).toEqual(['g', 'dup', 'c', 'p']);
    expect(ids({ global: false, character: true, preset: false })).toEqual(['c', 'dup']);
    expect(ids({ global: false, character: false, preset: false })).toEqual([]);
  });

  it('patches one script and leaves the list alone when the id is unknown', () => {
    const trees: ScriptTree[] = [script('a'), script('b')];
    expect(patchScript(trees, 'zz', { info: 'x' })).toBe(trees);
    const next = patchScript(trees, 'b', { info: 'x', buttons: [{ name: 'go', visible: true }] });
    expect(next[0]).toBe(trees[0]);
    expect(next[1]).toMatchObject({ info: 'x', button: { buttons: [{ name: 'go' }] } });
    expect((trees[1] as Script).info).toBe('');
  });

  it('a patch from the realm keeps only what a script may change about itself', () => {
    expect(
      sanitizeScriptPatch({
        info: 'i',
        data: { a: 1 },
        buttons: [{ name: 'x', visible: false }, 'bare', { nope: 1 }, { name: 'y' }],
        content: 'evil()',
        enabled: true,
      }),
    ).toEqual({
      info: 'i',
      data: { a: 1 },
      buttons: [
        { name: 'x', visible: false },
        { name: 'y', visible: true },
      ],
    });
    expect(sanitizeScriptPatch({ data: [1] })).toEqual({});
    expect(sanitizeScriptPatch(null)).toEqual({});
  });

  it('scripts written by scripts arrive switched off unless their code is unchanged', () => {
    const stored: ScriptTree[] = [script('same'), script('edited')];
    const next: ScriptTree[] = [
      script('same', { info: 'renamed is fine' }),
      script('edited', { content: 'fetch("//elsewhere")' }),
      script('brand-new'),
      script('new-but-off', { enabled: false }),
    ];
    expect(enabledScripts(guardScriptTrees(next, stored)).map((s) => s.id)).toEqual(['same']);
  });

  it('names frames and button events like upstream', () => {
    expect(scriptFrameName(script('abc', { name: '状态栏' }))).toBe('TH-script--状态栏--abc');
    expect(buttonEvent('abc', '开始')).toBe('abc_开始');
  });

  it('a script document cannot close its own script element early', () => {
    const doc = buildScriptDocument('const s = "</script><img onerror=1>";', 'tm://jq.js');
    expect(doc.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(doc.match(/<\/script>/g)).toHaveLength(3);
    expect(doc.indexOf('__tmScripts.install')).toBeLessThan(doc.indexOf('tm://jq.js'));
  });
});

describe('bridge: slash and generation', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.start();
  });
  const settle = async <T>(promise: Promise<T>): Promise<T> => {
    await t.pump();
    return promise;
  };

  it('triggerSlash returns the pipe and passes a failure on', async () => {
    await expect(settle(t.api.triggerSlash('/echo hi'))).resolves.toBe('ran /echo hi');
    await expect(settle(t.api.triggerSlash('/nope'))).rejects.toThrow('未支持的 slash 命令');
    expect(t.calls).toEqual([
      ['slash', '/echo hi'],
      ['slash', '/nope'],
    ]);
    expect(t.api.triggerSlashWithResult).toBe(t.api.triggerSlash);
  });

  it('a generation announces itself, streams, ends, and returns the text', async () => {
    const seen: unknown[][] = [];
    for (const name of [
      'js_generation_requested',
      'js_generation_started',
      'js_stream_token_received_fully',
      'js_stream_token_received_incrementally',
      'js_generation_ended',
    ]) {
      t.api.eventOn(name, (...args: unknown[]) => void seen.push([name, ...args]));
    }
    const config = { user_input: 'hi', should_stream: true, generation_id: 'g1' };
    await expect(settle(t.api.generate(config))).resolves.toBe('Hello');
    expect(seen).toEqual([
      ['js_generation_requested', 'g1', 'generate', config],
      ['js_generation_started', 'g1'],
      ['js_stream_token_received_fully', 'He', 'g1'],
      ['js_stream_token_received_incrementally', 'He', 'g1'],
      ['js_stream_token_received_fully', 'Hello', 'g1'],
      ['js_stream_token_received_incrementally', 'llo', 'g1'],
      ['js_generation_ended', 'Hello', 'g1'],
    ]);
    expect(t.calls).toEqual([['generate', 'generate', config, 'g1']]);
  });

  it('a request the app turns down never reports a start', async () => {
    const started = vi.fn();
    const ended = vi.fn();
    t.api.eventOn('js_generation_started', started);
    t.api.eventOn('js_generation_ended', ended);
    await expect(settle(t.api.generate({ custom_api: {} }))).rejects.toThrow('custom_api');
    expect(started).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });

  it('generateRaw gets an id of its own and can return the reasoning', async () => {
    const ended = vi.fn();
    t.api.eventOn('js_generation_ended', ended);
    const result = await settle(t.api.generateRaw({ should_return_reasoning: true }));
    expect(result).toEqual({ content: 'Hello', reasoning: 'hm' });
    const [, kind, , id] = t.calls[0]!;
    expect(kind).toBe('raw');
    expect(typeof id).toBe('string');
    expect(id).not.toBe('');
    expect(ended).toHaveBeenCalledWith('Hello', id);
  });

  it('stops one generation or all of them', async () => {
    expect(t.api.stopGenerationById('nobody')).toBe(false);
    expect(t.api.stopAllGeneration()).toBe(false);
    const running = t.api.generate({ generation_id: 'g2' });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.api.stopGenerationById('g2')).toBe(true);
    expect(t.api.stopAllGeneration()).toBe(true);
    await settle(running);
    expect(t.calls.filter((c) => c[0] === 'stop')).toEqual([
      ['stop', 'g2'],
      ['stop', null],
    ]);
    expect(t.api.stopGenerationById('g2')).toBe(false);
  });
});

describe('bridge: script library', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.start();
    t.setLibrary(
      library(
        [script('a', { button: { enabled: true, buttons: [{ name: '开始', visible: true }] } })],
        ['a'],
      ),
    );
    await t.pump();
  });
  const scriptApi = () =>
    t.hub.createApi(
      { structuredClone },
      { name: 'TH-script--a--a', messageId: -1, script: ref },
    ) as Record<string, (...args: never[]) => unknown> & ReturnType<typeof t.hub.createApi>;
  const ref = { id: 'a', scope: 'global' as const, reload: vi.fn() };

  it('the library reaches the realm, and only script frames get the script API', () => {
    expect(t.hub.scripts?.running).toEqual(['a']);
    expect('getScriptId' in t.api).toBe(false);
    const api = scriptApi();
    expect(api['getScriptId']!()).toBe('a');
    expect(api['getScriptName']!()).toBe('a');
    expect(api['getButtonEvent']!('开始' as never)).toBe('a_开始');
    expect(api['getAllEnabledScriptButtons']!()).toEqual({
      a: [{ button_id: 'a_开始', button_name: '开始' }],
    });
    expect(() => api.getCurrentMessageId()).toThrow('脚本不属于任何楼层');
  });

  it('script variables are read at once and saved as one patch per tick', async () => {
    const api = scriptApi();
    api.insertOrAssignVariables({ hp: 1 }, { type: 'script' });
    api.insertOrAssignVariables({ mp: 2 }, { type: 'script' });
    (api['replaceScriptInfo'] as (info: string) => void)('说明');
    expect(api.getVariables({ type: 'script' })).toEqual({ hp: 1, mp: 2 });
    expect(api.getAllVariables()).toMatchObject({ lang: 'zh', hp: 10, mp: 2 });
    await t.pump();
    const writes = t.calls.filter((c) => c[0] === 'scripts');
    expect(writes).toHaveLength(1);
    expect(writes[0]![2]).toMatchObject([{ id: 'a', info: '说明', data: { hp: 1, mp: 2 } }]);
    // the app's echo of that write is not sent back into the realm
    expect(t.hub.scripts?.trees.global[0]).toMatchObject({ data: { hp: 1, mp: 2 } });
  });

  it('a card reads a script’s variables only by id', () => {
    expect(() => t.api.getVariables({ type: 'script' })).toThrow('script_id');
    expect(t.api.getVariables({ type: 'script', script_id: 'a' })).toEqual({});
  });

  it('buttons can be replaced and appended', async () => {
    const api = scriptApi();
    (api['appendInexistentScriptButtons'] as (b: unknown) => void)([
      { name: '开始', visible: false },
      { name: '结束', visible: true },
    ]);
    expect(api['getScriptButtons']!()).toEqual([
      { name: '开始', visible: true },
      { name: '结束', visible: true },
    ]);
    await t.pump();
    expect(t.library()?.trees.global[0]).toMatchObject({
      button: { buttons: [{ name: '开始' }, { name: '结束' }] },
    });
  });

  it('a library written by a script comes back with new code switched off', async () => {
    const api = scriptApi();
    const done = (api['replaceScriptTrees'] as (trees: unknown) => Promise<void>)([
      script('a', { button: { enabled: true, buttons: [] } }),
      { name: 'dropped in', content: 'steal()' },
    ]);
    await t.pump();
    await done;
    const stored = t.library()!.trees.global;
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ id: 'a', enabled: true });
    expect(stored[1]).toMatchObject({ id: 'new-1', name: 'dropped in', enabled: false });
    expect(t.hub.scripts?.trees.global).toHaveLength(2);
  });

  it('patching a script that is gone is refused', async () => {
    t.setLibrary(library([], []));
    await t.pump();
    const api = scriptApi();
    expect(() => api.insertOrAssignVariables({ x: 1 }, { type: 'script' })).toThrow(
      '已经不在脚本库里',
    );
  });
});
