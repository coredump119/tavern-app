<script lang="ts" generics="T">
  /**
   * Bottom-anchored virtual list for chat: only rows near the viewport are in the DOM; the rest is
   * replaced by top/bottom spacers sized from measured (or estimated) heights. Variable row heights
   * are measured with a ResizeObserver, so streaming text that grows a row keeps the scroll stable.
   *
   * Rows the caller marks `keepAlive` are parked instead of destroyed when they leave the window:
   * they stay mounted where they are (zero height, hidden), so an iframe inside keeps its state.
   *
   * The list adds no element of its own around a row: the row snippet's root element is the row
   * (ST needs `.mes` to be a direct child of `#chat`). The snippet puts `attach` on that root and
   * sets the `tm-vlist__row--parked` class on it while `parked` is true.
   */
  import type { Snippet } from 'svelte';
  import { onMount, tick, untrack } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import { nextFollow, PIN_SLACK } from './follow.js';
  import { nextJump, NO_JUMP, type JumpState, type JumpTarget } from './jump.js';

  interface Props {
    items: readonly T[];
    key: (item: T, index: number) => string | number;
    row: Snippet<[item: T, index: number, attach: Attachment<HTMLElement>, parked: boolean]>;
    /** Height guess for rows not yet measured (px, read as CSS px) */
    estimate?: number;
    /** Extra rows rendered above/below the viewport */
    overscan?: number;
    /** Keep pinned to the bottom while content grows (streaming) */
    followBottom?: boolean;
    /** Rendered above the first row (e.g. day divider / load-more) */
    header?: Snippet;
    /** Called when the user scrolls near the top (load older) */
    onNearTop?: (() => void) | undefined;
    /** Park this row instead of destroying it when it leaves the window (its DOM holds live state) */
    keepAlive?: ((item: T, index: number) => boolean) | undefined;
    /** Most parked rows kept; the ones that left the window longest ago go first */
    keepAliveMax?: number;
    /** Called when the mounted window `[start, end)` changes */
    onWindow?: ((start: number, end: number) => void) | undefined;
    /**
     * Called when the "jump to an end" button to offer changes: the top while the user scrolls up,
     * the end while they scroll down, nothing once they stop for a moment or get close to that end.
     */
    onJump?: ((target: JumpTarget) => void) | undefined;
    id?: string | undefined;
    class?: string | undefined;
  }
  let {
    items,
    key,
    row,
    estimate = 120,
    overscan = 4,
    followBottom = $bindable(true),
    header,
    onNearTop,
    keepAlive,
    keepAliveMax = 6,
    onWindow,
    onJump,
    id,
    class: className,
  }: Props = $props();

  let viewport: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  const heights = new Map<string | number, number>();
  let measuredVersion = $state(0);

  function heightOf(item: T, i: number): number {
    return heights.get(key(item, i)) ?? estimate;
  }

  // Prefix sums; recomputed when items or measurements change. O(n) per change, fine for ≤ ~10k rows.
  const offsets = $derived.by(() => {
    void measuredVersion;
    const out = new Array<number>(items.length + 1);
    out[0] = 0;
    for (let i = 0; i < items.length; i++) out[i + 1] = out[i]! + heightOf(items[i]!, i);
    return out;
  });
  const total = $derived(offsets[items.length] ?? 0);

  function lowerBound(pos: number): number {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((offsets[mid + 1] ?? 0) <= pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  const range = $derived.by(() => {
    if (items.length === 0) return { start: 0, end: 0 };
    const start = Math.max(0, lowerBound(scrollTop) - overscan);
    const end = Math.min(items.length, lowerBound(scrollTop + viewportHeight) + 1 + overscan);
    return { start, end };
  });
  const padTop = $derived(offsets[range.start] ?? 0);
  const padBottom = $derived(total - (offsets[range.end] ?? 0));

  interface Mounted {
    index: number;
    key: string | number;
  }
  // Bookkeeping for parked rows. Plain on purpose: `shown` is the only reader and writer, and
  // re-running it with the same inputs leaves both lists as they are.
  let windowRows: Mounted[] = [];
  let parked: Mounted[] = [];

  /**
   * What is mounted, in index order: parked rows above the window, the window, parked rows below.
   * The order never changes for a mounted row, so the keyed each only inserts and removes nodes —
   * moving an iframe in the DOM would reload it.
   */
  const shown = $derived.by(() => {
    const { start, end } = range;
    if (keepAlive) {
      const keep = keepAlive;
      const outside = (r: Mounted) => r.index < start || r.index >= end;
      const alive = (r: Mounted) => {
        const item = items[r.index];
        return item !== undefined && key(item, r.index) === r.key && keep(item, r.index);
      };
      parked = [...windowRows.filter(outside), ...parked]
        .filter((r) => outside(r) && alive(r))
        .slice(0, keepAliveMax);
    } else {
      parked = [];
    }
    windowRows = [];
    const out = { items: [] as T[], index: [] as number[], keys: [] as (string | number)[] };
    const push = (i: number, k: string | number) => {
      out.items.push(items[i]!);
      out.index.push(i);
      out.keys.push(k);
    };
    const byIndex = [...parked].sort((a, b) => a.index - b.index);
    for (const r of byIndex) if (r.index < start) push(r.index, r.key);
    for (let i = start; i < end; i++) {
      const k = key(items[i]!, i);
      windowRows.push({ index: i, key: k });
      push(i, k);
    }
    for (const r of byIndex) if (r.index >= end) push(r.index, r.key);
    return out;
  });

  const observed = new Map<Element, string | number>();
  // created here, not in onMount: rows attach before the list's own mount callback runs
  const ro =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver((entries) => {
          let changed = false;
          for (const e of entries) {
            const k = observed.get(e.target);
            if (k === undefined) continue;
            // border box, like the first measurement: a row may carry its own padding
            const h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height;
            if (h && heights.get(k) !== h) {
              heights.set(k, h);
              changed = true;
            }
          }
          if (changed) {
            measuredVersion++;
            if (followBottom) void tick().then(() => scrollToBottom());
          }
        });

  // One attachment per mounted key, so a window shift does not re-attach the rows that stay.
  const attachments = new Map<string | number, Attachment<HTMLElement>>();
  function rowAttachment(k: string | number): Attachment<HTMLElement> {
    let attach = attachments.get(k);
    if (!attach) {
      attach = (node) =>
        untrack(() => {
          observed.set(node, k);
          ro?.observe(node);
          const h = node.getBoundingClientRect().height;
          if (h && heights.get(k) !== h) {
            heights.set(k, h);
            measuredVersion++;
          }
          return () => {
            observed.delete(node);
            ro?.unobserve(node);
            attachments.delete(k);
          };
        });
      attachments.set(k, attach);
    }
    return attach;
  }

  // who is scrolling: a finger / mouse button held on the list, or a wheel / key press just now
  const INPUT_WINDOW_MS = 200;
  let held = false;
  let lastInput = -Infinity;
  const userInput = () => held || performance.now() - lastInput < INPUT_WINDOW_MS;

  /** A mounted row is no longer the size the observer last reported (parked rows are 0 and skipped). */
  function layoutPending(): boolean {
    for (const [node, k] of observed) {
      const known = heights.get(k);
      const h = node.getBoundingClientRect().height;
      if (h && known !== undefined && Math.abs(h - known) > 1) return true;
    }
    return false;
  }

  // ---- jump buttons: the caller draws one, the list says which fits (DEV_NOTES §9.47) ----
  /** scroll events this close together are one gesture: momentum goes on after the finger lifts */
  const SCROLL_CHAIN_MS = 250;
  /** a shown button goes this long after the last scroll event */
  const JUMP_IDLE_MS = 1800;
  let jump: JumpState = NO_JUMP;
  let userScrollUntil = -Infinity;
  let jumpSeen = 0;
  let jumpTimer: ReturnType<typeof setTimeout> | undefined;

  function setJump(next: JumpState) {
    const changed = next.target !== jump.target;
    jump = next;
    if (changed) onJump?.(next.target);
  }
  function trackJump(delta: number, top: number, distanceFromBottom: number) {
    const now = performance.now();
    const user = userInput() || now < userScrollUntil;
    if (user) userScrollUntil = now + SCROLL_CHAIN_MS;
    setJump(nextJump(jump, { delta, top, distanceFromBottom, viewport: viewportHeight, user }));
    if (!jump.target) return;
    // one timer for the whole gesture: it re-arms itself for whatever time is left
    jumpSeen = now;
    jumpTimer ??= setTimeout(jumpIdle, JUMP_IDLE_MS);
  }
  function jumpIdle() {
    jumpTimer = undefined;
    if (!jump.target) return;
    const left = JUMP_IDLE_MS - (performance.now() - jumpSeen);
    if (left > 0) jumpTimer = setTimeout(jumpIdle, left);
    else setJump(NO_JUMP);
  }

  function onScroll() {
    if (!viewport) return;
    const top = viewport.scrollTop;
    const distanceFromBottom = viewport.scrollHeight - viewport.clientHeight - top;
    if (onJump) trackJump(top - scrollTop, top, distanceFromBottom);
    const wasFollowing = followBottom;
    followBottom = nextFollow(wasFollowing, {
      top,
      prevTop: scrollTop,
      distanceFromBottom,
      userInput: userInput(),
      layoutPending,
    });
    // rows changed size under a pinned list and the browser clamped the position: pin again
    if (followBottom && top < scrollTop && distanceFromBottom >= PIN_SLACK)
      void tick().then(() => scrollToBottom());
    scrollTop = top;
    if (viewport.scrollTop < viewportHeight && onNearTop) onNearTop();
  }

  export function scrollToBottom(behavior: ScrollBehavior = 'auto') {
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    followBottom = true;
    setJump(NO_JUMP);
  }

  export function scrollToTop() {
    if (!viewport) return;
    followBottom = false;
    viewport.scrollTo({ top: 0 });
    setJump(NO_JUMP);
  }

  onMount(() => {
    if (!viewport) return;
    viewportHeight = viewport.clientHeight;
    const vro = new ResizeObserver(() => {
      if (viewport) viewportHeight = viewport.clientHeight;
      if (followBottom) scrollToBottom();
    });
    vro.observe(viewport);
    scrollToBottom();
    const el = viewport;
    const hold = () => (held = true);
    const release = () => {
      held = false;
      lastInput = performance.now();
    };
    const touched = () => (lastInput = performance.now());
    const passive = { passive: true } as const;
    el.addEventListener('touchstart', hold, passive);
    el.addEventListener('touchend', release, passive);
    el.addEventListener('touchcancel', release, passive);
    el.addEventListener('mousedown', hold, passive);
    window.addEventListener('mouseup', release, passive);
    el.addEventListener('wheel', touched, passive);
    el.addEventListener('keydown', touched, passive);
    return () => {
      clearTimeout(jumpTimer);
      vro.disconnect();
      ro?.disconnect();
      el.removeEventListener('touchstart', hold);
      el.removeEventListener('touchend', release);
      el.removeEventListener('touchcancel', release);
      el.removeEventListener('mousedown', hold);
      window.removeEventListener('mouseup', release);
      el.removeEventListener('wheel', touched);
      el.removeEventListener('keydown', touched);
    };
  });

  $effect(() => {
    const { start, end } = range;
    if (onWindow) untrack(() => onWindow(start, end));
  });

  // New rows while following the bottom (sent / streaming) → stay pinned
  $effect(() => {
    void items.length;
    if (followBottom) void tick().then(() => scrollToBottom());
  });
</script>

<div {id} class={['tm-vlist', className]} bind:this={viewport} onscroll={onScroll}>
  {#if header}{@render header()}{/if}
  <div class="tm-vlist__pad" style:height="{padTop}px"></div>
  {#each shown.items as item, j (shown.keys[j])}
    {@render row(
      item,
      shown.index[j]!,
      rowAttachment(shown.keys[j]!),
      shown.index[j]! < range.start || shown.index[j]! >= range.end,
    )}
  {/each}
  <div class="tm-vlist__pad" style:height="{padBottom}px"></div>
</div>

<style>
  .tm-vlist {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    overflow-anchor: none;
  }
  .tm-vlist__pad {
    flex: none;
  }
  /* parked: still mounted and in place, but takes no room; measured as 0, which the observer
     ignores. The class sits on the caller's row element, whose own box styles must not leak out. */
  :global(.tm-vlist__row--parked) {
    height: 0 !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    overflow: hidden !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }
</style>
