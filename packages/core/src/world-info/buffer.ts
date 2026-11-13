// ST WorldInfoBuffer 移植：按深度切片的扫描缓冲、关键词匹配、组评分。
import { escapeRegex, parseRegexFromString } from '../util/regex.js';
import {
  MAX_SCAN_DEPTH,
  SCAN_STATE,
  WORLD_INFO_LOGIC,
  type ScanState,
  type WIEntry,
  type WIGlobalScanData,
  type WorldInfoSettings,
} from './types.js';

export interface WorldInfoBufferLogger {
  warn?(message: string): void;
  error?(message: string): void;
}

export class WorldInfoBuffer {
  readonly #globalScanData: WIGlobalScanData;
  readonly #settings: WorldInfoSettings;
  readonly #depthBuffer: string[] = [];
  readonly #recurseBuffer: string[] = [];
  readonly #injectBuffer: string[] = [];
  readonly #externalActivations: Map<string, WIEntry>;
  readonly #logger: WorldInfoBufferLogger;
  #skew = 0;
  readonly #startDepth = 0;

  constructor(
    messages: readonly string[],
    globalScanData: WIGlobalScanData,
    settings: WorldInfoSettings,
    {
      externalActivations = new Map<string, WIEntry>(),
      logger = {},
    }: { externalActivations?: Map<string, WIEntry>; logger?: WorldInfoBufferLogger } = {},
  ) {
    this.#initDepthBuffer(messages);
    this.#globalScanData = globalScanData;
    this.#settings = settings;
    this.#externalActivations = externalActivations;
    this.#logger = logger;
  }

  #initDepthBuffer(messages: readonly string[]) {
    for (let depth = 0; depth < MAX_SCAN_DEPTH; depth++) {
      const m = messages[depth];
      if (m) this.#depthBuffer[depth] = m.trim();
      if (depth === messages.length - 1) break;
    }
  }

  #transformString(str: string, entry: WIEntry): string {
    const caseSensitive = entry.caseSensitive ?? this.#settings.world_info_case_sensitive;
    return caseSensitive ? str : str.toLowerCase();
  }

  get(entry: WIEntry, scanState: ScanState): string {
    let depth = entry.scanDepth ?? this.getDepth();
    if (depth <= this.#startDepth) return '';
    if (depth < 0) {
      this.#logger.error?.(`[WI] Invalid WI scan depth ${depth}. Must be >= 0`);
      return '';
    }
    if (depth > MAX_SCAN_DEPTH) {
      this.#logger.warn?.(`[WI] Invalid WI scan depth ${depth}. Truncating to ${MAX_SCAN_DEPTH}`);
      depth = MAX_SCAN_DEPTH;
    }
    const MATCHER = '\x01';
    const JOINER = '\n' + MATCHER;
    let result = MATCHER + this.#depthBuffer.slice(this.#startDepth, depth).join(JOINER);
    const g = this.#globalScanData;
    if (entry.matchPersonaDescription && g.personaDescription)
      result += JOINER + g.personaDescription;
    if (entry.matchCharacterDescription && g.characterDescription)
      result += JOINER + g.characterDescription;
    if (entry.matchCharacterPersonality && g.characterPersonality)
      result += JOINER + g.characterPersonality;
    if (entry.matchCharacterDepthPrompt && g.characterDepthPrompt)
      result += JOINER + g.characterDepthPrompt;
    if (entry.matchScenario && g.scenario) result += JOINER + g.scenario;
    if (entry.matchCreatorNotes && g.creatorNotes) result += JOINER + g.creatorNotes;
    if (this.#injectBuffer.length > 0) result += JOINER + this.#injectBuffer.join(JOINER);
    if (this.#recurseBuffer.length > 0 && scanState !== SCAN_STATE.MIN_ACTIVATIONS)
      result += JOINER + this.#recurseBuffer.join(JOINER);
    return result;
  }

  matchKeys(haystack: string, needle: string, entry: WIEntry): boolean {
    const keyRegex = parseRegexFromString(needle);
    if (keyRegex) return keyRegex.test(haystack);
    haystack = this.#transformString(haystack, entry);
    const transformedString = this.#transformString(needle, entry);
    const matchWholeWords = entry.matchWholeWords ?? this.#settings.world_info_match_whole_words;
    if (matchWholeWords) {
      const keyWords = transformedString.split(/\s+/);
      if (keyWords.length > 1) return haystack.includes(transformedString);
      const regex = new RegExp(`(?:^|\\W)(${escapeRegex(transformedString)})(?:$|\\W)`);
      if (regex.test(haystack)) return true;
    } else {
      return haystack.includes(transformedString);
    }
    return false;
  }

  addRecurse(message: string): void {
    this.#recurseBuffer.push(message);
  }
  addInject(message: string): void {
    this.#injectBuffer.push(message);
  }
  hasRecurse(): boolean {
    return this.#recurseBuffer.length > 0;
  }
  advanceScan(): void {
    this.#skew++;
  }
  getDepth(): number {
    return this.#settings.world_info_depth + this.#skew;
  }
  getExternallyActivated(entry: WIEntry): WIEntry | undefined {
    return this.#externalActivations.get(`${entry.world}.${entry.uid}`);
  }
  resetExternalEffects(): void {
    this.#externalActivations.clear();
  }

  getScore(entry: WIEntry, scanState: ScanState): number {
    const bufferState = this.get(entry, scanState);
    let numberOfPrimaryKeys = 0;
    let numberOfSecondaryKeys = 0;
    let primaryScore = 0;
    let secondaryScore = 0;
    if (Array.isArray(entry.key)) {
      numberOfPrimaryKeys = entry.key.length;
      for (const key of entry.key) if (this.matchKeys(bufferState, key, entry)) primaryScore++;
    }
    if (Array.isArray(entry.keysecondary)) {
      numberOfSecondaryKeys = entry.keysecondary.length;
      for (const key of entry.keysecondary)
        if (this.matchKeys(bufferState, key, entry)) secondaryScore++;
    }
    if (!numberOfPrimaryKeys) return 0;
    if (numberOfSecondaryKeys > 0) {
      switch (entry.selectiveLogic) {
        case WORLD_INFO_LOGIC.AND_ANY:
          return primaryScore + secondaryScore;
        case WORLD_INFO_LOGIC.AND_ALL:
          return secondaryScore === numberOfSecondaryKeys
            ? primaryScore + secondaryScore
            : primaryScore;
      }
    }
    return primaryScore;
  }
}
