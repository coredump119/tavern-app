/**
 * SillyTavern theme ⇄ tm-theme. Mapping table: DESIGN.md §6; import fidelity rules: DEV_NOTES §9.26.
 *
 * ST only stores ten colors and composites them over its page (body `--greyCAIbg`, usually with a
 * background image). "Beautification" themes then re-skin everything through `custom_css`, mostly
 * by overriding ST's `--SmartTheme*` variables in `:root`. Import therefore (1) reads those variable
 * overrides (light + the `prefers-color-scheme: dark` block), (2) flattens alpha over ST's page
 * color so nothing comes out transparent, (3) derives the eleven tokens ST has no field for.
 * Lossless: every ST field is kept verbatim in `theme.st` and written back on export.
 */
import { z } from 'zod';
import { parseTheme, type Theme, type ThemeInput } from './schema.js';
import {
  compositeOver,
  contrastRatio,
  luminance,
  mix,
  parseColor,
  toCss,
  type Rgba,
} from './color.js';
import { readRootVars, resolveCssValue, type RootVars } from './css-vars.js';

export const StThemeSchema = z.looseObject({ name: z.string().min(1) });
export type StTheme = z.infer<typeof StThemeSchema>;

/** ST power_user defaults for fields a theme may omit (power-user.js). */
export const ST_DEFAULTS: Record<string, unknown> = {
  blur_strength: 10,
  shadow_width: 2,
  font_scale: 1,
  fast_ui_mode: false,
  waifuMode: false,
  avatar_style: 0,
  chat_display: 0,
  toastr_position: 'toast-top-center',
  noShadows: false,
  chat_width: 50,
  timer_enabled: true,
  timestamps_enabled: true,
  timestamp_model_icon: false,
  mesIDDisplay_enabled: false,
  hideChatAvatars_enabled: false,
  message_token_count_enabled: false,
  expand_message_actions: false,
  enableZenSliders: false,
  enableLabMode: false,
  hotswap_enabled: true,
  custom_css: '',
  bogus_folders: false,
  zoomed_avatar_magnification: false,
  reduced_motion: false,
  compact_input_area: true,
  show_swipe_num_all_messages: false,
};

/** ST style.css `--greyCAIbg`: what shows through transparent tints when no background image is set */
export const ST_PAGE_COLOR: Rgba = { r: 36, g: 36, b: 37, a: 1 };

/** ST theme key → the `--SmartTheme*` variable custom_css may override → tm color key */
const ST_COLOR_FIELDS = [
  ['main_text_color', '--SmartThemeBodyColor', 'text'],
  ['italics_text_color', '--SmartThemeEmColor', 'textEm'],
  ['underline_text_color', '--SmartThemeUnderlineColor', 'textLink'],
  ['quote_text_color', '--SmartThemeQuoteColor', 'textQuote'],
  ['blur_tint_color', '--SmartThemeBlurTintColor', 'surface'],
  ['chat_tint_color', '--SmartThemeChatTintColor', 'bg'],
  ['user_mes_blur_tint_color', '--SmartThemeUserMesBlurTintColor', 'bubbleUser'],
  ['bot_mes_blur_tint_color', '--SmartThemeBotMesBlurTintColor', 'bubbleBot'],
  ['border_color', '--SmartThemeBorderColor', 'border'],
  ['shadow_color', '--SmartThemeShadowColor', 'shadow'],
] as const;
type StColorKey = (typeof ST_COLOR_FIELDS)[number][0];

/** Fields that map 1:1 and are re-derived on export (not kept in `st`). Colors ARE kept (lossless). */
const CONSUMED = new Set<string>([
  'name',
  'custom_css',
  'font_scale',
  'blur_strength',
  'chat_width',
  'reduced_motion',
  'timestamps_enabled',
  'hideChatAvatars_enabled',
  'avatar_style',
  'chat_display',
]);

/** power-user.js avatar_styles: ROUND 0, RECTANGULAR 1, SQUARE 2, ROUNDED 3 */
const AVATAR_FROM_ST = ['circle', 'rectangle', 'square', 'rounded'] as const;
const AVATAR_TO_ST: Record<Theme['shape']['avatar'], number> = {
  circle: 0,
  rectangle: 1,
  square: 2,
  rounded: 3,
};
/** power-user.js chat_styles: DEFAULT 0, BUBBLES 1, DOCUMENT 2 */
const CHAT_FROM_ST = ['flat', 'bubbles', 'document'] as const;
const CHAT_TO_ST: Record<Theme['layout']['chatStyle'], number> = {
  flat: 0,
  bubbles: 1,
  document: 2,
};

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Does a font stack read as serif? (first family wins; Chinese serif names count) */
export function isSerifStack(stack: string): boolean {
  const first =
    stack
      .split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? '';
  if (/sans/i.test(first)) return false;
  return /serif|songti|song|宋|明|georgia|times|garamond|palatino|baskerville|charter|literata/i.test(
    first,
  );
}

interface StColorInputs {
  /** per ST key: the color string actually in effect (override or field) */
  values: Partial<Record<StColorKey, string>>;
  /** which keys came from custom_css overrides (for `appearance` fallback decisions) */
  fromCss: Set<StColorKey>;
  /** `html, body { background }` from custom_css, when the theme paints its own page */
  page: Rgba | null;
}

/** The ten ST colors in effect for one scheme: custom_css `--SmartTheme*` override, else the field. */
function stColorInputs(
  st: StTheme,
  vars: ReadonlyMap<string, string>,
  pageRaw: string | undefined,
  base?: ReadonlyMap<string, string>,
): StColorInputs {
  const values: Partial<Record<StColorKey, string>> = {};
  const fromCss = new Set<StColorKey>();
  let page: Rgba | null = null;
  if (pageRaw) {
    const resolved = resolveCssValue(pageRaw, vars, base);
    const c = resolved ? parseColor(resolved) : null;
    if (c) page = compositeOver(c, ST_PAGE_COLOR);
  }
  for (const [key, cssVar] of ST_COLOR_FIELDS) {
    const raw = vars.get(cssVar) ?? base?.get(cssVar);
    if (raw !== undefined) {
      const resolved = resolveCssValue(raw, vars, base);
      if (resolved && parseColor(resolved)) {
        values[key] = resolved;
        fromCss.add(key);
        continue;
      }
    }
    const v = str(st[key]);
    if (v && parseColor(v)) values[key] = v;
  }
  return { values, fromCss, page };
}

/**
 * ST's ten colors → our twenty-one. Alpha is flattened over the page (`bg`) the way ST renders it,
 * then the tokens ST never had are derived from text ↔ background mixes.
 */
export function derivePalette(
  values: Partial<Record<StColorKey, string>>,
  page: Rgba | null = null,
): {
  colors: NonNullable<ThemeInput['colors']>;
  appearance: 'light' | 'dark';
} {
  const get = (k: StColorKey) => (values[k] ? parseColor(values[k]!) : null);
  // the page under the tints: the theme's own body color when it paints one, else ST's grey
  const pageColor = page ?? ST_PAGE_COLOR;
  const bg = compositeOver(get('chat_tint_color') ?? { ...pageColor }, pageColor);
  const dark = luminance(bg) < 0.4;
  const over = (c: Rgba | null, fallback: Rgba) => compositeOver(c ?? fallback, bg);
  const surface = over(get('blur_tint_color'), bg);
  const fallbackText: Rgba = dark
    ? { r: 220, g: 220, b: 210, a: 1 } // ST --ivory
    : { r: 40, g: 36, b: 36, a: 1 };
  const text = over(get('main_text_color'), fallbackText);
  const textEm = over(get('italics_text_color'), text);
  const textLink = over(get('underline_text_color'), text);
  const textQuote = over(get('quote_text_color'), text);
  const bubbleUser = over(get('user_mes_blur_tint_color'), surface);
  const bubbleBot = over(get('bot_mes_blur_tint_color'), surface);
  const borderRaw = get('border_color');
  // a transparent border is the theme's choice ("no lines"): keep it invisible against bg
  const border = borderRaw ? compositeOver(borderRaw, bg) : mix(text, bg, 0.85);
  const shadowRaw = get('shadow_color');

  // accent = ST's underline (link) color, unless it barely shows against the page (e.g. a
  // near-white underline on a light theme): then the quote color, the italics color, the text
  const accent = [textLink, textQuote, textEm].find((c) => contrastRatio(c, bg) >= 2.2) ?? text;
  const accentDark = luminance(accent) < 0.4;
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  const colors: NonNullable<ThemeInput['colors']> = {
    bg: toCss(bg),
    surface: toCss(surface),
    surfaceRaised: toCss(dark ? mix(surface, white, 0.05) : mix(surface, white, 0.6)),
    surfaceSunken: toCss(
      dark ? mix(surface, { r: 0, g: 0, b: 0, a: 1 }, 0.22) : mix(surface, text, 0.06),
    ),
    text: toCss(text),
    textSecondary: toCss(mix(text, bg, 0.3)),
    textMuted: toCss(mix(text, bg, 0.52)),
    textEm: toCss(textEm),
    textQuote: toCss(textQuote),
    textLink: toCss(textLink),
    accent: toCss(accent),
    onAccent: toCss(accentDark ? { r: 252, g: 250, b: 249, a: 1 } : { r: 26, g: 22, b: 22, a: 1 }),
    border: toCss(border),
    borderStrong: toCss(mix(border, text, 0.35)),
    bubbleUser: toCss(bubbleUser),
    bubbleBot: toCss(bubbleBot),
    shadow: shadowRaw ? toCss(shadowRaw) : toCss({ r: 0, g: 0, b: 0, a: dark ? 0.5 : 0.18 }),
    scrim: toCss({ ...bg, a: 0.55 }),
  };
  return { colors, appearance: dark ? 'dark' : 'light' };
}

/** Fonts a beautification theme sets: `.mes_text` (body text) > `--mainFontFamily`; `--monoFontFamily`. */
function fontsFrom(
  vars: RootVars,
  layer: ReadonlyMap<string, string>,
  base?: ReadonlyMap<string, string>,
): Partial<ThemeInput['typography'] & object> {
  const res = (v: string | undefined) => (v ? resolveCssValue(v, layer, base) : null);
  const bodyStack =
    res(vars.fonts.mesText) ?? res(layer.get('--mainFontFamily') ?? base?.get('--mainFontFamily'));
  const uiStack =
    res(layer.get('--mainFontFamily') ?? base?.get('--mainFontFamily')) ?? res(vars.fonts.body);
  const mono = res(layer.get('--monoFontFamily') ?? base?.get('--monoFontFamily'));
  const out: Record<string, unknown> = {};
  if (bodyStack) {
    const serif = isSerifStack(bodyStack);
    out['body'] = serif ? 'serif' : 'sans';
    out[serif ? 'serif' : 'sans'] = bodyStack;
  }
  if (uiStack) {
    const serif = isSerifStack(uiStack);
    out['ui'] = serif ? 'serif' : 'sans';
    // only fill the stack when the body did not already claim this track with a different stack
    if (!(serif ? 'serif' : 'sans' in out)) out[serif ? 'serif' : 'sans'] = uiStack;
  }
  if (mono) out['mono'] = mono;
  return out as Partial<ThemeInput['typography'] & object>;
}

function buildTheme(
  st: StTheme,
  name: string,
  inputs: StColorInputs,
  typography: Partial<ThemeInput['typography'] & object>,
): Theme {
  const { colors, appearance } = derivePalette(inputs.values, inputs.page);
  const shadowWidth = num(st['shadow_width'], 2);
  const noShadows = bool(st['noShadows'], false);
  const chatIdx = clamp(Math.trunc(num(st['chat_display'], 0)), 0, 2);
  const avatarIdx = clamp(Math.trunc(num(st['avatar_style'], 0)), 0, 3);

  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(st)) if (!CONSUMED.has(k)) passthrough[k] = v;

  const input: ThemeInput = {
    name,
    appearance,
    typography: { scale: clamp(num(st['font_scale'], 1), 0.8, 1.4), ...typography },
    colors,
    shape: { avatar: AVATAR_FROM_ST[avatarIdx]! },
    layout: {
      chatWidth: clamp(num(st['chat_width'], 50), 25, 100),
      chatStyle: CHAT_FROM_ST[chatIdx]!,
      showAvatars: !bool(st['hideChatAvatars_enabled'], false),
      timestamps: bool(st['timestamps_enabled'], true),
    },
    effects: {
      blur: clamp(num(st['blur_strength'], 10), 0, 40),
      shadow: noShadows ? 0 : clamp(shadowWidth / 10, 0, 1),
      reducedMotion: bool(st['reduced_motion'], false),
    },
    customCss: str(st['custom_css']) ?? '',
    customCssEnabled: true,
    customCssLayout: false,
    st: passthrough,
  };
  return parseTheme(input);
}

/**
 * Import an ST theme. A `custom_css` with a `prefers-color-scheme: dark` block that changes any of
 * the ten colors yields two themes: the light one under the ST name and a `· 夜间` variant.
 */
export function importStThemes(raw: unknown): Theme[] {
  const st = StThemeSchema.parse(raw);
  const css = str(st['custom_css']) ?? '';
  const vars = readRootVars(css);
  const light = stColorInputs(st, vars.light, vars.page.light);
  const lightTheme = buildTheme(st, st.name, light, fontsFrom(vars, vars.light));
  if (vars.dark.size === 0) return [lightTheme];
  const dark = stColorInputs(st, vars.dark, vars.page.dark ?? vars.page.light, vars.light);
  const differs = ST_COLOR_FIELDS.some(([k]) => dark.values[k] !== light.values[k]);
  if (!differs) return [lightTheme];
  const darkTheme = buildTheme(
    st,
    `${st.name} · 夜间`,
    dark,
    fontsFrom(vars, vars.dark, vars.light),
  );
  return [lightTheme, darkTheme];
}

/** The light (first) variant; see `importStThemes`. */
export function importStTheme(raw: unknown): Theme {
  return importStThemes(raw)[0]!;
}

export function exportStTheme(theme: Theme): StTheme {
  const out: Record<string, unknown> = { ...ST_DEFAULTS, ...theme.st, name: theme.name };
  for (const [stKey, , tmKey] of ST_COLOR_FIELDS) {
    // the original ST string survives in `st`; a theme authored here falls back to its token
    if (out[stKey] === undefined) {
      const v = theme.colors[tmKey];
      if (v) out[stKey] = v;
    }
  }
  out['custom_css'] = theme.customCss;
  out['font_scale'] = theme.typography.scale;
  out['blur_strength'] = theme.effects.blur;
  out['chat_width'] = theme.layout.chatWidth;
  out['reduced_motion'] = theme.effects.reducedMotion;
  out['timestamps_enabled'] = theme.layout.timestamps;
  out['hideChatAvatars_enabled'] = !theme.layout.showAvatars;
  out['avatar_style'] = AVATAR_TO_ST[theme.shape.avatar];
  out['chat_display'] = CHAT_TO_ST[theme.layout.chatStyle];
  // lossy fields: prefer preserved ST values, else derive
  if (!('shadow_width' in theme.st)) out['shadow_width'] = Math.round(theme.effects.shadow * 10);
  if (!('noShadows' in theme.st)) out['noShadows'] = theme.effects.shadow === 0;
  return out as StTheme;
}

/** Heuristic: does this JSON look like an ST theme rather than a tm-theme? */
export function looksLikeStTheme(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  if (o['format'] === 'tm-theme') return false;
  return 'main_text_color' in o || 'blur_tint_color' in o || 'custom_css' in o;
}

/** Accept either format; an ST theme may expand to a light + dark pair. */
export function importAnyThemes(raw: unknown): Theme[] {
  return looksLikeStTheme(raw) ? importStThemes(raw) : [parseTheme(raw)];
}

/** Accept either format (first variant). */
export function importAnyTheme(raw: unknown): Theme {
  return importAnyThemes(raw)[0]!;
}
