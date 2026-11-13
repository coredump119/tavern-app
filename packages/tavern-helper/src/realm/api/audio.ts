/**
 * `playAudio` and friends (DEV_NOTES §9.5 第 3 轮 → 音频): two channels, each with a playlist,
 * settings and one audio element in the hub document. Everything lives in memory for the open
 * chat only; a chat that never plays anything creates no element.
 */
import { tavern_events } from '../events.js';
import type { ApiContext, FrameInfo, Hub } from '../hub.js';
import { isRecord } from '../util.js';

export type AudioChannel = 'bgm' | 'ambient';
export type AudioMode = 'repeat_one' | 'repeat_all' | 'shuffle' | 'play_one_and_stop';

export interface AudioTrack {
  title: string;
  url: string;
}
export interface AudioTrackInput {
  title?: string;
  url: string;
}
export interface AudioSettings {
  enabled: boolean;
  mode: AudioMode;
  muted: boolean;
  /** 0–100 */
  volume: number;
}
export interface CurrentAudio {
  /** the selected track's url; '' when none is selected */
  src: string;
  title: string;
  playing: boolean;
  /** 0–100 */
  progress: number;
}

/** A type alias, not an interface: it has to be assignable to an `ApiModule`'s record */
export type AudioApi = {
  playAudio(type: AudioChannel, audio: AudioTrackInput): void;
  pauseAudio(type: AudioChannel): void;
  getAudioList(type: AudioChannel): AudioTrack[];
  replaceAudioList(type: AudioChannel, audio_list: AudioTrackInput[]): void;
  appendAudioList(type: AudioChannel, audio_list: AudioTrackInput[]): void;
  getAudioSettings(type: AudioChannel): AudioSettings;
  setAudioSettings(type: AudioChannel, settings: Partial<AudioSettings>): void;
  getCurrentAudio(type: AudioChannel): CurrentAudio;
};

interface Channel {
  list: AudioTrack[];
  settings: AudioSettings;
  /** url of the selected track, always one of `list`; '' when none */
  current: string;
  /** a script asked for playback and nothing has paused or ended it since */
  wanted: boolean;
  /** the autoplay policy refused `play()`: the next touch on a card tries again */
  blocked: boolean;
  element: HTMLAudioElement | null;
  /** the url `element` was last given */
  loaded: string;
}

const MODES: readonly string[] = ['repeat_one', 'repeat_all', 'shuffle', 'play_one_and_stop'];
const PROTOCOLS: readonly string[] = ['http:', 'https:', 'data:', 'blob:'];
/** what unlocks audio on a phone; `pointerdown` covers mice */
const GESTURES = ['pointerdown', 'touchend'] as const;

const defaults = (): AudioSettings => ({
  enabled: true,
  mode: 'repeat_all',
  muted: false,
  volume: 50,
});

const blank = (): Channel => ({
  list: [],
  settings: defaults(),
  current: '',
  wanted: false,
  blocked: false,
  element: null,
  loaded: '',
});

/** Relative paths are refused too: nothing in the realm would resolve them to the user's files. */
function parseUrl(url: string): URL {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // reported below
  }
  if (!parsed || !PROTOCOLS.includes(parsed.protocol))
    throw new Error(`音频地址只支持 http / https / data / blob：${url.slice(0, 80)}`);
  return parsed;
}

/** The file name a url ends in; '' when it has none (a `data:` url's path is its payload) */
function fileName(url: URL): string {
  if (url.protocol === 'data:') return '';
  const name = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function toTrack(input: unknown): AudioTrack {
  if (!isRecord(input) || typeof input['url'] !== 'string')
    throw new Error('音频要写成 { title?, url } 的形式');
  const url = input['url'].trim();
  const parsed = parseUrl(url);
  const title = input['title'];
  return { title: typeof title === 'string' && title ? title : fileName(parsed), url };
}

function toTracks(input: unknown): AudioTrack[] {
  if (!Array.isArray(input)) throw new Error('音频列表必须是数组');
  return input.map(toTrack);
}

function toFlag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`音频设置 ${field} 必须是 true 或 false`);
  return value;
}

/** The fields a script gave, checked; the ones it left out stay as they are. */
function toSettings(input: unknown): Partial<AudioSettings> {
  if (!isRecord(input)) throw new Error('音频设置必须是对象');
  const { enabled, mode, muted, volume } = input;
  const out: Partial<AudioSettings> = {};
  if (enabled !== undefined) out.enabled = toFlag(enabled, 'enabled');
  if (muted !== undefined) out.muted = toFlag(muted, 'muted');
  if (mode !== undefined) {
    if (typeof mode !== 'string' || !MODES.includes(mode))
      throw new Error(`没有 "${String(mode)}" 这个播放模式`);
    out.mode = mode as AudioMode;
  }
  if (volume !== undefined) {
    if (typeof volume !== 'number' || Number.isNaN(volume))
      throw new Error('音量必须是 0–100 的数字');
    out.volume = Math.min(100, Math.max(0, volume));
  }
  return out;
}

/** The track to play after `current` ends; with nothing else to pick, `current` again. */
function following(list: readonly AudioTrack[], current: string, shuffle: boolean): string {
  if (shuffle) {
    const others = list.filter((track) => track.url !== current);
    return others[Math.floor(Math.random() * others.length)]?.url ?? current;
  }
  const at = list.findIndex((track) => track.url === current);
  return list[(at + 1) % list.length]?.url ?? current;
}

/**
 * The audio API as a hub module. Call once per hub: the returned module is run for every frame,
 * and all frames share the two channels.
 */
export function audioModule(hub: Hub, win: Window): (context: ApiContext) => AudioApi {
  const channels: Record<AudioChannel, Channel> = { bgm: blank(), ambient: blank() };

  const channelOf = (type: AudioChannel): Channel => {
    if (type !== 'bgm' && type !== 'ambient')
      throw new Error(`音频类型只有 'bgm' 和 'ambient'，没有 "${String(type)}"`);
    return channels[type];
  };

  const tune = ({ element, settings }: Channel): void => {
    if (!element) return;
    element.muted = settings.muted;
    element.volume = settings.volume / 100;
    // the element repeats by itself: no gap, and no `ended` to handle
    element.loop = settings.mode === 'repeat_one';
  };

  /**
   * One element per channel for good, never one per track: a WebView that wants a gesture for
   * `play()` lets an element that has already played go on to its next track without one.
   */
  const elementOf = (channel: Channel): HTMLAudioElement => {
    if (channel.element) return channel.element;
    const element = new (win as Window & typeof globalThis).Audio();
    element.addEventListener('ended', () => onEnded(channel));
    element.addEventListener('error', () => onError(channel));
    return (channel.element = element);
  };

  /** Synchronous up to `play()`, so a call made inside a tap still counts as that tap. */
  const start = (channel: Channel): void => {
    const url = channel.current;
    if (!url || !channel.settings.enabled) return;
    const element = elementOf(channel);
    if (channel.loaded !== url) {
      element.src = url;
      channel.loaded = url;
    }
    tune(channel);
    // on a playing element this does nothing; on an ended one it starts over
    element.play().catch((e: unknown) => {
      // a pause or a newer track interrupting this one rejects as well: only the policy matters
      if (!isRecord(e) || e['name'] !== 'NotAllowedError') return;
      if (channel.wanted && channel.loaded === url) channel.blocked = true;
    });
  };

  const halt = (channel: Channel): void => {
    channel.blocked = false;
    channel.element?.pause();
  };

  /** Stop and deselect, letting go of the network and the decoder. */
  const unload = (channel: Channel): void => {
    channel.wanted = false;
    channel.current = '';
    halt(channel);
    if (!channel.loaded) return;
    channel.loaded = '';
    // an empty `src` would fire `error`; no `src` at all just empties the element
    channel.element?.removeAttribute('src');
    channel.element?.load();
  };

  function onEnded(channel: Channel): void {
    if (!channel.wanted) return;
    const { mode } = channel.settings;
    if (mode === 'play_one_and_stop') {
      channel.wanted = false;
      return;
    }
    if (mode !== 'repeat_one')
      channel.current = following(channel.list, channel.current, mode === 'shuffle');
    start(channel);
  }

  /** A track that does not load stops its channel: skipping ahead could spin through a dead list. */
  function onError(channel: Channel): void {
    if (!channel.wanted) return;
    channel.wanted = false;
    channel.blocked = false;
    console.warn('[TavernHelper] 音频加载失败', channel.current.slice(0, 120));
  }

  // listeners live in the hub's own name, so no frame's `eventClearAll` drops this one
  hub.bus.on({}, tavern_events.CHAT_CHANGED, () => {
    for (const channel of Object.values(channels)) {
      unload(channel);
      channel.list = [];
      channel.settings = defaults();
    }
  });

  /**
   * Where the WebView wants a gesture before audio may start, `play()` is refused; the track
   * stays wanted and the next touch on any card tries again, once per touch. Always installed
   * and a no-op while nothing is blocked, which is cheaper than tracking the live frames. A
   * script frame is hidden and never sees a gesture, so a library script can not unlock audio
   * by itself: it takes a touch on a card.
   */
  const unblock = (): void => {
    for (const channel of Object.values(channels)) {
      if (!channel.blocked) continue;
      channel.blocked = false;
      start(channel);
    }
  };
  hub.installers.push((target: object, frame: FrameInfo) => {
    if (frame.script) return;
    const card = target as Partial<Pick<Window, 'addEventListener'>>;
    if (typeof card.addEventListener !== 'function') return;
    for (const type of GESTURES)
      card.addEventListener(type, unblock, { capture: true, passive: true });
  });

  return ({ give }) => ({
    /** Selects the track, adding it to the list when it is new; plays unless the channel is off. */
    playAudio(type, audio) {
      const channel = channelOf(type);
      const track = toTrack(audio);
      if (!channel.list.some((known) => known.url === track.url)) channel.list.push(track);
      channel.current = track.url;
      channel.wanted = true;
      channel.blocked = false;
      start(channel);
    },
    pauseAudio(type) {
      const channel = channelOf(type);
      channel.wanted = false;
      halt(channel);
    },
    getAudioList: (type) => give(channelOf(type).list),
    /** A url is a track's identity, so a repeated one is dropped; losing the playing track stops it. */
    replaceAudioList(type, audio_list) {
      const channel = channelOf(type);
      const next: AudioTrack[] = [];
      for (const track of toTracks(audio_list))
        if (!next.some((known) => known.url === track.url)) next.push(track);
      channel.list = next;
      if (channel.current && !next.some((known) => known.url === channel.current)) unload(channel);
    },
    appendAudioList(type, audio_list) {
      const { list } = channelOf(type);
      for (const track of toTracks(audio_list)) {
        // tracks without a title (a `data:` url has no file name) are not each other's duplicate
        const known = list.some(
          (other) => other.url === track.url || (track.title !== '' && other.title === track.title),
        );
        if (!known) list.push(track);
      }
    },
    getAudioSettings: (type) => give(channelOf(type).settings),
    /** `enabled` is a switch on top of what scripts asked for: off pauses, on resumes it. */
    setAudioSettings(type, settings) {
      const channel = channelOf(type);
      const before = channel.settings;
      channel.settings = { ...before, ...toSettings(settings) };
      tune(channel);
      if (!channel.settings.enabled) halt(channel);
      else if (!before.enabled && channel.wanted) start(channel);
    },
    getCurrentAudio(type) {
      const { element, current, list } = channelOf(type);
      const live = current && element ? element : null;
      const duration = live?.duration ?? NaN;
      return give({
        src: current,
        title: list.find((track) => track.url === current)?.title ?? '',
        playing: !!live && !live.paused && !live.ended,
        progress:
          live && Number.isFinite(duration) && duration > 0
            ? Math.min(100, Math.max(0, (live.currentTime / duration) * 100))
            : 0,
      });
    },
  });
}
