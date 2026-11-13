export function isTrueBoolean(arg: string | undefined | null): boolean {
  return ['on', 'true', '1'].includes(arg?.trim()?.toLowerCase() ?? '\u0000');
}
export function isFalseBoolean(arg: string | undefined | null): boolean {
  return ['off', 'false', '0'].includes(arg?.trim()?.toLowerCase() ?? '\u0000');
}
export function isDigitsOnly(str: string): boolean {
  return /^\d+$/.test(str);
}
