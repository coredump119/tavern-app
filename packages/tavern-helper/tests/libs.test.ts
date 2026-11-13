import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createToastr, sharedLibraries } from '../src/realm/libs.js';
import {
  buildCardDocument,
  buildScriptDocument,
  detectLibs,
  LIB_FILES,
  type LibName,
} from '../src/realm/srcdoc.js';

const BASE = 'tmhelper://localhost/th/lib/';
const JQUERY = 'tmhelper://localhost/assets/jquery.js';

describe('detectLibs', () => {
  const cases: [string, string, LibName[]][] = [
    ['plain markup', '<div class="card"><p>hello {{user}}</p></div>', []],
    ['own class names', '<div class="flex-box header-1 text-main p-main">x</div>', []],
    ['mustaches alone', '<p>{{ name }}</p><script>render()</script>', []],
    ['the Vue global', '<script>const { createApp, ref } = Vue;</script>', ['vue']],
    ['createApp', '<script type="module">createApp({}).mount("#app")</script>', ['vue']],
    ['a directive', '<li v-for="item in items">{{ item }}</li>', ['vue']],
    ['a word that only contains Vue', '<script>const myVueish = Vuex</script>', []],
    ['the router global', '<script>VueRouter.createRouter({})</script>', ['vue', 'vue-router']],
    ['a router element', '<router-view></router-view>', ['vue', 'vue-router']],
    ['an interaction', '<script>$("#box").draggable({ handle: ".bar" })</script>', ['jquery-ui']],
    ['a widget', '<script>$(".panel").tabs ()</script>', ['jquery-ui']],
    ['a widget class', '<div class="ui-widget ui-corner-all">x</div>', ['jquery-ui']],
    [
      'an easing',
      '<script>$("#a").animate({ top: 0 }, 300, "easeOutBounce")</script>',
      ['jquery-ui'],
    ],
    ['jQuery core alone', '<script>$("#a").on("click", () => $("#b").slideToggle())</script>', []],
    ['a style prefix', '<i class="fa-solid fa-heart"></i>', ['fontawesome']],
    ['the short prefix', '<i class="fas fa-star"></i>', ['fontawesome']],
    ['the old prefix', "<i class='fa fa-cog'></i>", ['fontawesome']],
    ['an icon name alone', '<i class="fa-heart"></i>', []],
    [
      'its own Font Awesome',
      '<link rel="stylesheet" href="https://cdn.example/font-awesome/6.5.2/css/all.min.css"><i class="fa-solid fa-heart"></i>',
      [],
    ],
    ['the word tailwind', '<style type="text/tailwindcss">.a{color:red}</style>', ['tailwind']],
    ['@apply', '<style>.btn { @apply px-4 py-2; }</style>', ['tailwind']],
    ['a palette colour', '<div class="panel bg-slate-800">x</div>', ['tailwind']],
    ['a variant', '<div class="box md:flex">x</div>', ['tailwind']],
    ['an arbitrary value', '<div class="w-[320px]">x</div>', ['tailwind']],
    ['two utilities in one class', '<div class="flex flex-col items-center">x</div>', ['tailwind']],
    ['one utility-like name', '<div class="p-4">x</div>', []],
    ['utilities in different attributes', '<p class="p-4"></p><p class="note gap-2x"></p>', []],
    [
      'its own tailwind',
      '<script src="/scripts/extensions/third-party/JS-Slash-Runner/lib/tailwindcss.min.js"></script><div class="bg-slate-800">x</div>',
      [],
    ],
    [
      'everything, in load order',
      '<div class="bg-red-500" v-if="open"><i class="far fa-bell"></i></div><script>$("#a").sortable(); VueRouter.createRouter({})</script>',
      ['fontawesome', 'tailwind', 'jquery-ui', 'vue', 'vue-router'],
    ],
  ];
  it.each(cases)('%s', (_name, source, expected) => {
    expect(detectLibs(source)).toEqual(expected);
  });

  const everything: LibName[] = ['fontawesome', 'tailwind', 'jquery-ui', 'vue', 'vue-router'];
  const remote: [string, string][] = [
    [
      'a static import',
      '<script type="module">import \'https://cards.example/ui/index.js\'</script>',
    ],
    ['a dynamic import', '<script>await import("https://cards.example/ui/index.js")</script>'],
    ['a named import', 'import { start } from "https://cards.example/ui/index.js"'],
    ['jQuery load', '<body><script>$("body").load("https://cards.example/ui/index.html")</script>'],
    ['a module script', '<script type="module" src="https://cards.example/ui/index.js"></script>'],
    [
      'a module script, src first',
      '<script src="https://cards.example/a.js" type=module></script>',
    ],
  ];
  it.each(remote)('gives a document that runs unseen code everything: %s', (_name, source) => {
    expect(detectLibs(source)).toEqual(everything);
  });
  it('does not take one library from an npm CDN for unseen card code', () => {
    expect(detectLibs("import dayjs from 'https://cdn.jsdelivr.net/npm/dayjs/+esm'")).toEqual([]);
    expect(detectLibs('import("https://esm.sh/canvas-confetti")')).toEqual([]);
    expect(detectLibs('<script src="https://cards.example/classic.js"></script>')).toEqual([]);
  });
  it('answers only from the set it is asked about', () => {
    const source = '<i class="fas fa-star"></i><script>Vue.createApp({})</script>';
    expect(detectLibs(source, ['vue', 'vue-router'])).toEqual(['vue']);
    expect(detectLibs("import 'https://cards.example/index.js'", ['vue', 'vue-router'])).toEqual([
      'vue',
      'vue-router',
    ]);
  });
  it('gives the same answer every time it is asked', () => {
    const source = '<div class="flex flex-col items-center" v-if="a">x</div>';
    expect(detectLibs(source)).toEqual(detectLibs(source));
  });
  it('stays fast on a large card without any signal', () => {
    const big = '<div class="row item-box"><span style="color:red">text</span></div>\n'.repeat(
      20000,
    );
    const started = performance.now();
    expect(detectLibs(big)).toEqual([]);
    expect(detectLibs('<script '.repeat(30000))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('library tags', () => {
  const card = (html: string) => ({
    name: 'TH-message--1--0',
    html,
    viewportHeight: 800,
    avatars: { user: null, char: null },
  });
  const tags = (doc: string): string[] =>
    [...doc.matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)].map(
      (m) => m[1] ?? '',
    );

  it('adds nothing to a card that asks for nothing', () => {
    const plain = card('<div class="card">x</div>');
    expect(buildCardDocument(plain, JQUERY, { base: BASE })).toBe(buildCardDocument(plain, JQUERY));
  });
  it('adds nothing when the realm has no library folder', () => {
    expect(tags(buildCardDocument(card('<i class="fas fa-star"></i>'), JQUERY))).toEqual([JQUERY]);
    expect(tags(buildScriptDocument('Vue.createApp({})', JQUERY))).toEqual([JQUERY]);
  });
  it('loads what a card uses after jQuery, dependencies first, before the card itself', () => {
    const html =
      '<div id="app" class="bg-zinc-900"><i class="fa-solid fa-gear"></i><router-view></router-view></div>' +
      '<script>$("#app").resizable()</script>';
    const doc = buildCardDocument(card(html), JQUERY, { base: BASE });
    expect(tags(doc)).toEqual([
      JQUERY,
      `${BASE}fontawesome/css/all.min.css`,
      `${BASE}tailwindcss.min.js`,
      `${BASE}jquery-ui.min.js`,
      `${BASE}jquery-ui/theme.css`,
      `${BASE}jquery.ui.touch-punch.min.js`,
      `${BASE}vue.global.prod.js`,
      `${BASE}vue-router.global.prod.js`,
    ]);
    expect(doc.indexOf('vue-router.global.prod.js')).toBeLessThan(doc.indexOf('<div id="app"'));
    expect(doc).toContain(`<link rel="stylesheet" href="${BASE}jquery-ui/theme.css">`);
    expect(doc).toContain(`<script src="${BASE}vue.global.prod.js"></script>`);
  });
  it('gives a script Vue and its router only', () => {
    const code = 'const app = Vue.createApp({}); $("<i class=\\"fas fa-x\\">").dialog();';
    expect(tags(buildScriptDocument(code, JQUERY, { base: BASE }))).toEqual([
      JQUERY,
      `${BASE}vue.global.prod.js`,
    ]);
    const routed = "import 'https://scripts.example/panel/index.js'";
    expect(tags(buildScriptDocument(routed, JQUERY, { base: BASE }))).toEqual([
      JQUERY,
      `${BASE}vue.global.prod.js`,
      `${BASE}vue-router.global.prod.js`,
    ]);
  });
  it('escapes the base it is given', () => {
    const doc = buildScriptDocument('Vue.ref(1)', JQUERY, { base: 'tm://x/"><b>/' });
    expect(doc).toContain('src="tm://x/&quot;>&lt;b>/vue.global.prod.js"');
  });
  it('names only files the copy script provides', () => {
    const copy = readFileSync(new URL('../../../tools/th-libs/copy.mjs', import.meta.url), 'utf8');
    for (const file of Object.values(LIB_FILES).flat()) expect(copy).toContain(`'${file}'`);
  });
});

describe('toastr', () => {
  const hub = () => ({ call: vi.fn((_name: string, _args?: unknown[]) => Promise.resolve(null)) });

  it('forwards every kind as one toast request', () => {
    const h = hub();
    const toastr = createToastr(h as never);
    toastr.success('saved');
    toastr.info('note', 'Title');
    toastr.warning(42, undefined, { timeOut: 1 });
    toastr.error(new Error('boom'), null);
    toastr.info();
    expect(h.call.mock.calls).toEqual([
      ['toast', ['success', 'saved', '']],
      ['toast', ['info', 'note', 'Title']],
      ['toast', ['warning', '42', '']],
      ['toast', ['error', 'Error: boom', '']],
      ['toast', ['info', '', '']],
    ]);
  });
  it('never lets a failed toast reach the script', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const rejecting = createToastr({ call: () => Promise.reject(new Error('no app')) } as never);
    expect(() => rejecting.error('x')).not.toThrow();
    const throwing = createToastr({
      call: () => {
        throw new Error('closed');
      },
    } as never);
    expect(() => throwing.info('x')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
  it('returns something scripts can chain on and await', async () => {
    const toastr = createToastr(hub() as never);
    const toast = toastr.info('x') as {
      remove(): unknown;
      find(selector: string): { on(name: string, fn: () => void): unknown };
      length: number;
    };
    expect(toast.remove()).toBe(toast);
    expect(toast.find('button').on('click', () => undefined)).toBe(toast);
    expect(toast.length).toBe(0);
    expect(String(toast)).toBe('[object Object]');
    expect(await toast).toBe(toast);
  });
  it('accepts clear, remove and option writes without doing anything', () => {
    const h = hub();
    const toastr = createToastr(h as never);
    toastr.options.timeOut = 3000;
    toastr.options = { positionClass: 'toast-top-center' };
    expect(toastr.clear()).toBeUndefined();
    expect(toastr.remove(toastr.info('x'))).toBeUndefined();
    expect(h.call).toHaveBeenCalledTimes(1);
  });
});

describe('shared libraries', () => {
  const libs = sharedLibraries({ call: () => Promise.resolve(null) } as never) as {
    YAML: typeof import('yaml');
    z: typeof import('zod').z;
    showdown: typeof import('showdown');
    toastr: unknown;
  };
  /** an object built by another realm, as a card's own objects are to the hub's libraries */
  const foreign = <T>(code: string): T => runInNewContext(code) as T;

  it('carries the names upstream documents', () => {
    expect(Object.keys(libs).sort()).toEqual(['YAML', 'showdown', 'toastr', 'z']);
  });
  it('validates objects of another realm', () => {
    const schema = libs.z.object({
      name: libs.z.string(),
      tags: libs.z.array(libs.z.string()),
      stats: libs.z.record(libs.z.string(), libs.z.number()),
      level: libs.z.coerce.number().default(1),
    });
    const input = foreign('({ name: "a", tags: ["x", "y"], stats: { hp: 3 }, extra: true })');
    expect(schema.parse(input)).toEqual({
      name: 'a',
      tags: ['x', 'y'],
      stats: { hp: 3 },
      level: 1,
    });
    const bad = schema.safeParse(foreign('({ name: 1, tags: "x", stats: [] })'));
    expect(bad.success).toBe(false);
  });
  it('reports schema errors in Chinese', () => {
    const result = libs.z.string().safeParse(foreign('({})'));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/[一-鿿]/);
  });
  it('reads and writes YAML across realms', () => {
    const value = foreign('({ a: 1, list: [1, "two", { three: null }], text: "多行\\n文本" })');
    const text = libs.YAML.stringify(value);
    expect(libs.YAML.parse(text)).toEqual({
      a: 1,
      list: [1, 'two', { three: null }],
      text: '多行\n文本',
    });
  });
  it('renders markdown', () => {
    const html = new libs.showdown.Converter().makeHtml('**bold** and `code`');
    expect(html).toBe('<p><strong>bold</strong> and <code>code</code></p>');
  });
});
