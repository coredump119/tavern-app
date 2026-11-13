/**
 * ST "beautification" custom_css support (DEV_NOTES §9.28): a small CSS block tokenizer, the
 * "appearance only" sanitizer, and a risk analyzer. Not a full CSS parser: it walks blocks with
 * string / comment / parenthesis awareness, which is all theme CSS needs.
 */

/** Declarations that move or resize things. Dropped in "appearance only" mode. */
const LAYOUT_PROPS = new Set([
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'inset-block',
  'inset-inline',
  'inset-block-start',
  'inset-block-end',
  'inset-inline-start',
  'inset-inline-end',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'block-size',
  'inline-size',
  'min-block-size',
  'min-inline-size',
  'max-block-size',
  'max-inline-size',
  'display',
  'flex',
  'flex-direction',
  'flex-wrap',
  'flex-flow',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'order',
  'float',
  'clear',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'margin-block',
  'margin-inline',
  'margin-block-start',
  'margin-block-end',
  'margin-inline-start',
  'margin-inline-end',
  'transform',
  'translate',
  'rotate',
  'scale',
  'zoom',
  'z-index',
  'overflow',
  'overflow-x',
  'overflow-y',
  'visibility',
  'aspect-ratio',
  'columns',
  'column-count',
  'column-width',
  'writing-mode',
  'direction',
  'contain',
  'resize',
]);
const LAYOUT_PREFIXES = ['grid', 'place-', 'align-', 'justify-'];

export function isLayoutProperty(prop: string): boolean {
  const p = prop.trim().toLowerCase();
  if (p.startsWith('--')) return false;
  const bare = p.replace(/^-(webkit|moz|ms|o)-/, '');
  return LAYOUT_PROPS.has(bare) || LAYOUT_PREFIXES.some((x) => bare.startsWith(x));
}

/** A parsed piece of a stylesheet. */
export type CssNode =
  | { kind: 'at-statement'; text: string } // @import …; / @charset …;
  | { kind: 'at-block'; prelude: string; name: string; body: CssNode[] } // @media / @supports / @layer …
  | { kind: 'at-raw'; prelude: string; name: string; raw: string } // @font-face / @keyframes … (kept verbatim)
  | { kind: 'rule'; selector: string; decls: CssDecl[] };

export interface CssDecl {
  prop: string;
  value: string;
}

/** at-rules whose body contains rules (recursed) */
const NESTING_AT = new Set(['media', 'supports', 'container', 'layer', 'document', 'scope']);

function stripComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '"' || c === "'") {
      const end = skipString(css, i);
      out += css.slice(i, end);
      i = end;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function skipString(css: string, i: number): number {
  const q = css[i];
  let j = i + 1;
  while (j < css.length && css[j] !== q) {
    if (css[j] === '\\') j++;
    j++;
  }
  return Math.min(css.length, j + 1);
}

/** Index of the `}` matching the `{` at `open` (string / paren aware). */
function matchBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const c = css[i]!;
    if (c === '"' || c === "'") {
      i = skipString(css, i) - 1;
    } else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return css.length;
}

/** Split declarations on `;` outside strings / parentheses. */
function parseDecls(body: string): CssDecl[] {
  const out: CssDecl[] = [];
  let depth = 0;
  let start = 0;
  const push = (chunk: string) => {
    const k = chunk.indexOf(':');
    if (k <= 0) return;
    const prop = chunk.slice(0, k).trim();
    const value = chunk.slice(k + 1).trim();
    if (prop && value) out.push({ prop, value });
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '"' || c === "'") i = skipString(body, i) - 1;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      push(body.slice(start, i));
      start = i + 1;
    }
  }
  push(body.slice(start));
  return out;
}

/** `inner` with nested `selector { … }` blocks removed: only the rule's own declarations remain. */
function topLevelText(inner: string): string {
  let out = '';
  let segStart = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === '"' || c === "'") {
      i = skipString(inner, i) - 1;
    } else if (c === ';') {
      out += inner.slice(segStart, i + 1);
      segStart = i + 1;
    } else if (c === '{') {
      const close = matchBrace(inner, i);
      i = close;
      segStart = close + 1;
    }
  }
  return out + inner.slice(segStart).replace(/[^;]*$/, (rest) => (rest.includes(':') ? rest : ''));
}

export function parseCss(input: string): CssNode[] {
  const css = stripComments(input);
  return parseBlock(css, 0, css.length);
}

function parseBlock(css: string, from: number, to: number): CssNode[] {
  const nodes: CssNode[] = [];
  let i = from;
  while (i < to) {
    while (i < to && /\s/.test(css[i]!)) i++;
    if (i >= to) break;
    if (css[i] === '}' || css[i] === ';') {
      i++;
      continue;
    }
    // find the next `{` or `;` at top level
    let j = i;
    let depth = 0;
    while (j < to) {
      const c = css[j]!;
      if (c === '"' || c === "'") {
        j = skipString(css, j);
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === '{' || c === ';')) break;
      j++;
    }
    const head = css.slice(i, j).trim();
    if (j >= to || css[j] === ';') {
      if (head.startsWith('@')) nodes.push({ kind: 'at-statement', text: `${head};` });
      i = j + 1;
      continue;
    }
    const close = Math.min(matchBrace(css, j), to);
    const inner = css.slice(j + 1, close);
    if (head.startsWith('@')) {
      const name = /^@([\w-]+)/.exec(head)?.[1]?.toLowerCase() ?? '';
      const bare = name.replace(/^-(webkit|moz|ms|o)-/, '');
      if (NESTING_AT.has(bare)) {
        nodes.push({
          kind: 'at-block',
          prelude: head,
          name: bare,
          body: parseBlock(css, j + 1, close),
        });
      } else {
        nodes.push({ kind: 'at-raw', prelude: head, name: bare, raw: inner });
      }
    } else if (inner.includes('{')) {
      // native CSS nesting: the parent's own declarations, then nested rules flattened under it
      const own = parseDecls(topLevelText(inner));
      if (own.length) nodes.push({ kind: 'rule', selector: head, decls: own });
      for (const n of parseBlock(css, j + 1, close)) {
        if (n.kind === 'rule') {
          const sel = n.selector.includes('&')
            ? n.selector.replaceAll('&', head)
            : `${head} ${n.selector}`;
          nodes.push({ kind: 'rule', selector: sel, decls: n.decls });
        } else if (n.kind !== 'at-statement') nodes.push(n);
      }
    } else {
      nodes.push({ kind: 'rule', selector: head, decls: parseDecls(inner) });
    }
    i = close + 1;
  }
  return nodes;
}

export function serializeCss(nodes: readonly CssNode[], indent = ''): string {
  const out: string[] = [];
  for (const n of nodes) {
    switch (n.kind) {
      case 'at-statement':
        out.push(`${indent}${n.text}`);
        break;
      case 'at-raw':
        out.push(`${indent}${n.prelude} {${n.raw}}`);
        break;
      case 'at-block': {
        const body = serializeCss(n.body, `${indent}  `);
        if (body.trim()) out.push(`${indent}${n.prelude} {\n${body}\n${indent}}`);
        break;
      }
      case 'rule':
        if (n.decls.length)
          out.push(
            `${indent}${n.selector} {\n${n.decls.map((d) => `${indent}  ${d.prop}: ${d.value};`).join('\n')}\n${indent}}`,
          );
        break;
    }
  }
  return out.join('\n');
}

const PSEUDO_OVERLAY = /::?(before|after)\b/i;
const hasContent = (decls: readonly CssDecl[]) =>
  decls.some(
    (d) => d.prop.toLowerCase() === 'content' && !/^(none|normal|''|"")$/i.test(d.value.trim()),
  );
const positions = (decls: readonly CssDecl[]) =>
  decls.some(
    (d) =>
      (d.prop.toLowerCase() === 'position' && /absolute|fixed|sticky/i.test(d.value)) ||
      /^(transform|translate|top|left|right|bottom|inset)$/i.test(d.prop),
  );

/** A positioned ::before / ::after overlay: dropped whole in appearance mode. */
function isPositionedOverlay(selector: string, decls: readonly CssDecl[]): boolean {
  return PSEUDO_OVERLAY.test(selector) && hasContent(decls) && positions(decls);
}

function sanitizeNodes(nodes: readonly CssNode[]): CssNode[] {
  const out: CssNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'at-block') {
      const body = sanitizeNodes(n.body);
      if (body.length) out.push({ ...n, body });
    } else if (n.kind === 'rule') {
      if (isPositionedOverlay(n.selector, n.decls)) continue;
      const decls = n.decls.filter((d) => !isLayoutProperty(d.prop));
      if (decls.length) out.push({ ...n, decls });
    } else out.push(n);
  }
  return out;
}

/** "Appearance only": drop layout declarations and positioned overlays; keep everything else. */
export function sanitizeCustomCss(css: string): string {
  if (!css.trim()) return '';
  return serializeCss(sanitizeNodes(parseCss(css)));
}

const SCHEME_MEDIA = /@media\b([^{;]*\bprefers-color-scheme\b[^{;]*)\{/gi;
const SCHEME_FEATURE = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/i;

/** One media query with its color-scheme condition settled; `null` = can never match */
function pinQuery(query: string, appearance: 'light' | 'dark'): string | null {
  const feature = SCHEME_FEATURE.exec(query);
  if (!feature || /^\s*not\b/i.test(query)) return query.trim();
  if (feature[1]!.toLowerCase() !== appearance) return null;
  const rest = (
    query.slice(0, feature.index) +
    ' ' +
    query.slice(feature.index + feature[0].length)
  )
    .replace(/^\s*and\b|\band\s*$/gi, '')
    .replace(/\band\s+and\b/gi, 'and')
    .replace(/\s+/g, ' ')
    .trim();
  return rest || 'all';
}

/**
 * Make a theme's CSS follow the theme's own appearance instead of the system's (DEV_NOTES §9.28):
 * `@media (prefers-color-scheme: …)` conditions that agree with `appearance` always apply, the
 * others never do. CSS without such a condition is returned untouched.
 */
export function pinColorScheme(input: string, appearance: 'light' | 'dark'): string {
  if (!/prefers-color-scheme/i.test(input)) return input;
  const css = stripComments(input);
  let out = '';
  let last = 0;
  SCHEME_MEDIA.lastIndex = 0;
  for (let m = SCHEME_MEDIA.exec(css); m; m = SCHEME_MEDIA.exec(css)) {
    const open = m.index + m[0].length - 1;
    const queries = splitSelectors(m[1]!)
      .map((q) => pinQuery(q, appearance))
      .filter((q): q is string => q !== null);
    out += css.slice(last, m.index);
    if (queries.length) {
      out += `@media ${queries.join(', ')} {`;
      last = open + 1;
    } else {
      last = matchBrace(css, open) + 1;
    }
    SCHEME_MEDIA.lastIndex = last;
  }
  return out + css.slice(last);
}

/** Where a message's own content lives (ST contract class) */
const MESSAGE_BODY = '.mes_text';

/** Split a selector list on its top-level commas */
function splitSelectors(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (c === '"' || c === "'") i = skipString(selector, i) - 1;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      out.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  out.push(selector.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function scopeNodes(nodes: readonly CssNode[]): CssNode[] {
  const out: CssNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'at-block') {
      const body = scopeNodes(n.body);
      if (body.length) out.push({ ...n, body });
    } else if (n.kind === 'rule') {
      const inside: string[] = [];
      const outside: string[] = [];
      for (const selector of splitSelectors(n.selector)) {
        if (selector.includes(MESSAGE_BODY)) inside.push(selector);
        else {
          inside.push(`${MESSAGE_BODY} ${selector}`);
          outside.push(selector);
        }
      }
      if (inside.length) out.push({ ...n, selector: inside.join(', ') });
      if (outside.length) out.push(...sanitizeNodes([{ ...n, selector: outside.join(', ') }]));
    } else if (n.kind !== 'at-statement') out.push(n);
  }
  return out;
}

/**
 * CSS a TavernHelper script added to the page (DEV_NOTES §9.5 第 3 轮): applied whole inside
 * message bodies, where scripts put their own elements, and "appearance only" everywhere else,
 * like a theme's custom CSS. `@import` is dropped: what it loads would apply unscoped.
 */
export function scopeScriptCss(css: string): string {
  if (!css.trim()) return '';
  return serializeCss(scopeNodes(parseCss(css)));
}

export interface CustomCssReport {
  rules: number;
  /** declarations that would be dropped in appearance-only mode */
  layoutDecls: number;
  /** positioned ::before / ::after overlays */
  overlays: number;
  /** `@import url(...)` targets (usually web fonts) */
  imports: string[];
  /** rules that draw Font Awesome glyphs through `content: "\\f…"` (cannot work without FA) */
  fontAwesomeGlyphs: number;
  /** a few example selectors that carry layout changes, for the panel */
  layoutSamples: string[];
}

export function analyzeCustomCss(css: string): CustomCssReport {
  const report: CustomCssReport = {
    rules: 0,
    layoutDecls: 0,
    overlays: 0,
    imports: [],
    fontAwesomeGlyphs: 0,
    layoutSamples: [],
  };
  const walk = (nodes: readonly CssNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'at-block') walk(n.body);
      else if (n.kind === 'at-statement') {
        const m = /@import\s+(?:url\()?\s*["']?([^"')\s;]+)/i.exec(n.text);
        if (m) report.imports.push(m[1]!);
      } else if (n.kind === 'rule') {
        report.rules++;
        if (isPositionedOverlay(n.selector, n.decls)) report.overlays++;
        const layout = n.decls.filter((d) => isLayoutProperty(d.prop)).length;
        report.layoutDecls += layout;
        if (layout && report.layoutSamples.length < 6)
          report.layoutSamples.push(n.selector.slice(0, 60));
        if (
          n.decls.some(
            (d) => d.prop.toLowerCase() === 'content' && /["']\\f[0-9a-f]{3}/i.test(d.value),
          )
        )
          report.fontAwesomeGlyphs++;
      }
    }
  };
  walk(parseCss(css));
  return report;
}
