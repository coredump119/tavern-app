import { describe, expect, it } from 'vitest';
import { MAX_CRASHES_PER_EXTENSION, crashOwner, withCrash } from '../src/lib/ext/crash';

const BASE = 'tmext://localhost';
const NAMES = ['tm-sample', 'tm-sample-2'];

describe('crashOwner', () => {
  it('finds the extension by script address', () => {
    const where = `${BASE}/scripts/extensions/third-party/tm-sample/index.js`;
    expect(crashOwner(BASE, where, NAMES)).toBe('tm-sample');
  });

  it('does not mistake a longer folder name for a shorter one', () => {
    const where = `${BASE}/scripts/extensions/third-party/tm-sample-2/index.js`;
    expect(crashOwner(BASE, where, NAMES)).toBe('tm-sample-2');
  });

  it('takes the innermost frame of a stack', () => {
    const stack = [
      `run@${BASE}/scripts/extensions/third-party/tm-sample-2/a.js:1:20`,
      `emit@${BASE}/scripts/extensions/third-party/tm-sample/index.js:9:3`,
    ].join('\n');
    expect(crashOwner(BASE, stack, NAMES)).toBe('tm-sample-2');
  });

  it('reads an encoded address', () => {
    const where = `${BASE}/scripts/extensions/third-party/my%20ext/index.js`;
    expect(crashOwner(BASE, where, ['my ext'])).toBe('my ext');
  });

  it('leaves app code and empty input alone', () => {
    expect(crashOwner(BASE, 'http://localhost:1420/src/main.ts', NAMES)).toBeNull();
    expect(crashOwner(BASE, '', NAMES)).toBeNull();
  });
});

describe('withCrash', () => {
  it('skips repeats and caps each extension', () => {
    let list = withCrash([], { name: 'a', message: 'x' });
    expect(withCrash(list, { name: 'a', message: 'x' })).toBe(list);
    for (let i = 0; i < 10; i++) list = withCrash(list, { name: 'a', message: `m${i}` });
    expect(list).toHaveLength(MAX_CRASHES_PER_EXTENSION);
    expect(withCrash(list, { name: 'b', message: 'x' })).toHaveLength(
      MAX_CRASHES_PER_EXTENSION + 1,
    );
  });
});
