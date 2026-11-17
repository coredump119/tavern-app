/** Which "jump to an end" button a scrolling list offers (VirtualList, DEV_NOTES §9.47). */

export type JumpTarget = 'top' | 'bottom' | null;

/** px moved one way before a button shows: a resting finger wobbles by a few px. */
export const JUMP_TRAVEL = 24;

export interface JumpState {
  target: JumpTarget;
  /** px moved in the current direction, signed: up is negative */
  travel: number;
}

export const NO_JUMP: JumpState = { target: null, travel: 0 };

export interface JumpMove {
  /** `scrollTop` change since the previous scroll event */
  delta: number;
  top: number;
  /** px between the viewport's end and the content's end */
  distanceFromBottom: number;
  /** viewport height: within half of it from an end, that end's button is not worth showing */
  viewport: number;
  /** the user is scrolling (finger, wheel, keys, or the momentum that follows), not the list itself */
  user: boolean;
}

/**
 * The button to offer after a scroll event: moving up offers the top, moving down offers the end.
 * A shown button stays through small moves the other way and goes once its end is close.
 */
export function nextJump(prev: JumpState, move: JumpMove): JumpState {
  let { target, travel } = prev;
  if (move.user && move.delta !== 0) {
    travel = Math.sign(travel) === Math.sign(move.delta) ? travel + move.delta : move.delta;
    if (Math.abs(travel) >= JUMP_TRAVEL) target = travel < 0 ? 'top' : 'bottom';
  }
  const edge = move.viewport / 2;
  if (target === 'top' && move.top <= edge) target = null;
  if (target === 'bottom' && move.distanceFromBottom <= edge) target = null;
  return target === prev.target && travel === prev.travel ? prev : { target, travel };
}
