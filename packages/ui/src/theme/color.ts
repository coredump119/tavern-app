/** Tiny color parser for ST theme values (rgb/rgba/hex). Returns null for anything else. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = parseInt(h, 16);
    const hasA = h.length === 8;
    return {
      r: (n >>> (hasA ? 24 : 16)) & 255,
      g: (n >>> (hasA ? 16 : 8)) & 255,
      b: (n >>> (hasA ? 8 : 0)) & 255,
      a: hasA ? (n & 255) / 255 : 1,
    };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
    return { r: +m[1]!, g: +m[2]!, b: +m[3]!, a: Math.min(1, Math.max(0, a)) };
  }
  // space-separated syntax: rgb(23 23 23 / 0.5)
  m = /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
    return { r: +m[1]!, g: +m[2]!, b: +m[3]!, a: Math.min(1, Math.max(0, a)) };
  }
  return null;
}

const clamp255 = (n: number) => Math.min(255, Math.max(0, Math.round(n)));

/** `rgb(r, g, b)` / `rgba(r, g, b, a)` string */
export function toCss(c: Rgba): string {
  const r = clamp255(c.r);
  const g = clamp255(c.g);
  const b = clamp255(c.b);
  return c.a >= 1
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${Math.round(c.a * 1000) / 1000})`;
}

/** Alpha-composite `fg` over an opaque `bg` (what the eye sees in ST, where tints sit on the page). */
export function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

/** Linear mix in sRGB: t = 0 → a, t = 1 → b (alpha mixed too). */
export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  };
}

/** Relative luminance 0..1 (sRGB). */
export function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two opaque colors (1..21) */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function isDarkColor(input: string): boolean | null {
  const c = parseColor(input);
  return c ? luminance(c) < 0.4 : null;
}
