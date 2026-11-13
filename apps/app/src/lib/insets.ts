/**
 * Android safe-area bridge. Chromium's Android WebView only exposes the display cutout
 * through env(safe-area-inset-*); system bars and the keyboard are invisible to CSS under
 * edge-to-edge. MainActivity.kt pushes WindowInsets (in CSS px) through `__TM_ANDROID_INSETS`
 * and a `tm-insets` event; we write them to the --tm-safe-* tokens (DESIGN.md §2.5).
 * iOS and desktop never define the bridge, so env() stays in charge there.
 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

declare global {
  interface Window {
    __TM_ANDROID_INSETS?: { get(): string };
  }
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

export function applyInsets(insets: Insets, root: HTMLElement = document.documentElement): void {
  for (const side of SIDES) {
    root.style.setProperty(`--tm-safe-${side}`, `${Math.max(0, Math.round(insets[side]))}px`);
  }
}

export function installInsetsBridge(): void {
  const bridge = window.__TM_ANDROID_INSETS;
  if (!bridge) return;
  try {
    applyInsets(JSON.parse(bridge.get()) as Insets);
  } catch {
    /* bridge not ready yet; the event below will catch up */
  }
  window.addEventListener('tm-insets', (e) => applyInsets((e as CustomEvent<Insets>).detail));
}

/** iPhone / iPad WebKit (an iPad reports itself as a Mac with touch points) */
export function isIos(): boolean {
  return (
    /iP(hone|ad|od)/.test(navigator.platform) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * How much of the layout viewport the keyboard (or just its accessory bar, with a hardware keyboard)
 * covers. Measured against the full layout height: once WebKit has scrolled the page to reveal a
 * field, `innerHeight` shrinks and `offsetTop` grows by the same amount, and their difference from
 * the visual height reads 0 while the bar is still up.
 */
export function keyboardCover(layoutHeight: number, visualHeight: number, scale = 1): number {
  return Math.max(0, Math.round(layoutHeight - visualHeight * scale));
}

/** focus moves before the viewport does; look again while the keyboard animates */
const RECHECK_MS = [80, 350, 700];

/**
 * iOS keyboard. WKWebView keeps the layout viewport at full height and scrolls the page to reveal
 * the focused field, so the top bar slides under the status bar. We instead treat the keyboard as
 * a bottom inset: --tm-safe-bottom grows by the keyboard height (same contract Android uses for the
 * IME) and the document is pinned to scrollTop 0. No-op where visualViewport is missing.
 */
export function installKeyboardInset(root: HTMLElement = document.documentElement): void {
  const vv = window.visualViewport;
  if (!vv) return;
  if (!isIos()) return;
  // The keyboard is only up while something holds focus. A relaunch with it up can report the old,
  // shorter viewport once and then stay silent, which left a blank strip under the page.
  const editing = () => {
    const el = document.activeElement;
    return !!el && el !== document.body && el !== document.documentElement;
  };
  const update = () => {
    const layout = Math.max(window.innerHeight, root.clientHeight);
    const keyboard = editing() ? keyboardCover(layout, vv.height, vv.scale) : 0;
    if (keyboard > 0) {
      root.style.setProperty('--tm-safe-bottom', `${keyboard}px`);
      root.setAttribute('data-tm-keyboard', 'open');
    } else {
      // back to the stylesheet's env(safe-area-inset-bottom)
      root.style.removeProperty('--tm-safe-bottom');
      root.removeAttribute('data-tm-keyboard');
    }
    // The shell never scrolls the document. A field that goes away while focused sends no
    // focusout, and the page could stay shifted up with a blank strip under it.
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };
  const later = () => {
    for (const ms of RECHECK_MS) setTimeout(update, ms);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  window.addEventListener('focusout', later);
  window.addEventListener('focusin', later);
  window.addEventListener('scroll', () => {
    if (root.getAttribute('data-tm-keyboard') === 'open' && window.scrollY !== 0)
      window.scrollTo(0, 0);
  });
}
