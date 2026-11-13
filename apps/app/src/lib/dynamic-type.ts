/**
 * iOS Dynamic Type (DEV_NOTES §9.40). In WKWebView `font: -apple-system-body` resolves to the body
 * size of the system's text-size setting, 17px at the default step. A hidden probe carries that
 * font; its size over 17 goes into --tm-os-font-scale, which the type scale multiplies in.
 */
import { isIos } from './insets';

const BODY_DEFAULT_PX = 17;
/** the smallest system step is 14px; the accessibility steps go to 3x, which a phone cannot lay out */
const MIN_SCALE = 0.82;
const MAX_SCALE = 2;

export function osFontScale(bodyPx: number): number {
  if (!Number.isFinite(bodyPx) || bodyPx <= 0) return 1;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, bodyPx / BODY_DEFAULT_PX));
  return Math.round(scale * 100) / 100;
}

export function installDynamicType(root: HTMLElement = document.documentElement): void {
  if (!isIos() || typeof ResizeObserver === 'undefined') return;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  // the px size stays in charge where the system font keyword is not understood
  probe.style.cssText =
    'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;white-space:nowrap;' +
    `font-size:${BODY_DEFAULT_PX}px;font:-apple-system-body`;
  probe.textContent = 'M';
  document.body.appendChild(probe);

  let applied = 1;
  const update = () => {
    const scale = osFontScale(parseFloat(getComputedStyle(probe).fontSize));
    if (scale === applied) return;
    applied = scale;
    if (scale === 1) root.style.removeProperty('--tm-os-font-scale');
    else root.style.setProperty('--tm-os-font-scale', String(scale));
  };
  update();
  // WebKit lays the page out again when the setting changes, which resizes the probe
  new ResizeObserver(update).observe(probe);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') update();
  });
}
