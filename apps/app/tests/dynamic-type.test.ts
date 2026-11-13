import { describe, expect, it } from 'vitest';
import { osFontScale } from '../src/lib/dynamic-type';

describe('osFontScale', () => {
  it('is 1 at the default text size', () => {
    expect(osFontScale(17)).toBe(1);
  });

  it('follows the larger steps', () => {
    expect(osFontScale(23)).toBe(1.35);
    expect(osFontScale(28)).toBe(1.65);
  });

  it('stops at 2x for the largest accessibility steps', () => {
    expect(osFontScale(40)).toBe(2);
    expect(osFontScale(53)).toBe(2);
  });

  it('follows the smaller steps down to the smallest one', () => {
    expect(osFontScale(15)).toBe(0.88);
    expect(osFontScale(14)).toBe(0.82);
    expect(osFontScale(10)).toBe(0.82);
  });

  it('falls back to 1 on a reading it cannot use', () => {
    expect(osFontScale(NaN)).toBe(1);
    expect(osFontScale(0)).toBe(1);
  });
});
