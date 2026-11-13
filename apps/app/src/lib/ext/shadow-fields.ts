/**
 * The touch clamp of `ext.css` for text fields inside an extension's shadow root, where document
 * rules do not reach (DEV_NOTES §9.34). Custom properties do cross the boundary, so the tokens resolve.
 */
export const FIELD_CLAMP_CSS = `@media (pointer: coarse) {
  input:not([type='checkbox'], [type='radio'], [type='range'], [type='file']), select, textarea {
    font-size: max(var(--tm-text-input-min), var(--tm-text-md)) !important;
  }
}`;

/** `sheets` with `sheet` once, at the end */
export function keepLast<T>(sheets: Iterable<T>, sheet: T): T[] {
  const out = [...sheets].filter((s) => s !== sheet);
  out.push(sheet);
  return out;
}

let installed = false;

/**
 * Every shadow root created from now on adopts the clamp sheet, and keeps it when the author
 * assigns `adoptedStyleSheets` afterwards. No-op where constructable stylesheets are missing.
 */
export function installShadowFieldClamp(): void {
  if (installed) return;
  if (typeof CSSStyleSheet !== 'function' || typeof ShadowRoot !== 'function') return;
  const slot = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets');
  const { get, set } = slot ?? {};
  if (!slot || !get || !set || !('replaceSync' in CSSStyleSheet.prototype)) return;
  installed = true;

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(FIELD_CLAMP_CSS);
  Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
    ...slot,
    set(this: ShadowRoot, sheets: Iterable<CSSStyleSheet>) {
      set.call(this, keepLast(sheets, sheet));
    },
  });
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
    const root = attach.call(this, init);
    set.call(root, keepLast(get.call(root) as Iterable<CSSStyleSheet>, sheet));
    return root;
  };
}
