import { describe, expect, it } from 'vitest';
import {
  applyScriptEdit,
  editScript,
  findScript,
  newScript,
  normalizeScriptTrees,
  scriptExport,
  scriptExportFileName,
  type Script,
  type ScriptFolder,
  type ScriptTree,
} from '../src/scripts.js';

const script = (id: string, over: Partial<Script> = {}): Script => ({
  type: 'script',
  enabled: true,
  name: id,
  id,
  content: `console.log('${id}')`,
  info: '',
  button: { enabled: true, buttons: [] },
  data: {},
  ...over,
});

const folder = (id: string, scripts: Script[]): ScriptFolder => ({
  type: 'folder',
  enabled: true,
  name: id,
  id,
  icon: '',
  color: '',
  scripts,
});

describe('script editor helpers', () => {
  const trees: ScriptTree[] = [script('a'), folder('f', [script('b'), script('c')]), script('d')];

  it('finds a script at the top level and inside a folder, never the folder itself', () => {
    expect(findScript(trees, 'a')?.id).toBe('a');
    expect(findScript(trees, 'c')?.id).toBe('c');
    expect(findScript(trees, 'f')).toBeUndefined();
    expect(findScript(trees, 'zz')).toBeUndefined();
  });

  it('a new script is empty and switched off', () => {
    const fresh = newScript('n1');
    expect(fresh).toMatchObject({ type: 'script', id: 'n1', enabled: false, content: '' });
    expect(fresh.name).not.toBe('');
    expect(normalizeScriptTrees(fresh, () => 'unused')).toEqual([fresh]);
  });

  it('edits a script inside a folder and leaves the rest untouched', () => {
    const next = editScript(trees, 'c', { name: ' C2 ', content: 'let x = 1', info: 'note' });
    expect(next).not.toBe(trees);
    expect(next[0]).toBe(trees[0]);
    expect(next[2]).toBe(trees[2]);
    const edited = findScript(next, 'c');
    expect(edited).toMatchObject({ id: 'c', name: 'C2', content: 'let x = 1', info: 'note' });
    expect(edited?.enabled).toBe(true);
    expect((next[1] as ScriptFolder).scripts[0]).toBe((trees[1] as ScriptFolder).scripts[0]);
    // the input is not mutated
    expect(findScript(trees, 'c')?.name).toBe('c');
  });

  it('returns the same array when the script is gone', () => {
    expect(editScript(trees, 'zz', { name: 'x' })).toBe(trees);
    // a folder id is not a script
    expect(editScript(trees, 'f', { name: 'x' })).toBe(trees);
  });

  it('keeps what the edit does not mention: switch, data, unknown fields', () => {
    const before = script('a', { enabled: true, data: { k: 1 }, extra: 'kept' });
    const after = applyScriptEdit(before, { content: 'new' });
    expect(after).toEqual({ ...before, content: 'new' });
    expect(after.data).toBe(before.data);
  });

  it('a blank name keeps the old one', () => {
    expect(applyScriptEdit(script('a'), { name: '   ' }).name).toBe('a');
    expect(applyScriptEdit(script('a'), { name: '' }).name).toBe('a');
  });

  it('replaces the buttons, dropping nameless ones, and keeps unknown button fields', () => {
    const before = script('a', {
      button: { enabled: true, buttons: [{ name: 'old', visible: true }], pinned: 1 } as never,
    });
    const after = applyScriptEdit(before, {
      button: {
        enabled: false,
        buttons: [
          { name: 'go', visible: false },
          { name: '', visible: true },
        ],
      },
    });
    expect(after.button).toEqual({
      enabled: false,
      buttons: [{ name: 'go', visible: false }],
      pinned: 1,
    });
    expect(before.button.buttons).toEqual([{ name: 'old', visible: true }]);
  });
});

describe('single script export', () => {
  const source = script('a', {
    name: '面板',
    info: 'what it does',
    button: { enabled: true, buttons: [{ name: 'go', visible: true }] },
    data: { token: 'user typed this' },
    extra: 1,
  });

  it('round-trips through the import normaliser', () => {
    const file: unknown = JSON.parse(JSON.stringify(scriptExport(source)));
    expect(normalizeScriptTrees(file, () => 'unused')).toEqual([source]);
  });

  it('can leave the script storage out without touching the stored script', () => {
    const out = scriptExport(source, false);
    expect(out.data).toEqual({});
    expect(out).toMatchObject({ id: 'a', name: '面板', content: source.content, extra: 1 });
    expect(source.data).toEqual({ token: 'user typed this' });
  });

  it('names the file after the script, without path characters', () => {
    expect(scriptExportFileName({ name: '面板' })).toBe('面板.json');
    expect(scriptExportFileName({ name: 'a/b:c*?"<>|\\d' })).toBe('a-b-c-d.json');
    expect(scriptExportFileName({ name: '  ' })).toBe('script.json');
  });
});
