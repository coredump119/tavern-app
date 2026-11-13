import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FORMAT_POWER_USER,
  REGEX_PLACEMENT,
  createMessageFormatter,
  decodeStyleTags,
  encodeStyleTags,
  fixMarkdown,
} from '../src/index.js';

const fmt = (over: Partial<typeof DEFAULT_FORMAT_POWER_USER> = {}, extra = {}) =>
  createMessageFormatter({
    powerUser: { ...DEFAULT_FORMAT_POWER_USER, ...over },
    substitute: (t) => t.replaceAll('{{user}}', '旅人'),
    ...extra,
  });
const bot = { chName: 'Lune', isSystem: false, isUser: false, messageId: -1 };

describe('fixMarkdown（ST power-user.js 文档用例）', () => {
  it('把成对星号内侧的空格挪到外面', () => {
    expect(fixMarkdown('^example *text *\n', true)).toBe('^example *text*\n');
    expect(fixMarkdown('^* example * text\n', true)).toBe('^*example* text\n');
    expect(fixMarkdown('^example * text* * harder problem *\n', true)).toBe(
      '^example *text* *harder problem*\n',
    );
  });
  it('只在显示时补未配对的 * 和 "', () => {
    expect(fixMarkdown('*broken\n"quote', true)).toBe('*broken*\n"quote"');
    expect(fixMarkdown('*broken\n"quote', false)).toBe('*broken\n"quote');
  });
});

describe('messageFormatting 移植', () => {
  it('对白进 <q>，动作进 <em>，段落按 simpleLineBreaks', () => {
    const html = fmt().format('*雨没停。*\n"你来晚了。"她没抬头。', bot);
    expect(html).toBe('<p><em>雨没停。</em><br />\n<q>"你来晚了。"</q>她没抬头。</p>');
  });
  it('中文弯引号与角括号都算对白', () => {
    const html = fmt().format('“弯”「角」『白』«法»＂全＂', bot);
    expect(html).toBe('<p><q>“弯”</q><q>「角」</q><q>『白』</q><q>«法»</q><q>＂全＂</q></p>');
  });
  it('单下划线斜体，snake_case 不受影响', () => {
    const html = fmt().format('_single_ and snake_case_word and __bold__', bot);
    // showdown `underline: true`（ST 同）：__x__ 是下划线不是粗体
    expect(html).toBe('<p><em>single</em> and snake_case_word and <u>bold</u></p>');
  });
  it('代码块里的 &amp; 还原、换行保留、引号不高亮', () => {
    const html = fmt().format('```js\nconst a = 1 & 2; // "x"\n```', bot);
    expect(html).toContain('<code class="js language-js">const a = 1 & 2; // "x"\n</code>');
    expect(html).not.toContain('<q>');
  });
  it('推理前后缀转义成可见文本（只替换第一处）', () => {
    const html = fmt().format('<think>想</think> 答 <think>', bot);
    expect(html).toContain('&lt;think&gt;想&lt;/think&gt; 答 ');
    // 只替换第一处：第二个 <think> 仍是原始标签，留给消毒器处理
    expect(html.match(/&lt;think&gt;/g)?.length).toBe(1);
    expect(html).toContain('<think>');
  });
  it('allow_name2_display=false 时剥掉行首「角色名:」', () => {
    // ST 在 makeHtml 之后才剥名字：首行前面是 <p> 不算行首，所以只剥掉换行后的那个（含其后空格保留）
    expect(fmt().format('Lune: 你好\nLune: 再见', bot)).toBe('<p>Lune: 你好<br />\n 再见</p>');
    expect(fmt({ allow_name2_display: true }).format('Lune: 你好', bot)).toBe('<p>Lune: 你好</p>');
    expect(fmt().format('Lune: 你好', { ...bot, isUser: true })).toBe('<p>Lune: 你好</p>');
  });
  it('第 0 楼开场白做宏替换，其它楼层不做', () => {
    expect(fmt().format('你好 {{user}}', { ...bot, messageId: 0 })).toBe('<p>你好 旅人</p>');
    expect(fmt().format('你好 {{user}}', { ...bot, messageId: 1 })).toBe('<p>你好 {{user}}</p>');
  });
  it('系统用户的消息不走 Markdown；Note 与隐藏消息照常', () => {
    const sys = { chName: 'SillyTavern System', isSystem: true, isUser: false, messageId: 2 };
    expect(fmt().format('*raw* "q"', sys)).toBe('*raw* "q"');
    expect(fmt().format('*md*', { ...sys, chName: 'Note' })).toBe('<p><em>md</em></p>');
    expect(fmt().format('*md*', { ...sys, chName: 'Lune' })).toBe('<p><em>md</em></p>');
  });
  it('encode_tags 把尖括号转义（行首 > 引用除外）', () => {
    const html = fmt({ encode_tags: true }).format('<b>x</b>\n> quote', bot);
    expect(html).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>\n<blockquote>\n  <p>quote</p>\n</blockquote>');
  });
  it('标签属性里的双引号不被当成对白', () => {
    const html = fmt().format('<span class="a">"hi"</span>', bot);
    expect(html).toBe('<p><span class="a"><q>"hi"</q></span></p>');
  });
  it('<style> 被编码成 <custom-style>（消毒前）', () => {
    const html = fmt().format('<style>.a{color:red}</style>文', bot);
    expect(html).toContain('<custom-style>');
    expect(html).not.toContain('<style>');
  });
  it('正则 depth 跳过 is_system，placement 按 user / narrator / ai', () => {
    const applyRegex = vi.fn(
      (t: string, _placement: number, _params: { depth: number | undefined }) => t,
    );
    const chat = [
      { is_system: false },
      { is_system: true },
      { is_system: false, extra: { type: 'narrator' } },
      { is_system: false },
    ];
    const f = fmt({}, { applyRegex });
    f.format('a', { ...bot, messageId: 0, chat });
    f.format('b', { ...bot, messageId: 2, chat });
    f.format('c', { ...bot, messageId: 3, chat, isUser: true });
    f.format('d', { ...bot, messageId: 1, chat });
    expect(applyRegex.mock.calls.map((c) => [c[1], c[2].depth])).toEqual([
      [REGEX_PLACEMENT.AI_OUTPUT, 2],
      [REGEX_PLACEMENT.SLASH_COMMAND, 1],
      [REGEX_PLACEMENT.USER_INPUT, 0],
      [REGEX_PLACEMENT.AI_OUTPUT, undefined],
    ]);
  });
  it('非 Markdown 字符串独占一行时不被解析', () => {
    // auto_fix 会把单独一行的 *** 补成 ****（奇数个星号），所以这里关掉它单测扩展本身
    const html = fmt({
      markdown_escape_strings: '***,{{user}}',
      auto_fix_generated_markdown: false,
    }).format('***\n*x*\n旅人\n', bot);
    expect(html).toContain('***');
    expect(html).not.toContain('<hr');
  });
});

describe('style tags', () => {
  it('选择器加前缀、class 加 custom-、去 @import、无外链时去掉 :// 声明', () => {
    const encoded = encodeStyleTags(
      '<style>@import url(x.css); .foo .bar:not(.baz) { color: red; background: url(http://a/b.png) } @media (min-width: 1px) { .q { color: blue } }</style>',
    );
    const out = decodeStyleTags(encoded, { mediaAllowed: false });
    expect(out).toContain('.mes_text .custom-foo .custom-bar:not(.custom-baz)');
    expect(out).toContain('.mes_text .custom-q');
    expect(out).not.toContain('@import');
    expect(out).not.toContain('http://a/b.png');
    expect(out).toContain('color: red');
  });
  it('允许外链时保留 url 声明', () => {
    const out = decodeStyleTags(
      encodeStyleTags('<style>.a{background:url(http://a/b.png)}</style>'),
      {
        mediaAllowed: true,
      },
    );
    expect(out).toContain('http://a/b.png');
  });
});
