/** Page side of the crash log (DEV_NOTES §9.38): what gets reported, how often, and the text view. */
import { describe, expect, it } from 'vitest';
import {
  crashGate,
  crashLogFileName,
  describeError,
  formatCrashLog,
  installCrashCapture,
} from '../src/lib/crashlog';
import { backupFileName, backupPasswordProblem } from '../src/lib/backup-rules';

describe('describeError', () => {
  it('keeps name, message and stack of an Error', () => {
    const e = new TypeError('x is not a function');
    const r = describeError('js', e, 'app.js:1:2');
    expect(r).toMatchObject({ kind: 'js', message: 'TypeError: x is not a function' });
    expect(r.source).toBe('app.js:1:2');
    expect(r.stack).toBe(e.stack);
  });

  it('describes non-Error reasons without throwing', () => {
    expect(describeError('promise', 'plain text').message).toBe('plain text');
    expect(describeError('promise', { code: 3 }).message).toBe('{"code":3}');
    expect(describeError('promise', undefined).message).toBe('undefined');
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(describeError('promise', loop).message).toBe('[object Object]');
  });
});

describe('crashGate', () => {
  const report = (message: string) => describeError('js', message);

  it('drops a report that repeats the one before it', () => {
    const pass = crashGate();
    expect([report('a'), report('a'), report('b'), report('a')].map(pass)).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });

  it('stops at the session cap', () => {
    const pass = crashGate(3);
    const passed = Array.from({ length: 10 }, (_, i) => pass(report(`e${i}`)));
    expect(passed.filter(Boolean)).toHaveLength(3);
  });
});

describe('installCrashCapture', () => {
  it('reports uncaught errors and unhandled rejections, and survives a failing log', async () => {
    const target = new EventTarget();
    const seen: string[][] = [];
    installCrashCapture(
      (...args) => {
        seen.push(args);
        return Promise.reject(new Error('disk full'));
      },
      target as unknown as Window,
    );

    const error = Object.assign(new Event('error'), {
      error: new RangeError('too deep'),
      message: 'ignored',
      filename: 'tauri://localhost/app.js',
      lineno: 7,
      colno: 9,
    });
    target.dispatchEvent(error);
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'nope' }));
    await Promise.resolve();

    expect(seen).toHaveLength(2);
    expect(seen[0]!.slice(0, 3)).toEqual([
      'js',
      'RangeError: too deep',
      'tauri://localhost/app.js:7:9',
    ]);
    expect(seen[1]).toEqual(['promise', 'nope', '', '']);
  });
});

describe('formatCrashLog', () => {
  it('lists the newest entry first and indents the details', () => {
    const text = formatCrashLog([
      { t: new Date(2026, 10, 12, 9, 5, 3).getTime(), kind: 'js', message: 'first' },
      {
        t: new Date(2026, 10, 12, 21, 40, 0).getTime(),
        kind: 'rust',
        message: 'second',
        source: 'src/lib.rs:10',
        stack: 'frame a\nframe b',
      },
    ]);
    expect(text).toBe(
      '[2026-11-12 21:40:00] 内核　second\n  src/lib.rs:10\n  frame a\n  frame b\n\n' +
        '[2026-11-12 09:05:03] 页面错误　first',
    );
    expect(formatCrashLog([])).toBe('');
  });

  it('names the export after the minute it was made', () => {
    expect(crashLogFileName(new Date(2026, 0, 2, 3, 4))).toBe('tavern-crash-20260102-0304.txt');
  });
});

describe('sealed backup naming and password rule', () => {
  it('uses .tmbackup for a sealed backup', () => {
    const at = new Date(2026, 10, 12, 8, 30);
    expect(backupFileName(at)).toBe('tavern-backup-20261112-0830.zip');
    expect(backupFileName(at, true)).toBe('tavern-backup-20261112-0830.tmbackup');
  });

  it('wants 8 characters and a matching repeat', () => {
    expect(backupPasswordProblem('short', 'short')).toMatch(/至少 8/);
    expect(backupPasswordProblem('long enough', 'long enoug')).toMatch(/不一样/);
    expect(backupPasswordProblem('long enough', 'long enough')).toBeNull();
    // counted in characters, not UTF-16 units
    expect(backupPasswordProblem('密码密码密码密码', '密码密码密码密码')).toBeNull();
  });
});
