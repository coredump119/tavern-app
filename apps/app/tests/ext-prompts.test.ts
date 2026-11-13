import { describe, expect, it } from 'vitest';
import { activePrompts } from '../src/lib/ext/prompts';

const gate = (): boolean => true;
/** what ST's `setExtensionPrompt` leaves in `extension_prompts` */
const stored = {
  note: { value: 'remember the lamp', position: 1, depth: 2, scan: true, role: 0, filter: null },
  gated: { value: 'only sometimes', position: 0, depth: '3', role: '1', filter: gate },
  empty: { value: '', position: 1, depth: 0, scan: false, role: 0, filter: null },
  broken: { value: 'x', position: 'top', depth: 0 },
  nothing: null,
};

describe('extension prompts into a generation (DEV_NOTES §9.34)', () => {
  it('keeps only prompts ST would inject', () => {
    const active = activePrompts(stored);
    expect(Object.keys(active)).toEqual(['note', 'gated']);
    expect(active['note']).toEqual({
      value: 'remember the lamp',
      position: 1,
      depth: 2,
      scan: true,
      role: 0,
      filter: null,
    });
  });

  it('normalises loose fields and keeps the filter function', () => {
    const { gated } = activePrompts(stored);
    expect(gated).toMatchObject({ depth: 3, role: 1, scan: false });
    expect(gated?.filter).toBe(gate);
  });
});
