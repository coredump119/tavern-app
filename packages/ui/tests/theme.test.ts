import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_THEMES,
  COLOR_KEYS,
  exportStTheme,
  compositeOver,
  evalArith,
  importAnyTheme,
  importAnyThemes,
  importStTheme,
  importStThemes,
  parseColor,
  parseTheme,
  readRootVars,
  resolveCssValue,
  safeParseTheme,
  themeToCssVars,
  themeToDataAttrs,
} from '../src/index.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/st-theme-sample.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>;

describe('tm-theme schema', () => {
  it('fills every default from just a name', () => {
    const t = parseTheme({ name: 'Minimal' });
    expect(t.format).toBe('tm-theme');
    expect(t.typography.body).toBe('serif');
    expect(t.typography.ui).toBe('sans');
    expect(t.layout.chatMeasure).toBe(68);
    expect(t.effects.shadow).toBe(0);
    expect(t.customCss).toBe('');
  });
  it('rejects unknown keys and bad ranges', () => {
    expect(safeParseTheme({ name: 'x', bogus: 1 }).success).toBe(false);
    expect(safeParseTheme({ name: 'x', typography: { scale: 3 } }).success).toBe(false);
    expect(safeParseTheme({}).success).toBe(false);
  });
  it('built-ins are valid and distinct', () => {
    expect(BUILTIN_THEMES.map((t) => t.name)).toEqual(['Paper', 'Ink']);
    expect(BUILTIN_THEMES[1]!.appearance).toBe('dark');
  });
});

describe('themeToCssVars', () => {
  it('emits every color token and no undefined', () => {
    for (const t of BUILTIN_THEMES) {
      const vars = themeToCssVars(t);
      for (const k of COLOR_KEYS) {
        const name = `--tm-color-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
        expect(vars[name], name).toBeTruthy();
      }
      expect(Object.values(vars).some((v) => v === 'undefined' || v === '')).toBe(false);
    }
  });
  it('switches body font track', () => {
    expect(
      themeToCssVars(parseTheme({ name: 'a', typography: { body: 'sans' } }))['--tm-font-body'],
    ).toBe('var(--tm-font-sans)');
    expect(themeToDataAttrs(parseTheme({ name: 'a' }))['data-tm-body-font']).toBe('serif');
  });
});

const azure = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/st-theme-azure.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>;
const rgb = (s: string | undefined) => {
  const c = parseColor(s ?? '');
  return c
    ? [Math.round(c.r), Math.round(c.g), Math.round(c.b), Math.round(c.a * 100) / 100]
    : null;
};

describe('ST theme import', () => {
  it('maps colors, scale and appearance from a real ST theme', () => {
    const t = importStTheme(fixture);
    expect(t.name).toBe(fixture['name']);
    expect(t.appearance).toBe('light');
    // the sample overrides the SmartTheme variables in custom_css: those win over the ten fields
    expect(rgb(t.colors.text)).toEqual([34, 48, 42, 1]); // --s-ink (main_text_color says 10,10,10)
    expect(rgb(t.colors.accent)).toEqual([63, 122, 92, 1]); // --s-accent via --SmartThemeUnderlineColor
    expect(rgb(t.colors.bubbleUser)).toEqual([232, 239, 230, 1]); // --s-sunken
    expect(rgb(t.colors.border)).toEqual([211, 222, 208, 1]); // --s-line (border_color says 200)
    expect(t.typography.scale).toBe(fixture['font_scale']);
    expect(t.effects.shadow).toBe(0); // noShadows: true
    expect(t.layout.chatWidth).toBe(fixture['chat_width']);
    expect(t.customCss).toBe(fixture['custom_css']);
    expect(t.customCssEnabled).toBe(true); // DEV_NOTES §9.28: on by default, appearance-only
    expect(t.customCssLayout).toBe(false);
    expect(t.st['toastr_position']).toBe(fixture['toastr_position']);
  });
  it('round-trips losslessly back to ST', () => {
    expect(exportStTheme(importStTheme(fixture))).toEqual(fixture);
    // ST's bundled Azure omits a few power_user fields; export fills them with ST defaults
    expect(exportStTheme(importStTheme(azure))).toMatchObject(azure);
  });
  it('flattens transparent tints over ST page color so nothing imports as see-through (Azure)', () => {
    // chat_tint_color is rgba(23,23,23,0): ST shows its dark page behind it
    const t = importStTheme(azure);
    expect(t.appearance).toBe('dark');
    expect(rgb(t.colors.bg)).toEqual([36, 36, 37, 1]);
    const surface = rgb(t.colors.surface)!;
    expect(surface[3]).toBe(1);
    expect(surface[0]).toBeLessThan(36); // blur tint rgba(23,30,33,.61) over the page
    expect(t.colors.textSecondary).toBeTruthy();
    expect(t.colors.surfaceSunken).toBeTruthy();
    expect(rgb(t.colors.accent)).toEqual(rgb(azure['underline_text_color'] as string));
    expect(rgb(t.colors.onAccent)![0]).toBeLessThan(60); // light accent → dark text on it
    expect(compositeOver({ r: 255, g: 0, b: 0, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 })).toEqual({
      r: 127.5,
      g: 0,
      b: 0,
      a: 1,
    });
  });
  it('a dark prefers-color-scheme block yields a second 夜间 variant with its own palette and fonts', () => {
    const themes = importStThemes(fixture);
    expect(themes.map((t) => t.name)).toEqual([fixture['name'], `${fixture['name']} · 夜间`]);
    const [light, dark] = themes;
    expect(dark!.appearance).toBe('dark');
    expect(rgb(dark!.colors.text)).toEqual([226, 236, 229, 1]);
    expect(rgb(dark!.colors.accent)).toEqual([140, 199, 166, 1]);
    expect(rgb(dark!.colors.bg)![0]).toBeLessThan(40);
    // .mes_text uses var(--s-body) = var(--s-serif): a serif body track with the theme's stack
    expect(light!.typography.body).toBe('serif');
    expect(light!.typography.serif).toContain('Noto Serif SC');
    expect(light!.typography.ui).toBe('sans'); // --mainFontFamily: var(--s-sans)
    expect(light!.typography.sans).toContain('PingFang SC');
    // the sample paints `html, body { background: var(--s-paper) }`: the page under the tints is the paper,
    // not ST's grey, so the light bg stays paper-white instead of being dimmed by the 4% transparency
    expect(rgb(light!.colors.bg)).toEqual([247, 250, 246, 1]);
    expect(importAnyThemes(azure)).toHaveLength(1);
    // the ten ST strings survive in `st` for export even though colors were re-derived
    expect(light!.st['main_text_color']).toBe(fixture['main_text_color']);
  });
  it('detects format automatically', () => {
    expect(importAnyTheme(fixture).format).toBe('tm-theme');
    expect(importAnyTheme({ name: 'tm', format: 'tm-theme' }).name).toBe('tm');
  });
  it('infers appearance from the composited page/background, not the panel tint', () => {
    expect(importStTheme({ name: 'd', chat_tint_color: 'rgba(23, 23, 23, 1)' }).appearance).toBe(
      'dark',
    );
    expect(
      importStTheme({ name: 'l', chat_tint_color: 'rgba(250, 248, 246, 0.9)' }).appearance,
    ).toBe('light');
    // no fields at all: ST's own page color → dark
    expect(importStTheme({ name: 'x' }).appearance).toBe('dark');
  });
});

describe('derived accent', () => {
  it('falls back from a low-contrast underline color to the quote color', () => {
    // near-white underline on a light page, grey quote color
    const t = importStTheme({
      name: 'light',
      chat_tint_color: 'rgba(231, 228, 223, 1)',
      main_text_color: 'rgba(154, 146, 137, 1)',
      underline_text_color: 'rgba(230, 230, 230, 1)',
      quote_text_color: 'rgba(154, 146, 137, 1)',
    });
    expect(rgb(t.colors.accent)).toEqual([154, 146, 137, 1]);
    expect(t.appearance).toBe('light');
  });
});

describe('custom_css root variables', () => {
  it('reads :root declarations, splits the dark media block and resolves var()/calc() chains', () => {
    const vars = readRootVars(`
      /* c */ :root { --a: #112233; --b: var(--a); --c: rgba(var(--rgb), calc(0.5 * (1 - var(--k)))); --rgb: 1, 2, 3; --k: 0; }
      @media (prefers-color-scheme: dark) { :root { --a: #ffffff !important; } .x { --ignored: 1 } }
      .mes_text { font-family: var(--f) !important; } :root { --f: "Noto Serif SC", serif; }
      html, body { background-color: var(--a) !important; }
      @media (prefers-color-scheme: dark) { body { background: #101010 } }
    `);
    expect(vars.page.light).toBe('var(--a)');
    expect(vars.page.dark).toBe('#101010');
    expect(vars.light.get('--a')).toBe('#112233');
    expect(vars.dark.get('--a')).toBe('#ffffff');
    expect(resolveCssValue('var(--b)', vars.light)).toBe('#112233');
    expect(resolveCssValue('var(--b)', vars.dark, vars.light)).toBe('#ffffff');
    expect(resolveCssValue('var(--c)', vars.light)).toBe('rgba(1, 2, 3, 0.5)');
    expect(resolveCssValue('var(--missing)', vars.light)).toBeNull();
    expect(resolveCssValue('var(--missing, red)', vars.light)).toBe('red');
    expect(resolveCssValue(vars.fonts.mesText!, vars.light)).toBe('"Noto Serif SC", serif');
    expect(evalArith('0.96 * (1 - 0)')).toBe(0.96);
    expect(evalArith('1px + 2')).toBeNull();
  });
  it('maps chat_display and avatar_style both ways with ST enum values', () => {
    const t = importStTheme({ name: 'x', chat_display: 2, avatar_style: 3 });
    expect(t.layout.chatStyle).toBe('document');
    expect(t.shape.avatar).toBe('rounded');
    const back = exportStTheme(t);
    expect(back['chat_display']).toBe(2);
    expect(back['avatar_style']).toBe(3);
    expect(importStTheme({ name: 'y', avatar_style: 1 }).shape.avatar).toBe('rectangle');
    expect(
      exportStTheme(parseTheme({ name: 'z', layout: { chatStyle: 'bubbles' } }))['chat_display'],
    ).toBe(1);
  });
  it('old files with the dropped bubble-shape field still parse; new background section defaults', () => {
    const t = parseTheme({ name: 'old', shape: { bubble: 'round' } });
    expect(t.background).toEqual({ avatar: false, opacity: 0.25, blur: 0, keepOriginal: true });
    expect(t.layout.immersiveChat).toBe(true);
    const vars = themeToCssVars(parseTheme({ name: 'r', shape: { avatar: 'rectangle' } }));
    expect(vars['--tm-avatar-height']).toContain('1.5');
    expect(themeToDataAttrs(t)['data-tm-immersive']).toBe('true');
  });
});
