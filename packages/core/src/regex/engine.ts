// ST extensions/regex/engine.js 移植：RegexProvider（LRU）、getRegexScripts、getRegexedString、runRegexScript。
import type { SubstituteOptions } from '../macros/engine.js';
import {
  REGEX_SCRIPT_TYPES,
  REGEX_SCRIPT_TYPE_UNKNOWN,
  SUBSTITUTE_FIND_REGEX,
  type RegexParams,
  type RegexScript,
  type RegexScriptSources,
} from './types.js';

/** ST utils.regexFromString：解析 `/pattern/flags` 或裸 pattern；非法 flags 时把整串当 pattern */
export function regexFromString(input: string): RegExp | undefined {
  try {
    const m = /(\/?)(.+)\1([a-z]*)/i.exec(input);
    if (!m) return undefined;
    if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) return RegExp(input);
    return new RegExp(m[2]!, m[3]);
  } catch {
    return undefined;
  }
}

export class RegexProvider {
  readonly #cache = new Map<string, RegExp>();
  readonly #maxSize: number;
  constructor(maxSize = 1000) {
    this.#maxSize = maxSize;
  }
  get(regexString: string): RegExp | null {
    const isCached = this.#cache.has(regexString);
    const regex = isCached ? this.#cache.get(regexString) : regexFromString(regexString);
    if (!regex) return null;
    if (isCached) {
      this.#cache.delete(regexString);
      this.#cache.set(regexString, regex);
    } else {
      if (this.#cache.size >= this.#maxSize) {
        const firstKey = this.#cache.keys().next().value;
        if (firstKey !== undefined) this.#cache.delete(firstKey);
      }
      this.#cache.set(regexString, regex);
    }
    if (regex.global || regex.sticky) regex.lastIndex = 0;
    return regex;
  }
  get size(): number {
    return this.#cache.size;
  }
  clear(): void {
    this.#cache.clear();
  }
}

export function sanitizeRegexMacro(x: string): string {
  return x && typeof x === 'string'
    ? x.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, (s) => {
        switch (s) {
          case '\n':
            return '\\n';
          case '\r':
            return '\\r';
          case '\t':
            return '\\t';
          case '\v':
            return '\\v';
          case '\f':
            return '\\f';
          case '\0':
            return '\\0';
          default:
            return '\\' + s;
        }
      })
    : x;
}

export function getScriptsByType(
  sources: RegexScriptSources,
  scriptType: number,
  { allowedOnly = false } = {},
): RegexScript[] {
  switch (scriptType) {
    case REGEX_SCRIPT_TYPE_UNKNOWN:
      return [];
    case REGEX_SCRIPT_TYPES.GLOBAL:
      return [...(sources.global ?? [])];
    case REGEX_SCRIPT_TYPES.SCOPED:
      if (allowedOnly && !sources.scopedAllowed) return [];
      return Array.isArray(sources.scoped) ? [...sources.scoped] : [];
    case REGEX_SCRIPT_TYPES.PRESET:
      if (allowedOnly && !sources.presetAllowed) return [];
      return Array.isArray(sources.preset) ? [...sources.preset] : [];
    default:
      return [];
  }
}

/** ST getRegexScripts：GLOBAL → PRESET → SCOPED */
export function getRegexScripts(
  sources: RegexScriptSources,
  options: { allowedOnly?: boolean } = {},
): RegexScript[] {
  return Object.values(REGEX_SCRIPT_TYPES).flatMap((type) =>
    getScriptsByType(sources, type, options),
  );
}

export interface RegexEngineDeps {
  /** substituteParams(text, options) */
  substitute: (text: string, options?: SubstituteOptions) => string;
  /** 每次取最新脚本来源（宿主状态可能变化） */
  sources: () => RegexScriptSources;
  provider?: RegexProvider | undefined;
  log?: ((message: string) => void) | undefined;
}

export class RegexEngine {
  readonly provider: RegexProvider;
  readonly #deps: RegexEngineDeps;
  constructor(deps: RegexEngineDeps) {
    this.#deps = deps;
    this.provider = deps.provider ?? new RegexProvider();
  }

  /** ST getRegexedString */
  getRegexedString(
    rawString: unknown,
    placement: number | undefined,
    { characterOverride, isMarkdown, isPrompt, isEdit, depth }: RegexParams = {},
  ): string {
    if (typeof rawString !== 'string') return '';
    let finalString = rawString;
    const sources = this.#deps.sources();
    if (sources.extensionDisabled || !rawString || placement === undefined) return finalString;

    for (const script of getRegexScripts(sources, { allowedOnly: true })) {
      const applies =
        (script.markdownOnly && isMarkdown) ||
        (script.promptOnly && isPrompt) ||
        (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt);
      if (!applies) continue;
      if (isEdit && !script.runOnEdit) continue;
      if (typeof depth === 'number') {
        const min = script.minDepth;
        const max = script.maxDepth;
        if (min !== null && min !== undefined && !isNaN(min) && min >= -1 && depth < min) continue;
        if (max !== null && max !== undefined && !isNaN(max) && max >= 0 && depth > max) continue;
      }
      if (Array.isArray(script.placement) && script.placement.includes(placement)) {
        finalString = this.runRegexScript(script, finalString, { characterOverride });
      }
    }
    return finalString;
  }

  /** ST runRegexScript */
  runRegexScript(
    regexScript: RegexScript | null | undefined,
    rawString: string,
    { characterOverride }: { characterOverride?: string | undefined } = {},
  ): string {
    const newString = rawString;
    if (!regexScript || !!regexScript.disabled || !regexScript.findRegex || !rawString)
      return newString;
    const sub = this.#deps.substitute;

    const getRegexString = (): string => {
      switch (Number(regexScript.substituteRegex)) {
        case SUBSTITUTE_FIND_REGEX.NONE:
          return regexScript.findRegex!;
        case SUBSTITUTE_FIND_REGEX.RAW:
          return sub(regexScript.findRegex!);
        case SUBSTITUTE_FIND_REGEX.ESCAPED:
          return sub(regexScript.findRegex!, { postProcessFn: sanitizeRegexMacro });
        default:
          this.#deps.log?.(
            `runRegexScript: Unknown substituteRegex value ${String(regexScript.substituteRegex)}. Using raw regex.`,
          );
          return regexScript.findRegex!;
      }
    };
    const findRegex = this.provider.get(getRegexString());
    if (!findRegex) return newString;

    return rawString.replace(findRegex, (...args: unknown[]) => {
      const replaceString = (regexScript.replaceString ?? '').replace(/{{match}}/gi, '$0');
      const replaceWithGroups = replaceString.replaceAll(
        /\$(\d+)|\$<([^>]+)>/g,
        (_: string, num: string | undefined, groupName: string | undefined) => {
          let match: unknown;
          if (num) match = args[Number(num)];
          else if (groupName) {
            const groups = args[args.length - 1];
            match =
              groups && typeof groups === 'object'
                ? (groups as Record<string, unknown>)[groupName]
                : undefined;
          }
          if (!match) return '';
          return this.filterString(String(match), regexScript.trimStrings ?? [], {
            characterOverride,
          });
        },
      );
      return sub(replaceWithGroups);
    });
  }

  filterString(
    rawString: string,
    trimStrings: readonly string[],
    { characterOverride }: { characterOverride?: string | undefined } = {},
  ): string {
    let finalString = rawString;
    for (const trimString of trimStrings) {
      const subTrim = this.#deps.substitute(trimString, { name2Override: characterOverride });
      finalString = finalString.replaceAll(subTrim, '');
    }
    return finalString;
  }
}
