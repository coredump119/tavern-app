import { describe, expect, it, vi } from 'vitest';
import {
  ApiRouter,
  AUTO_FIRE_EVENTS,
  Coverage,
  createGetContext,
  elementId,
  event_types,
  extensionPath,
  isHostPath,
  Mirror,
  missingMember,
  planLoad,
  redactedCopy,
  reportMissingImports,
  setExport,
  shimNames,
  StEventEmitter,
  versionAtLeast,
  type ModuleTable,
} from '../src/index.js';

const request = (method: string, path: string, body?: unknown) => ({
  method,
  path,
  query: new URLSearchParams(),
  body,
});

describe('StEventEmitter', () => {
  it('awaits listeners in order and survives a throwing one', async () => {
    const source = new StEventEmitter();
    const seen: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    source.on('x', async (value: string) => {
      await Promise.resolve();
      seen.push(`a:${value}`);
    });
    source.on('x', () => {
      throw new Error('boom');
    });
    source.on('x', (value: string) => void seen.push(`c:${value}`));
    await source.emit('x', '1');
    expect(seen).toEqual(['a:1', 'c:1']);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('makeFirst / makeLast / removeListener / off / once', async () => {
    const source = new StEventEmitter();
    const seen: string[] = [];
    const a = () => void seen.push('a');
    const b = () => void seen.push('b');
    const c = () => void seen.push('c');
    source.on('x', a);
    source.on('x', b);
    source.makeFirst('x', c);
    source.makeLast('x', a);
    source.once('x', () => void seen.push('once'));
    await source.emit('x');
    expect(seen).toEqual(['c', 'b', 'a', 'once']);
    source.removeListener('x', c);
    source.off('x', b);
    seen.length = 0;
    await source.emit('x');
    expect(seen).toEqual(['a']);
    expect(source.has('x')).toBe(true);
    expect(source.has('y')).toBe(false);
  });

  it('a listener removed during an emit still runs in that emit (list is snapshotted)', async () => {
    const source = new StEventEmitter();
    const seen: string[] = [];
    const second = () => void seen.push('second');
    source.on('x', () => source.removeListener('x', second));
    source.on('x', second);
    await source.emit('x');
    await source.emit('x');
    expect(seen).toEqual(['second']);
  });

  it('replays app_ready to a late subscriber, and nothing else', async () => {
    const source = new StEventEmitter(AUTO_FIRE_EVENTS);
    await source.emit(event_types.APP_READY);
    await source.emit(event_types.CHAT_CHANGED, 'chat');
    const ready = vi.fn();
    const changed = vi.fn();
    source.on(event_types.APP_READY, ready);
    source.on(event_types.CHAT_CHANGED, changed);
    expect(ready).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });

  it('emitLate reaches a listener that subscribes before the next emit, once', async () => {
    const source = new StEventEmitter(AUTO_FIRE_EVENTS);
    const early = vi.fn();
    source.on(event_types.CHAT_CHANGED, early);
    await source.emitLate(event_types.CHAT_CHANGED, 'open-at-start');
    const late = vi.fn();
    source.on(event_types.CHAT_CHANGED, late);
    expect(late).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(early.mock.calls).toEqual([['open-at-start']]);
    expect(late.mock.calls).toEqual([['open-at-start']]);

    await source.emit(event_types.CHAT_CHANGED, 'next');
    const later = vi.fn();
    source.on(event_types.CHAT_CHANGED, later);
    await Promise.resolve();
    expect(later).not.toHaveBeenCalled();
    expect(late.mock.calls).toEqual([['open-at-start'], ['next']]);
  });

  it('emitAndWait does not wait for async listeners', () => {
    const source = new StEventEmitter();
    let done = false;
    source.on('x', async () => {
      await Promise.resolve();
      done = true;
    });
    source.emitAndWait('x');
    expect(done).toBe(false);
  });
});

describe('planLoad', () => {
  const ext = (name: string, manifest: unknown, error: string | null = null) => ({
    name,
    manifest,
    error,
  });

  it('orders by loading_order, then display name; no order sorts last', () => {
    const plan = planLoad(
      [
        ext('zeta', { display_name: 'Zeta', loading_order: 5, js: 'index.js' }),
        ext('plain', { display_name: 'Plain', js: 'index.js' }),
        ext('beta', { display_name: 'Beta', loading_order: 5, js: 'index.js' }),
        ext('early', { display_name: 'Early', loading_order: 1, js: 'index.js' }),
      ],
      [],
      '1.18.0',
    );
    expect(plan.load.map((e) => e.name)).toEqual(['early', 'beta', 'zeta', 'plain']);
    expect(plan.load[0]!.id).toBe('third-party/early');
  });

  it('separates disabled, too-new, Extras-bound and dependency-less extensions', () => {
    const plan = planLoad(
      [
        ext('off', { display_name: 'Off' }),
        ext('new', { minimum_client_version: '1.19.0' }),
        ext('old', { minimum_client_version: '1.12.13' }),
        ext('extras', { requires: ['tts'] }),
        ext('needs-regex', { dependencies: ['regex'] }),
        ext('needs-gone', { dependencies: ['third-party/gone'] }),
        ext('needs-off', { dependencies: ['third-party/off'] }),
        ext('broken', null, 'manifest.json 不是合法 JSON'),
      ],
      ['third-party/off'],
      '1.18.0',
    );
    expect(plan.load.map((e) => e.name).sort()).toEqual(['needs-regex', 'old']);
    expect(plan.disabled.map((e) => e.name)).toEqual(['off']);
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.name, s.reason]));
    expect(reasons['new']).toContain('1.19.0');
    expect(reasons['extras']).toContain('tts');
    expect(reasons['needs-gone']).toContain('third-party/gone');
    expect(reasons['needs-off']).toContain('third-party/off');
    expect(reasons['broken']).toBe('manifest.json 不是合法 JSON');
  });

  it('versionAtLeast compares numerically', () => {
    expect(versionAtLeast('1.18.0', '1.12.13')).toBe(true);
    expect(versionAtLeast('1.18.0', '1.18.0')).toBe(true);
    expect(versionAtLeast('1.9.0', '1.12.0')).toBe(false);
    expect(versionAtLeast('', '0.0.1')).toBe(false);
  });

  it('builds ST paths and element ids', () => {
    expect(extensionPath('my-ext', './index.js')).toBe(
      '/scripts/extensions/third-party/my-ext/index.js',
    );
    expect(elementId('third-party/my ext', 'js')).toBe('third-party_my_ext-js');
  });
});

describe('host module table', () => {
  const table = (): ModuleTable => ({
    '/script.js': { chat: [], saveChat: () => {} },
    '/scripts/utils.js': { uuidv4: () => 'id' },
  });

  it('registers implemented and requested names', () => {
    const names = shimNames(table(), [
      { '/script.js': ['chat', 'eventSource'] },
      { '/scripts/power-user.js': ['power_user'] },
    ]);
    expect(names).toEqual({
      '/script.js': ['chat', 'eventSource', 'saveChat'],
      '/scripts/power-user.js': ['power_user'],
      '/scripts/utils.js': ['uuidv4'],
    });
  });

  it('reports imports the app has nothing for', () => {
    const coverage = new Coverage();
    const missing = reportMissingImports(
      table(),
      [{ '/script.js': ['chat', 'eventSource'], '/scripts/power-user.js': ['power_user'] }],
      coverage,
    );
    expect(missing).toBe(2);
    expect(coverage.list().map((e) => e.name)).toEqual([
      '/script.js#eventSource',
      '/scripts/power-user.js#power_user',
    ]);
  });

  it('setExport notifies loaded stand-ins only on a change', () => {
    const modules = table();
    const live = vi.fn();
    modules['/script.js']!.__live = [live];
    const next = [1];
    setExport(modules, '/script.js', 'chat', next);
    setExport(modules, '/script.js', 'chat', next);
    setExport(modules, '/scripts/new.js', 'x', 1);
    expect(live).toHaveBeenCalledExactlyOnceWith('chat', next);
    expect(modules['/scripts/new.js']).toEqual({ x: 1 });
    expect(shimNames(modules, [])['/script.js']).not.toContain('__live');
  });
});

describe('Mirror', () => {
  it('keeps one object and merges per top-level key', () => {
    const mirror = new Mirror();
    mirror.reset({ a: 1, nested: { x: 1 } });
    const held = mirror.value;
    // the extension edits one key in place, the app another
    (held['nested'] as { x: number }).x = 2;
    held['mine'] = 'ext';
    mirror.pull({ a: 5, nested: { x: 1 } });
    expect(mirror.value).toBe(held);
    expect(held).toEqual({ a: 5, nested: { x: 2 }, mine: 'ext' });
    expect(mirror.push()).toEqual({ set: { nested: { x: 2 }, mine: 'ext' }, removed: [] });
    expect(mirror.push()).toBeNull();
  });

  it('follows removals from both sides', () => {
    const mirror = new Mirror();
    mirror.reset({ a: 1, b: 2, c: 3 });
    delete mirror.value['a'];
    expect(mirror.push()).toEqual({ set: {}, removed: ['a'] });
    mirror.pull({ c: 3 });
    expect(mirror.value).toEqual({ c: 3 });
  });

  it('hands out copies, not the extension’s own objects', () => {
    const mirror = new Mirror();
    mirror.reset({});
    const mine = { n: 1 };
    mirror.value['k'] = mine;
    const patch = mirror.push()!;
    expect(patch.set['k']).toEqual(mine);
    expect(patch.set['k']).not.toBe(mine);
  });

  it('reset drops what the extension left unsaved', () => {
    const mirror = new Mirror();
    mirror.reset({ a: 1 });
    mirror.value['stale'] = true;
    mirror.reset({ b: 2 });
    expect(mirror.value).toEqual({ b: 2 });
    expect(mirror.push()).toBeNull();
  });

  it('redactedCopy blanks the named keys at any depth', () => {
    const source = { url: 'u', deep: [{ secret: 'k', keep: 1 }], secret: { a: 1 } };
    const copy = redactedCopy(source, new Set(['secret']));
    expect(copy).toEqual({ url: 'u', deep: [{ secret: '', keep: 1 }], secret: {} });
    expect(source.deep[0]!.secret).toBe('k');
  });
});

describe('ApiRouter', () => {
  it('routes, and answers 501 for what is not there', async () => {
    const coverage = new Coverage();
    const router = new ApiRouter(
      {
        'POST /api/extensions/discover': () => ({ status: 200, body: [] }),
        'POST /api/broken': () => {
          throw new Error('no');
        },
      },
      coverage,
    );
    expect(await router.handle(request('POST', '/api/extensions/discover'))).toEqual({
      status: 200,
      body: [],
    });
    expect((await router.handle(request('POST', '/api/images/upload'))).status).toBe(501);
    expect((await router.handle(request('GET', '/api/plugins/x/y'))).status).toBe(501);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await router.handle(request('POST', '/api/broken'))).status).toBe(500);
    error.mockRestore();
    expect(coverage.list().map((e) => e.name)).toEqual([
      'GET /api/plugins/*',
      'POST /api/images/upload',
    ]);
  });

  it('knows which paths are the ST server’s', () => {
    expect(isHostPath('/api/chats/get')).toBe(true);
    expect(isHostPath('/csrf-token')).toBe(true);
    expect(isHostPath('/scripts/extensions/third-party/x/a.json')).toBe(false);
  });
});

describe('getContext', () => {
  const setup = () => {
    const coverage = new Coverage();
    let chatId = 'one';
    const getContext = createGetContext(
      {
        statics: { uuidv4: () => 'id' },
        state: () => ({ chat: [], chatId }),
      },
      coverage,
    );
    return { coverage, getContext, setChat: (id: string) => (chatId = id) };
  };

  it('returns a fresh object with current state', () => {
    const { getContext, setChat } = setup();
    const first = getContext();
    setChat('two');
    const second = getContext();
    expect(first).not.toBe(second);
    expect(first['chatId']).toBe('one');
    expect(second['chatId']).toBe('two');
    expect((second['uuidv4'] as () => string)()).toBe('id');
  });

  it('destructuring a missing member is free; using it throws and is recorded', () => {
    const { getContext, coverage } = setup();
    const { generateRaw, variables, Popup, characters } = getContext() as Record<string, any>;
    expect(coverage.list()).toHaveLength(1); // `characters`: state the app has nothing for
    expect(characters).toBeUndefined();
    expect(typeof generateRaw).toBe('function');
    expect(() => generateRaw({ prompt: 'x' })).toThrow('generateRaw 尚未实现');
    expect(() => variables.local.get('x')).toThrow('variables.local.get 尚未实现');
    expect(() => new Popup('x', 1)).toThrow('Popup 尚未实现');
    expect({} instanceof Popup).toBe(false);
    expect(coverage.list().map((e) => e.name)).toEqual([
      'characters',
      'generateRaw',
      'Popup',
      'variables.local.get',
    ]);
  });

  it('spreading the context does not touch missing state', () => {
    const { getContext, coverage } = setup();
    const copy = { ...getContext() };
    expect(copy['chatId']).toBe('one');
    expect(coverage.list()).toHaveLength(0);
  });

  it('a missing member is not mistaken for a promise', async () => {
    const coverage = new Coverage();
    const stub = missingMember('x', coverage, 'global');
    await expect(Promise.resolve(stub)).resolves.toBe(stub);
    expect(coverage.list()).toHaveLength(0);
  });
});
