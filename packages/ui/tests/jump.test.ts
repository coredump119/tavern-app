import { describe, expect, it } from 'vitest';
import {
  JUMP_TRAVEL,
  NO_JUMP,
  nextJump,
  type JumpMove,
  type JumpState,
} from '../src/components/jump.js';

const move = (over: Partial<JumpMove> = {}): JumpMove => ({
  delta: -JUMP_TRAVEL,
  top: 5000,
  distanceFromBottom: 5000,
  viewport: 600,
  user: true,
  ...over,
});
const run = (moves: Partial<JumpMove>[], from: JumpState = NO_JUMP): JumpState =>
  moves.reduce((state, m) => nextJump(state, move(m)), from);

describe('nextJump', () => {
  it('offers the top when the user moves up and the end when they move down', () => {
    expect(nextJump(NO_JUMP, move()).target).toBe('top');
    expect(nextJump(NO_JUMP, move({ delta: JUMP_TRAVEL })).target).toBe('bottom');
  });

  it('waits for enough travel in one direction', () => {
    expect(run([{ delta: -10 }]).target).toBeNull();
    expect(run([{ delta: -10 }, { delta: -10 }]).target).toBeNull();
    expect(run([{ delta: -10 }, { delta: -10 }, { delta: -10 }]).target).toBe('top');
    // a turn starts the count again
    expect(run([{ delta: -20 }, { delta: 20 }, { delta: -20 }]).target).toBeNull();
  });

  it('keeps the shown button through a small move the other way, then switches', () => {
    const up = nextJump(NO_JUMP, move());
    expect(run([{ delta: 10 }], up).target).toBe('top');
    expect(run([{ delta: 10 }, { delta: 20 }], up).target).toBe('bottom');
  });

  it('offers nothing within half a viewport of the end it points at', () => {
    expect(nextJump(NO_JUMP, move({ top: 300 })).target).toBeNull();
    expect(nextJump(NO_JUMP, move({ top: 301 })).target).toBe('top');
    expect(
      nextJump(NO_JUMP, move({ delta: JUMP_TRAVEL, distanceFromBottom: 300 })).target,
    ).toBeNull();
    // rubber-band past the end
    expect(nextJump(NO_JUMP, move({ top: -40 })).target).toBeNull();
  });

  it('drops a shown button once its end is reached, whoever scrolled', () => {
    const up = nextJump(NO_JUMP, move());
    expect(nextJump(up, move({ delta: -4000, top: 0, user: false })).target).toBeNull();
    const down = nextJump(NO_JUMP, move({ delta: JUMP_TRAVEL }));
    expect(
      nextJump(down, move({ delta: 4000, distanceFromBottom: 0, user: false })).target,
    ).toBeNull();
  });

  it('ignores moves the list makes itself', () => {
    expect(nextJump(NO_JUMP, move({ delta: -900, user: false })).target).toBeNull();
    expect(nextJump(NO_JUMP, move({ delta: 900, user: false })).target).toBeNull();
    const up = nextJump(NO_JUMP, move());
    expect(nextJump(up, move({ delta: 200, user: false }))).toBe(up);
  });

  it('returns the same state when nothing changed', () => {
    const up = nextJump(NO_JUMP, move());
    expect(nextJump(up, move({ delta: 0 }))).toBe(up);
  });
});
