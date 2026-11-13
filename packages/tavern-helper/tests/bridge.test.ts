import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Port } from '../src/host.js';
import { ORIGIN, msg, setup } from './harness.js';

describe('bridge', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.start();
  });

  it('mirrors the chat on init', () => {
    expect(t.statuses).toEqual(['loading', 'ready']);
    expect(t.hub.chat.map((m) => m.mes)).toEqual(['first', 'hi', 'reply']);
    expect(t.api.getLastMessageId()).toBe(2);
    expect(t.api.getCurrentMessageId()).toBe(2);
    expect(t.api.getIframeName()).toBe('TH-message--2--0');
    expect(t.api.SillyTavern.name2).toBe('Seraphina');
    expect(
      t.api.substitudeMacros(
        '{{user}}/{{char}}/{{lastMessageId}}/{{getvar::hp}}/{{getglobalvar::lang}}',
      ),
    ).toBe('Me/Seraphina/2/10/zh');
  });

  it('reads messages by range with filters', () => {
    expect(t.api.getChatMessages('0-{{lastMessageId}}').map((m) => m.message_id)).toEqual([
      0, 1, 2,
    ]);
    expect(t.api.getChatMessages('0-2', { role: 'user' })).toMatchObject([
      { message_id: 1, message: 'hi' },
    ]);
    expect(t.api.getChatMessages(-1)).toMatchObject([{ message_id: 2, role: 'assistant' }]);
    expect(t.api.getChatMessages('nope')).toEqual([]);
  });

  it('chat and global variables: sync read, one coalesced write per tick', async () => {
    expect(t.api.getVariables()).toEqual({ hp: 10 });
    const got = t.api.getVariables();
    got['hp'] = 0;
    expect(t.api.getVariables()).toEqual({ hp: 10 });

    t.api.insertOrAssignVariables({ hp: 9, bag: ['a'] });
    t.api.insertOrAssignVariables({ bag: ['b'] });
    t.api.insertVariables({ hp: 1, mp: 3 });
    expect(t.api.getVariables()).toEqual({ hp: 9, bag: ['b'], mp: 3 });
    expect(t.api.deleteVariable('mp')).toEqual({
      variables: { hp: 9, bag: ['b'] },
      delete_occurred: true,
    });
    t.api.replaceVariables({ lang: 'en' }, { type: 'global' });
    const sent = vi.fn();
    const original = t.host.handleMessage.bind(t.host);
    t.host.handleMessage = (source, data) => {
      sent((data as { type: string }).type);
      original(source, data);
    };
    await t.pump();
    expect(sent.mock.calls.map((c) => c[0])).toEqual(['vars.set', 'vars.set']);
    expect(t.saved).toEqual({ chat: { hp: 9, bag: ['b'] }, global: { lang: 'en' } });

    // the app echoing the same value back is not re-sent; a real change is
    t.host.syncVariables('chat', { hp: 9, bag: ['b'] });
    t.host.syncVariables('chat', { hp: 1 });
    await t.pump();
    expect(t.api.getVariables()).toEqual({ hp: 1 });
  });

  it('updateVariablesWith accepts sync and async updaters', async () => {
    expect(t.api.updateVariablesWith((v) => ({ ...v, hp: 11 }))).toEqual({ hp: 11 });
    await t.api.updateVariablesWith(async (v) => ({ ...v, hp: 12 }));
    expect(t.api.getVariables()).toEqual({ hp: 12 });
  });

  it('message variables are written at once and saved per swipe', async () => {
    t.api.replaceVariables({ mood: 'calm' }, { type: 'message', message_id: 0 });
    expect(t.api.getVariables({ type: 'message', message_id: 0 })).toEqual({ mood: 'calm' });
    t.api.insertOrAssignVariables({ seen: true }, { type: 'message' });
    await t.pump();
    expect(t.chat()[0]!.variables).toEqual([{ mood: 'calm' }]);
    expect(t.chat()[2]!.variables).toEqual([{ seen: true }]);
    expect(t.api.getAllVariables()).toEqual({ lang: 'zh', hp: 10, mood: 'calm', seen: true });
    expect(() => t.api.getVariables({ type: 'message', message_id: 9 })).toThrow();
    expect(t.api.getVariables({ type: 'character' })).toEqual({});
  });

  it('setChatMessages goes through the app and comes back', async () => {
    const before = t.chat();
    const done = t.api.setChatMessages([
      { message_id: 0, message: 'FIRST' },
      { message_id: -1, is_hidden: true },
    ]);
    await t.pump();
    await done;
    expect(t.chat()).not.toBe(before);
    expect(t.chat().map((m) => m.mes)).toEqual(['FIRST', 'hi', 'reply']);
    expect(t.chat()[2]!.is_system).toBe(true);
    expect(t.chat()[1]).toBe(before[1]);
    expect(t.api.getChatMessages(0)[0]).toMatchObject({ message: 'FIRST' });
    expect(t.api.getChatMessages('0-2', { hide_state: 'hidden' }).map((m) => m.message_id)).toEqual(
      [2],
    );
  });

  it('creates and deletes messages', async () => {
    const made = t.api.createChatMessages([{ role: 'user', message: 'new' }], { insert_before: 1 });
    await t.pump();
    await made;
    expect(t.chat().map((m) => m.mes)).toEqual(['first', 'new', 'hi', 'reply']);
    expect(t.chat()[1]).toMatchObject({
      name: 'Me',
      is_user: true,
      send_date: 'NOW',
      is_system: false,
    });
    const gone = t.api.deleteChatMessages([1, -1]);
    await t.pump();
    await gone;
    expect(t.chat().map((m) => m.mes)).toEqual(['first', 'hi']);
    expect(t.hub.chat.map((m) => m.mes)).toEqual(['first', 'hi']);
  });

  it('rejects bad requests without touching the chat', async () => {
    const before = t.chat();
    await expect(t.api.setChatMessages([{ message_id: 99, message: 'x' }])).rejects.toThrow(
      /楼层号/,
    );
    const bad = t.api.setChatMessages([{ message_id: 0, message: 5 as unknown as string }]);
    await t.pump();
    await expect(bad).rejects.toThrow(/mes/);
    expect(t.chat()).toBe(before);
  });

  it('app changes become splices and ST events; script changes do not echo', async () => {
    const seen: unknown[][] = [];
    for (const name of Object.values(t.api.tavern_events)) {
      t.api.eventOn(name, (...args: unknown[]) => void seen.push([name, ...args]));
    }
    const chat = t.chat();
    t.appSet([...chat, msg('more', { is_user: true })]);
    await t.pump();
    expect(seen).toEqual([
      ['message_sent', 3],
      ['user_message_rendered', 3],
    ]);
    seen.length = 0;

    const set = t.api.setChatMessages([{ message_id: 3, message: 'edited by script' }]);
    await t.pump();
    await set;
    // the app's store effect fires with the array the controller already has: nothing is sent
    t.host.syncChat('chat-a', t.chat());
    await t.pump();
    expect(seen).toEqual([]);

    t.appSet(t.chat().slice(0, 2));
    t.host.emit('generation_started', 'normal', {}, false);
    await t.pump();
    expect(seen).toEqual([
      ['message_deleted', 2],
      ['generation_started', 'normal', {}, false],
    ]);
    expect(t.hub.chat).toHaveLength(2);
  });

  it('a request built on a stale chat is refused and the mirror is refreshed', async () => {
    const stale = t.api.deleteChatMessages([2]);
    t.appSet([...t.chat(), msg('raced')]);
    await t.pump();
    await expect(stale).rejects.toThrow(/chat changed/);
    expect(t.chat().map((m) => m.mes)).toEqual(['first', 'hi', 'reply', 'raced']);
    expect(t.hub.chat.map((m) => m.mes)).toEqual(['first', 'hi', 'reply', 'raced']);
    const again = t.api.deleteChatMessages([2]);
    await t.pump();
    await again;
    expect(t.chat().map((m) => m.mes)).toEqual(['first', 'hi', 'raced']);
  });

  it('switching chats re-inits and fires chat_id_changed', async () => {
    const changed = vi.fn();
    t.api.eventOn('chat_id_changed', changed);
    t.host.syncChat('chat-b', [msg('other')]);
    await t.pump();
    expect(changed).toHaveBeenCalledWith('chat-b');
    expect(t.api.SillyTavern.chatId).toBe('chat-b');
    expect(t.api.getLastMessageId()).toBe(0);
  });

  it('two chats with the same file name are different chats', async () => {
    const changed = vi.fn();
    t.api.eventOn('chat_id_changed', changed);
    t.host.syncChat('chats/A/same.jsonl', [msg('a')], 'same');
    await t.pump();
    t.host.syncChat('chats/B/same.jsonl', [msg('b1'), msg('b2')], 'same');
    await t.pump();
    expect(changed.mock.calls).toEqual([['same'], ['same']]);
    expect(t.api.SillyTavern.getCurrentChatId()).toBe('same');
    expect(t.api.SillyTavern.chat.map((m) => m.mes)).toEqual(['b1', 'b2']);
  });

  it('the mirror takes what the app stored, not what the script sent', async () => {
    const done = t.api.createChatMessages([{ role: 'assistant', message: 'new' }]);
    await t.pump();
    await done;
    // the app stamps the message; the script's copy has the stamp too
    expect(t.chat()[3]).toMatchObject({ mes: 'new', send_date: 'NOW' });
    expect(t.api.SillyTavern.chat[3]).toEqual(t.chat()[3]);
  });

  it('release drops a frame’s listeners', async () => {
    const fn = vi.fn();
    t.api.eventOn('x', fn);
    t.hub.release(globalThis);
    await t.api.eventEmit('x');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('host controller: slots and trust', () => {
  it('ignores messages from unknown windows and before ready', () => {
    const t = setup();
    const stranger: Port = { postMessage: vi.fn() };
    t.host.handleMessage(stranger, { tm: 'th', v: 1, type: 'ready', ok: true });
    expect(t.host.status).toBe('idle');
    t.host.attachHub(t.hubPort);
    t.host.handleMessage(t.hubPort, {
      tm: 'th',
      v: 1,
      type: 'vars.set',
      scope: 'chat',
      value: { a: 1 },
    });
    expect(t.saved).toEqual({});
  });

  it('reports an unsupported realm', () => {
    const t = setup();
    t.host.attachHub(t.hubPort);
    t.host.handleMessage(t.hubPort, {
      tm: 'th',
      v: 1,
      type: 'ready',
      ok: false,
      reason: 'app scripts present',
    });
    expect(t.host.status).toBe('unsupported');
    expect(t.host.reason).toBe('app scripts present');
  });

  it('fills a slot once both it and the hub are ready, and clamps heights', async () => {
    const t = setup();
    const posted: Record<string, unknown>[] = [];
    const slot: Port = { postMessage: (m) => void posted.push(m as Record<string, unknown>) };
    const heights: number[] = [];
    t.host.setViewport(800);
    const detach = t.host.attachSlot(
      slot,
      { name: 'TH-message--0--0', html: '<body>x</body>', avatars: { user: null, char: null } },
      (h) => heights.push(h),
    );
    t.host.handleMessage(slot, { tm: 'th', v: 1, type: 'slot.ready' });
    expect(posted).toEqual([]);
    await t.start();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: 'slot.content',
      name: 'TH-message--0--0',
      viewportHeight: 800,
    });
    t.host.handleMessage(slot, { tm: 'th', v: 1, type: 'slot.height', height: 321 });
    t.host.handleMessage(slot, { tm: 'th', v: 1, type: 'slot.height', height: 9e9 });
    t.host.handleMessage(slot, { tm: 'th', v: 1, type: 'slot.height', height: 'x' });
    expect(heights).toEqual([321, 20_000]);
    t.host.setViewport(700);
    expect(posted.at(-1)).toMatchObject({ type: 'viewport', height: 700 });
    detach();
    t.host.handleMessage(slot, { tm: 'th', v: 1, type: 'slot.height', height: 5 });
    expect(heights).toHaveLength(2);
  });
});
