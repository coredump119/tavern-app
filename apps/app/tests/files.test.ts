// 文件选择器的扩展名过滤（DEV_NOTES §9.48）
import { describe, expect, it } from 'vitest';
import { pickerExtensions } from '../src/lib/files';

describe('pickerExtensions', () => {
  it('passes the list through off Android', () => {
    for (const platform of ['ios', 'macos', 'windows', 'linux', 'web'])
      expect(pickerExtensions(platform, ['json', 'jsonl'])).toEqual(['json', 'jsonl']);
  });

  it('keeps the filter on Android when every extension has a file type there', () => {
    expect(pickerExtensions('android', ['png', 'json'])).toEqual(['png', 'json']);
    expect(pickerExtensions('android', ['ZIP'])).toEqual(['ZIP']);
  });

  it('drops the filter on Android when one extension has no file type', () => {
    expect(pickerExtensions('android', ['json', 'jsonl'])).toBeNull();
    expect(pickerExtensions('android', ['zip', 'tmbackup'])).toBeNull();
    expect(pickerExtensions('android', ['png', 'mp4', 'txt'])).toBeNull();
  });

  it('returns a copy', () => {
    const list = ['json'];
    expect(pickerExtensions('ios', list)).not.toBe(list);
  });
});
