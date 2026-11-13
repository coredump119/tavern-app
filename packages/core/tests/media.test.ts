// 消息媒体：旧字段迁移、显示模式、内联支持与图片 token（DEV_NOTES §9.30）
import { describe, expect, it } from 'vitest';
import {
  CHAT_COMPLETION_SOURCES as S,
  MEDIA_DISPLAY,
  ensureMessageMediaIsArray,
  getMediaDisplay,
  getMediaIndex,
  appendFileContent,
  embedOpenRouterMedia,
  humanFileSize,
  imageTokenCost,
  isAudioInliningSupported,
  isImageInliningSupported,
  isVideoInliningSupported,
  looksBinary,
  postProcessText,
  prepareCoreChat,
  mediaTypeFromMime,
  mediaTypeFromName,
} from '../src/index.js';
import { createTestState } from './helpers.js';

describe('ensureMessageMediaIsArray', () => {
  it('migrates extra.image into media', () => {
    const extra: Record<string, unknown> = { image: 'a.png', inline_image: true };
    expect(ensureMessageMediaIsArray(extra)).toBe(true);
    expect(extra).toEqual({ inline_image: true, media: [{ type: 'image', url: 'a.png' }] });
  });
  it('migrates image_swipes to a gallery and selects extra.image', () => {
    const extra: Record<string, unknown> = { image_swipes: ['a.png', 'b.png'], image: 'b.png' };
    ensureMessageMediaIsArray(extra);
    expect(extra['media_display']).toBe(MEDIA_DISPLAY.GALLERY);
    expect(extra['media']).toEqual([
      { type: 'image', url: 'a.png' },
      { type: 'image', url: 'b.png' },
    ]);
    expect(extra['media_index']).toBe(1);
    expect(extra).not.toHaveProperty('image');
    expect(extra).not.toHaveProperty('image_swipes');
  });
  it('migrates extra.file into files and leaves new-style messages alone', () => {
    const extra: Record<string, unknown> = { file: { url: 'f.txt', name: 'f' } };
    ensureMessageMediaIsArray(extra);
    expect(extra).toEqual({ files: [{ url: 'f.txt', name: 'f' }] });
    const fresh: Record<string, unknown> = { media: [{ url: 'x.png', type: 'image' }] };
    expect(ensureMessageMediaIsArray(fresh)).toBe(false);
  });
});

describe('display / index / types', () => {
  const mes = (extra: Record<string, unknown>) => ({ name: 'S', is_user: false, mes: '', extra });
  it('display falls back to the power_user default, then list', () => {
    expect(getMediaDisplay(mes({}))).toBe('list');
    expect(getMediaDisplay(mes({}), 'gallery')).toBe('gallery');
    expect(getMediaDisplay(mes({ media_display: 'gallery' }), 'list')).toBe('gallery');
    expect(getMediaDisplay(mes({ media_display: 'bogus' }))).toBe('list');
  });
  it('index is clamped to the media array', () => {
    const m = mes({ media: [{ url: 'a' }, { url: 'b' }], media_index: 1 });
    expect(getMediaIndex(m)).toBe(1);
    expect(getMediaIndex(mes({ media: [{ url: 'a' }], media_index: 5 }))).toBe(0);
    expect(getMediaIndex(mes({}))).toBe(0);
  });
  it('type detection by mime and by extension', () => {
    expect(mediaTypeFromMime('image/webp')).toBe('image');
    expect(mediaTypeFromMime('video/mp4')).toBe('video');
    expect(mediaTypeFromMime('text/plain')).toBeNull();
    expect(mediaTypeFromName('user/images/S/1.JPG')).toBe('image');
    expect(mediaTypeFromName('clip.webm?x=1')).toBe('video');
    expect(mediaTypeFromName('notes.txt')).toBeNull();
  });
});

describe('isImageInliningSupported (ST openai.js)', () => {
  it('needs chat completion + media_inlining + a vision model', () => {
    expect(
      isImageInliningSupported(
        { media_inlining: true, chat_completion_source: S.OPENAI, openai_model: 'gpt-4o' },
        null,
        'textgenerationwebui',
      ),
    ).toBe(false);
    expect(
      isImageInliningSupported({
        media_inlining: false,
        chat_completion_source: S.OPENAI,
        openai_model: 'gpt-4o',
      }),
    ).toBe(false);
    expect(
      isImageInliningSupported({
        media_inlining: true,
        chat_completion_source: S.OPENAI,
        openai_model: 'gpt-4o-mini',
      }),
    ).toBe(true);
    expect(
      isImageInliningSupported({
        media_inlining: true,
        chat_completion_source: S.OPENAI,
        openai_model: 'gpt-3.5-turbo',
      }),
    ).toBe(false);
    expect(
      isImageInliningSupported({
        media_inlining: true,
        chat_completion_source: S.CLAUDE,
        claude_model: 'claude-sonnet-4-5',
      }),
    ).toBe(true);
    expect(
      isImageInliningSupported({
        media_inlining: true,
        chat_completion_source: S.MAKERSUITE,
        google_model: 'gemini-2.5-flash',
      }),
    ).toBe(true);
    expect(
      isImageInliningSupported({ media_inlining: true, chat_completion_source: S.CUSTOM }),
    ).toBe(true);
  });
  it('list-driven sources read the model list and fail closed without it', () => {
    const s = {
      media_inlining: true,
      chat_completion_source: S.OPENROUTER,
      openrouter_model: 'x/y',
    };
    expect(isImageInliningSupported(s, null)).toBe(false);
    expect(
      isImageInliningSupported(s, [
        { id: 'x/y', architecture: { input_modalities: ['text', 'image'] } },
      ]),
    ).toBe(true);
    expect(
      isImageInliningSupported(s, [{ id: 'x/y', architecture: { input_modalities: ['text'] } }]),
    ).toBe(false);
    const m = {
      media_inlining: true,
      chat_completion_source: S.MISTRALAI,
      mistralai_model: 'pixtral-large',
    };
    expect(
      isImageInliningSupported(m, [{ id: 'pixtral-large', capabilities: { vision: true } }]),
    ).toBe(true);
  });
});

describe('imageTokenCost', () => {
  it('follows OpenAI tile pricing; low and small-auto cost 85', () => {
    expect(imageTokenCost(4000, 3000, 'low')).toBe(85);
    expect(imageTokenCost(400, 300, 'auto')).toBe(85);
    expect(imageTokenCost(1024, 1024, 'auto')).toBe(4 * 170 + 85); // 768×768 → 2×2 tiles
    expect(imageTokenCost(2048, 4096, 'high')).toBe(2 * 3 * 170 + 85); // 768×1536 → 2×3
    expect(imageTokenCost(0, 0, 'high')).toBe(85);
  });
});

describe('video / audio support (ST openai.js)', () => {
  it('video: Gemini / Vertex / Z.AI by name, OpenRouter by modalities', () => {
    expect(
      isVideoInliningSupported({
        media_inlining: true,
        chat_completion_source: S.MAKERSUITE,
        google_model: 'gemini-2.5-pro',
      }),
    ).toBe(true);
    expect(
      isVideoInliningSupported({
        media_inlining: true,
        chat_completion_source: S.OPENAI,
        openai_model: 'gpt-4o',
      }),
    ).toBe(false);
    const or = {
      media_inlining: true,
      chat_completion_source: S.OPENROUTER,
      openrouter_model: 'm',
    };
    expect(
      isVideoInliningSupported(or, [{ id: 'm', architecture: { input_modalities: ['video'] } }]),
    ).toBe(true);
    expect(isVideoInliningSupported(or, null)).toBe(false);
  });
  it('audio: OpenAI audio models, Gemini, Custom always', () => {
    expect(
      isAudioInliningSupported({
        media_inlining: true,
        chat_completion_source: S.OPENAI,
        openai_model: 'gpt-4o-audio-preview',
      }),
    ).toBe(true);
    expect(
      isAudioInliningSupported({
        media_inlining: true,
        chat_completion_source: S.OPENAI,
        openai_model: 'gpt-4o',
      }),
    ).toBe(false);
    expect(
      isAudioInliningSupported({ media_inlining: true, chat_completion_source: S.CUSTOM }),
    ).toBe(true);
    expect(
      isAudioInliningSupported({ media_inlining: false, chat_completion_source: S.CUSTOM }),
    ).toBe(false);
  });
  it('embedOpenRouterMedia turns audio_url into input_audio and leaves http urls', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'x' },
          { type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,QUJD' } },
          { type: 'audio_url', audio_url: { url: 'https://example.com/a.mp3' } },
        ],
      },
    ];
    embedOpenRouterMedia(messages, { audio: true, video: false });
    expect(messages[0]!.content[1]).toEqual({
      type: 'input_audio',
      input_audio: { format: 'wav', data: 'QUJD' },
    });
    expect(messages[0]!.content[2]).toEqual({
      type: 'audio_url',
      audio_url: { url: 'https://example.com/a.mp3' },
    });
  });
});

describe('text attachments (ST Data Bank)', () => {
  it('appendFileContent prepends every file text, blank-line separated', () => {
    expect(appendFileContent({ files: [{ text: 'A' }, { text: 'B' }] }, 'msg')).toBe(
      'A\n\nB\n\nmsg',
    );
    expect(appendFileContent({}, 'msg')).toBe('msg');
    // ST quirk: files without loaded text still add the separator
    expect(appendFileContent({ files: [{ url: 'x' }] }, 'msg')).toBe('\n\nmsg');
  });
  it('prepareCoreChat applies it after regex for every generation type', () => {
    const state = createTestState({
      chat: [{ name: 'Yun', is_user: true, mes: 'hello', extra: { files: [{ text: 'FILE' }] } }],
    });
    const out = prepareCoreChat(state, {
      type: 'normal',
      applyRegex: (t) => t.toUpperCase(),
      substitute: (t) => t,
    });
    expect(out[0]!.mes).toBe('FILE\n\nHELLO');
  });
  it('helpers: postProcessText, binary sniff, human file size', () => {
    expect(postProcessText('a\r\n\n\n\n\nb\t  c\n   \n', false)).toBe('a\n\n\n\nb c');
    expect(postProcessText('  a  \n\n b ')).toBe('a\nb');
    expect(looksBinary('plain text\nok')).toBe(false);
    expect(looksBinary('PK\u0003\u0004zip')).toBe(true);
    expect(humanFileSize(512)).toBe('512 B');
    expect(humanFileSize(1536)).toBe('1.5 KiB');
  });
});
