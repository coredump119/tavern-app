// ST public/scripts/chats.js encodeStyleTags / decodeStyleTags 的 1:1 移植（@adobe/css-tools 与 ST 同版本）。
import { parse, stringify, type CssAtRuleAST, type CssStylesheetAST } from '@adobe/css-tools';

/** 消毒前：把 `<style>` 内容 URI 编码进 `<custom-style>`，让 DOMPurify 不把它当样式动刀。 */
export function encodeStyleTags(text: string): string {
  const styleRegex = /<style>(.+?)<\/style>/gims;
  return text.replaceAll(styleRegex, (_, match: string) => {
    return `<custom-style>${encodeURIComponent(match)}</custom-style>`;
  });
}

export interface DecodeStyleOptions {
  /** 每条选择器前缀，ST 为 `.mes_text ` */
  prefix?: string;
  /** 不允许外部媒体时丢掉含 `://` 的声明 */
  mediaAllowed: boolean;
}

interface RuleLike {
  type: string;
  selectors?: string[];
  declarations?: Array<{ type: string; value?: string }>;
  rules?: CssAtRuleAST[];
}

/** 消毒后：解码 `<custom-style>`，把选择器限定到消息内并给 class 加 `custom-` 前缀，去掉 @import。 */
export function decodeStyleTags(text: string, options: DecodeStyleOptions): string {
  const prefix = options.prefix ?? '.mes_text ';
  const mediaAllowed = options.mediaAllowed;
  const styleDecodeRegex = /<custom-style>(.+?)<\/custom-style>/gms;

  function sanitizeRule(rule: RuleLike) {
    if (Array.isArray(rule.selectors)) {
      for (let i = 0; i < rule.selectors.length; i++) {
        const selector = rule.selectors[i];
        if (selector) rule.selectors[i] = prefix + sanitizeSelector(selector);
      }
    }
    if (!mediaAllowed && Array.isArray(rule.declarations) && rule.declarations.length > 0) {
      rule.declarations = rule.declarations.filter(
        (declaration) => !String(declaration.value ?? '').includes('://'),
      );
    }
  }

  function sanitizeSelector(selector: string): string {
    const pseudoClasses = ['has', 'not', 'where', 'is', 'matches', 'any'];
    const pseudoRegex = new RegExp(`:(${pseudoClasses.join('|')})\\(([^)]+)\\)`, 'g');
    selector = selector.replace(pseudoRegex, (_match, pseudoClass: string, content: string) => {
      return `:${pseudoClass}(${sanitizeSimpleSelector(content)})`;
    });
    return sanitizeSimpleSelector(selector);
  }

  function sanitizeSimpleSelector(selector: string): string {
    return selector
      .split(/\s+/)
      .map((part) =>
        part.replace(/\.([\w-]+)/g, (match, className: string) =>
          className.startsWith('custom-') ? match : `.custom-${className}`,
        ),
      )
      .join(' ');
  }

  function sanitizeRuleSet(ruleSet: RuleLike) {
    if (Array.isArray(ruleSet.selectors) || Array.isArray(ruleSet.declarations)) {
      sanitizeRule(ruleSet);
    }
    if (Array.isArray(ruleSet.rules)) {
      ruleSet.rules = ruleSet.rules.filter((rule) => rule.type !== 'import');
      for (const mediaRule of ruleSet.rules) sanitizeRuleSet(mediaRule as unknown as RuleLike);
    }
  }

  return text.replaceAll(styleDecodeRegex, (_, style: string) => {
    try {
      const styleCleaned = decodeURIComponent(style).replaceAll(/<br\/>/g, '');
      const ast: CssStylesheetAST = parse(styleCleaned);
      const sheet = ast?.stylesheet;
      if (sheet) sanitizeRuleSet(sheet as unknown as RuleLike);
      return `<style>${stringify(ast)}</style>`;
    } catch (error) {
      return `CSS ERROR: ${error}`;
    }
  });
}
