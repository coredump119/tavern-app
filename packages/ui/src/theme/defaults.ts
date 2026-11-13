import type { ColorKey, Theme, ThemeInput } from './schema.js';
import { parseTheme } from './schema.js';

/** Full color sets. Must stay in sync with tokens.css. */
export const LIGHT_COLORS: Record<ColorKey, string> = {
  bg: 'oklch(97.5% 0.008 80)',
  surface: 'oklch(99% 0.005 80)',
  surfaceRaised: 'oklch(100% 0 0)',
  surfaceSunken: 'oklch(95.5% 0.01 80)',
  text: 'oklch(25% 0.015 60)',
  textSecondary: 'oklch(50% 0.015 60)',
  textMuted: 'oklch(66% 0.012 60)',
  textEm: 'oklch(48% 0.03 40)',
  textQuote: 'oklch(45% 0.09 30)',
  textLink: 'oklch(48% 0.08 250)',
  accent: 'oklch(42% 0.09 35)',
  onAccent: 'oklch(98% 0.005 80)',
  border: 'oklch(89% 0.01 80)',
  borderStrong: 'oklch(70% 0.015 80)',
  bubbleUser: 'oklch(94% 0.015 60)',
  bubbleBot: 'oklch(99% 0.005 80)',
  danger: 'oklch(52% 0.18 25)',
  success: 'oklch(55% 0.12 150)',
  warning: 'oklch(70% 0.14 75)',
  shadow: 'oklch(20% 0.02 60 / 0.18)',
  scrim: 'oklch(20% 0.02 60 / 0.4)',
};

export const DARK_COLORS: Record<ColorKey, string> = {
  bg: 'oklch(16% 0.008 260)',
  surface: 'oklch(19.5% 0.008 260)',
  surfaceRaised: 'oklch(24% 0.01 260)',
  surfaceSunken: 'oklch(13% 0.008 260)',
  text: 'oklch(90% 0.01 80)',
  textSecondary: 'oklch(68% 0.01 80)',
  textMuted: 'oklch(52% 0.01 80)',
  textEm: 'oklch(72% 0.03 70)',
  textQuote: 'oklch(80% 0.08 75)',
  textLink: 'oklch(75% 0.08 230)',
  accent: 'oklch(78% 0.09 80)',
  onAccent: 'oklch(18% 0.01 80)',
  border: 'oklch(28% 0.01 260)',
  borderStrong: 'oklch(45% 0.01 260)',
  bubbleUser: 'oklch(23% 0.012 260)',
  bubbleBot: 'oklch(19.5% 0.008 260)',
  danger: 'oklch(68% 0.17 25)',
  success: 'oklch(72% 0.13 150)',
  warning: 'oklch(80% 0.14 80)',
  shadow: 'oklch(0% 0 0 / 0.5)',
  scrim: 'oklch(0% 0 0 / 0.55)',
};

export const PAPER: ThemeInput = {
  name: 'Paper',
  appearance: 'light',
  typography: { body: 'serif', ui: 'sans', leading: 'relaxed' },
};

export const INK: ThemeInput = {
  name: 'Ink',
  appearance: 'dark',
  typography: { body: 'sans', ui: 'sans', leading: 'normal' },
};

export const BUILTIN_THEMES: readonly Theme[] = [PAPER, INK].map(parseTheme);

export function builtinTheme(name: string): Theme | undefined {
  return BUILTIN_THEMES.find((t) => t.name === name);
}
