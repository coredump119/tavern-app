// ST MacroFlags.js 移植：{{ 与标识符之间的执行标志。

export interface MacroFlags {
  immediate: boolean;
  delayed: boolean;
  reevaluate: boolean;
  filter: boolean;
  closingBlock: boolean;
  preserveWhitespace: boolean;
  raw: string[];
}

export const MacroFlagType = Object.freeze({
  IMMEDIATE: '!',
  DELAYED: '?',
  REEVALUATE: '~',
  FILTER: '>',
  CLOSING_BLOCK: '/',
  PRESERVE_WHITESPACE: '#',
});

export const ValidFlagSymbols: ReadonlySet<string> = new Set(Object.values(MacroFlagType));

export function createEmptyFlags(): MacroFlags {
  return {
    immediate: false,
    delayed: false,
    reevaluate: false,
    filter: false,
    closingBlock: false,
    preserveWhitespace: false,
    raw: [],
  };
}

export function parseFlags(
  flagSymbols: string[],
  onUnknown?: (symbol: string) => void,
): MacroFlags {
  const flags = createEmptyFlags();
  for (const symbol of flagSymbols) {
    switch (symbol) {
      case MacroFlagType.IMMEDIATE:
        flags.immediate = true;
        break;
      case MacroFlagType.DELAYED:
        flags.delayed = true;
        break;
      case MacroFlagType.REEVALUATE:
        flags.reevaluate = true;
        break;
      case MacroFlagType.FILTER:
        flags.filter = true;
        break;
      case MacroFlagType.CLOSING_BLOCK:
        flags.closingBlock = true;
        break;
      case MacroFlagType.PRESERVE_WHITESPACE:
        flags.preserveWhitespace = true;
        break;
      default:
        onUnknown?.(symbol);
    }
    flags.raw.push(symbol);
  }
  return flags;
}

export function hasAnyFlag(flags: MacroFlags): boolean {
  return flags.raw.length > 0;
}

export function isValidFlag(symbol: string): boolean {
  return ValidFlagSymbols.has(symbol);
}
