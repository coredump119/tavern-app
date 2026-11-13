// 检查点 / 分支的数据规则，对照 ST bookmarks.js（DEV_NOTES §9.29）
import { describe, expect, it } from 'vitest';
import {
  addBranch,
  bookmarkLinkOf,
  bookmarkMetadata,
  branchName,
  branchSnapshot,
  checkpointName,
  getUniqueName,
  mainChatName,
  setBookmarkLink,
  syncSwipeToMes,
  type ChatMessageLike,
} from '../src/index.js';

describe('checkpoint / branch names', () => {
  it('getUniqueName defaults to " (i)" suffixes starting at 1', () => {
    const taken = new Set(['a', 'a (1)']);
    expect(getUniqueName('a', (x) => taken.has(x))).toBe('a (2)');
    expect(getUniqueName('a', () => true, { maxTries: 3 })).toBeNull();
  });
  it('appends " - Checkpoint #i" and strips an existing suffix or legacy prefix first', () => {
    expect(checkpointName('Sera - 2026-11-08', [])).toBe('Sera - 2026-11-08 - Checkpoint #1');
    expect(
      checkpointName('Sera - 2026-11-08 - Checkpoint #3', ['Sera - 2026-11-08 - Checkpoint #1']),
    ).toBe('Sera - 2026-11-08 - Checkpoint #2');
    expect(checkpointName('Checkpoint #2 - Old', [])).toBe('Old - Checkpoint #1');
    expect(branchName('Main', ['Main - Branch #1', 'Main - Branch #2'])).toBe('Main - Branch #3');
  });
});

describe('snapshots', () => {
  const chat: ChatMessageLike[] = [
    { name: 'Sera', is_user: false, mes: 'one' },
    { name: 'Yun', is_user: true, mes: 'two' },
    {
      name: 'Sera',
      is_user: false,
      mes: 'three-a',
      send_date: 't0',
      swipe_id: 0,
      swipes: ['three-a', 'three-b'],
      swipe_info: [
        { send_date: 't0', extra: { v: 'a' } },
        { send_date: 't1', gen_started: 'g1', extra: { v: 'b' } },
      ],
      extra: { v: 'a' },
    },
    { name: 'Yun', is_user: true, mes: 'four' },
  ];
  it('cuts the chat at mesId and clones it', () => {
    const snap = branchSnapshot(chat, 1)!;
    expect(snap.map((m) => m.mes)).toEqual(['one', 'two']);
    expect(snap[0]).not.toBe(chat[0]);
    expect(branchSnapshot(chat, 9)).toBeNull();
  });
  it('moves the last message to the requested swipe (syncSwipeToMes)', () => {
    const snap = branchSnapshot(chat, 2, 1)!;
    const last = snap[2]!;
    expect(last.mes).toBe('three-b');
    expect(last.swipe_id).toBe(1);
    expect(last.send_date).toBe('t1');
    expect(last['gen_started']).toBe('g1');
    expect(last['extra']).toEqual({ v: 'b' });
    expect(chat[2]!.mes).toBe('three-a'); // original untouched
    expect(branchSnapshot(chat, 2, 5)).toBeNull();
    expect(branchSnapshot(chat, 1, 0)).toBeNull(); // no swipes on that message
  });
  it('syncSwipeToMes backfills swipe_info', () => {
    const m = {
      name: 'S',
      is_user: false,
      mes: 'x',
      send_date: 'd',
      swipe_id: 0,
      swipes: ['x', 'y'],
    };
    expect(syncSwipeToMes(m, 1)).toBe(true);
    expect(m.mes).toBe('y');
    expect((m as Record<string, unknown>)['swipe_info']).toHaveLength(2);
  });
});

describe('metadata and marks', () => {
  it('bookmarkMetadata copies the current metadata and sets main_chat', () => {
    const meta = { note_prompt: 'n', variables: { a: 1 } };
    const out = bookmarkMetadata(meta, 'Sera - main');
    expect(out).toEqual({ note_prompt: 'n', variables: { a: 1 }, main_chat: 'Sera - main' });
    expect(out['variables']).not.toBe(meta.variables);
  });
  it('mainChatName prefers chat_metadata, derives from a legacy checkpoint name for characters only', () => {
    expect(mainChatName({ main_chat: 'M' }, 'x', false)).toEqual({ name: 'M', derived: false });
    expect(mainChatName({}, 'Sera - 2026 - Checkpoint #2', false)).toEqual({
      name: 'Sera - 2026 -',
      derived: true,
    });
    expect(mainChatName({}, 'Sera - 2026 - Checkpoint #2', true)).toEqual({
      name: null,
      derived: false,
    });
    expect(mainChatName({}, 'plain', false)).toEqual({ name: null, derived: false });
  });
  it('setBookmarkLink / addBranch create extra when missing', () => {
    const m: ChatMessageLike = { name: 'S', is_user: false, mes: 'x' };
    expect(bookmarkLinkOf(m)).toBeNull();
    setBookmarkLink(m, 'cp1');
    addBranch(m, 'b1');
    addBranch(m, 'b2');
    expect(bookmarkLinkOf(m)).toBe('cp1');
    expect(m['extra']).toEqual({ bookmark_link: 'cp1', branches: ['b1', 'b2'] });
  });
});
