import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_NONE,
  BG_METADATA_KEY,
  activeBackgroundRel,
  backgroundRelOf,
  backgroundSettingsOf,
  backgroundUrlParam,
  isBackgroundImage,
  setBackgroundFitting,
  setGlobalBackground,
} from '../src/index.js';

describe('chat backgrounds (ST backgrounds.js data)', () => {
  it('stores the url the way ST does and reads it back', () => {
    const url = backgroundUrlParam('night sky #2.jpg');
    expect(url).toBe('url("backgrounds/night%20sky%20%232.jpg")');
    expect(backgroundRelOf(url)).toBe('backgrounds/night sky #2.jpg');
  });

  it('treats the transparent entry, foreign urls and path escapes as no background', () => {
    expect(backgroundRelOf(backgroundUrlParam(BACKGROUND_NONE))).toBeNull();
    expect(backgroundRelOf('url("https://example.test/a.png")')).toBeNull();
    expect(backgroundRelOf('url("backgrounds/../settings.json")')).toBeNull();
    expect(backgroundRelOf('url("backgrounds/%E0%A4%A.png")')).toBeNull();
    expect(backgroundRelOf(undefined)).toBeNull();
    expect(backgroundRelOf("url('/user/images/Sera/1.png')")).toBe('user/images/Sera/1.png');
  });

  it('fills ST defaults and keeps unknown keys when choosing a background', () => {
    expect(backgroundSettingsOf(null)).toEqual({
      name: BACKGROUND_NONE,
      url: backgroundUrlParam(BACKGROUND_NONE),
      fitting: 'classic',
    });
    const settings: Record<string, unknown> = { background: { animation: true, fitting: 'cover' } };
    setGlobalBackground(settings, 'a.png');
    expect(settings['background']).toEqual({
      animation: true,
      fitting: 'cover',
      name: 'a.png',
      url: 'url("backgrounds/a.png")',
    });
    setBackgroundFitting(settings, 'contain');
    expect(backgroundSettingsOf(settings)).toMatchObject({ name: 'a.png', fitting: 'contain' });
    expect((settings['background'] as Record<string, unknown>)['animation']).toBe(true);
    setGlobalBackground(settings, null);
    expect(backgroundSettingsOf(settings).name).toBe(BACKGROUND_NONE);
  });

  it('shows the chat-locked background before the global one', () => {
    const settings: Record<string, unknown> = {};
    setGlobalBackground(settings, 'global.png');
    expect(activeBackgroundRel(settings, {})).toBe('backgrounds/global.png');
    const meta = { [BG_METADATA_KEY]: backgroundUrlParam('chat.webp') };
    expect(activeBackgroundRel(settings, meta)).toBe('backgrounds/chat.webp');
    expect(activeBackgroundRel({}, { [BG_METADATA_KEY]: undefined })).toBeNull();
  });

  it('lists only images as backgrounds', () => {
    expect(isBackgroundImage('a.PNG')).toBe(true);
    expect(isBackgroundImage('a.mp4')).toBe(false);
    expect(isBackgroundImage(BACKGROUND_NONE)).toBe(false);
  });
});
