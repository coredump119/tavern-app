/** The document a card block is rendered as (DEV_NOTES §9.5); pure string building. */
import type { SlotContent } from '../protocol.js';

/** TavernHelper's base rules: the frame is as tall as its content and never scrolls on its own */
const BASE_STYLE =
  '*,*::before,*::after{box-sizing:border-box}' +
  'html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important}';

const escapeAttr = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const cssUrl = (url: string) =>
  url.replace(/[\\"\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);

/**
 * `min-height: 100vh` inside a frame sized to its content would grow forever, so it is tied to
 * the real viewport instead: `calc(var(--TH-viewport-height) * N / 100)`.
 */
export function rewriteViewportUnits(html: string): string {
  return html.replace(
    /(min-height\s*:\s*)(\d+(?:\.\d+)?)vh/gi,
    (_all, head: string, n: string) => `${head}calc(var(--TH-viewport-height) * ${n} / 100)`,
  );
}

/** What a document may get on top of jQuery; every file is served by the realm under `/th/lib/` */
export type LibName = 'fontawesome' | 'tailwind' | 'jquery-ui' | 'vue' | 'vue-router';

export interface DocumentLibs {
  /** absolute URL of `/th/lib/`, with the trailing slash */
  base: string;
}

/** Keys in load order: `VueRouter` reads the `Vue` global, jQuery UI the jQuery loaded before. */
export const LIB_FILES: Record<LibName, readonly string[]> = {
  fontawesome: ['fontawesome/css/all.min.css'],
  tailwind: ['tailwindcss.min.js'],
  'jquery-ui': ['jquery-ui.min.js', 'jquery-ui/theme.css', 'jquery.ui.touch-punch.min.js'],
  vue: ['vue.global.prod.js'],
  'vue-router': ['vue-router.global.prod.js'],
};
const ALL_LIBS = Object.keys(LIB_FILES) as LibName[];
/** what upstream puts in a script frame; the others only matter in a document that is shown */
const SCRIPT_LIBS: readonly LibName[] = ['vue', 'vue-router'];

/**
 * Code fetched at run time cannot be inspected, and bundles built from upstream's template take
 * `Vue` and friends from globals: such a document gets everything, as it would upstream. Imports
 * from an npm CDN are single libraries, not such bundles.
 */
const REMOTE_CODE = new RegExp(
  [
    String.raw`\bimport\s*\(?\s*["'\`]URL`,
    String.raw`\bfrom\s*["'\`]URL`,
    String.raw`\.load\s*\(\s*["'\`]URL`,
    String.raw`<script\b[^<>]*\btype\s*=\s*["']?module\b[^<>]*\bsrc\s*=\s*["']?URL`,
    String.raw`<script\b[^<>]*\bsrc\s*=\s*["']?URL[^<>]*\btype\s*=\s*["']?module\b`,
  ]
    .join('|')
    .replaceAll(
      'URL',
      String.raw`https?:\/\/(?![^"'\`\s>]*(?:\/npm\/|esm\.sh|esm\.run|unpkg\.com|cdnjs\.|skypack\.|jspm\.))`,
    ),
  'i',
);

const VUE = /\bVue\b|\bcreateApp\s*\(|\sv-(?:if|else|for|model|show|bind|on|html|text|cloak)\b/;
const VUE_ROUTER =
  /\bVueRouter\b|\bcreateRouter\s*\(|<router-(?:view|link)\b|<Router(?:View|Link)\b/;
/** widget and interaction methods, the widget classes, effects and the easings jQuery lacks */
const JQUERY_UI = new RegExp(
  String.raw`\.(?:draggable|droppable|resizable|selectable|sortable|accordion|autocomplete` +
    String.raw`|checkboxradio|controlgroup|datepicker|dialog|progressbar|selectmenu|slider|spinner` +
    String.raw`|tabs|tooltip|effect)\s*\(` +
    String.raw`|\bui-(?:widget|state|corner|icon|helper|draggable|resizable|sortable|dialog|tabs)\b` +
    String.raw`|(?:\$|jQuery)\.(?:ui|widget)\b` +
    String.raw`|\bease(?:In|Out|InOut)(?:Quad|Cubic|Quart|Quint|Expo|Sine|Circ|Elastic|Back|Bounce)\b`,
);
const FONT_AWESOME = /\bfa-(?:solid|regular|brands)\b|\bfa[srb]?\s+fa-[a-z]/;
/** the card links its own copy: ours would only be parsed and then overridden */
const OWN_FONT_AWESOME =
  /(?:href\s*=\s*["']?|url\(\s*["']?|@import\s+["'])[^"'\s>)]*font-?awesome/i;
const OWN_TAILWIND = /<script\b[^<>]*\bsrc\s*=\s*["']?[^"'\s>]*tailwind/i;

const TW_COLOR =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue' +
  '|indigo|violet|purple|fuchsia|pink|rose';
const TW_COMMON =
  '(?:flex-(?:col|row|wrap|1)|items-(?:center|start|end|stretch)' +
  '|justify-(?:center|between|around|evenly|start|end)|rounded-(?:sm|md|lg|xl|[23]xl|full)' +
  String.raw`|[pm][xytrbl]?-\d+(?:\.5)?|gap-\d+|space-[xy]-\d+|[wh]-(?:full|screen|\d+)` +
  String.raw`|text-(?:xs|sm|base|lg|[2-9]?xl)|font-(?:medium|semibold|bold)|grid-cols-\d+` +
  String.raw`|shadow-(?:sm|md|lg|xl|2xl))(?![\w-])`;
/**
 * Utility classes cannot be told from a card's own class names in general, so beyond the word
 * itself only shapes that are tailwind's alone count: a palette colour (`bg-slate-800`), a variant
 * (`md:flex`, `hover:bg-…`), an arbitrary value (`w-[320px]`), or two everyday utilities in one
 * `class` attribute. No lookbehind: the build still targets Safari 15.
 */
const TAILWIND: readonly RegExp[] = [
  /tailwind|@apply\b/i,
  new RegExp(
    String.raw`\b(?:bg|text|border|ring|from|via|to|fill|stroke|divide|outline|shadow|decoration` +
      String.raw`|accent)-(?:${TW_COLOR})-(?:50|[1-9]00|950)\b` +
      String.raw`|[\s"'\`](?:sm|md|lg|xl|2xl|hover|focus|active|dark|group-hover):` +
      String.raw`(?:[a-z]+-[a-z0-9[]|(?:flex|grid|hidden|block|inline|underline)\b)` +
      String.raw`|\b(?:w|h|min-w|max-w|min-h|max-h|size|p[xytrbl]?|m[xytrbl]?|gap|top|left|right` +
      String.raw`|bottom|inset|bg|text|border|rounded|z|leading|tracking|grid-cols|translate-[xy])` +
      String.raw`-\[[^\]\s"'<>]+\]`,
  ),
  new RegExp(
    String.raw`\bclass(?:Name)?\s*=\s*(["'\`])(?:(?:(?!\1)[^])*?\s)?${TW_COMMON}` +
      String.raw`(?:(?!\1)[^])*?\s${TW_COMMON}`,
  ),
];

const SIGNALS: Record<LibName, (source: string) => boolean> = {
  fontawesome: (source) => FONT_AWESOME.test(source) && !OWN_FONT_AWESOME.test(source),
  tailwind: (source) =>
    !OWN_TAILWIND.test(source) && TAILWIND.some((signal) => signal.test(source)),
  'jquery-ui': (source) => JQUERY_UI.test(source),
  vue: (source) => VUE.test(source) || VUE_ROUTER.test(source),
  'vue-router': (source) => VUE_ROUTER.test(source),
};

/**
 * Which libraries a card's HTML or a script's text asks for, in load order. Upstream loads all of
 * them into every frame; on a phone that is too much for the many cards that use none, so they
 * are loaded on evidence. What this misses a card can still load itself.
 */
export function detectLibs(source: string, among: readonly LibName[] = ALL_LIBS): LibName[] {
  if (REMOTE_CODE.test(source)) return [...among];
  return among.filter((name) => SIGNALS[name](source));
}

function libTags(names: readonly LibName[], libs: DocumentLibs): string {
  return names
    .flatMap((name) => LIB_FILES[name])
    .map((file) => {
      const url = escapeAttr(libs.base + file);
      return file.endsWith('.css')
        ? `<link rel="stylesheet" href="${url}">`
        : `<script src="${url}"></script>`;
    })
    .join('');
}

function avatarRule(selector: string, url: string | null): string {
  return url ? `${selector}{background-image:url("${cssUrl(url)}")}` : '';
}

/**
 * The card's HTML behind a prefix that installs the API before any card script runs. The prefix
 * leaves `<head>` open: the parser folds the card's own `<html>` / `<head>` / `<body>` into it,
 * and the leading doctype keeps the page in standards mode, which the height measurement needs.
 */
export function buildCardDocument(
  content: SlotContent,
  jqueryUrl: string,
  libs?: DocumentLibs,
): string {
  const style =
    BASE_STYLE +
    `:root{--TH-viewport-height:${Math.max(0, Math.round(content.viewportHeight))}px}` +
    avatarRule('.user_avatar,.user-avatar', content.avatars.user) +
    avatarRule('.char_avatar,.char-avatar', content.avatars.char);
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style>${style}</style>` +
    '<script>window.parent.__tmSlot.install(window)</script>' +
    `<script src="${escapeAttr(jqueryUrl)}"></script>` +
    (libs ? libTags(detectLibs(content.html), libs) : '') +
    rewriteViewportUnits(content.html)
  );
}

/**
 * The document a library script runs in: no markup of its own, the content is one module script
 * (as upstream), so `import` and top-level `await` work. A `</script` inside the code would end
 * the element early; inside JS `<\/script` means the same thing.
 */
export function buildScriptDocument(
  content: string,
  jqueryUrl: string,
  libs?: DocumentLibs,
): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<script>window.parent.__tmScripts.install(window)</script>' +
    `<script src="${escapeAttr(jqueryUrl)}"></script>` +
    (libs ? libTags(detectLibs(content, SCRIPT_LIBS), libs) : '') +
    `</head><body><script type="module">${content.replace(/<\/script/gi, '<\\/script')}</script>` +
    '</body></html>'
  );
}
