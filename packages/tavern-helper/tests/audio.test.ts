import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioModule, type AudioApi } from '../src/realm/api/audio.js';
import type { FrameInfo } from '../src/realm/hub.js';
import { msg, setup } from './harness.js';

const A = 'https://cdn.example/music/Night%20Rain.mp3';
const B = 'https://cdn.example/music/b.ogg';
const C = 'https://cdn.example/music/c.ogg';
const CARD: FrameInfo = { name: 'TH-message--2--0', messageId: 2 };

/** The few members of an audio element the module touches */
class FakeAudio {
  src = '';
  loop = false;
  muted = false;
  volume = 1;
  paused = true;
  ended = false;
  currentTime = 0;
  duration = NaN;
  plays = 0;
  loads = 0;
  /** what the next `play()` calls reject with */
  refusals: string[] = [];
  private readonly listeners = new Map<string, (() => void)[]>();

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
  load(): void {
    this.loads++;
    this.paused = true;
    this.currentTime = 0;
  }
  play(): Promise<void> {
    this.plays++;
    const refusal = this.refusals.shift();
    if (refusal) return Promise.reject(new DOMException('refused', refusal));
    this.paused = false;
    this.ended = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  /** the track played to its end */
  finish(): void {
    this.paused = true;
    this.ended = true;
    this.fire('ended');
  }
}

/** A card window as far as the gesture listener goes */
function fakeCard() {
  const listeners = new Map<string, () => void>();
  return {
    structuredClone,
    listeners,
    addEventListener: (type: string, listener: () => void) => void listeners.set(type, listener),
  };
}

describe('audio', () => {
  let t: ReturnType<typeof setup>;
  let made: FakeAudio[];
  let api: AudioApi;
  /** queued for the next element that gets created */
  let refusals: string[];

  beforeEach(async () => {
    t = setup();
    await t.start();
    made = [];
    refusals = [];
    class Audio extends FakeAudio {
      constructor() {
        super();
        this.refusals = refusals;
        made.push(this);
      }
    }
    const module = audioModule(t.hub, { Audio } as unknown as Window);
    t.hub.modules.push(module);
    api = module({ hub: t.hub, owner: globalThis, frame: CARD, give: structuredClone });
  });
  afterEach(() => void vi.restoreAllMocks());

  const switchChat = async () => {
    t.host.syncChat('chat-b', [msg('other')]);
    await t.pump();
  };

  it('is part of every frame API', () => {
    const globals = t.hub.createApi(globalThis, CARD) as Record<string, unknown>;
    expect(globals['playAudio']).toBeTypeOf('function');
    expect((globals['TavernHelper'] as Record<string, unknown>)['getCurrentAudio']).toBeTypeOf(
      'function',
    );
  });

  it('replaces and appends the list, titles defaulting to the file name', () => {
    expect(api.getAudioList('bgm')).toEqual([]);
    api.replaceAudioList('bgm', [{ url: A }, { title: 'Bee', url: B }, { title: 'again', url: A }]);
    expect(api.getAudioList('bgm')).toEqual([
      { title: 'Night Rain.mp3', url: A },
      { title: 'Bee', url: B },
    ]);
    // same url, then same title, then a new one
    api.appendAudioList('bgm', [{ url: B }, { title: 'Bee', url: C }, { title: 'Sea', url: C }]);
    expect(api.getAudioList('bgm').map((a) => a.title)).toEqual(['Night Rain.mp3', 'Bee', 'Sea']);

    const data = 'data:audio/wav;base64,AAAA';
    api.appendAudioList('ambient', [{ url: data }, { url: 'data:audio/wav;base64,BBBB' }]);
    expect(api.getAudioList('ambient')).toMatchObject([{ title: '', url: data }, { title: '' }]);
    expect(api.getAudioList('bgm')).toHaveLength(3);

    // what a script gets is its own copy
    api.getAudioList('bgm').pop();
    expect(api.getAudioList('bgm')).toHaveLength(3);
    expect(made).toHaveLength(0);
  });

  it('creates an element on first play, adds an unknown track, pauses and resumes', () => {
    expect(api.getCurrentAudio('bgm')).toEqual({ src: '', title: '', playing: false, progress: 0 });
    api.playAudio('bgm', { url: A });
    expect(made).toHaveLength(1);
    const [el] = made as [FakeAudio];
    expect(el).toMatchObject({ src: A, paused: false, volume: 0.5, muted: false, loop: false });
    expect(api.getAudioList('bgm')).toEqual([{ title: 'Night Rain.mp3', url: A }]);

    el.duration = 200;
    el.currentTime = 50;
    expect(api.getCurrentAudio('bgm')).toEqual({
      src: A,
      title: 'Night Rain.mp3',
      playing: true,
      progress: 25,
    });

    api.pauseAudio('bgm');
    expect(el.paused).toBe(true);
    expect(api.getCurrentAudio('bgm')).toMatchObject({ src: A, playing: false });
    // the same track again goes on where it was: the element is not given the url anew
    el.src = 'untouched';
    api.playAudio('bgm', { title: 'ignored', url: A });
    expect(el).toMatchObject({ src: 'untouched', paused: false, currentTime: 50 });
    expect(api.getAudioList('bgm')).toHaveLength(1);

    // the other channel has its own element
    api.playAudio('ambient', { title: 'Rain', url: B });
    expect(made).toHaveLength(2);
    expect(api.getCurrentAudio('ambient')).toMatchObject({ title: 'Rain', playing: true });
    expect(api.getCurrentAudio('bgm')).toMatchObject({ src: A, playing: true });
  });

  it('stops when the list loses the selected track', () => {
    api.replaceAudioList('bgm', [{ url: A }, { url: B }]);
    api.playAudio('bgm', { url: A });
    api.replaceAudioList('bgm', [{ url: A }, { url: C }]);
    expect(made[0]).toMatchObject({ src: A, paused: false });
    api.replaceAudioList('bgm', [{ url: C }]);
    expect(made[0]).toMatchObject({ src: '', paused: true, loads: 1 });
    expect(api.getCurrentAudio('bgm')).toEqual({ src: '', title: '', playing: false, progress: 0 });
    made[0]!.finish();
    expect(made[0]!.plays).toBe(1);
  });

  describe('when a track ends', () => {
    beforeEach(() => api.replaceAudioList('bgm', [{ url: A }, { url: B }, { url: C }]));

    it('repeat_all goes through the list and wraps', () => {
      api.playAudio('bgm', { url: B });
      const el = made[0]!;
      el.finish();
      expect(el).toMatchObject({ src: C, paused: false });
      el.finish();
      expect(el).toMatchObject({ src: A, paused: false });
      expect(api.getCurrentAudio('bgm').src).toBe(A);
      expect(made).toHaveLength(1);
    });

    it('repeat_all with one track plays it again', () => {
      api.replaceAudioList('bgm', [{ url: A }]);
      api.playAudio('bgm', { url: A });
      made[0]!.finish();
      expect(made[0]).toMatchObject({ src: A, paused: false, plays: 2 });
    });

    it('repeat_one loops on the element', () => {
      api.setAudioSettings('bgm', { mode: 'repeat_one' });
      api.playAudio('bgm', { url: A });
      const el = made[0]!;
      expect(el.loop).toBe(true);
      // should an engine report the end anyway, it is the same track again
      el.finish();
      expect(el).toMatchObject({ src: A, paused: false, plays: 2 });
      api.setAudioSettings('bgm', { mode: 'repeat_all' });
      expect(el.loop).toBe(false);
    });

    it('shuffle picks one of the other tracks', () => {
      api.setAudioSettings('bgm', { mode: 'shuffle' });
      api.playAudio('bgm', { url: A });
      const el = made[0]!;
      vi.spyOn(Math, 'random').mockReturnValue(0.99);
      el.finish();
      expect(el.src).toBe(C);
      vi.spyOn(Math, 'random').mockReturnValue(0);
      el.finish();
      expect(el.src).toBe(A);
      el.finish();
      expect(el.src).toBe(B);
    });

    it('play_one_and_stop stays stopped, and plays again when asked', () => {
      api.setAudioSettings('bgm', { mode: 'play_one_and_stop' });
      api.playAudio('bgm', { url: A });
      const el = made[0]!;
      el.finish();
      expect(el).toMatchObject({ src: A, paused: true, plays: 1 });
      expect(api.getCurrentAudio('bgm')).toMatchObject({ src: A, playing: false });
      api.playAudio('bgm', { url: A });
      expect(el).toMatchObject({ paused: false, plays: 2 });
    });

    it('a track that fails to load stops the channel', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      api.playAudio('bgm', { url: A });
      const el = made[0]!;
      el.paused = true;
      el.fire('error');
      expect(warn).toHaveBeenCalledOnce();
      el.finish();
      expect(el.plays).toBe(1);
    });
  });

  it('settings round-trip, apply to the element and are checked', () => {
    const initial = { enabled: true, mode: 'repeat_all', muted: false, volume: 50 };
    expect(api.getAudioSettings('bgm')).toEqual(initial);
    api.setAudioSettings('bgm', { volume: 80 });
    api.setAudioSettings('bgm', { muted: true, mode: 'shuffle' });
    expect(api.getAudioSettings('bgm')).toEqual({
      ...initial,
      volume: 80,
      muted: true,
      mode: 'shuffle',
    });
    expect(api.getAudioSettings('ambient')).toEqual(initial);
    expect(made).toHaveLength(0);

    api.playAudio('bgm', { url: A });
    const el = made[0]!;
    expect(el).toMatchObject({ volume: 0.8, muted: true });
    api.setAudioSettings('bgm', { volume: 250, muted: false });
    expect(el).toMatchObject({ volume: 1, muted: false, paused: false });
    expect(api.getAudioSettings('bgm').volume).toBe(100);
    api.setAudioSettings('bgm', { volume: -3 });
    expect(el.volume).toBe(0);

    const bad = [{ mode: 'loop' }, { volume: '50' }, { volume: NaN }, { enabled: 1 }, null];
    for (const settings of bad)
      expect(() => api.setAudioSettings('bgm', settings as never)).toThrow();
    expect(api.getAudioSettings('bgm')).toMatchObject({
      mode: 'shuffle',
      volume: 0,
      enabled: true,
    });
    expect(() => api.getAudioSettings('sfx' as never)).toThrow(/bgm/);
  });

  it('a disabled channel pauses, refuses to play and resumes what was wanted', () => {
    api.playAudio('bgm', { url: A });
    const el = made[0]!;
    api.setAudioSettings('bgm', { enabled: false });
    expect(el.paused).toBe(true);
    api.playAudio('bgm', { url: B });
    expect(el).toMatchObject({ src: A, paused: true, plays: 1 });
    expect(api.getCurrentAudio('bgm')).toMatchObject({ src: B, playing: false });
    api.setAudioSettings('bgm', { enabled: true });
    expect(el).toMatchObject({ src: B, paused: false, plays: 2 });

    // paused by the script: switching the channel back on does not start it
    api.pauseAudio('bgm');
    api.setAudioSettings('bgm', { enabled: false });
    api.setAudioSettings('bgm', { enabled: true });
    expect(el).toMatchObject({ paused: true, plays: 2 });

    // nothing is created for a channel that is off
    api.setAudioSettings('ambient', { enabled: false });
    api.playAudio('ambient', { url: C });
    expect(made).toHaveLength(1);
  });

  it('a chat switch stops playback and resets both channels', async () => {
    api.setAudioSettings('bgm', { volume: 10, mode: 'shuffle' });
    api.replaceAudioList('ambient', [{ url: C }]);
    api.playAudio('bgm', { url: A });
    const el = made[0]!;

    // the app syncing the same chat again is not a switch
    t.appSet([...t.chat(), msg('more')]);
    await t.pump();
    expect(el.paused).toBe(false);

    await switchChat();
    expect(el).toMatchObject({ src: '', paused: true });
    for (const type of ['bgm', 'ambient'] as const) {
      expect(api.getAudioList(type)).toEqual([]);
      expect(api.getAudioSettings(type)).toMatchObject({ volume: 50, mode: 'repeat_all' });
      expect(api.getCurrentAudio(type)).toMatchObject({ src: '', playing: false });
    }
    el.finish();
    expect(el.plays).toBe(1);

    // the element is kept for the next chat
    api.playAudio('bgm', { url: B });
    expect(made).toHaveLength(1);
    expect(el).toMatchObject({ src: B, paused: false, volume: 0.5 });
  });

  it('a frame clearing its listeners does not take the reset with it', async () => {
    api.playAudio('bgm', { url: A });
    t.hub.createApi(globalThis, CARD).eventClearAll();
    t.hub.release(globalThis);
    await switchChat();
    expect(made[0]!.paused).toBe(true);
  });

  it('retries a refused play() on the next touch of a card', async () => {
    const card = fakeCard();
    t.hub.install(card, CARD);
    expect([...card.listeners.keys()]).toEqual(['pointerdown', 'touchend']);

    // a touch with nothing waiting does nothing
    card.listeners.get('touchend')!();
    expect(made).toHaveLength(0);

    refusals.push('NotAllowedError', 'NotAllowedError');
    api.playAudio('bgm', { url: A });
    const el = made[0]!;
    await Promise.resolve();
    expect(el).toMatchObject({ paused: true, plays: 1 });
    expect(api.getCurrentAudio('bgm')).toMatchObject({ src: A, playing: false });

    // `pointerdown` of a touch is no activation yet: refused again, and still waiting
    card.listeners.get('pointerdown')!();
    await Promise.resolve();
    expect(el).toMatchObject({ paused: true, plays: 2 });
    card.listeners.get('touchend')!();
    await Promise.resolve();
    expect(el).toMatchObject({ paused: false, plays: 3 });

    // once per refusal: later touches leave the element alone
    card.listeners.get('touchend')!();
    expect(el.plays).toBe(3);
  });

  it('does not retry what was paused, nor other rejections', async () => {
    const card = fakeCard();
    t.hub.install(card, CARD);
    refusals.push('NotAllowedError');
    api.playAudio('bgm', { url: A });
    await Promise.resolve();
    api.pauseAudio('bgm');
    card.listeners.get('touchend')!();
    expect(made[0]!.plays).toBe(1);

    // a pause arriving before playback began rejects with AbortError
    refusals.push('AbortError');
    api.playAudio('bgm', { url: B });
    await Promise.resolve();
    card.listeners.get('touchend')!();
    expect(made[0]!.plays).toBe(2);
  });

  it('script frames get no gesture listener', () => {
    const frame = fakeCard();
    t.hub.install(frame, {
      name: 'TH-script--x--1',
      messageId: -1,
      script: { id: '1', scope: 'global', reload: () => {} },
    });
    expect(frame.listeners.size).toBe(0);
  });

  it('accepts only http, https, data and blob urls', () => {
    const blob = 'blob:https://app.example/3f0c';
    api.appendAudioList('bgm', [{ url: 'http://a.example/x.mp3' }, { url: blob }]);
    expect(api.getAudioList('bgm').map((a) => a.title)).toEqual(['x.mp3', '3f0c']);
    const bad = [
      'file:///etc/passwd',
      'javascript:alert(1)',
      '/music/a.mp3',
      'a.mp3',
      '',
      'tmhelper://localhost/a.mp3',
    ];
    for (const url of bad) {
      expect(() => api.playAudio('bgm', { url })).toThrow(/http/);
      expect(() => api.replaceAudioList('bgm', [{ url: A }, { url }])).toThrow(/http/);
      expect(() => api.appendAudioList('bgm', [{ url: A }, { url }])).toThrow(/http/);
    }
    expect(() => api.playAudio('bgm', 'a.mp3' as never)).toThrow();
    expect(() => api.replaceAudioList('bgm', { url: A } as never)).toThrow();
    // a refused call changes nothing
    expect(api.getAudioList('bgm')).toHaveLength(2);
    expect(made).toHaveLength(0);
  });
});
