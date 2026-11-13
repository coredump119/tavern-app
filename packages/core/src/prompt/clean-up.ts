/**
 * ST script.js `cleanUpMessage` (DEV_NOTES §9.19): the post-processing every generated reply goes
 * through before it is shown / saved. Host state is injected; group cleanup is not ported yet.
 */
import { fixMarkdown } from '../render/fix-markdown.js';
import { escapeRegex } from '../util/regex.js';
import { collapseNewlines } from './character-fields.js';

export interface MessageCleanerDeps {
  name1: string;
  name2: string;
  isInstruct: boolean;
  powerUser: {
    user_prompt_bias?: string | undefined;
    collapse_newlines?: boolean | undefined;
    allow_name1_display?: boolean | undefined;
    allow_name2_display?: boolean | undefined;
    auto_fix_generated_markdown?: boolean | undefined;
    trim_sentences?: boolean | undefined;
    trim_spaces?: boolean | undefined;
    instruct?:
      | {
          stop_sequence?: string | undefined;
          input_sequence?: string | undefined;
          output_sequence?: string | undefined;
          last_output_sequence?: string | undefined;
          sequences_as_stop_strings?: boolean | undefined;
        }
      | undefined;
  };
  substitute: (text: string) => string;
  /** getRegexedString(text, isImpersonate ? USER_INPUT : AI_OUTPUT) */
  regex: (text: string, isImpersonate: boolean) => string;
  /** PromptReasoning.getLatestPrefix() — trim_spaces is skipped while a reasoning prefix is open */
  hasReasoningPrefix?: (() => boolean) | undefined;
}

export interface CleanUpOptions {
  isImpersonate?: boolean | undefined;
  isContinue?: boolean | undefined;
  displayIncompleteSentences?: boolean | undefined;
  stoppingStrings: readonly string[];
  includeUserPromptBias?: boolean | undefined;
  trimNames?: boolean | undefined;
  trimWrongNames?: boolean | undefined;
}

/** utils.js trimToEndSentence */
export function trimToEndSentence(input: string): string {
  if (!input) return '';
  const isEmoji = (x: string) => /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u.test(x);
  const punctuation = new Set([
    '.',
    '!',
    '?',
    '*',
    '"',
    ')',
    '}',
    '`',
    ']',
    '$',
    '。',
    '！',
    '？',
    '”',
    '）',
    '】',
    '’',
    '」',
    '_',
  ]);
  let last = -1;
  const chars = Array.from(input);
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i]!;
    const emoji = isEmoji(ch);
    if (punctuation.has(ch) || emoji) {
      last = !emoji && i > 0 && /[\s\n]/.test(chars[i - 1]!) ? i - 1 : i;
      break;
    }
  }
  if (last === -1) return input.trimEnd();
  return chars
    .slice(0, last + 1)
    .join('')
    .trimEnd();
}

export function createMessageCleaner(deps: MessageCleanerDeps) {
  return function cleanUpMessage(input: string, opts: CleanUpOptions): string {
    const pu = deps.powerUser;
    const isImpersonate = !!opts.isImpersonate;
    const isContinue = !!opts.isContinue;
    const includeBias = opts.includeUserPromptBias ?? true;
    const trimNames = opts.trimNames ?? true;
    const trimWrongNames = opts.trimWrongNames ?? true;
    let m = input;
    if (!m) return '';

    if (includeBias && pu.user_prompt_bias && !isImpersonate && !isContinue) {
      m = deps.substitute(pu.user_prompt_bias) + m;
    }

    for (const stop of opts.stoppingStrings) {
      if (!stop.length) continue;
      for (let j = stop.length; j > 0; j--) {
        if (m.slice(-j) === stop.slice(0, j)) {
          m = m.slice(0, -j);
          break;
        }
      }
    }

    m = deps.regex(m, isImpersonate);
    if (pu.collapse_newlines) m = collapseNewlines(m);
    m = m.replace(/[^\S\r\n]+$/gm, '');

    if (trimWrongNames) {
      const wrongName = isImpersonate
        ? !pu.allow_name2_display
          ? deps.name2
          : ''
        : !pu.allow_name1_display
          ? deps.name1
          : '';
      if (wrongName) {
        if (m.indexOf(`${wrongName}:`) === 0) m = '';
        const at = m.indexOf(`\n${wrongName}:`);
        if (at >= 0) m = m.substring(0, at);
      }
    }

    if (m.indexOf('<|endoftext|>') !== -1) m = m.substring(0, m.indexOf('<|endoftext|>'));
    const ins = pu.instruct ?? {};
    const notEmpty = (s: string | undefined): s is string => !!s && s.trim() !== '';
    if (deps.isInstruct && ins.stop_sequence && m.indexOf(ins.stop_sequence) !== -1) {
      m = m.substring(0, m.indexOf(ins.stop_sequence));
    }
    if (deps.isInstruct && notEmpty(ins.input_sequence) && m.indexOf(ins.input_sequence) !== -1) {
      m = m.substring(0, m.indexOf(ins.input_sequence));
    }
    if (deps.isInstruct && ins.sequences_as_stop_strings) {
      const seqs = [
        { value: ins.input_sequence, apply: isImpersonate && notEmpty(ins.input_sequence) },
        { value: ins.output_sequence, apply: !isImpersonate && notEmpty(ins.output_sequence) },
        {
          value: ins.last_output_sequence,
          apply: !isImpersonate && notEmpty(ins.last_output_sequence),
        },
      ];
      for (const seq of seqs.filter((x) => x.apply)) {
        for (const line of String(seq.value)
          .split('\n')
          .filter((l) => l.trim() !== '')) {
          m = m.replaceAll(line, '');
        }
      }
    }

    if (!pu.allow_name2_display) {
      m = m.replace(new RegExp(`(^|\n)${escapeRegex(deps.name2)}:\\s*`, 'g'), '$1');
    }
    if (isImpersonate) m = m.trim();
    if (pu.auto_fix_generated_markdown) m = fixMarkdown(m, false);

    if (trimNames) {
      const nameToTrim = isImpersonate
        ? !pu.allow_name1_display
          ? deps.name1
          : ''
        : !pu.allow_name2_display
          ? deps.name2
          : '';
      if (nameToTrim && m.startsWith(`${nameToTrim}:`)) {
        m = m.replace(`${nameToTrim}:`, '').trimStart();
      }
    }
    if (isImpersonate) m = m.trim();
    if (!opts.displayIncompleteSentences && pu.trim_sentences) m = trimToEndSentence(m);
    if (pu.trim_spaces && !deps.hasReasoningPrefix?.()) m = m.trim();
    return m;
  };
}
