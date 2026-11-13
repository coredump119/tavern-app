// @vitest-environment jsdom
// 附件的 app 层胶水（DEV_NOTES §9.30）：显示 URL、extra.media / extra.files 形状、文件文本回填、内联门槛
import { describe, expect, it, vi } from 'vitest';

const written = new Map<string, string>();
vi.mock('../src/lib/ipc', () => ({
  isTauri: () => false,
  fileUrl: (p: string) => `asset://${p}`,
  mediaUpload: vi.fn(
    async (_root: string, ch: string, _src: string, name: string) => `/user/images/${ch}/1_${name}`,
  ),
  dataDelete: vi.fn(async () => undefined),
  fileReadText: vi.fn(async (path: string) =>
    path.endsWith('.bin.txt') ? 'PK\u0003\u0004' : `text of ${path}`,
  ),
  dataWriteText: vi.fn(async (_root: string, rel: string, text: string) => {
    written.set(rel, text);
  }),
  dataReadText: vi.fn(async (_root: string, rel: string) => {
    const v = written.get(rel);
    if (v === undefined) throw new Error('ENOENT');
    return v;
  }),
}));
vi.mock('../src/lib/files', () => ({
  pickFiles: vi.fn(async () => [
    '/tmp/pick/photo.PNG',
    '/tmp/pick/notes.txt',
    '/tmp/pick/clip.mp4',
    '/tmp/pick/app.exe',
  ]),
}));

import {
  inlineMediaDeps,
  mediaUrl,
  pickMedia,
  textAttachmentRel,
  textForAttachment,
  toAttachments,
  withFileTexts,
} from '../src/lib/chat/media';

describe('mediaUrl', () => {
  it('maps data-root relative urls (with or without ST leading slash) through the asset protocol', () => {
    expect(mediaUrl('/root', '/user/images/Sera/1.png')).toBe(
      'asset:///root/user/images/Sera/1.png',
    );
    expect(mediaUrl('/root', 'user/images/x.png')).toBe('asset:///root/user/images/x.png');
    expect(mediaUrl('/root', 'data:image/png;base64,AA')).toBe('data:image/png;base64,AA');
  });
});

describe('pickMedia / toAttachments', () => {
  it('stores media under user/images and text under user/files, skipping unknown types', async () => {
    const pending = await pickMedia('/root', 'Sera');
    expect(pending.map((p) => p.type)).toEqual(['image', 'file', 'video']);
    const file = pending[1]!;
    expect(file.url).toMatch(/^\/user\/files\/\d+_\d+\.txt$/);
    expect(written.get(file.url.slice(1))).toBe('text of /tmp/pick/notes.txt');
    const { media, files } = toAttachments(pending);
    expect(media.map((m) => m.type)).toEqual(['image', 'video']);
    expect(media[0]).toEqual({
      url: '/user/images/Sera/1_photo.PNG',
      type: 'image',
      title: 'photo.PNG',
      source: 'upload',
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ url: file.url, name: 'notes.txt', size: 27 });
  });
  it('text conversions follow ST: markdown cleaned, html reduced to body text', () => {
    expect(textForAttachment('a.md', 'x\r\n\n\n\n\ny')).toBe('x\n\n\n\ny');
    expect(
      textForAttachment(
        'a.html',
        '<html><body><h1>T</h1><script>bad()</script><p> body </p></body></html>',
      ),
    ).toBe('T\nbody');
    expect(textAttachmentRel('notes.txt', 42)).toMatch(/^user\/files\/42_\d+\.txt$/);
  });
});

describe('withFileTexts', () => {
  it('fills file.text from disk without touching the original chat', async () => {
    written.set('user/files/9_1.txt', 'DATA');
    const chat = [
      {
        name: 'Yun',
        mes: 'q',
        extra: {
          files: [{ url: '/user/files/9_1.txt', name: 'n' }, { url: '/user/files/missing.txt' }],
        },
      },
      { name: 'S', mes: 'a' },
    ];
    const out = await withFileTexts('/root', chat);
    const files = (out[0]!.extra as { files: { text?: string }[] }).files;
    expect(files).toHaveLength(2);
    expect(files[0]?.text).toBe('DATA');
    expect(files[1]?.text).toBeUndefined();
    expect((chat[0]!.extra!.files[0]! as { text?: string }).text).toBeUndefined();
    expect(out[1]).toBe(chat[1]);
  });
});

describe('inlineMediaDeps', () => {
  const base = { main_api: 'openai' };
  it('is undefined unless ST would inline something for this source / model', () => {
    expect(
      inlineMediaDeps(
        '/root',
        {
          ...base,
          oai_settings: {
            media_inlining: false,
            chat_completion_source: 'openai',
            openai_model: 'gpt-4o',
          },
        },
        null,
      ),
    ).toBeUndefined();
    expect(
      inlineMediaDeps(
        '/root',
        {
          ...base,
          oai_settings: {
            media_inlining: true,
            chat_completion_source: 'openai',
            openai_model: 'gpt-3.5-turbo',
          },
        },
        null,
      ),
    ).toBeUndefined();
  });
  it('sets per-kind flags', () => {
    const img = inlineMediaDeps(
      '/root',
      {
        ...base,
        oai_settings: {
          media_inlining: true,
          chat_completion_source: 'openai',
          openai_model: 'gpt-4o',
          inline_image_quality: 'low',
        },
      },
      null,
    )!;
    expect([img.quality, img.image, img.video, img.audio]).toEqual(['low', true, false, false]);
    const gem = inlineMediaDeps(
      '/root',
      {
        ...base,
        oai_settings: {
          media_inlining: true,
          chat_completion_source: 'makersuite',
          google_model: 'gemini-2.5-flash',
        },
      },
      null,
    )!;
    expect([gem.image, gem.video, gem.audio]).toEqual([true, true, true]);
  });
});
