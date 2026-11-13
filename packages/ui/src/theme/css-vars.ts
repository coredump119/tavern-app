/**
 * Tiny reader for the `:root { --var: … }` blocks of an ST theme's `custom_css` (DEV_NOTES §9.26).
 * ST "beautification" themes drive the whole UI through CSS variables that override ST's
 * `--SmartTheme*` tokens (often via their own `--x` chain and an `@media (prefers-color-scheme:
 * dark)` block). We only need those values; this is not a CSS parser.
 */

export interface RootVars {
  /** declarations from top-level `:root { }` blocks, in source order (later wins) */
  light: Map<string, string>;
  /** declarations from `:root { }` blocks inside `@media (prefers-color-scheme: dark)` */
  dark: Map<string, string>;
  /** `font-family` of `.mes_text` / `body` rules (light only; last wins), raw values */
  fonts: { mesText?: string; body?: string };
  /** `background(-color)` of `html` / `body` rules: the page color behind ST's tints, raw values */
  page: { light?: string; dark?: string };
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Collect `{ … }` bodies of `:root` rules in `css`, skipping nested braces inside them. */
function rootBlocks(css: string): string[] {
  const out: string[] = [];
  const re = /(^|[}\s;])(:root|html)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const start = re.lastIndex;
    let depth = 1;
    let i = start;
    while (i < css.length && depth > 0) {
      const c = css[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    out.push(css.slice(start, i - 1));
    re.lastIndex = i;
  }
  return out;
}

/** `--name: value;` pairs (value keeps `!important` stripped) */
function declarations(block: string, into: Map<string, string>): void {
  const re = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    into.set(m[1]!, m[2]!.replace(/\s*!important\s*$/i, '').trim());
  }
}

/** Split out `@media (prefers-color-scheme: dark) { … }` bodies from the rest. */
function splitDarkMedia(css: string): { rest: string; dark: string } {
  let rest = '';
  let dark = '';
  const re = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    rest += css.slice(last, m.index);
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      const c = css[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    dark += css.slice(re.lastIndex, i - 1) + '\n';
    last = i;
    re.lastIndex = i;
  }
  rest += css.slice(last);
  return { rest, dark };
}

/** Last `prop` declared in any rule whose selector list contains `selector` (e.g. `html, body {}`). */
function declOf(css: string, selector: RegExp, prop: RegExp): string | undefined {
  let found: string | undefined;
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(css))) {
    const selectors = m[1]!.split(',').map((s) => s.trim());
    if (!selectors.some((s) => selector.test(s))) continue;
    const re = new RegExp(`(?:^|;)\\s*${prop.source}\\s*:\\s*([^;]+)`, 'gi');
    let d: RegExpExecArray | null;
    while ((d = re.exec(m[2]!))) found = d[1]!.replace(/\s*!important\s*$/i, '').trim();
  }
  return found;
}
const fontOf = (css: string, selector: RegExp) => declOf(css, selector, /font-family/);
/** `background-color`, or the color part of a shorthand `background` (first token when it parses) */
function pageColorOf(css: string): string | undefined {
  const sel = /^(html|body|html\s+body)$/;
  const direct = declOf(css, sel, /background-color/);
  if (direct) return direct;
  const shorthand = declOf(css, sel, /background/);
  if (!shorthand) return undefined;
  // `var(--x)` or a plain color token; anything with url()/gradient is not a flat color
  if (/url\(|gradient/i.test(shorthand)) return undefined;
  return shorthand.split(/\s+(?![^(]*\))/)[0];
}

export function readRootVars(customCss: string): RootVars {
  const css = stripComments(customCss);
  const { rest, dark } = splitDarkMedia(css);
  const light = new Map<string, string>();
  const darkMap = new Map<string, string>();
  for (const b of rootBlocks(rest)) declarations(b, light);
  for (const b of rootBlocks(dark)) declarations(b, darkMap);
  const fonts: RootVars['fonts'] = {};
  const mes = fontOf(rest, /^\.mes_text$/);
  const body = fontOf(rest, /^body$/);
  if (mes) fonts.mesText = mes;
  if (body) fonts.body = body;
  const page: RootVars['page'] = {};
  const pl = pageColorOf(rest);
  const pd = pageColorOf(dark);
  if (pl) page.light = pl;
  if (pd) page.dark = pd;
  return { light, dark: darkMap, fonts, page };
}

/** Evaluate a flat arithmetic expression (`0.96 * (1 - 0)`); null when it is not plain math. */
export function evalArith(expr: string): number | null {
  const s = expr.replace(/\s+/g, '');
  if (!/^[\d.()+\-*/]+$/.test(s) || s.length === 0) return null;
  let i = 0;
  const peek = () => s[i];
  const num = (): number | null => {
    if (peek() === '(') {
      i++;
      const v = add();
      if (peek() !== ')') return null;
      i++;
      return v;
    }
    const m = /^-?\d*\.?\d+/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const mul = (): number | null => {
    let v = num();
    while (v !== null && (peek() === '*' || peek() === '/')) {
      const op = s[i++];
      const r = num();
      if (r === null) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const add = (): number | null => {
    let v = mul();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = s[i++];
      const r = mul();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = add();
  return i === s.length && v !== null && Number.isFinite(v) ? v : null;
}

/**
 * Resolve `var(--x[, fallback])` references in `value` against `vars` (with `base` as the layer
 * under it, e.g. light vars under dark overrides), then fold `calc(...)` of plain numbers.
 * Returns null when a referenced variable is missing without a fallback or nesting runs away.
 */
export function resolveCssValue(
  value: string,
  vars: ReadonlyMap<string, string>,
  base?: ReadonlyMap<string, string>,
  depth = 0,
): string | null {
  if (depth > 16) return null;
  let out = value;
  // innermost var() first: no nested parentheses inside the match
  const re = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*?(?:\([^()]*\)[^()]*?)*))?\)/;
  for (let guard = 0; guard < 64; guard++) {
    const m = re.exec(out);
    if (!m) break;
    const name = m[1]!;
    const v = vars.get(name) ?? base?.get(name);
    const replacement = v !== undefined ? v : m[2];
    if (replacement === undefined) return null;
    const inner = resolveCssValue(replacement, vars, base, depth + 1);
    if (inner === null) return null;
    out = out.slice(0, m.index) + inner + out.slice(m.index + m[0].length);
  }
  // calc() with plain arithmetic
  for (let guard = 0; guard < 16; guard++) {
    const m = /calc\(([^()]*(?:\([^()]*\)[^()]*)*)\)/.exec(out);
    if (!m) break;
    const n = evalArith(m[1]!);
    if (n === null) return null;
    out =
      out.slice(0, m.index) +
      String(Math.round(n * 10000) / 10000) +
      out.slice(m.index + m[0].length);
  }
  return out.trim();
}
