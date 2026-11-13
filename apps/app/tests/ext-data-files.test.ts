import { describe, expect, it } from 'vitest';
import { dataFilePath, localFileAddress } from '../src/lib/ext/data-files';

describe('files ST serves out of the data folder (DEV_NOTES §9.34 第 12 轮)', () => {
  it('maps the served folders onto the data root', () => {
    expect(dataFilePath('/user/images/box/a.png')).toEqual({ rel: 'user/images/box/a.png' });
    expect(dataFilePath('/user/files/note.txt')).toEqual({ rel: 'user/files/note.txt' });
    expect(dataFilePath('/characters/Sera.png')).toEqual({ rel: 'characters/Sera.png' });
    expect(dataFilePath('/backgrounds/sky.jpg')).toEqual({ rel: 'backgrounds/sky.jpg' });
    expect(dataFilePath('/User%20Avatars/me.png')).toEqual({ rel: 'User Avatars/me.png' });
    expect(dataFilePath('/user/images/%E7%9B%92/a%20b.png')).toEqual({
      rel: 'user/images/盒/a b.png',
    });
  });

  it('leaves everything else alone', () => {
    for (const path of [
      '/settings.json',
      '/secrets.json',
      '/chats/Sera/chat.jsonl',
      '/user/imagesX/a.png',
      '/user/images',
      '/api/images/list',
      '/scripts/extensions/third-party/x/index.js',
      '/user/images/%E0%A4%A',
    ])
      expect(dataFilePath(path), path).toBeNull();
  });

  it('refuses a path that leaves its folder', () => {
    for (const path of [
      '/user/images/../settings.json',
      '/user/images/box/%2e%2e/%2e%2e/settings.json',
      '/user/images/box%2F..%2F..%2Fsecrets.json',
      '/characters/..%5Csecrets.json',
    ])
      expect(dataFilePath(path), path).toBe('forbidden');
  });
});

describe('same-origin paths written into the DOM (DEV_NOTES §9.34 第 12 轮)', () => {
  const page = 'http://localhost:1420/#/chat';
  const sources = {
    origin: 'http://localhost:1420',
    extensionBase: 'tmext://localhost',
    dataFileUrl: (rel: string) => `asset://localhost/root/${rel}`,
  };
  const address = (raw: string) => localFileAddress(raw, page, sources);

  it('points extension files at the extension origin', () => {
    expect(address('/scripts/extensions/third-party/tm-sample/a.png?v=2')).toBe(
      'tmext://localhost/scripts/extensions/third-party/tm-sample/a.png?v=2',
    );
    expect(address('scripts/extensions/third-party/tm-sample/a.png')).toBe(
      'tmext://localhost/scripts/extensions/third-party/tm-sample/a.png',
    );
    expect(address('http://localhost:1420/scripts/extensions/third-party/tm-sample/a.css')).toBe(
      'tmext://localhost/scripts/extensions/third-party/tm-sample/a.css',
    );
  });

  it('points served data files at the data root', () => {
    expect(address('/user/images/box/a%20b.png')).toBe(
      'asset://localhost/root/user/images/box/a b.png',
    );
    expect(
      localFileAddress('/user/images/a.png', page, { ...sources, dataFileUrl: () => null }),
    ).toBeNull();
  });

  it('leaves every other address alone', () => {
    for (const raw of [
      '',
      'data:image/png;base64,AAAA',
      'blob:http://localhost:1420/1234',
      'asset://localhost/root/characters/Sera.png',
      'https://example.com/user/images/a.png',
      '/assets/index.css',
      '/user/images/../../secrets.json',
      '/user/images/a/..%2F..%2Fsettings.json',
    ])
      expect(address(raw), raw).toBeNull();
  });
});
