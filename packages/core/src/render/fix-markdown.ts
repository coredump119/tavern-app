// ST public/scripts/power-user.js fixMarkdown 的 1:1 移植。

const isOdd = (n: number) => n % 2 !== 0;
const countOccurrences = (s: string, ch: string) => s.split(ch).length - 1;

/**
 * 修正生成文本里成对 `*` / `_` 内侧的多余空格（"* text *" → "*text*"）；
 * `forDisplay` 时再给每行未配对的 `*` / `"` 在行尾补一个。
 */
export function fixMarkdown(text: string, forDisplay: boolean): string {
  const format = /([*_]{1,2})([\s\S]*?)\1/gm;
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = format.exec(text)) !== null) matches.push(match);

  let newText = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!;
    const matchText = m[0];
    const replacementText = matchText.replace(
      /(\*|_)([\t    -   　﻿]+)|([\t    -   　﻿]+)(\*|_)/g,
      '$1$4',
    );
    newText =
      newText.slice(0, m.index) + replacementText + newText.slice(m.index + matchText.length);
  }

  // 清理用途（continue）不补未配对符号，只有显示时补。
  if (!forDisplay) return newText;

  const splitText = newText.split('\n');
  for (let index = 0; index < splitText.length; index++) {
    const line = splitText[index]!;
    for (const char of ['*', '"']) {
      if (line.includes(char) && isOdd(countOccurrences(line, char))) {
        splitText[index] = splitText[index]!.trimEnd() + char;
      }
    }
  }
  return splitText.join('\n');
}
