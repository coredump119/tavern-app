import { describe, expect, it } from 'vitest';
import { nextFollow, PIN_SLACK, type ScrollMove } from '../src/components/follow.js';

const move = (over: Partial<ScrollMove> = {}): ScrollMove => ({
  top: 800,
  prevTop: 840,
  distanceFromBottom: 40,
  userInput: false,
  layoutPending: () => false,
  ...over,
});

describe('nextFollow', () => {
  it('re-pins whenever the viewport is at the end', () => {
    expect(nextFollow(false, move({ distanceFromBottom: PIN_SLACK - 1 }))).toBe(true);
    expect(nextFollow(false, move({ distanceFromBottom: 0, userInput: true }))).toBe(true);
  });

  it('keeps its state when the position did not move up', () => {
    // content grew under a pinned list: far from the end, but nobody scrolled
    expect(nextFollow(true, move({ top: 840, prevTop: 840, distanceFromBottom: 300 }))).toBe(true);
    expect(nextFollow(false, move({ top: 900, prevTop: 840 }))).toBe(false);
  });

  it('lets go when the user moves up', () => {
    expect(nextFollow(true, move({ userInput: true }))).toBe(false);
    // no touch events (screen reader gesture), no size change pending
    expect(nextFollow(true, move())).toBe(false);
  });

  it('stays pinned when rows changed size under it and nobody touched the list', () => {
    expect(nextFollow(true, move({ layoutPending: () => true }))).toBe(true);
  });

  it('a finger on the list wins over a pending size change', () => {
    expect(nextFollow(true, move({ userInput: true, layoutPending: () => true }))).toBe(false);
  });

  it('never starts following from a move up', () => {
    expect(nextFollow(false, move({ layoutPending: () => true }))).toBe(false);
  });

  it('asks about row sizes only for an untouched move up while pinned', () => {
    let asked = 0;
    const layoutPending = () => (asked++, true);
    nextFollow(true, move({ distanceFromBottom: 0, layoutPending }));
    nextFollow(true, move({ top: 900, layoutPending }));
    nextFollow(true, move({ userInput: true, layoutPending }));
    nextFollow(false, move({ layoutPending }));
    expect(asked).toBe(0);
    nextFollow(true, move({ layoutPending }));
    expect(asked).toBe(1);
  });
});
