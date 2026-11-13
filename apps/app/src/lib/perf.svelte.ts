/**
 * In-app performance check (DEV_NOTES §9.31): the 网络自检 page asks for a run, the chat page
 * performs it (it owns the list), results come back here. Uses a synthetic chat on the open
 * character and deletes it afterwards.
 */
export interface PerfResult {
  rows: number;
  /** openChat() → first painted frame */
  openMs: number;
  /** auto-scroll sample: frames rendered, frames longer than 1.5× 16.7ms */
  frames: number;
  dropped: number;
  droppedPct: number;
  at: number;
}

export const perfBench = $state<{
  requested: boolean;
  rows: number;
  running: boolean;
  result: PerfResult | null;
  error: string | null;
}>({ requested: false, rows: 3000, running: false, result: null, error: null });

export const PERF_BUDGET = { openMs: 200, droppedPct: 5 };
