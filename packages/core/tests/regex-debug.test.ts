import { describe, expect, it } from 'vitest';
import { debugRegexChain, debugRegexScript } from '../src/regex/debug.js';

describe('regex debugger (ST executeRegexScriptForDebugging)', () => {
  it('replaces every match and counts captured / added / removed', () => {
    const r = debugRegexScript(
      { findRegex: '/(\\w+)@(\\w+)/', replaceString: '<$2:$1>' },
      'a@b c@d',
    );
    expect(r.output).toBe('<b:a> <d:c>');
    expect(r.error).toBeNull();
    // two matches of 3 chars; literals `<`, `:`, `>` per match; the `@` of each match is gone
    expect([r.charsCaptured, r.charsAdded, r.charsRemoved]).toEqual([6, 6, 2]);
    expect(r.segments).toEqual([
      { kind: 'removed', text: 'a@b' },
      { kind: 'text', text: ' → ' },
      { kind: 'added', text: '<' },
      { kind: 'kept', text: 'b' },
      { kind: 'added', text: ':' },
      { kind: 'kept', text: 'a' },
      { kind: 'added', text: '>' },
      { kind: 'text', text: ' ' },
      { kind: 'removed', text: 'c@d' },
      { kind: 'text', text: ' → ' },
      { kind: 'added', text: '<' },
      { kind: 'kept', text: 'd' },
      { kind: 'added', text: ':' },
      { kind: 'kept', text: 'c' },
      { kind: 'added', text: '>' },
    ]);
  });

  it('handles $$, $&, the text around the match and unknown groups', () => {
    expect(debugRegexScript({ findRegex: 'b', replaceString: '$$[$&]' }, 'abc').output).toBe(
      'a$[b]c',
    );
    const around = debugRegexScript({ findRegex: 'b', replaceString: "$`|$'" }, 'abc');
    expect(around.output).toBe('aa|cc');
    expect([around.charsAdded, around.charsRemoved]).toEqual([1, -1]);
    // $3 is not a group of the pattern: nothing in the output, shown as a literal in the diff
    const unknown = debugRegexScript({ findRegex: '(b)', replaceString: '$3x' }, 'abc');
    expect(unknown.output).toBe('axc');
    expect(unknown.segments.filter((s) => s.kind === 'added')).toEqual([
      { kind: 'added', text: '$3x' },
    ]);
  });

  it('leaves the text alone without a match or with a bad pattern', () => {
    const none = debugRegexScript({ findRegex: 'z', replaceString: 'y' }, 'abc');
    expect(none).toMatchObject({ output: 'abc', error: null, charsCaptured: 0 });
    const bad = debugRegexScript({ findRegex: '/(/', replaceString: '' }, 'abc');
    expect(bad.output).toBe('abc');
    expect(bad.error).toMatch(/^Compile error: /);
    expect(debugRegexScript({ replaceString: '' }, 'abc').error).toMatch(/^Compile error: /);
  });

  it('chains rules in order and sums the totals', () => {
    const run = debugRegexChain(
      [
        { scriptName: 'one', findRegex: 'a', replaceString: 'bb' },
        { scriptName: 'two', findRegex: '/B/i', replaceString: '' },
      ],
      'aXa',
    );
    expect(run.steps.map((s) => [s.scriptName, s.output])).toEqual([
      ['one', 'bbXbb'],
      ['two', 'X'],
    ]);
    expect(run.output).toBe('X');
    expect([run.charsCaptured, run.charsAdded, run.charsRemoved]).toEqual([6, 4, 6]);
  });
});
