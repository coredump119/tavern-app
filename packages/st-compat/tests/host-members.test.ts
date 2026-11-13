import { describe, expect, it, vi } from 'vitest';
import {
  createSwipeMember,
  createVariablesMember,
  permissionSummary,
  resolveSwipe,
  shouldSendOnEnter,
  type SwipePage,
  type VariableHost,
} from '../src/index.js';

function variableHost(): VariableHost & { tables: Record<string, Record<string, unknown>> } {
  const tables: Record<string, Record<string, unknown>> = { local: {}, global: {} };
  return {
    tables,
    get: (kind, name) => tables[kind]![name],
    set: (kind, name, value) => void (tables[kind]![name] = value),
    delete: (kind, name) => void delete tables[kind]![name],
  };
}

describe('createVariablesMember', () => {
  it('reads, writes and deletes per scope', () => {
    const host = variableHost();
    const { local, global } = createVariablesMember(host);
    expect(local.has('hp')).toBe(false);
    expect(local.get('hp')).toBe('');
    local.set('hp', '12');
    expect(local.get('hp')).toBe(12);
    expect(local.has('hp')).toBe(true);
    expect(global.has('hp')).toBe(false);
    expect(local.del('hp')).toBe('');
    expect(host.tables['local']).toEqual({});
  });

  it('adds numbers, appends to lists and joins text like /addvar', () => {
    const host = variableHost();
    const { global } = createVariablesMember(host);
    expect(global.inc('n')).toBe(1);
    expect(global.add('n', 4)).toBe(5);
    expect(global.dec('n')).toBe(4);
    global.set('list', '["a"]');
    expect(global.add('list', 'b')).toBe('["a","b"]');
    global.set('word', 'ab');
    expect(global.add('word', 'cd')).toBe('abcd');
  });

  it('takes ST `key` and `index` arguments', () => {
    const host = variableHost();
    const { local } = createVariablesMember(host);
    local.set('bag', '{"coins":3}');
    expect(local.get('ignored', { key: 'bag', index: 'coins' })).toBe(3);
    local.set('bag', 7, { index: 'coins' });
    expect(JSON.parse(String(host.tables['local']!['bag']))).toEqual({ coins: 7 });
    expect(() => local.set('', 1)).toThrow();
  });
});

function swipePage(over: Partial<SwipePage> = {}) {
  const chat: Record<string, unknown>[] = [
    { mes: 'greeting', swipe_id: 0, swipes: ['greeting', 'alt greeting'] },
    { mes: 'ask', is_user: true },
    { mes: 'b', swipe_id: 1, swipes: ['a', 'b', 'c'] },
  ];
  const load = vi.fn(async (_index: number, _swipeId: number) => {});
  const regenerate = vi.fn(async () => {});
  const setHidden = vi.fn((_hidden: boolean) => {});
  const page: SwipePage = {
    chat: () => chat,
    busy: () => false,
    pristine: () => false,
    load,
    regenerate,
    setHidden,
    ...over,
  };
  return { page, chat, load, regenerate, setHidden };
}

describe('resolveSwipe', () => {
  const { chat } = swipePage();
  const env = { hidden: false, pristine: false };
  const at = (direction: unknown, options = {}, over = {}) =>
    resolveSwipe(chat, direction, options, { ...env, ...over });

  it('steps the last message, wrapping on the left and regenerating past the right end', () => {
    expect(at('left')).toEqual({ index: 2, swipeId: 0 });
    expect(at('right')).toEqual({ index: 2, swipeId: 2 });
    expect(at('left', { forceSwipeId: -1 })).toEqual({ index: 2, swipeId: 2 });
    expect(at('left', { forceSwipeId: 9 })).toEqual({ index: 2, swipeId: 2 });
    expect(at('right', { forceSwipeId: 3 })).toEqual({ index: 2, regenerate: true });
    expect(at('right', { forceSwipeId: 1 })).toBeNull();
    expect(at('sideways')).toBeNull();
    expect(resolveSwipe([], 'right', {}, env)).toBeNull();
  });

  it('leaves other messages alone unless the source skips the checks', () => {
    expect(at('right', { forceMesId: 0 })).toBeNull();
    expect(at('right', { message: chat[0] })).toBeNull();
    expect(at('right', { message: { mes: 'gone' } })).toBeNull();
    expect(at('right', { forceMesId: 7, source: 'slash_command' })).toBeNull();
    expect(at('right', { forceMesId: 0, source: 'slash_command' })).toEqual({
      index: 0,
      swipeId: 1,
    });
    expect(at('right', { message: chat[0], forceSwipeId: 1, source: 'swipe_picker' })).toEqual({
      index: 0,
      swipeId: 1,
    });
    // past the end of an older message: nothing to regenerate there
    expect(at('right', { forceMesId: 0, forceSwipeId: 2, source: 'auto_swipe' })).toBeNull();
    expect(at('right', { forceMesId: 1, source: 'slash_command' })).toBeNull();
    expect(at('right', { forceMesId: 2, forceSwipeId: 5, source: 'back' })).toEqual({
      index: 2,
      swipeId: 2,
    });
    expect(at('left', {}, { hidden: true })).toBeNull();
    expect(at('left', { source: 'swipe_picker' }, { hidden: true })).toEqual({
      index: 2,
      swipeId: 0,
    });
  });

  it('follows the overswipe behaviour of the message', () => {
    const only = (extra: Record<string, unknown>, pristine = false, rest = {}) =>
      resolveSwipe(
        [{ mes: 'b', swipe_id: 1, swipes: ['a', 'b'], extra, ...rest }],
        'right',
        { source: 'slash_command' },
        { hidden: false, pristine },
      );
    expect(only({})).toEqual({ index: 0, regenerate: true });
    expect(only({}, true)).toEqual({ index: 0, swipeId: 0 });
    expect(only({ overswipe_behavior: 'loop' })).toEqual({ index: 0, swipeId: 0 });
    expect(only({ overswipe_behavior: 'none' })).toBeNull();
    expect(only({ overswipe_behavior: 'edit_generate' }, true)).toEqual({
      index: 0,
      regenerate: true,
    });
    expect(only({ swipeable: false })).toBeNull();
    expect(only({}, false, { is_user: true })).toEqual({ index: 0, swipeId: 0 });
  });
});

describe('createSwipeMember', () => {
  it('loads the swipe it lands on and regenerates past the end', async () => {
    const { page, chat, load, regenerate } = swipePage();
    const swipe = createSwipeMember(page);
    await swipe.left();
    await swipe.right(null, { message: chat[2] });
    await swipe.to(null, 'right', { forceMesId: 0, source: 'slash_command' });
    await swipe.to(null, 'sideways');
    expect(load.mock.calls).toEqual([
      [2, 0],
      [2, 2],
      [0, 1],
    ]);
    await swipe.right(null, { forceSwipeId: 3 });
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(swipe.state()).toBe('none');
  });

  it('reports `swiping` while a swipe is on its way and takes no second one', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { page, load } = swipePage({ load: vi.fn(() => gate) });
    const swipe = createSwipeMember(page);
    const first = swipe.left();
    expect(swipe.state()).toBe('swiping');
    await swipe.right();
    release();
    await first;
    expect(swipe.state()).toBe('none');
    expect(page.load).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
  });

  it('does nothing while swiping is not allowed', async () => {
    const empty = swipePage({ chat: () => [] });
    const none = createSwipeMember(empty.page);
    expect(none.isAllowed()).toBe(false);
    await none.right();
    expect(empty.load).not.toHaveBeenCalled();

    const busy = swipePage({ busy: () => true });
    const generating = createSwipeMember(busy.page);
    expect(generating.isAllowed()).toBe(false);
    await generating.left(null, { source: 'swipe_picker' });
    expect(busy.load).not.toHaveBeenCalled();
  });

  it('hides and shows the swipe buttons', async () => {
    const { page, load, setHidden } = swipePage();
    const swipe = createSwipeMember(page);
    expect(swipe.isAllowed()).toBe(true);
    swipe.hide();
    expect(swipe.isAllowed()).toBe(false);
    await swipe.right();
    expect(load).not.toHaveBeenCalled();
    swipe.refresh();
    swipe.show();
    expect(setHidden.mock.calls).toEqual([[true], [true], [false]]);
    expect(swipe.isAllowed()).toBe(true);
  });
});

describe('shouldSendOnEnter', () => {
  it('is true only when the setting is ENABLED', () => {
    expect(shouldSendOnEnter({ send_on_enter: 1 })).toBe(true);
    expect(shouldSendOnEnter({ send_on_enter: 0 })).toBe(false);
    expect(shouldSendOnEnter({ send_on_enter: -1 })).toBe(false);
    expect(shouldSendOnEnter(undefined)).toBe(false);
  });
});

describe('permissionSummary', () => {
  it('lists files, the interceptor and what the imports give away', () => {
    const lines = permissionSummary(
      { js: 'index.js', css: 'style.css', generate_interceptor: 'tmSampleIntercept' },
      {
        '/script.js': ['generateRaw', 'eventSource'],
        '/scripts/world-info.js': ['loadWorldInfo'],
      },
    );
    expect(lines[0]).toBe('文件：index.js、style.css');
    expect(lines.some((line) => line.includes('生成拦截器'))).toBe(true);
    expect(lines.some((line) => line.includes('发起生成'))).toBe(true);
    expect(lines.some((line) => line.includes('世界书'))).toBe(true);
    expect(lines.some((line) => line.includes('slash'))).toBe(false);
    expect(lines.at(-1)).toContain('全部权限');
  });

  it('copes with a missing manifest', () => {
    const lines = permissionSummary(null);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('没有脚本');
  });
});
