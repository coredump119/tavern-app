// ST public/scripts/showdown-underscore.js 与 showdown-exclusion.js 的 1:1 移植。
import type showdown from 'showdown';

/** `_word_` → `<em>word</em>`（跳过 <code> / <style> 内部）。ST 在不支持负向后行断言的引擎上直接跳过；我们只跑现代引擎。 */
export function markdownUnderscoreExt(): showdown.ShowdownExtension[] {
  return [
    {
      type: 'output',
      regex: new RegExp(
        '(<code(?:\\s+[^>]*)?>[\\s\\S]*?<\\/code>|<style(?:\\s+[^>]*)?>[\\s\\S]*?<\\/style>)|\\b(?<!_)_(?!_)(.*?)(?<!_)_(?!_)\\b',
        'gi',
      ),
      replace: (
        match: string,
        tagContent: string | undefined,
        italicContent: string | undefined,
      ) => {
        if (tagContent) return match;
        if (italicContent) return `<em>${italicContent}</em>`;
        return match;
      },
    },
  ];
}

/**
 * 「非 Markdown 字符串」（power_user.markdown_escape_strings，逗号分隔，宏已替换）独占一行时不参与 Markdown 解析。
 * ST 在创建 converter 时若设置为空就不装这个扩展；`strings()` 每次过滤时求值（宏可能变化）。
 */
export function markdownExclusionExt(strings: () => string): showdown.ShowdownExtension[] {
  return [
    {
      type: 'lang',
      filter: (text: string) => {
        const escapedExclusions = strings()
          .split(',')
          .filter((element) => element.length > 0)
          .map(
            (element) =>
              `(${element
                .split('')
                .map((char) => `\\${char}`)
                .join('')})`,
          );
        if (escapedExclusions.length === 0) return text;
        const replaceRegex = new RegExp(`^(${escapedExclusions.join('|')})\n`, 'gm');
        return text.replace(replaceRegex, (match) =>
          match.replace(replaceRegex, `\u0000${match} \n`),
        );
      },
    },
  ];
}
