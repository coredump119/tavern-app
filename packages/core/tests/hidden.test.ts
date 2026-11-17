// 批量隐藏 / 取消隐藏楼层的数据规则，对照 ST hideChatMessageRange（DEV_NOTES §9.47）
import { describe, expect, it } from 'vitest';
import { countHiddenChange, setHiddenRange } from '../src/index.js';

const chat = () => [
  { mes: 'a', is_system: false },
  { mes: 'b', is_system: true },
  { mes: 'c' },
  { mes: 'd', is_system: false },
];

describe('setHiddenRange', () => {
  it('hides every message up to and including the end index', () => {
    const before = chat();
    const r = setHiddenRange(before, 0, 2, true);
    expect(r.messages.map((m) => !!m.is_system)).toEqual([true, true, true, false]);
    expect(r).toMatchObject({ first: 0, changed: 2 });
    // untouched messages keep their identity, changed ones are copies
    expect(r.messages[1]).toBe(before[1]);
    expect(r.messages[3]).toBe(before[3]);
    expect(r.messages[0]).not.toBe(before[0]);
    expect(before[0]!.is_system).toBe(false);
  });

  it('shows them again and reports the first changed index', () => {
    const r = setHiddenRange(chat(), 0, 3, false);
    expect(r.messages.map((m) => !!m.is_system)).toEqual([false, false, false, false]);
    expect(r).toMatchObject({ first: 1, changed: 1 });
  });

  it('changes nothing when the range is already in that state', () => {
    const before = chat();
    const r = setHiddenRange(before, 1, 1, true);
    expect(r).toMatchObject({ first: -1, changed: 0 });
    expect(r.messages).toEqual(before);
  });

  it('keeps the other fields of a changed message', () => {
    const message: { mes: string; name: string; extra: object; is_system?: boolean } = {
      mes: 'x',
      name: 'n',
      extra: { a: 1 },
    };
    const r = setHiddenRange([message], 0, 0, true);
    expect(r.messages[0]).toEqual({ mes: 'x', name: 'n', extra: { a: 1 }, is_system: true });
  });
});

describe('countHiddenChange', () => {
  it('matches what setHiddenRange would change', () => {
    for (const hidden of [true, false])
      for (const [start, end] of [
        [0, 3],
        [0, 0],
        [1, 2],
        [2, 9],
      ] as const)
        expect(countHiddenChange(chat(), start, end, hidden)).toBe(
          setHiddenRange(chat(), start, end, hidden).changed,
        );
  });
});
