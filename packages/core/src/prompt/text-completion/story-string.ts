// ST power-user.js renderStoryString：Handlebars.compile(storyString, { noEscape: true }) + 'trim' helper + helperMissing。
// 这里实现一个忠实的 Handlebars 子集（变量、#if/#unless/else、注释、standalone 行空白规则、~ 空白控制），
// 避免在 WebView 里依赖 eval。宏引擎的 {{#if x}} 不查 dynamicMacros，空字段会被当成真值，故不能直接拿来渲染。
import type { MacroEngine } from '../../macros/engine.js';
import type { ContextSettings, CoreState, InstructSettings } from '../../state.js';
import { EXTENSION_PROMPT_TYPES } from '../extension-prompts.js';

export interface StoryStringParams {
  description: string;
  personality: string;
  persona: string;
  scenario: string;
  system: string;
  char: string;
  user: string;
  wiBefore: string;
  wiAfter: string;
  loreBefore: string;
  loreAfter: string;
  anchorBefore: string;
  anchorAfter: string;
  mesExamples: string;
  mesExamplesRaw: string;
  [key: string]: string;
}

type Token =
  | { type: 'text'; value: string }
  | { type: 'mustache'; expr: string; stripBefore: boolean; stripAfter: boolean }
  | {
      type: 'open';
      helper: string;
      expr: string;
      stripBefore: boolean;
      stripAfter: boolean;
      standalone?: boolean;
    }
  | { type: 'else'; stripBefore: boolean; stripAfter: boolean; standalone?: boolean }
  | {
      type: 'close';
      helper: string;
      stripBefore: boolean;
      stripAfter: boolean;
      standalone?: boolean;
    }
  | { type: 'comment'; stripBefore: boolean; stripAfter: boolean; standalone?: boolean };

type Node =
  | { type: 'text'; value: string }
  | { type: 'mustache'; expr: string }
  | { type: 'block'; helper: string; expr: string; body: Node[]; inverse: Node[] };

export class StoryStringSyntaxError extends Error {}

function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let text = '';
  const flushText = () => {
    if (text) tokens.push({ type: 'text', value: text });
    text = '';
  };
  while (i < template.length) {
    if (template.startsWith('{{', i)) {
      // 注释
      if (template.startsWith('{{!--', i)) {
        const end = template.indexOf('--}}', i + 5);
        if (end === -1) throw new StoryStringSyntaxError('Unterminated comment');
        flushText();
        tokens.push({ type: 'comment', stripBefore: false, stripAfter: false });
        i = end + 4;
        continue;
      }
      if (template.startsWith('{{!', i)) {
        const end = template.indexOf('}}', i + 3);
        if (end === -1) throw new StoryStringSyntaxError('Unterminated comment');
        flushText();
        tokens.push({ type: 'comment', stripBefore: false, stripAfter: false });
        i = end + 2;
        continue;
      }
      const triple = template.startsWith('{{{', i);
      const closeSeq = triple ? '}}}' : '}}';
      const end = template.indexOf(closeSeq, i + (triple ? 3 : 2));
      if (end === -1) throw new StoryStringSyntaxError(`Unterminated mustache at ${i}`);
      let inner = template.slice(i + (triple ? 3 : 2), end);
      let stripBefore = false;
      let stripAfter = false;
      if (inner.startsWith('~')) {
        stripBefore = true;
        inner = inner.slice(1);
      }
      if (inner.endsWith('~')) {
        stripAfter = true;
        inner = inner.slice(0, -1);
      }
      inner = inner.trim();
      flushText();
      if (inner.startsWith('#')) {
        const body = inner.slice(1).trim();
        const sp = body.search(/\s/);
        const helper = sp === -1 ? body : body.slice(0, sp);
        const expr = sp === -1 ? '' : body.slice(sp).trim();
        tokens.push({ type: 'open', helper, expr, stripBefore, stripAfter });
      } else if (inner.startsWith('/')) {
        tokens.push({ type: 'close', helper: inner.slice(1).trim(), stripBefore, stripAfter });
      } else if (inner === 'else' || inner === '^') {
        tokens.push({ type: 'else', stripBefore, stripAfter });
      } else {
        tokens.push({ type: 'mustache', expr: inner, stripBefore, stripAfter });
      }
      i = end + closeSeq.length;
      continue;
    }
    text += template[i];
    i++;
  }
  flushText();
  return tokens;
}

/** Handlebars 的 standalone 规则：块/注释标签独占一行时，整行（含行尾换行）被移除 */
function applyWhitespace(tokens: Token[]): Token[] {
  const isBlockish = (t: Token) =>
    t.type === 'open' || t.type === 'close' || t.type === 'else' || t.type === 'comment';
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]!;
    if (!isBlockish(t)) continue;
    const prev = tokens[idx - 1];
    const next = tokens[idx + 1];
    const prevText = prev?.type === 'text' ? prev.value : '';
    const nextText = next?.type === 'text' ? next.value : '';
    const prevOk =
      idx === 0 ||
      (prev?.type === 'text' && /(^|\n)[ \t]*$/.test(prevText)) ||
      (prev && prev.type !== 'text' && (prev as { standalone?: boolean }).standalone === true);
    const nextMatch = /^[ \t]*(\r?\n|$)/.exec(nextText);
    const nextOk =
      idx === tokens.length - 1 ||
      (next?.type === 'text' &&
        nextMatch !== null &&
        (nextMatch[1] !== '' || idx + 1 === tokens.length - 1 || tokens[idx + 2] === undefined));
    // 两侧都只有空白才算 standalone；模板末尾/开头也算行界
    const atLineStart =
      idx === 0 ||
      (prev?.type === 'text'
        ? /(^|\n)[ \t]*$/.test(prevText)
        : (prev as { standalone?: boolean })?.standalone === true);
    const atLineEnd =
      next === undefined ||
      (next.type === 'text' &&
        nextMatch !== null &&
        (nextMatch[1] !== '' || idx + 1 === tokens.length - 1));
    if (atLineStart && atLineEnd && prevOk && nextOk) {
      (t as { standalone?: boolean }).standalone = true;
      if (prev?.type === 'text') prev.value = prevText.replace(/[ \t]*$/, '');
      if (next?.type === 'text') next.value = nextText.replace(/^[ \t]*(\r?\n)?/, '');
    }
  }
  // ~ 空白控制
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]!;
    if (t.type === 'text') continue;
    if (t.stripBefore) {
      const prev = tokens[idx - 1];
      if (prev?.type === 'text') prev.value = prev.value.replace(/\s+$/, '');
    }
    if (t.stripAfter) {
      const next = tokens[idx + 1];
      if (next?.type === 'text') next.value = next.value.replace(/^\s+/, '');
    }
  }
  return tokens;
}

function parse(tokens: Token[]): Node[] {
  let pos = 0;
  const parseNodes = (closeHelper: string | null): { body: Node[]; inverse: Node[] } => {
    const body: Node[] = [];
    let inverse: Node[] | null = null;
    let target = body;
    while (pos < tokens.length) {
      const t = tokens[pos]!;
      if (t.type === 'text') {
        if (t.value) target.push({ type: 'text', value: t.value });
        pos++;
      } else if (t.type === 'comment') {
        pos++;
      } else if (t.type === 'mustache') {
        target.push({ type: 'mustache', expr: t.expr });
        pos++;
      } else if (t.type === 'open') {
        pos++;
        const inner = parseNodes(t.helper);
        target.push({
          type: 'block',
          helper: t.helper,
          expr: t.expr,
          body: inner.body,
          inverse: inner.inverse,
        });
      } else if (t.type === 'else') {
        if (closeHelper === null) throw new StoryStringSyntaxError('{{else}} outside of a block');
        inverse = [];
        target = inverse;
        pos++;
      } else {
        if (closeHelper === null || t.helper !== closeHelper)
          throw new StoryStringSyntaxError(`Unexpected {{/${t.helper}}}`);
        pos++;
        return { body, inverse: inverse ?? [] };
      }
    }
    if (closeHelper !== null) throw new StoryStringSyntaxError(`Missing {{/${closeHelper}}}`);
    return { body, inverse: inverse ?? [] };
  };
  return parseNodes(null).body;
}

const isEmpty = (v: unknown) =>
  v === false ||
  v === null ||
  v === undefined ||
  v === '' ||
  v === 0 ||
  (Array.isArray(v) && v.length === 0);

function lookup(params: Record<string, unknown>, path: string): { found: boolean; value: unknown } {
  if (path === 'this' || path === '.') return { found: true, value: params };
  const parts = path.replace(/^this\./, '').split('.');
  let cur: unknown = params;
  for (const [i, part] of parts.entries()) {
    if (cur === null || cur === undefined) return { found: i > 0, value: undefined };
    const obj = Object(cur) as Record<string, unknown>;
    if (!(part in obj)) return { found: i > 0, value: undefined };
    cur = obj[part];
  }
  return { found: true, value: cur };
}

export interface StoryStringHelpers {
  /** helperMissing：ST 用 substituteParams(`{{name}}`) */
  missing: (name: string) => string;
}

export function renderHandlebarsSubset(
  template: string,
  params: Record<string, unknown>,
  helpers: StoryStringHelpers,
): string {
  const nodes = parse(applyWhitespace(tokenize(template)));
  const render = (list: Node[]): string => {
    let out = '';
    for (const n of list) {
      if (n.type === 'text') out += n.value;
      else if (n.type === 'mustache') {
        const sp = n.expr.search(/\s/);
        const name = sp === -1 ? n.expr : n.expr.slice(0, sp);
        if (name === 'trim') {
          out += '{{trim}}';
          continue;
        }
        const hasParams = sp !== -1;
        const { found, value } = lookup(params, name);
        if (!hasParams && found) out += value === null || value === undefined ? '' : String(value);
        else if (name.includes('.')) out += '';
        else out += helpers.missing(name);
      } else {
        const { value } = lookup(params, n.expr.split(/\s/)[0] ?? '');
        const truthy = !isEmpty(value);
        if (n.helper === 'unless') out += truthy ? render(n.inverse) : render(n.body);
        else out += truthy ? render(n.body) : render(n.inverse);
      }
    }
    return out;
  };
  return render(nodes);
}

export function renderStoryString(
  engine: MacroEngine,
  state: CoreState,
  params: StoryStringParams,
  {
    customStoryString = null,
    customInstructSettings = null,
    customContextSettings = null,
  }: {
    customStoryString?: string | null;
    customInstructSettings?: InstructSettings | null;
    customContextSettings?: ContextSettings | null;
  } = {},
): string {
  const instruct = customInstructSettings ?? state.powerUser.instruct;
  const context = customContextSettings ?? state.powerUser.context;
  const storyString = customStoryString ?? context.story_string ?? '';
  const position =
    (context['story_string_position'] as number | undefined) ?? EXTENSION_PROMPT_TYPES.IN_PROMPT;

  let output = renderHandlebarsSubset(storyString, params, {
    missing: (name) => engine.substituteParams(`{{${name}}}`, state),
  });
  output = engine.substituteParams(output, state, {
    name1Override: params.user,
    name2Override: params.char,
  });
  output = output.replace(/^\n+/, '');
  if (output.length > 0 && !output.endsWith('\n') && position !== EXTENSION_PROMPT_TYPES.IN_CHAT) {
    if (!instruct.enabled || (instruct.wrap && !instruct.story_string_suffix)) output += '\n';
  }
  return output;
}
