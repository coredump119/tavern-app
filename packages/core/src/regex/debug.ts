/**
 * The regex debugger's own runner (ST extensions/regex/index.js `executeRegexScriptForDebugging`,
 * DEV_NOTES §9.37). Deliberately not the runtime pipeline: no placement, depth, macro or trim
 * handling. A rule is its find pattern (always global here) and its replace string, and the
 * result says what each match lost and gained.
 */
import { regexFromString } from './engine.js';
import type { RegexScript } from './types.js';

/** A run of the diff view: plain text, the original match, a literal the rule added, a part it kept */
export interface RegexDebugSegment {
  kind: 'text' | 'removed' | 'added' | 'kept';
  text: string;
}

export interface RegexDebugResult {
  output: string;
  /** the diff view: each match as `removed → replacement` between the untouched text */
  segments: RegexDebugSegment[];
  error: string | null;
  charsCaptured: number;
  charsAdded: number;
  charsRemoved: number;
}

type DebugScript = Pick<RegexScript, 'findRegex' | 'replaceString'>;

const BACKREF = /\$\$|\$&|\$`|\$'|\$(\d{1,2})/g;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function push(segments: RegexDebugSegment[], kind: RegexDebugSegment['kind'], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last?.kind === kind) last.text += text;
  else segments.push({ kind, text });
}

/** One match's replacement: plain text, diff segments, and how much is new / carried over. */
function expand(
  match: RegExpMatchArray,
  input: string,
  pattern: string,
  segments: RegexDebugSegment[],
): { text: string; added: number; kept: number } {
  let text = '';
  let added = 0;
  let kept = 0;
  let last = 0;
  const start = match.index ?? 0;
  for (const ref of pattern.matchAll(BACKREF)) {
    const literal = pattern.slice(last, ref.index);
    added += literal.length;
    text += literal;
    push(segments, 'added', literal);
    last = ref.index + ref[0].length;

    if (ref[0] === '$$') {
      text += '$';
      push(segments, 'text', '$');
    } else if (ref[0] === '$&') {
      kept += match[0].length;
      text += match[0];
      push(segments, 'kept', match[0]);
    } else if (ref[0] === '$`' || ref[0] === "$'") {
      const part = ref[0] === '$`' ? input.slice(0, start) : input.slice(start + match[0].length);
      kept += part.length;
      text += part;
      push(segments, 'text', part);
    } else {
      const group = match[Number(ref[1])];
      if (Number(ref[1]) > 0 && group !== undefined) {
        kept += group.length;
        text += group;
        push(segments, 'kept', group);
      } else {
        // not a group of this pattern: ST drops it from the output and shows it as a literal
        push(segments, 'added', ref[0]);
      }
    }
  }
  const tail = pattern.slice(last);
  added += tail.length;
  text += tail;
  push(segments, 'added', tail);
  return { text, added, kept };
}

export function debugRegexScript(script: DebugScript, text: string): RegexDebugResult {
  const untouched = (error: string | null): RegexDebugResult => ({
    output: text,
    segments: text ? [{ kind: 'text', text }] : [],
    error,
    charsCaptured: 0,
    charsAdded: 0,
    charsRemoved: 0,
  });

  let regex: RegExp;
  try {
    const parsed = regexFromString(script.findRegex ?? '');
    if (!parsed) throw new Error('Invalid regex string');
    regex = new RegExp(
      parsed.source,
      parsed.flags.includes('g') ? parsed.flags : `${parsed.flags}g`,
    );
  } catch (e) {
    return untouched(`Compile error: ${errorText(e)}`);
  }

  const matches = [...text.matchAll(regex)];
  if (matches.length === 0) return untouched(null);

  const replace = script.replaceString ?? '';
  const segments: RegexDebugSegment[] = [];
  let output = '';
  let last = 0;
  let charsCaptured = 0;
  let charsAdded = 0;
  let charsRemoved = 0;
  for (const match of matches) {
    const start = match.index;
    const between = text.slice(last, start);
    output += between;
    push(segments, 'text', between);

    push(segments, 'removed', match[0]);
    push(segments, 'text', ' → ');
    const replaced = expand(match, text, replace, segments);
    output += replaced.text;
    charsCaptured += match[0].length;
    charsAdded += replaced.added;
    charsRemoved += match[0].length - replaced.kept;
    last = start + match[0].length;
  }
  const rest = text.slice(last);
  output += rest;
  push(segments, 'text', rest);
  return { output, segments, error: null, charsCaptured, charsAdded, charsRemoved };
}

export interface RegexDebugStep extends RegexDebugResult {
  scriptName: string;
}

export interface RegexDebugRun {
  steps: RegexDebugStep[];
  /** the text after the last rule */
  output: string;
  charsCaptured: number;
  charsAdded: number;
  charsRemoved: number;
}

/** Run the checked rules in order, each over the previous rule's output (ST debugger "Run"). */
export function debugRegexChain(
  scripts: ReadonlyArray<DebugScript & Pick<RegexScript, 'scriptName'>>,
  text: string,
): RegexDebugRun {
  const run: RegexDebugRun = {
    steps: [],
    output: text,
    charsCaptured: 0,
    charsAdded: 0,
    charsRemoved: 0,
  };
  for (const script of scripts) {
    const step = debugRegexScript(script, run.output);
    run.steps.push({ ...step, scriptName: script.scriptName ?? '' });
    run.output = step.output;
    run.charsCaptured += step.charsCaptured;
    run.charsAdded += step.charsAdded;
    run.charsRemoved += step.charsRemoved;
  }
  return run;
}
