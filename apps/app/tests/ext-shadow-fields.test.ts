import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIELD_CLAMP_CSS, installShadowFieldClamp, keepLast } from '../src/lib/ext/shadow-fields';

describe('touch clamp inside extension shadow roots (DEV_NOTES §9.34)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the sheet once, at the end', () => {
    expect(keepLast(['a', 'b'], 'x')).toEqual(['a', 'b', 'x']);
    expect(keepLast(['x', 'a', 'x'], 'x')).toEqual(['a', 'x']);
    expect(keepLast([], 'x')).toEqual(['x']);
  });

  it('adopts the sheet on new roots and survives a later assignment', () => {
    class Sheet {
      text = '';
      replaceSync(text: string) {
        this.text = text;
      }
    }
    class Root {
      list: unknown[] = [];
      get adoptedStyleSheets() {
        return this.list;
      }
      set adoptedStyleSheets(v: unknown[]) {
        this.list = [...v];
      }
    }
    class El {
      attachShadow(_init: unknown) {
        return new Root();
      }
    }
    vi.stubGlobal('CSSStyleSheet', Sheet);
    vi.stubGlobal('ShadowRoot', Root);
    vi.stubGlobal('Element', El);

    installShadowFieldClamp();
    const root = new El().attachShadow({ mode: 'open' });
    expect(root.list).toHaveLength(1);
    expect((root.list[0] as Sheet).text).toBe(FIELD_CLAMP_CSS);

    const own = new Sheet();
    root.adoptedStyleSheets = [own];
    expect(root.list).toEqual([own, root.list[1]]);
    expect((root.list[1] as Sheet).text).toBe(FIELD_CLAMP_CSS);
  });
});
