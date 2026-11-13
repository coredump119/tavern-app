/** ST utils.shuffle（Fisher–Yates，就地）；random 可注入以便确定性测试 */
export function shuffle<T>(array: T[], random: () => number = Math.random): T[] {
  let currentIndex = array.length;
  while (currentIndex !== 0) {
    const randomIndex = Math.floor(random() * currentIndex);
    currentIndex--;
    const a = array[currentIndex] as T;
    const b = array[randomIndex] as T;
    array[currentIndex] = b;
    array[randomIndex] = a;
  }
  return array;
}

/** ST utils.onlyUnique：配合 Array.prototype.filter 去重 */
export function onlyUnique<T>(value: T, index: number, array: readonly T[]): boolean {
  return array.indexOf(value) === index;
}

/** ST utils.extractAllWords：`\b\w+\b` 全部小写 */
export function extractAllWords(value: string | undefined | null): string[] {
  const words: string[] = [];
  if (!value) return words;
  for (const match of value.matchAll(/\b\w+\b/gim)) {
    words.push(match[0].toLowerCase());
  }
  return words;
}
