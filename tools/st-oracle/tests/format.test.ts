/**
 * Phase 4：消息渲染对拍——真实 ST 页面里的 SillyTavern.getContext().messageFormatting() vs
 * @tm/core createMessageFormatter + @tm/ui createMessageSanitizer（jsdom）+ decodeStyleTags，HTML 字符串逐字相同。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { JSDOM } from 'jsdom';
import {
  DEFAULT_FORMAT_POWER_USER,
  createMessageFormatter,
  decodeStyleTags,
  type FormatPowerUser,
} from '@tm/core';
import { createMessageSanitizer } from '@tm/ui';
import {
  locateSillyTavern,
  startDriver,
  startOracle,
  type Oracle,
  type StDriver,
} from '../src/index.js';

const stDir = locateSillyTavern();
const hasChromium = [
  '~/Library/Caches/ms-playwright',
  '~/.cache/ms-playwright',
  process.env['PLAYWRIGHT_BROWSERS_PATH'],
]
  .filter((p): p is string => !!p)
  .some((p) => existsSync(p.replace(/^~/, homedir())));

interface Sample {
  name: string;
  mes: string;
  chName?: string;
  isUser?: boolean;
  isSystem?: boolean;
}

const samples: Sample[] = [
  { name: '动作 + 对白 + 换行', mes: '*雨从傍晚就没停。*\n"你来晚了。"她没有抬头，"茶凉了。"' },
  { name: '各种引号', mes: '“弯引号”和「角括号」以及『白角』、«法引»、＂全角＂、"ascii"' },
  { name: '下划线', mes: '_single_ and snake_case_word and __under__ and **bold**' },
  { name: '代码块', mes: '前文\n```js\nconst a = 1 & 2; // "x" <b>\n```\n后文 `inline & "q"`' },
  {
    name: '表格 / 删除线 / emoji',
    mes: '| a | b |\n|---|---|\n| 1 | 2 |\n\n~~strike~~ :smile: ++ul++',
  },
  { name: '推理前后缀', mes: '<think>想一想</think>\n答案 <think>' },
  { name: '角色名前缀', mes: 'Lune: 你好\nLune: 再见\n旅人: 不剥' },
  { name: '坏星号与未配对引号', mes: '* 动作 * 然后 "未闭合\n*另一行' },
  { name: '未知元素里的换行', mes: '<custom-tag>第一行\n第二行</custom-tag>' },
  {
    name: 'class 前缀与属性里的引号',
    mes: '<span class="foo bar fa-solid">"hi"</span> <div class="monospace">x</div>',
  },
  {
    name: '样式标签',
    mes: '<style>.foo .bar:not(.baz){color:red;background:url(http://a/b.png)} @import url(x.css);</style><div class="foo">样式</div>',
  },
  {
    name: '外链媒体与链接',
    mes: '<img src="https://example.com/a.png"> <a href="https://example.com">链接</a> <img src="/img/x.png">',
  },
  { name: 'LaTeX align', mes: '\\begin{align*} x = 1 \\end{align*}' },
  {
    name: '脚本与事件属性',
    mes: '<script>alert(1)</script><b onclick="x()">加粗</b><a href="javascript:void(0)">js</a>',
  },
  { name: '引用与列表', mes: '> 引用 "对白"\n\n- 一\n- 二\n  - 三\n\n1. 甲\n2. 乙' },
  { name: '用户消息', mes: 'Lune: 我说的 *动作* "对白"', isUser: true, chName: '旅人' },
  {
    name: '系统消息不走 Markdown',
    mes: '*raw* "q" <b>x</b>',
    isSystem: true,
    chName: 'SillyTavern System',
  },
  { name: '隐藏消息照常 Markdown', mes: '*md* "q"', isSystem: true, chName: 'Lune' },
];

describe.skipIf(!stDir || !hasChromium)('Phase 4: messageFormatting 对拍', () => {
  let st: Oracle;
  let driver: StDriver;
  let powerUser: FormatPowerUser;

  beforeAll(async () => {
    st = await startOracle({ stDir: stDir! });
    await st.settings(); // 触发 default-user 首启内容拷贝
    driver = await startDriver(st.baseUrl, { headless: process.env['ORACLE_HEADED'] !== '1' });
    await driver.page.goto(st.baseUrl, { waitUntil: 'load' });
    // settings.json 里的值 vs 页面 power_user 的代码默认值可能不同（auto_fix_generated_markdown 默认 true，文件里 false）：
    // 等到页面上的值与文件一致，说明 getSettings() 已经跑完
    const fileSettings = JSON.parse(
      readFileSync(join(st.dataRoot, 'default-user', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    const filePu = fileSettings['power_user'] as Record<string, unknown>;
    await driver.page.waitForFunction(
      (expected) => {
        const g = globalThis as unknown as {
          SillyTavern?: { getContext: () => Record<string, unknown> };
        };
        const ctx = g.SillyTavern?.getContext?.();
        const pu = ctx?.['powerUserSettings'] as Record<string, unknown> | undefined;
        return (
          !!ctx &&
          typeof ctx['messageFormatting'] === 'function' &&
          !!pu &&
          pu['auto_fix_generated_markdown'] === expected.auto_fix &&
          pu['encode_tags'] === expected.encode_tags
        );
      },
      { auto_fix: !!filePu['auto_fix_generated_markdown'], encode_tags: !!filePu['encode_tags'] },
      { timeout: 45_000 },
    );
    // 直接用页面里生效的 power_user，保证两边读的是同一份设置
    const pu = await driver.page.evaluate(() => {
      const g = globalThis as unknown as {
        SillyTavern: { getContext: () => Record<string, unknown> };
      };
      const p = g.SillyTavern.getContext()['powerUserSettings'] as Record<string, unknown>;
      return {
        auto_fix_generated_markdown: p['auto_fix_generated_markdown'],
        encode_tags: p['encode_tags'],
        allow_name2_display: p['allow_name2_display'],
        show_user_prompt_bias: p['show_user_prompt_bias'],
        user_prompt_bias: p['user_prompt_bias'],
        markdown_escape_strings: p['markdown_escape_strings'],
        reasoning: p['reasoning'] as { prefix?: string; suffix?: string } | undefined,
      };
    });
    if (process.env['ORACLE_DEBUG']) console.log('page power_user subset', JSON.stringify(pu));
    powerUser = {
      ...DEFAULT_FORMAT_POWER_USER,
      auto_fix_generated_markdown: !!pu.auto_fix_generated_markdown,
      encode_tags: !!pu.encode_tags,
      allow_name2_display: !!pu.allow_name2_display,
      show_user_prompt_bias: pu.show_user_prompt_bias !== false,
      user_prompt_bias: String(pu.user_prompt_bias ?? ''),
      markdown_escape_strings: String(pu.markdown_escape_strings ?? ''),
      reasoning: {
        prefix: String(pu.reasoning?.prefix ?? '<think>'),
        suffix: String(pu.reasoning?.suffix ?? '</think>'),
      },
    };
  }, 120_000);

  afterAll(async () => {
    await driver?.close();
    await st?.stop();
  });

  for (const sample of samples) {
    it(sample.name, async () => {
      const chName = sample.chName ?? 'Lune';
      const isUser = !!sample.isUser;
      const isSystem = !!sample.isSystem;
      const theirs = await driver.page.evaluate(
        ([mes, name, sys, user]) => {
          const g = globalThis as unknown as {
            SillyTavern: { getContext: () => { messageFormatting: (...a: unknown[]) => string } };
          };
          return g.SillyTavern.getContext().messageFormatting(mes, name, sys, user, -1);
        },
        [sample.mes, chName, isSystem, isUser] as const,
      );

      const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: st.baseUrl });
      const win = dom.window as unknown as Window & typeof globalThis;
      const sanitize = createMessageSanitizer(win, { mediaAllowed: () => false });
      const formatter = createMessageFormatter({ powerUser, substitute: (t) => t });
      const pre = formatter.format(sample.mes, { chName, isSystem, isUser, messageId: -1 });
      const ours = decodeStyleTags(sanitize(pre), { mediaAllowed: false });

      expect(ours).toBe(theirs);
    });
  }
});
