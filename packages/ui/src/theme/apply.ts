import { COLOR_KEYS, type ColorKey, type Theme } from './schema.js';
import {
  customCssFonts,
  pinColorScheme,
  sanitizeCustomCss,
  type CustomCssFonts,
} from './st-css.js';
import { DARK_COLORS, LIGHT_COLORS } from './defaults.js';

export type ResolvedColors = Record<ColorKey, string>;

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

/** Fill missing colors from the appearance's default palette. */
export function resolveColors(theme: Theme): ResolvedColors {
  const base = theme.appearance === 'dark' ? DARK_COLORS : LIGHT_COLORS;
  const out = { ...base };
  for (const k of COLOR_KEYS) {
    const v = theme.colors[k];
    if (v) out[k] = v;
  }
  return out;
}

const LEADING: Record<Theme['typography']['leading'], string> = {
  tight: 'var(--tm-leading-tight)',
  normal: 'var(--tm-leading-normal)',
  relaxed: 'var(--tm-leading-relaxed)',
};
const DENSITY: Record<Theme['layout']['density'], string> = {
  compact: '0.85',
  comfortable: '1',
  spacious: '1.2',
};
/** ST toggle-dependent.css: --avatar-base-border-radius 2px (square), -rounded 10px; big avatars 2:3 */
const AVATAR: Record<Theme['shape']['avatar'], { radius: string; height: string }> = {
  circle: { radius: '50%', height: 'var(--tm-avatar-size)' },
  rectangle: { radius: 'var(--tm-radius-sm)', height: 'calc(var(--tm-avatar-size) * 1.5)' },
  square: { radius: 'var(--tm-radius-sm)', height: 'var(--tm-avatar-size)' },
  rounded: { radius: 'var(--tm-radius-md)', height: 'var(--tm-avatar-size)' },
};

/** last `customCssFonts` result (same reason as `cssMemo` below) */
let fontMemo: { source: string; fonts: CustomCssFonts } | undefined;

function fontsOfCustomCss(theme: Theme): CustomCssFonts {
  if (!theme.customCss || !theme.customCssEnabled) return {};
  if (fontMemo?.source !== theme.customCss)
    fontMemo = { source: theme.customCss, fonts: customCssFonts(theme.customCss) };
  return fontMemo.fonts;
}

/** Theme → flat map of CSS custom properties. Pure; safe for tests and SSR. */
export function themeToCssVars(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  const colors = resolveColors(theme);
  for (const k of COLOR_KEYS) vars[`--tm-color-${kebab(k)}`] = colors[k];

  const t = theme.typography;
  if (t.serif) vars['--tm-font-serif'] = t.serif;
  if (t.sans) vars['--tm-font-sans'] = t.sans;
  if (t.mono) vars['--tm-font-mono'] = t.mono;
  // a page-wide font set by the custom CSS goes in front of the theme's own choice
  const cssFonts = fontsOfCustomCss(theme);
  const lead = cssFonts.main ? `${cssFonts.main}, ` : '';
  vars['--tm-font-body'] = `${lead}var(--tm-font-${t.body})`;
  vars['--tm-font-ui'] = `${lead}var(--tm-font-${t.ui})`;
  if (cssFonts.mono && !t.mono)
    vars['--tm-font-mono'] = `${cssFonts.mono}, ui-monospace, monospace`;
  vars['--tm-font-scale'] = String(t.scale);
  vars['--tm-leading-body'] = LEADING[t.leading];

  const s = theme.shape;
  vars['--tm-radius-scale'] = String(s.radius);
  vars['--tm-radius-avatar'] = AVATAR[s.avatar].radius;
  vars['--tm-avatar-height'] = AVATAR[s.avatar].height;
  vars['--tm-border-width'] = `${s.borderWidth}px`;

  const l = theme.layout;
  vars['--tm-chat-measure'] = `${l.chatMeasure}ch`;
  // ST semantics: chat_width is a DESKTOP-only percentage (mobile-styles.css forces #sheld to 100%).
  // Phone/tablet CSS ignores --tm-chat-width; on lg an explicit width replaces the reading-measure cap.
  vars['--tm-chat-width'] = `${l.chatWidth}%`;
  vars['--tm-chat-desktop-max'] = l.chatWidth < 100 ? 'none' : `${l.chatMeasure}ch`;
  // the same column as one length, for places that centre with padding instead of width + margin
  vars['--tm-chat-desktop-column'] = l.chatWidth < 100 ? `${l.chatWidth}%` : `${l.chatMeasure}ch`;
  vars['--tm-density'] = DENSITY[l.density];

  const e = theme.effects;
  vars['--tm-blur'] = `${e.blur}px`;
  vars['--tm-shadow-strength'] = String(e.shadow);

  const b = theme.background;
  vars['--tm-chat-bg-opacity'] = String(b.opacity);
  vars['--tm-chat-bg-blur'] = `${b.blur}px`;
  return vars;
}

/** Root data attributes driven by the theme (CSS reacts to these). */
export function themeToDataAttrs(theme: Theme): Record<string, string> {
  return {
    'data-tm-appearance': theme.appearance,
    'data-tm-chat-style': theme.layout.chatStyle,
    'data-tm-user-side': theme.layout.userSide,
    'data-tm-avatars': String(theme.layout.showAvatars),
    'data-tm-timestamps': String(theme.layout.timestamps),
    'data-tm-reduced-motion': String(theme.effects.reducedMotion),
    'data-tm-body-font': theme.typography.body,
    'data-tm-immersive': String(theme.layout.immersiveChat),
    'data-tm-avatar-bg': String(theme.background.avatar),
  };
}

/** ST `power_user` toggles that ST themes carry verbatim in `theme.st`, mapped to the body class ST sets. */
const ST_FLAG_CLASSES: ReadonlyArray<[key: string, cls: string, when: boolean]> = [
  ['timer_enabled', 'no-timer', false],
  ['timestamp_model_icon', 'no-modelIcons', false],
  ['message_token_count_enabled', 'no-tokenCount', false],
  ['mesIDDisplay_enabled', 'no-mesIDDisplay', false],
  ['hotswap_enabled', 'no-hotswap', false],
  ['expand_message_actions', 'expandMessageActions', true],
  ['compact_input_area', 'compact', true],
  ['show_swipe_num_all_messages', 'swipeAllMessages', true],
  ['enableZenSliders', 'enableZenSliders', true],
  ['enableLabMode', 'enableLabMode', true],
  ['waifuMode', 'waifuMode', true],
];
const ST_BODY_CLASSES = [
  'bubblechat',
  'documentstyle',
  'big-avatars',
  'square-avatars',
  'rounded-avatars',
  'hideChatAvatars',
  'no-timestamps',
  'no-blur',
  'noShadows',
  'reduced-motion',
  ...ST_FLAG_CLASSES.map(([, c]) => c),
];

/** The `<body>` classes ST's power-user.js would set for this theme (DEV_NOTES §9.3). */
export function themeToBodyClasses(theme: Theme): string[] {
  const out: string[] = [];
  if (theme.layout.chatStyle === 'bubbles') out.push('bubblechat');
  if (theme.layout.chatStyle === 'document') out.push('documentstyle');
  if (theme.shape.avatar === 'rectangle') out.push('big-avatars');
  if (theme.shape.avatar === 'square') out.push('square-avatars');
  if (theme.shape.avatar === 'rounded') out.push('rounded-avatars');
  if (!theme.layout.showAvatars) out.push('hideChatAvatars');
  if (!theme.layout.timestamps) out.push('no-timestamps');
  if (theme.st['fast_ui_mode'] === true || theme.effects.blur === 0) out.push('no-blur');
  if (theme.st['noShadows'] === true || theme.effects.shadow === 0) out.push('noShadows');
  if (theme.effects.reducedMotion) out.push('reduced-motion');
  for (const [key, cls, when] of ST_FLAG_CLASSES) {
    const v = theme.st[key];
    if (typeof v === 'boolean' && v === when) out.push(cls);
  }
  return out;
}

/** last `effectiveCustomCss` result: theme edits re-apply on every change, the CSS rarely differs */
let cssMemo: { source: string; layout: boolean; appearance: string; css: string } | undefined;

/** The custom CSS that will actually be injected (empty when disabled). */
export function effectiveCustomCss(theme: Theme): string {
  if (!theme.customCss || !theme.customCssEnabled) return '';
  const { customCss: source, customCssLayout: layout, appearance } = theme;
  if (cssMemo?.source === source && cssMemo.layout === layout && cssMemo.appearance === appearance)
    return cssMemo.css;
  const pinned = pinColorScheme(source, appearance);
  const css = layout ? pinned : sanitizeCustomCss(pinned);
  cssMemo = { source, layout, appearance, css };
  return css;
}

const CUSTOM_CSS_ID = 'tm-theme-custom-css';

/** Apply a theme to a document root. Idempotent; clears variables from a previous theme. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  const prev = root.dataset['tmVars']?.split(' ') ?? [];
  for (const name of prev) root.style.removeProperty(name);

  const vars = themeToCssVars(theme);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset['tmVars'] = Object.keys(vars).join(' ');

  for (const [k, v] of Object.entries(themeToDataAttrs(theme))) root.setAttribute(k, v);

  const doc = root.ownerDocument;
  const body = doc.body;
  if (body) {
    const want = new Set(themeToBodyClasses(theme));
    for (const cls of ST_BODY_CLASSES) body.classList.toggle(cls, want.has(cls));
  }

  let style = doc.getElementById(CUSTOM_CSS_ID) as HTMLStyleElement | null;
  const css = effectiveCustomCss(theme);
  if (css) {
    if (!style) {
      style = doc.createElement('style');
      style.id = CUSTOM_CSS_ID;
      doc.head.appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
  } else if (style) {
    style.remove();
  }
}
