// ST public/script.js messageFormatting() 的移植：Markdown + 引号高亮 + 代码块修补 + 名字剥离。
// 产出的是「消毒前」的 HTML（已把 <style> 编码成 <custom-style>）；DOMPurify 在宿主（@tm/ui createMessageSanitizer）里跑，
// 之后再 decodeStyleTags。顺序与 ST 一致：encodeStyleTags → sanitize → decodeStyleTags。
import showdown from 'showdown';
import { REGEX_PLACEMENT, type RegexPlacementValue } from '../regex/types.js';
import { escapeRegex } from '../util/index.js';
import { fixMarkdown } from './fix-markdown.js';
import { markdownExclusionExt, markdownUnderscoreExt } from './showdown-ext.js';
import { encodeStyleTags } from './style-tags.js';

/** ST 常量 */
export const SYSTEM_USER_NAME = 'SillyTavern System';
export const COMMENT_NAME_DEFAULT = 'Note';

/** power_user 里 messageFormatting 读到的字段 */
export interface FormatPowerUser {
  auto_fix_generated_markdown: boolean;
  encode_tags: boolean;
  allow_name2_display: boolean;
  show_user_prompt_bias: boolean;
  user_prompt_bias: string;
  markdown_escape_strings: string;
  reasoning: { prefix: string; suffix: string };
}

export const DEFAULT_FORMAT_POWER_USER: FormatPowerUser = {
  auto_fix_generated_markdown: true,
  encode_tags: false,
  allow_name2_display: false,
  show_user_prompt_bias: true,
  user_prompt_bias: '',
  markdown_escape_strings: '',
  reasoning: { prefix: '<think>', suffix: '</think>' },
};

export interface FormatRegexParams {
  characterOverride: string;
  isMarkdown: true;
  depth: number | undefined;
}

export interface MessageFormatterDeps {
  powerUser: FormatPowerUser;
  /** substituteParams(text, undefined, ch_name)；第 0 楼的宏替换与 user_prompt_bias 用 */
  substitute: (text: string, charName?: string) => string;
  /** getRegexedString(text, placement, params)；缺省不做正则 */
  applyRegex?:
    | ((text: string, placement: RegexPlacementValue, params: FormatRegexParams) => string)
    | undefined;
}

/** 渲染一条消息需要的上下文（ST 从全局 chat 读；这里显式传） */
export interface FormatContext {
  chName: string;
  isSystem: boolean;
  isUser: boolean;
  /** 在 chat 数组中的下标；-1 表示脱离聊天（不做第 0 楼宏替换、正则 depth 为 undefined） */
  messageId: number;
  isReasoning?: boolean | undefined;
  /** 用于算正则 depth（跳过 is_system）与识别 narrator；缺省视为无聊天 */
  chat?:
    | ReadonlyArray<{
        is_system?: boolean | undefined;
        extra?: { type?: string | undefined } | undefined;
      }>
    | undefined;
}

export interface MessageFormatter {
  /** 消毒前 HTML */
  format(mes: string, ctx: FormatContext): string;
}

/** ST 传给 DOMPurify 的额外配置（宿主 sanitize 时合并） */
export const MESSAGE_SANITIZE_CONFIG = {
  ADD_TAGS: ['custom-style'],
  MESSAGE_SANITIZE: true,
} as const;

export function escapeHtml(str: string | null | undefined): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** ST reloadMarkdownProcessor()：同一套 showdown 选项与扩展 */
export function createMarkdownConverter(
  deps: Pick<MessageFormatterDeps, 'powerUser' | 'substitute'>,
): showdown.Converter {
  const converter = new showdown.Converter({
    emoji: true,
    literalMidWordUnderscores: true,
    parseImgDimensions: true,
    tables: true,
    underline: true,
    simpleLineBreaks: true,
    strikethrough: true,
    disableForced4SpacesIndentedSublists: true,
    extensions: [markdownUnderscoreExt()],
  });
  // ST：设置为空时不装 exclusion 扩展（改设置会重建 converter）
  if (deps.powerUser.markdown_escape_strings) {
    converter.addExtension(
      markdownExclusionExt(() => deps.substitute(deps.powerUser.markdown_escape_strings)),
      'exclusion',
    );
  }
  return converter;
}

const QUOTE_RE =
  /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/gim;

export function createMessageFormatter(deps: MessageFormatterDeps): MessageFormatter {
  const pu = deps.powerUser;
  const converter = createMarkdownConverter(deps);

  function format(input: string, ctx: FormatContext): string {
    let mes = input;
    if (!mes) return '';
    let { isSystem } = ctx;
    const { chName, isUser, messageId } = ctx;
    const isReasoning = !!ctx.isReasoning;

    // 第 0 楼（开场白）显示时做一次宏替换
    if (Number(messageId) === 0 && !isSystem && !isUser && !isReasoning) {
      mes = deps.substitute(mes, chName);
    }

    // 评论消息强制按普通消息格式化
    if (chName === COMMENT_NAME_DEFAULT && isSystem && !isUser) isSystem = false;
    // 隐藏消息也允许 Markdown
    if (isSystem && chName !== SYSTEM_USER_NAME) isSystem = false;

    // prompt bias 在原文上剥离
    const replacedPromptBias = pu.user_prompt_bias && deps.substitute(pu.user_prompt_bias);
    if (
      !pu.show_user_prompt_bias &&
      chName &&
      !isUser &&
      !isSystem &&
      replacedPromptBias &&
      mes.startsWith(replacedPromptBias)
    ) {
      mes = mes.slice(replacedPromptBias.length);
    }

    if (!isSystem && deps.applyRegex) {
      const chat = ctx.chat ?? [];
      const placement: RegexPlacementValue = isReasoning
        ? REGEX_PLACEMENT.REASONING
        : isUser
          ? REGEX_PLACEMENT.USER_INPUT
          : chat[messageId]?.extra?.type === 'narrator'
            ? REGEX_PLACEMENT.SLASH_COMMAND
            : REGEX_PLACEMENT.AI_OUTPUT;
      const usable = chat.map((m, index) => ({ m, index })).filter((x) => !x.m.is_system);
      const indexOf = usable.findIndex((x) => x.index === Number(messageId));
      const depth = messageId >= 0 && indexOf !== -1 ? usable.length - indexOf - 1 : undefined;
      mes = deps.applyRegex(mes, placement, { characterOverride: chName, isMarkdown: true, depth });
    }

    if (pu.auto_fix_generated_markdown) mes = fixMarkdown(mes, true);

    if (!isSystem && pu.encode_tags) {
      mes = mes.replaceAll('<', '&lt;').replace(new RegExp('(?<!^|\\n\\s*)>', 'g'), '&gt;');
    }

    // 推理前后缀永远可见（只替换第一处）
    for (const reasoningString of [pu.reasoning.prefix, pu.reasoning.suffix]) {
      if (!reasoningString || !reasoningString.trim().length) continue;
      if (mes.includes(reasoningString))
        mes = mes.replace(reasoningString, escapeHtml(reasoningString));
    }

    if (!isSystem) {
      // 标签内的双引号先换成特殊字符，免得被当对白
      if (!pu.encode_tags) {
        mes = mes.replace(
          /<([^>]+)>/g,
          (_, contents: string) => '<' + contents.replace(/"/g, '￾') + '>',
        );
      }
      mes = mes.replace(
        QUOTE_RE,
        (match, p1?: string, p2?: string, p3?: string, p4?: string, p5?: string, p6?: string) => {
          if (p1) return `<q>"${p1.slice(1, -1)}"</q>`;
          if (p2) return `<q>“${p2.slice(1, -1)}”</q>`;
          if (p3) return `<q>«${p3.slice(1, -1)}»</q>`;
          if (p4) return `<q>「${p4.slice(1, -1)}」</q>`;
          if (p5) return `<q>『${p5.slice(1, -1)}』</q>`;
          if (p6) return `<q>＂${p6.slice(1, -1)}＂</q>`;
          return match;
        },
      );
      if (!pu.encode_tags) mes = mes.replace(/￾/g, '"');

      mes = mes.replaceAll('\\begin{align*}', '$$');
      mes = mes.replaceAll('\\end{align*}', '$$');
      mes = converter.makeHtml(mes);

      // 代码块里的换行先藏起来再放回（ST 为 Firefox 的 <br> 问题）
      mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, (match) => match.replace(/\n/gm, '\u0000'));
      mes = mes.replace(/\u0000/g, '\n');
      mes = mes.trim();
      mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, (match) => match.replace(/&amp;/g, '&'));
    }

    if (!pu.allow_name2_display && chName && !isUser && !isSystem) {
      mes = mes.replace(new RegExp(`(^|\n)${escapeRegex(chName)}:`, 'g'), '$1');
    }

    return encodeStyleTags(mes);
  }

  return { format };
}
