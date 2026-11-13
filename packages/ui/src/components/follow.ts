/** Scroll-follow rule for a list pinned to its end (VirtualList, DEV_NOTES §9.34 round 13). */

/** Closer than this to the end (px) counts as being at the end. */
export const PIN_SLACK = 8;

export interface ScrollMove {
  /** `scrollTop` now and at the previous scroll event */
  top: number;
  prevTop: number;
  /** px between the viewport's end and the content's end */
  distanceFromBottom: number;
  /** a finger or mouse button is down on the list, or a wheel / key press just happened */
  userInput: boolean;
  /** some mounted row no longer has the size that was last measured; only asked when it matters */
  layoutPending: () => boolean;
}

/**
 * Whether the list keeps following its end after a scroll event.
 *
 * Only a move up leaves the end: content that grew, or a viewport that shrank, also puts distance
 * between the viewport and the end. A move up with nobody touching the list while rows are changing
 * size is the browser clamping `scrollTop` (a row got shorter before it got taller), not the user.
 */
export function nextFollow(following: boolean, move: ScrollMove): boolean {
  if (move.distanceFromBottom < PIN_SLACK) return true;
  if (move.top >= move.prevTop) return following;
  return following && !move.userInput && move.layoutPending();
}
