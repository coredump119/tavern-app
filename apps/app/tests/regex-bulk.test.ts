import { describe, expect, it, vi } from 'vitest';
import type { RegexScript } from '@tm/core';

vi.mock('../src/lib/ipc', () => ({}));
const { allRegexBulkKeys, applyRegexBulk, pickedRegexScripts, regexBulkExportFileName } =
  await import('../src/lib/regex-bulk');

const script = (id: string, disabled = false) => ({ id, scriptName: id, disabled }) as RegexScript;
const lists = () => ({
  global: [script('g1'), script('g2', true)],
  preset: [script('p1')],
  scoped: [script('s1'), script('s2')],
});
const ids = (list: RegexScript[] | undefined) => list?.map((s) => s.id);

describe('regex bulk operations', () => {
  it('lists keys and picked scripts in list order', () => {
    expect(allRegexBulkKeys(lists())).toEqual([
      'global:g1',
      'global:g2',
      'preset:p1',
      'scoped:s1',
      'scoped:s2',
    ]);
    const picked = new Set(['scoped:s2', 'global:g2', 'preset:nope']);
    expect(ids(pickedRegexScripts(lists(), picked))).toEqual(['g2', 's2']);
  });

  it('enables / disables only the picked scripts and skips unchanged lists', () => {
    const picked = new Set(['global:g1', 'global:g2', 'preset:p1']);
    const off = applyRegexBulk(lists(), picked, { kind: 'disable' });
    expect(Object.keys(off).sort()).toEqual(['global', 'preset']);
    expect(off.global?.map((s) => s.disabled)).toEqual([true, true]);
    const on = applyRegexBulk(lists(), picked, { kind: 'enable' });
    expect(Object.keys(on)).toEqual(['global']);
    expect(on.global?.map((s) => s.disabled)).toEqual([false, false]);
  });

  it('deletes the picked scripts', () => {
    const out = applyRegexBulk(lists(), new Set(['scoped:s1', 'global:g2']), { kind: 'delete' });
    expect(ids(out.global)).toEqual(['g1']);
    expect(ids(out.scoped)).toEqual(['s2']);
    expect(out.preset).toBeUndefined();
  });

  it('moves to another list by appending; scripts already there stay put', () => {
    const picked = new Set(['global:g1', 'scoped:s2', 'preset:p1']);
    const out = applyRegexBulk(lists(), picked, { kind: 'move', to: 'preset' });
    expect(ids(out.global)).toEqual(['g2']);
    expect(ids(out.scoped)).toEqual(['s1']);
    expect(ids(out.preset)).toEqual(['p1', 'g1', 's2']);
    expect(applyRegexBulk(lists(), new Set(['preset:p1']), { kind: 'move', to: 'preset' })).toEqual(
      {},
    );
  });

  it('names the export file like ST', () => {
    expect(regexBulkExportFileName(new Date('2026-11-12T03:04:05.000Z'))).toBe(
      'regex-2026-11-12T03-04-05.000Z.json',
    );
  });
});
