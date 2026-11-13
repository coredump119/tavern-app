import { describe, expect, it } from 'vitest';
import { keyboardCover } from '../src/lib/insets';

describe('keyboardCover', () => {
  it('is 0 with no keyboard', () => {
    expect(keyboardCover(874, 874)).toBe(0);
  });

  it('measures the software keyboard', () => {
    expect(keyboardCover(874, 538)).toBe(336);
  });

  it('still sees the accessory bar after the page was scrolled to reveal a field', () => {
    // innerHeight has dropped to 830 by then; the caller passes the full layout height
    expect(keyboardCover(874, 830)).toBe(44);
  });

  it('does not take a pinch zoom for a keyboard', () => {
    expect(keyboardCover(874, 437, 2)).toBe(0);
  });

  it('never goes negative', () => {
    expect(keyboardCover(778, 874)).toBe(0);
  });
});
