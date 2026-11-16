import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  analyzeCustomCss,
  customCssFonts,
  effectiveCustomCss,
  importStTheme,
  importStThemes,
  isLayoutProperty,
  parseCss,
  parseTheme,
  pinColorScheme,
  sanitizeCustomCss,
  scopeScriptCss,
  serializeCss,
  themeToBodyClasses,
  themeToCssVars,
} from '../src/index.js';

/** synthetic beautification theme (DEV_NOTES §9.28: users' own themes never go in the repo) */
const sample = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/st-theme-sample.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>;

const LIGHT_SAMPLE = `
/* credit line */
@import url("https://fonts.example.com/serif/result.css");
:not([class*="fa-"]):not(.fas), #send_textarea { font-family: HeSimpl Serif VF; }
#send_textarea { resize: none; }
#send_textarea::placeholder { color: transparent !important; text-shadow: none !important; }
#nonQRFormItems:has(#send_textarea:placeholder-shown)::before {
  content: "ꜱᴏꜰᴛ ᴡʜɪᴛᴇ ᴄʟᴏᴜᴅ"; color: #D2CCC8; position: absolute; top: 50%; left: 55%;
  transform: translate(-50%, -50%); font-size: 0.6em; pointer-events: none; z-index: 10;
}
#send_textarea { clip-path: none !important; background-color: transparent !important; border-color: transparent !important; }
#top-bar { background: rgba(255, 255, 255, 0) !important; width: 100vw; height: 40px; }
@media (max-width: 1000px) { #sheld { width: 100% !important; margin: 0 } .mes { border-radius: 12px; } }
@keyframes pulse { from { opacity: 0 } to { opacity: 1 } }
.drawer-icon.fa-bars::before { content: "\\f0c9"; }
`;

describe('custom_css parsing', () => {
  it('round-trips rules, at-rules and strings with braces / semicolons inside', () => {
    const nodes = parseCss(
      `a { content: "{ ; }"; color: red } @media (x) { b { color: blue } } @import url(a.css);`,
    );
    expect(nodes.map((n) => n.kind)).toEqual(['rule', 'at-block', 'at-statement']);
    const css = serializeCss(nodes);
    expect(css).toContain('content: "{ ; }";');
    expect(css).toContain('@media (x) {');
    expect(css).toContain('@import url(a.css);');
  });
  it('flattens native nesting and keeps the parent declarations', () => {
    const css = serializeCss(parseCss(`.a { color: red; & .b { color: blue } .c { width: 1px } }`));
    expect(css).toContain('.a {\n  color: red;');
    expect(css).toContain('.a .b {');
    expect(css).toContain('.a .c {');
  });
  it('classifies layout vs appearance properties', () => {
    for (const p of [
      'position',
      'width',
      'display',
      'grid-template-columns',
      'margin-top',
      '-webkit-transform',
      'z-index',
      'justify-content',
    ])
      expect(isLayoutProperty(p), p).toBe(true);
    for (const p of [
      'color',
      'background',
      'border-radius',
      'font-family',
      'padding',
      'gap',
      'box-shadow',
      '--x',
      'opacity',
      'backdrop-filter',
    ])
      expect(isLayoutProperty(p), p).toBe(false);
  });
});

describe('appearance-only sanitizer', () => {
  it('keeps colors, fonts, imports, keyframes and drops layout + positioned overlays', () => {
    const out = sanitizeCustomCss(LIGHT_SAMPLE);
    expect(out).toContain('@import url("https://fonts.example.com/serif/result.css");');
    expect(out).toContain('font-family: HeSimpl Serif VF;');
    expect(out).toContain('#send_textarea::placeholder');
    expect(out).toContain('background-color: transparent !important;');
    expect(out).toContain('@keyframes pulse');
    expect(out).toContain('border-radius: 12px;');
    expect(out).toContain('#top-bar {\n  background: rgba(255, 255, 255, 0) !important;\n}');
    // gone: the positioned overlay as a whole, every layout declaration, emptied rules
    expect(out).not.toContain('ꜱᴏꜰᴛ');
    expect(analyzeCustomCss(out).layoutDecls).toBe(0);
    expect(out).toContain('@media (max-width: 1000px)'); // media conditions are not declarations
    expect(out).not.toContain('#sheld');
    expect(out).not.toContain('credit line');
  });
  it('report counts what would be dropped', () => {
    const r = analyzeCustomCss(LIGHT_SAMPLE);
    expect(r.overlays).toBe(1);
    expect(r.imports).toEqual(['https://fonts.example.com/serif/result.css']);
    expect(r.fontAwesomeGlyphs).toBe(1);
    expect(r.layoutDecls).toBeGreaterThanOrEqual(8);
    expect(r.layoutSamples).toContain('#top-bar');
  });
  it('sample theme: every layout declaration is removed, its variables and colors survive', () => {
    const css = String(sample['custom_css']);
    const before = analyzeCustomCss(css);
    expect(before.layoutDecls).toBeGreaterThan(20);
    expect(before.overlays).toBe(1);
    expect(before.fontAwesomeGlyphs).toBe(1);
    const out = sanitizeCustomCss(css);
    expect(analyzeCustomCss(out).layoutDecls).toBe(0);
    expect(out).toContain('--s-accent: #3F7A5C;');
    expect(out).toContain('border-radius: 999px !important;');
    expect(out).not.toContain('grid-template-columns');
    expect(out).toContain('--SmartThemeBodyColor: var(--s-ink) !important;');
    expect(out).toMatch(/prefers-color-scheme: dark/);
    expect(out.length).toBeLessThan(css.length);
  });
});

describe('color scheme follows the theme, not the system', () => {
  const css = `/* note */
:root { --ink: #111; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #eee; }
}
@media screen and (prefers-color-scheme: light) and (max-width: 600px) { .a { color: red; } }
@media (max-width: 600px), (prefers-color-scheme: dark) { .b { color: blue; } }
@media not (prefers-color-scheme: dark) { .c { color: green; } }
.d { color: var(--ink); }`;
  it('dark theme: dark blocks always apply, light ones never', () => {
    const out = pinColorScheme(css, 'dark');
    expect(out).toContain('@media all {\n  :root { --ink: #eee; }');
    expect(out).not.toContain('.a {');
    expect(out).toContain('@media (max-width: 600px), all { .b');
    expect(out).toContain('@media not (prefers-color-scheme: dark) { .c');
    expect(out).toContain('.d { color: var(--ink); }');
  });
  it('light theme: dark blocks are removed, light conditions dropped from the query', () => {
    const out = pinColorScheme(css, 'light');
    expect(out).not.toContain('#eee');
    expect(out).toContain('@media screen and (max-width: 600px) { .a');
    expect(out).toContain('@media (max-width: 600px) { .b');
    expect(out).toContain(':root { --ink: #111; }');
  });
  it('leaves css without a scheme condition untouched', () => {
    const plain = '/* keep */ @media (max-width: 1px) { .a { color: red; } }';
    expect(pinColorScheme(plain, 'dark')).toBe(plain);
  });
  it('both variants of the sample theme resolve their own variables', () => {
    const [light, dark] = importStThemes(sample);
    expect(effectiveCustomCss(light!)).not.toMatch(/prefers-color-scheme/);
    expect(effectiveCustomCss(dark!)).not.toMatch(/prefers-color-scheme/);
    expect(effectiveCustomCss(dark!).length).toBeGreaterThan(effectiveCustomCss(light!).length);
  });
});

describe('theme ↔ custom css / body classes', () => {
  it('imported ST themes enable custom css in appearance-only mode by default', () => {
    const t = importStTheme(sample);
    expect(t.customCssEnabled).toBe(true);
    expect(t.customCssLayout).toBe(false);
    const eff = effectiveCustomCss(t);
    expect(analyzeCustomCss(eff).layoutDecls).toBe(0);
    expect(effectiveCustomCss({ ...t, customCssLayout: true })).toBe(
      pinColorScheme(t.customCss, t.appearance),
    );
    expect(
      effectiveCustomCss({ ...t, customCss: '#chat { color: red; }', customCssLayout: true }),
    ).toBe('#chat { color: red; }');
    expect(effectiveCustomCss({ ...t, customCssEnabled: false })).toBe('');
  });
  it('body classes follow ST power-user.js', () => {
    const t = parseTheme({
      name: 'x',
      layout: { chatStyle: 'bubbles', showAvatars: false, timestamps: false },
      shape: { avatar: 'rectangle' },
      effects: { reducedMotion: true, blur: 4, shadow: 0.3 },
      st: {
        timer_enabled: false,
        compact_input_area: true,
        mesIDDisplay_enabled: true,
        fast_ui_mode: true,
      },
    });
    expect(themeToBodyClasses(t).sort()).toEqual(
      [
        'big-avatars',
        'bubblechat',
        'compact',
        'hideChatAvatars',
        'no-blur',
        'no-timer',
        'no-timestamps',
        'reduced-motion',
      ].sort(),
    );
    const doc = parseTheme({
      name: 'd',
      layout: { chatStyle: 'document' },
      shape: { avatar: 'square' },
    });
    expect(themeToBodyClasses(doc)).toEqual(
      expect.arrayContaining(['documentstyle', 'square-avatars']),
    );
  });
});

describe('scopeScriptCss', () => {
  it('keeps layout inside message bodies and drops it elsewhere', () => {
    const css = scopeScriptCss(
      '.bar, #chat .mes_text .own { display: flex; color: red; } #send_form { display: none; }',
    );
    const rules = parseCss(css);
    expect(rules).toEqual([
      {
        kind: 'rule',
        selector: '.mes_text .bar, #chat .mes_text .own',
        decls: [
          { prop: 'display', value: 'flex' },
          { prop: 'color', value: 'red' },
        ],
      },
      { kind: 'rule', selector: '.bar', decls: [{ prop: 'color', value: 'red' }] },
      {
        kind: 'rule',
        selector: '.mes_text #send_form',
        decls: [{ prop: 'display', value: 'none' }],
      },
    ]);
  });

  it('does not split on commas inside :is() and keeps custom properties on the page', () => {
    const css = scopeScriptCss(':is(.a, .b) { margin: 0; } :root { --gap: 4px; }');
    expect(parseCss(css).map((n) => (n.kind === 'rule' ? n.selector : n.kind))).toEqual([
      '.mes_text :is(.a, .b)',
      '.mes_text :root',
      ':root',
    ]);
  });

  it('drops @import, keeps @keyframes and recurses into @media', () => {
    const css = scopeScriptCss(
      '@import url("https://x.example/a.css"); @keyframes spin { to { rotate: 1turn; } } ' +
        '@media (min-width: 600px) { .bar { width: 50%; } }',
    );
    expect(css).not.toContain('@import');
    expect(css).toContain('@keyframes spin');
    expect(css).toContain('.mes_text .bar');
    expect(css).not.toMatch(/^\s*\.bar/m);
  });

  it('returns nothing for blank input', () => {
    expect(scopeScriptCss('  \n')).toBe('');
  });
});

describe('page-wide fonts set by custom css', () => {
  it('reads --mainFontFamily / --monoFontFamily and a font-family on body, html, :root or *', () => {
    expect(
      customCssFonts(':root { --mainFontFamily: "Lora", serif; --monoFontFamily: Menlo }'),
    ).toEqual({ main: '"Lora", serif', mono: 'Menlo' });
    expect(customCssFonts('html, body { font-family: Georgia, serif !important; }').main).toBe(
      'Georgia, serif',
    );
    expect(customCssFonts('@media (min-width: 1px) { * { font-family: "A B" } }').main).toBe(
      '"A B"',
    );
  });

  it('prefers the variable, lets later rules win, ignores narrower selectors and self-references', () => {
    expect(
      customCssFonts(
        'body { font-family: One } :root { --mainFontFamily: Two } body { font-family: Three }',
      ).main,
    ).toBe('Two');
    expect(customCssFonts('body { font-family: One } body { font-family: Two }').main).toBe('Two');
    expect(customCssFonts('.mes_text { font-family: X } body.foo { font-family: Y }')).toEqual({});
    expect(
      customCssFonts('body { font-family: var(--mainFontFamily) } * { font-family: inherit }'),
    ).toEqual({});
  });

  it('puts the css font in front of the theme font, only while the css is on', () => {
    const base = parseTheme({ name: 't', customCss: 'body { font-family: "Lora", serif }' });
    const on = themeToCssVars(base);
    expect(on['--tm-font-body']).toBe('"Lora", serif, var(--tm-font-serif)');
    expect(on['--tm-font-ui']).toBe('"Lora", serif, var(--tm-font-sans)');
    const off = themeToCssVars(parseTheme({ ...base, customCssEnabled: false }));
    expect(off['--tm-font-body']).toBe('var(--tm-font-serif)');
  });
});
