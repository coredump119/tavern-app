import { describe, expect, it, vi } from 'vitest';
import { isFrontend, slotMessageId, slotName } from '../src/detect.js';
import { diffByReference, sanitizePatch } from '../src/host.js';
import { envelope, openEnvelope, type RawMessage } from '../src/protocol.js';
import {
  creatingToPatch,
  roleOf,
  toChatMessage,
  toChatMessageSwiped,
  updateToPatch,
} from '../src/realm/chat.js';
import { deriveEvents, EventBus } from '../src/realm/events.js';
import { parseRange, resolveMessageId } from '../src/realm/range.js';
import { buildCardDocument, rewriteViewportUnits } from '../src/realm/srcdoc.js';
import {
  deletePath,
  insertMissing,
  mergeAssign,
  messageVariables,
  swipeVariables,
  withMessageVariables,
} from '../src/realm/variables.js';

const msg = (over: Partial<RawMessage> = {}): RawMessage => ({
  name: 'Seraphina',
  is_user: false,
  mes: 'hello',
  ...over,
});

describe('detect', () => {
  it('uses upstream markers for a front-end block', () => {
    expect(isFrontend('<html><body>x</body></html>')).toBe(true);
    expect(isFrontend('<head>\n<style></style>')).toBe(true);
    expect(isFrontend('<body class="x">')).toBe(true);
    expect(isFrontend('const a = 1;')).toBe(false);
    expect(isFrontend('<div>plain</div>')).toBe(false);
  });
  it('round-trips slot names', () => {
    expect(slotName(12, 3)).toBe('TH-message--12--3');
    expect(slotMessageId('TH-message--12--3')).toBe(12);
    expect(slotMessageId('tm-th-hub')).toBeNull();
  });
});

describe('envelope', () => {
  it('accepts only tagged messages of this version', () => {
    expect(openEnvelope(envelope({ type: 'slot.ready' }))).toMatchObject({ type: 'slot.ready' });
    expect(openEnvelope({ type: 'slot.ready' })).toBeNull();
    expect(openEnvelope({ tm: 'th', v: 2, type: 'x' })).toBeNull();
    expect(openEnvelope('th')).toBeNull();
    expect(openEnvelope(null)).toBeNull();
  });
});

describe('parseRange', () => {
  it('reads single ids and spans, negatives from the end', () => {
    expect(parseRange(3, 10)).toEqual([3, 3]);
    expect(parseRange('0-4', 10)).toEqual([0, 4]);
    expect(parseRange('-1', 10)).toEqual([9, 9]);
    expect(parseRange('-3--1', 10)).toEqual([7, 9]);
    expect(parseRange('5-2', 10)).toEqual([2, 5]);
  });
  it('clamps to the chat and rejects junk', () => {
    expect(parseRange('0-99', 10)).toEqual([0, 9]);
    expect(parseRange('-99-1', 10)).toEqual([0, 1]);
    expect(parseRange('20', 10)).toBeNull();
    expect(parseRange('abc', 10)).toBeNull();
    expect(parseRange('0', 0)).toBeNull();
  });
  it('resolves one id or throws', () => {
    expect(resolveMessageId(-1, 4)).toBe(3);
    expect(() => resolveMessageId(4, 4)).toThrow();
    expect(() => resolveMessageId(1.5, 4)).toThrow();
  });
});

describe('variables', () => {
  it('mergeAssign replaces arrays, merges objects', () => {
    const out = mergeAssign({ a: [1, 2, 3], b: { x: 1, y: 2 } }, { a: [9], b: { y: 3 } });
    expect(out).toEqual({ a: [9], b: { x: 1, y: 3 } });
  });
  it('insertMissing keeps what exists', () => {
    expect(insertMissing({ a: 1, b: { x: 1 } }, { a: 2, b: { x: 2, y: 2 }, c: 3 })).toEqual({
      a: 1,
      b: { x: 1, y: 2 },
      c: 3,
    });
  });
  it('deletePath reports whether it removed something', () => {
    const v = { a: { b: 1 } };
    expect(deletePath(v, 'a.b')).toBe(true);
    expect(v).toEqual({ a: {} });
    expect(deletePath(v, 'a.zz')).toBe(false);
  });
  it('reads message variables per swipe in every stored shape', () => {
    expect(swipeVariables(msg())).toEqual([{}]);
    expect(swipeVariables(msg({ variables: [{ a: 1 }] }))).toEqual([{ a: 1 }]);
    expect(
      swipeVariables(msg({ variables: { 0: { a: 1 }, 1: { b: 2 } }, swipes: ['x', 'y'] })),
    ).toEqual([{ a: 1 }, { b: 2 }]);
    const single = msg({ variables: { hp: 5 }, swipes: ['x', 'y'], swipe_id: 1 });
    expect(swipeVariables(single)).toEqual([{}, { hp: 5 }]);
    expect(messageVariables(single)).toEqual({ hp: 5 });
  });
  it('writes the current swipe only', () => {
    const m = msg({ variables: [{ a: 1 }, { b: 2 }], swipes: ['x', 'y'], swipe_id: 1 });
    expect(withMessageVariables(m, { c: 3 })).toEqual([{ a: 1 }, { c: 3 }]);
  });
});

describe('chat mapping', () => {
  it('maps roles like ST stores them', () => {
    expect(roleOf(msg())).toBe('assistant');
    expect(roleOf(msg({ is_user: true }))).toBe('user');
    expect(roleOf(msg({ extra: { type: 'narrator' } }))).toBe('system');
  });
  it('builds both views', () => {
    const m = msg({
      is_system: true,
      swipes: ['a', 'hello'],
      swipe_id: 1,
      variables: [{}, { hp: 1 }],
    });
    expect(toChatMessage(m, 4)).toEqual({
      message_id: 4,
      name: 'Seraphina',
      role: 'assistant',
      is_hidden: true,
      message: 'hello',
      data: { hp: 1 },
      extra: {},
    });
    expect(toChatMessageSwiped(m, 4)).toMatchObject({
      swipe_id: 1,
      swipes: ['a', 'hello'],
      swipes_data: [{}, { hp: 1 }],
      swipes_info: [{}, {}],
    });
  });
  it('an edit of the text keeps the swipe list in step', () => {
    const m = msg({ swipes: ['a', 'hello'], swipe_id: 1, swipe_info: [{ t: 1 }, { t: 2 }] });
    expect(updateToPatch(m, { message_id: 0, message: 'new' })).toEqual({
      mes: 'new',
      swipes: ['a', 'new'],
      swipe_id: 1,
      swipe_info: [{ t: 1 }, { t: 2 }],
      variables: [{}, {}],
    });
  });
  it('a message without swipes does not grow them', () => {
    expect(updateToPatch(msg(), { message_id: 0, message: 'new', data: { a: 1 } })).toEqual({
      mes: 'new',
      variables: [{ a: 1 }],
    });
  });
  it('switching swipe changes the shown text and clamps the id', () => {
    const m = msg({ swipes: ['a', 'b'], swipe_id: 0, mes: 'a' });
    expect(updateToPatch(m, { message_id: 0, swipe_id: 7 })).toMatchObject({
      mes: 'b',
      swipe_id: 1,
    });
  });
  it('role and hidden map to ST fields', () => {
    expect(
      updateToPatch(msg({ extra: { api: 'x' } }), {
        message_id: 0,
        role: 'system',
        is_hidden: true,
      }),
    ).toEqual({
      is_user: false,
      is_system: true,
      extra: { api: 'x', type: 'narrator' },
    });
    expect(
      updateToPatch(msg({ extra: { type: 'narrator' } }), { message_id: 0, role: 'user' }),
    ).toEqual({
      is_user: true,
      extra: {},
    });
  });
  it('creates messages with default names', () => {
    const names = { user: 'Me', char: 'Seraphina' };
    expect(creatingToPatch({ role: 'user', message: 'hi' }, names)).toEqual({
      name: 'Me',
      is_user: true,
      is_system: false,
      mes: 'hi',
      extra: {},
    });
    expect(
      creatingToPatch({ role: 'assistant', message: 'yo', data: { a: 1 } }, names),
    ).toMatchObject({
      name: 'Seraphina',
      variables: [{ a: 1 }],
    });
  });
});

describe('EventBus', () => {
  it('runs listeners in order, awaits them, survives a throw', async () => {
    const bus = new EventBus();
    const owner = {};
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.on(owner, 'e', async () => {
      await Promise.resolve();
      seen.push('a');
    });
    bus.on(owner, 'e', () => {
      throw new Error('boom');
    });
    bus.on(owner, 'e', (x: number) => void seen.push(`c${x}`));
    await bus.emit('e', [7]);
    expect(seen).toEqual(['a', 'c7']);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
  it('does not double a listener; once fires once; first/last reorder', async () => {
    const bus = new EventBus();
    const owner = {};
    const seen: string[] = [];
    const a = () => void seen.push('a');
    const b = () => void seen.push('b');
    bus.on(owner, 'e', a);
    bus.on(owner, 'e', a);
    bus.on(owner, 'e', b, { once: true });
    expect(bus.count('e')).toBe(2);
    bus.on(owner, 'e', b, { once: true, position: 'first' });
    await bus.emit('e', []);
    await bus.emit('e', []);
    expect(seen).toEqual(['b', 'a', 'a']);
  });
  it('clears by owner, event and listener', () => {
    const bus = new EventBus();
    const one = {};
    const two = {};
    const f = () => {};
    bus.on(one, 'x', f);
    bus.on(one, 'y', f);
    bus.on(two, 'x', f);
    bus.clearListener(one, f);
    expect([bus.count('x'), bus.count('y')]).toEqual([1, 0]);
    bus.on(two, 'y', f).stop();
    expect(bus.count('y')).toBe(0);
    bus.clearOwner(two);
    expect(bus.count('x')).toBe(0);
  });
});

describe('deriveEvents', () => {
  const names = (calls: unknown[][]) => calls.map((c) => c[0]);
  it('append → sent / received', () => {
    expect(
      deriveEvents(2, [], { start: 2, deleteCount: 0, messages: [msg({ is_user: true })] }),
    ).toEqual([
      ['message_sent', 2],
      ['user_message_rendered', 2],
    ]);
    expect(names(deriveEvents(2, [], { start: 2, deleteCount: 0, messages: [msg()] }))).toEqual([
      'message_received',
      'character_message_rendered',
    ]);
    // the record of a tool-call turn is not a reply
    const record = msg({ is_system: true, extra: { tool_invocations: [] } });
    expect(deriveEvents(2, [], { start: 2, deleteCount: 0, messages: [record] })).toEqual([]);
  });
  it('replace → swiped, new swipe, or edited', () => {
    const old = msg({ swipes: ['a', 'b'], swipe_id: 0 });
    const at = (next: RawMessage) =>
      deriveEvents(3, [old], { start: 1, deleteCount: 1, messages: [next] });
    expect(at({ ...old, swipe_id: 1 })).toEqual([['message_swiped', 1]]);
    expect(at({ ...old, swipes: ['a', 'b', 'c'], swipe_id: 2 })[0]).toEqual([
      'message_received',
      1,
      'swipe',
    ]);
    expect(names(at({ ...old, mes: 'edited' }))).toEqual(['message_edited', 'message_updated']);
    expect(at({ ...old, variables: [{ a: 1 }] })).toEqual([]);
  });
  it('shrink → deleted with the new length', () => {
    expect(deriveEvents(5, [msg(), msg()], { start: 3, deleteCount: 2, messages: [] })).toEqual([
      ['message_deleted', 3],
    ]);
  });
});

describe('host helpers', () => {
  it('diffs by reference', () => {
    const a = msg();
    const b = msg();
    const c = msg();
    const d = msg();
    expect(diffByReference([a, b], [a, b])).toBeNull();
    expect(diffByReference([a, b], [a, b, c])).toEqual({ start: 2, deleteCount: 0, messages: [c] });
    expect(diffByReference([a, b, c], [a, d, c])).toEqual({
      start: 1,
      deleteCount: 1,
      messages: [d],
    });
    expect(diffByReference([a, b, c], [a, c])).toEqual({ start: 1, deleteCount: 1, messages: [] });
    expect(diffByReference([a, a], [a, a, a])).toEqual({ start: 2, deleteCount: 0, messages: [a] });
    expect(diffByReference([a, b], [])).toEqual({ start: 0, deleteCount: 2, messages: [] });
  });
  it('sanitizes patches to known, well-typed fields', () => {
    expect(
      sanitizePatch({ mes: 'x', send_date: 'evil', force_avatar: 'x', extra: { a: 1 } }),
    ).toEqual({
      mes: 'x',
      extra: { a: 1 },
    });
    expect(() => sanitizePatch({ mes: 1 })).toThrow(/mes/);
    expect(() => sanitizePatch({ swipes: ['a', 2] })).toThrow(/swipes/);
    expect(() => sanitizePatch({ swipe_id: -1 })).toThrow(/swipe_id/);
    expect(() => sanitizePatch('x')).toThrow();
  });
});

describe('card document', () => {
  const content = {
    name: 'TH-message--3--0',
    html: '<html><head><style>.a{min-height: 100vh}</style></head><body><div style="min-height:50.5vh">x</div></body></html>',
    viewportHeight: 812.4,
    avatars: { user: 'asset://localhost/a"b.png', char: null },
  };
  it('rewrites min-height vh only', () => {
    expect(rewriteViewportUnits('min-height: 100vh; height: 100vh')).toBe(
      'min-height: calc(var(--TH-viewport-height) * 100 / 100); height: 100vh',
    );
  });
  it('installs the API before any card markup and stays in standards mode', () => {
    const doc = buildCardDocument(content, 'tmhelper://localhost/assets/jquery.js');
    expect(doc.startsWith('<!DOCTYPE html>')).toBe(true);
    const install = doc.indexOf('__tmSlot.install(window)');
    const jquery = doc.indexOf('assets/jquery.js');
    const card = doc.indexOf('<div style=');
    expect(install).toBeGreaterThan(0);
    expect(jquery).toBeGreaterThan(install);
    expect(card).toBeGreaterThan(jquery);
    expect(doc).toContain('--TH-viewport-height:812px');
    expect(doc).toContain('calc(var(--TH-viewport-height) * 50.5 / 100)');
    expect(doc).toContain(
      '.user_avatar,.user-avatar{background-image:url("asset://localhost/a\\22 b.png")}',
    );
    expect(doc).not.toContain('.char_avatar');
  });
});
