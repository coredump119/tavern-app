// ST checkWorldInfo / filterByInclusionGroups / getWorldInfoPrompt 移植。
// 宿主能力（宏替换、token 计数、正则脚本、注入提示、角色过滤信息、随机数）全部经 deps 注入。
import { WorldInfoBuffer } from './buffer.js';
import { WorldInfoTimedEffects } from './timed-effects.js';
import {
  DEFAULT_DEPTH,
  DEFAULT_GLOBAL_SCAN_DATA,
  DEFAULT_WEIGHT,
  EXTENSION_PROMPT_ROLES,
  SCAN_STATE,
  WI_ANCHOR_POSITION,
  WORLD_INFO_LOGIC,
  WORLD_INFO_POSITION,
  type ScanState,
  type WIActivated,
  type WIAnchoredEntry,
  type WIDepthEntry,
  type WIEntry,
  type WIGlobalScanData,
  type WIPromptResult,
  type WorldInfoSettings,
} from './types.js';

export interface WorldInfoScanDeps {
  settings: WorldInfoSettings;
  /** chat_metadata（timedWorldInfo 会被就地修改） */
  chatMetadata: Record<string, unknown>;
  /** substituteParams(text) */
  substitute: (text: string) => string;
  /** getTokenCountAsync(text) */
  countTokens: (text: string) => Promise<number> | number;
  /** getRegexedString(content, WORLD_INFO, { depth, isMarkdown:false, isPrompt:true })；缺省恒等 */
  applyRegex?: ((content: string, depth: number | null) => string) | undefined;
  /** 带 scan 标记的扩展提示词（已 substitute），对应 context.extensionPrompts[key].scan */
  scanInjects?: readonly string[] | undefined;
  /** getCharaFilename()：角色文件名（无扩展名） */
  characterFilename?: string | null | undefined;
  /** 当前角色的标签列表（tagMap[tagKey]） */
  characterTags?: readonly string[] | undefined;
  /** WORLDINFO_FORCE_ACTIVATE 注入的外部激活条目，键 `${world}.${uid}` */
  externalActivations?: Map<string, WIEntry> | undefined;
  /** 概率与组权重的随机源（默认 Math.random） */
  random?: (() => number) | undefined;
  /** 调试日志 */
  log?: ((message: string) => void) | undefined;
  /** 预算溢出警告（world_info_overflow_alert） */
  onOverflow?: ((budget: number, activated: number) => void) | undefined;
  /** 每轮扫描结束的钩子（WORLDINFO_SCAN_DONE），可改写 next 状态等 */
  onScanDone?: ((args: WIScanDoneArgs) => void | Promise<void>) | undefined;
}

export interface WIScanDoneArgs {
  state: { current: ScanState; next: ScanState; loopCount: number };
  new: { all: WIEntry[]; successful: WIEntry[] };
  activated: { entries: Map<string, WIEntry>; text: string };
  sortedEntries: WIEntry[];
  recursionDelay: { availableLevels: number[]; currentLevel: number };
  budget: { current: number; overflowed: boolean };
  timedEffects: WorldInfoTimedEffects;
}

export interface CheckWorldInfoInput {
  /** 要扫描的消息，逆序（最新在前）。world_info_include_names 为真时形如 `name: mes` */
  chat: readonly string[];
  maxContext: number;
  isDryRun?: boolean;
  globalScanData?: Partial<WIGlobalScanData> | undefined;
  /** getSortedEntries 的输出 */
  sortedEntries: WIEntry[];
}

const emptyResult = (): WIActivated => ({
  worldInfoBefore: '',
  worldInfoAfter: '',
  WIDepthEntries: [],
  EMEntries: [],
  ANBeforeEntries: [],
  ANAfterEntries: [],
  outletEntries: {},
  allActivatedEntries: new Set(),
});

export async function checkWorldInfo(
  input: CheckWorldInfoInput,
  deps: WorldInfoScanDeps,
): Promise<WIActivated> {
  const { chat, maxContext, isDryRun = false, sortedEntries } = input;
  const globalScanData: WIGlobalScanData = {
    ...DEFAULT_GLOBAL_SCAN_DATA,
    ...(input.globalScanData ?? {}),
  };
  const s = deps.settings;
  const log = deps.log ?? (() => {});
  const random = deps.random ?? Math.random;
  const externalActivations = deps.externalActivations ?? new Map<string, WIEntry>();
  const buffer = new WorldInfoBuffer(chat, globalScanData, s, {
    externalActivations,
    logger: { warn: log, error: log },
  });

  log(
    `[WI] --- START WI SCAN (on ${chat.length} messages, trigger = ${globalScanData.trigger})${isDryRun ? ' (DRY RUN)' : ''} ---`,
  );

  for (const inject of deps.scanInjects ?? []) if (inject) buffer.addInject(inject);

  let scanState: ScanState = SCAN_STATE.INITIAL;
  let tokenBudgetOverflowed = false;
  let budgetOverflow: WIActivated['budgetOverflow'];
  let count = 0;
  const allActivatedEntries = new Map<string, WIEntry>();
  const failedProbabilityChecks = new Set<WIEntry>();
  let allActivatedText = '';

  let budget = Math.round((s.world_info_budget * maxContext) / 100) || 1;
  if (s.world_info_budget_cap > 0 && budget > s.world_info_budget_cap)
    budget = s.world_info_budget_cap;

  const timedEffects = new WorldInfoTimedEffects(chat, sortedEntries, deps.chatMetadata, {
    isDryRun,
    log,
  });
  timedEffects.checkTimedEffects();

  if (sortedEntries.length === 0) return emptyResult();

  const availableRecursionDelayLevels = [
    ...new Set(
      sortedEntries
        .filter((e) => e.delayUntilRecursion)
        .map((e) => (e.delayUntilRecursion === true ? 1 : Number(e.delayUntilRecursion))),
    ),
  ].sort((a, b) => a - b);
  let currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0;

  while (scanState) {
    if (s.world_info_max_recursion_steps && s.world_info_max_recursion_steps <= count) {
      log(
        `[WI] Search stopped by reaching max recursion steps ${s.world_info_max_recursion_steps}`,
      );
      break;
    }
    count++;
    let nextScanState: ScanState = SCAN_STATE.NONE;
    const activatedNow = new Set<WIEntry>();

    for (const entry of sortedEntries) {
      if (
        failedProbabilityChecks.has(entry) ||
        allActivatedEntries.has(`${entry.world}.${entry.uid}`)
      )
        continue;
      if (entry.disable == true) continue;

      if (Array.isArray(entry.triggers) && entry.triggers.length > 0) {
        if (!entry.triggers.includes(globalScanData.trigger)) continue;
      }

      const cf = entry.characterFilter;
      if (cf && (cf.names?.length ?? 0) > 0) {
        const nameIncluded = cf.names!.includes(deps.characterFilename ?? '');
        if (cf.isExclude ? nameIncluded : !nameIncluded) continue;
      }
      if (cf && (cf.tags?.length ?? 0) > 0 && Array.isArray(deps.characterTags)) {
        const includesTag = deps.characterTags.some((tag) => cf.tags!.includes(tag));
        if (cf.isExclude ? includesTag : !includesTag) continue;
      }

      const isSticky = timedEffects.isEffectActive('sticky', entry);
      const isCooldown = timedEffects.isEffectActive('cooldown', entry);
      const isDelay = timedEffects.isEffectActive('delay', entry);

      if (isDelay) continue;
      if (isCooldown && !isSticky) continue;
      if (scanState !== SCAN_STATE.RECURSION && entry.delayUntilRecursion && !isSticky) continue;
      if (
        scanState === SCAN_STATE.RECURSION &&
        entry.delayUntilRecursion &&
        Number(entry.delayUntilRecursion) > currentRecursionDelayLevel &&
        !isSticky
      )
        continue;
      if (
        scanState === SCAN_STATE.RECURSION &&
        s.world_info_recursive &&
        entry.excludeRecursion &&
        !isSticky
      )
        continue;

      const decorators = entry.decorators ?? [];
      if (decorators.includes('@@activate')) {
        activatedNow.add(entry);
        continue;
      }
      if (decorators.includes('@@dont_activate')) continue;

      const external = buffer.getExternallyActivated(entry);
      if (external) {
        activatedNow.add(external);
        continue;
      }
      if (entry.constant) {
        activatedNow.add(entry);
        continue;
      }
      if (isSticky) {
        activatedNow.add(entry);
        continue;
      }
      if (!Array.isArray(entry.key) || !entry.key.length) continue;

      const textToScan = buffer.get(entry, scanState);
      const primaryKeyMatch = entry.key.find((key) => {
        const substituted = deps.substitute(key);
        return substituted && buffer.matchKeys(textToScan, substituted.trim(), entry);
      });
      if (!primaryKeyMatch) continue;

      const hasSecondaryKeywords =
        entry.selective && Array.isArray(entry.keysecondary) && entry.keysecondary.length;
      if (!hasSecondaryKeywords) {
        activatedNow.add(entry);
        continue;
      }

      const selectiveLogic = entry.selectiveLogic ?? 0;
      const matchSecondaryKeys = (): boolean => {
        let hasAnyMatch = false;
        let hasAllMatch = true;
        for (const keysecondary of entry.keysecondary!) {
          const secondarySubstituted = deps.substitute(keysecondary);
          const hasSecondaryMatch =
            !!secondarySubstituted &&
            buffer.matchKeys(textToScan, secondarySubstituted.trim(), entry);
          if (hasSecondaryMatch) hasAnyMatch = true;
          if (!hasSecondaryMatch) hasAllMatch = false;
          if (selectiveLogic === WORLD_INFO_LOGIC.AND_ANY && hasSecondaryMatch) return true;
          if (selectiveLogic === WORLD_INFO_LOGIC.NOT_ALL && !hasSecondaryMatch) return true;
        }
        if (selectiveLogic === WORLD_INFO_LOGIC.NOT_ANY && !hasAnyMatch) return true;
        if (selectiveLogic === WORLD_INFO_LOGIC.AND_ALL && hasAllMatch) return true;
        return false;
      };
      if (!matchSecondaryKeys()) continue;
      activatedNow.add(entry);
    }

    const newEntries = [...activatedNow].sort((a, b) => {
      const isASticky = timedEffects.isEffectActive('sticky', a) ? 1 : 0;
      const isBSticky = timedEffects.isEffectActive('sticky', b) ? 1 : 0;
      return isBSticky - isASticky || sortedEntries.indexOf(a) - sortedEntries.indexOf(b);
    });

    let newContent = '';
    const textToScanTokens = await deps.countTokens(allActivatedText);

    filterByInclusionGroups(
      newEntries,
      allActivatedEntries,
      buffer,
      scanState,
      timedEffects,
      s,
      random,
      log,
    );

    let ignoresBudget = newEntries.filter((e) => e.ignoreBudget).length;
    for (const entry of newEntries) {
      ignoresBudget -= entry.ignoreBudget ? 1 : 0;
      if (tokenBudgetOverflowed && !entry.ignoreBudget) {
        if (ignoresBudget > 0) continue;
        break;
      }

      const verifyProbability = () => {
        if (!entry.useProbability || entry.probability === 100) return true;
        if (timedEffects.isEffectActive('sticky', entry)) return true;
        const rollValue = random() * 100;
        if (rollValue <= (entry.probability ?? 100)) return true;
        failedProbabilityChecks.add(entry);
        return false;
      };
      if (!verifyProbability()) continue;

      entry.content = deps.substitute(entry.content ?? '');
      newContent += `${entry.content}\n`;

      if (
        !entry.ignoreBudget &&
        textToScanTokens + (await deps.countTokens(newContent)) >= budget
      ) {
        if (!tokenBudgetOverflowed) {
          if (s.world_info_overflow_alert) deps.onOverflow?.(budget, allActivatedEntries.size);
          budgetOverflow = {
            budget,
            activated: allActivatedEntries.size,
            firstSkipped: String(entry.comment || entry.key?.[0] || ''),
          };
          log(
            `[WI] budget of ${budget} reached, stopping after ${allActivatedEntries.size} entries`,
          );
          tokenBudgetOverflowed = true;
        }
        continue;
      }
      allActivatedEntries.set(`${entry.world}.${entry.uid}`, entry);
    }

    const successfulNewEntries = newEntries.filter((x) => !failedProbabilityChecks.has(x));
    const successfulNewEntriesForRecursion = successfulNewEntries.filter(
      (x) => !x.preventRecursion,
    );

    if (s.world_info_recursive && !tokenBudgetOverflowed && successfulNewEntriesForRecursion.length)
      nextScanState = SCAN_STATE.RECURSION;
    if (
      s.world_info_recursive &&
      !tokenBudgetOverflowed &&
      scanState === SCAN_STATE.MIN_ACTIVATIONS &&
      buffer.hasRecurse()
    )
      nextScanState = SCAN_STATE.RECURSION;

    const minActivationsNotSatisfied =
      s.world_info_min_activations > 0 && allActivatedEntries.size < s.world_info_min_activations;
    if (!nextScanState && !tokenBudgetOverflowed && minActivationsNotSatisfied) {
      const overMax =
        (s.world_info_min_activations_depth_max > 0 &&
          buffer.getDepth() > s.world_info_min_activations_depth_max) ||
        buffer.getDepth() > chat.length;
      if (!overMax) {
        nextScanState = SCAN_STATE.MIN_ACTIVATIONS;
        buffer.advanceScan();
      }
    }

    if (nextScanState === SCAN_STATE.NONE && availableRecursionDelayLevels.length) {
      nextScanState = SCAN_STATE.RECURSION;
      currentRecursionDelayLevel = availableRecursionDelayLevels.shift()!;
    }

    const curScanState = scanState;
    scanState = nextScanState;
    if (scanState) {
      const text = successfulNewEntriesForRecursion.map((x) => x.content).join('\n');
      if (text) {
        buffer.addRecurse(text);
        allActivatedText = text + '\n' + allActivatedText;
      }
    }

    if (deps.onScanDone) {
      const args: WIScanDoneArgs = {
        state: { current: curScanState, next: scanState, loopCount: count },
        new: { all: newEntries, successful: successfulNewEntries },
        activated: { entries: allActivatedEntries, text: allActivatedText },
        sortedEntries,
        recursionDelay: {
          availableLevels: availableRecursionDelayLevels,
          currentLevel: currentRecursionDelayLevel,
        },
        budget: { current: budget, overflowed: tokenBudgetOverflowed },
        timedEffects,
      };
      await deps.onScanDone(args);
      if (args.state.next !== scanState) scanState = args.state.next;
      allActivatedText = args.activated.text;
      currentRecursionDelayLevel = args.recursionDelay.currentLevel;
      budget = args.budget.current;
      tokenBudgetOverflowed = args.budget.overflowed;
    }
  }

  // --- BUILDING PROMPT ---
  const WIBeforeEntries: string[] = [];
  const WIAfterEntries: string[] = [];
  const EMEntries: WIAnchoredEntry[] = [];
  const ANTopEntries: string[] = [];
  const ANBottomEntries: string[] = [];
  const WIDepthEntries: WIDepthEntry[] = [];
  const WIOutletEntries: Record<string, string[]> = {};
  const applyRegex = deps.applyRegex ?? ((c: string) => c);
  const sortFn = (a: WIEntry, b: WIEntry) => (b.order ?? 0) - (a.order ?? 0);

  [...allActivatedEntries.values()].sort(sortFn).forEach((entry) => {
    const regexDepth =
      entry.position === WORLD_INFO_POSITION.atDepth ? (entry.depth ?? DEFAULT_DEPTH) : null;
    const content = applyRegex(entry.content ?? '', regexDepth);
    if (!content) return;
    switch (entry.position) {
      case WORLD_INFO_POSITION.before:
        WIBeforeEntries.unshift(content);
        break;
      case WORLD_INFO_POSITION.after:
        WIAfterEntries.unshift(content);
        break;
      case WORLD_INFO_POSITION.EMTop:
        EMEntries.unshift({ position: WI_ANCHOR_POSITION.before, content });
        break;
      case WORLD_INFO_POSITION.EMBottom:
        EMEntries.unshift({ position: WI_ANCHOR_POSITION.after, content });
        break;
      case WORLD_INFO_POSITION.ANTop:
        ANTopEntries.unshift(content);
        break;
      case WORLD_INFO_POSITION.ANBottom:
        ANBottomEntries.unshift(content);
        break;
      case WORLD_INFO_POSITION.atDepth: {
        const role = entry.role ?? EXTENSION_PROMPT_ROLES.SYSTEM;
        const idx = WIDepthEntries.findIndex(
          (e) => e.depth === (entry.depth ?? DEFAULT_DEPTH) && e.role === role,
        );
        if (idx !== -1) WIDepthEntries[idx]!.entries.unshift(content);
        else WIDepthEntries.push({ depth: entry.depth, entries: [content], role });
        break;
      }
      case WORLD_INFO_POSITION.outlet: {
        if (!entry.outletName) {
          log(`[WI] Entry ${entry.uid} has position 'outlet' but no outlet name. Skipping.`);
          break;
        }
        (WIOutletEntries[entry.outletName] ??= []).push(content);
        break;
      }
      default:
        break;
    }
  });

  const worldInfoBefore = WIBeforeEntries.length ? WIBeforeEntries.join('\n') : '';
  const worldInfoAfter = WIAfterEntries.length ? WIAfterEntries.join('\n') : '';

  timedEffects.setTimedEffects(allActivatedEntries.values());
  buffer.resetExternalEffects();
  timedEffects.cleanUp();

  return {
    worldInfoBefore,
    worldInfoAfter,
    EMEntries,
    WIDepthEntries,
    ANBeforeEntries: ANTopEntries,
    ANAfterEntries: ANBottomEntries,
    outletEntries: WIOutletEntries,
    allActivatedEntries: new Set(allActivatedEntries.values()),
    ...(budgetOverflow ? { budgetOverflow } : {}),
  };
}

function filterGroupsByScoring(
  groups: Record<string, WIEntry[]>,
  buffer: WorldInfoBuffer,
  removeEntry: (entry: WIEntry) => void,
  scanState: ScanState,
  hasStickyMap: Map<string, boolean>,
  settings: WorldInfoSettings,
) {
  for (const [key, group] of Object.entries(groups)) {
    if (!settings.world_info_use_group_scoring && !group.some((x) => x.useGroupScoring)) continue;
    if (hasStickyMap.get(key)) continue;
    const scores = group.map((entry) => buffer.getScore(entry, scanState));
    const maxScore = Math.max(...scores);
    for (let i = 0; i < group.length; i++) {
      const isScored = group[i]!.useGroupScoring ?? settings.world_info_use_group_scoring;
      if (!isScored) continue;
      if (scores[i]! < maxScore) {
        removeEntry(group[i]!);
        group.splice(i, 1);
        scores.splice(i, 1);
        i--;
      }
    }
  }
}

function filterGroupsByTimedEffects(
  groups: Record<string, WIEntry[]>,
  timedEffects: WorldInfoTimedEffects,
  removeEntry: (entry: WIEntry) => void,
): Map<string, boolean> {
  const hasStickyMap = new Map<string, boolean>();
  for (const [key, group] of Object.entries(groups)) {
    hasStickyMap.set(key, false);
    const stickyEntries = group.filter((x) => timedEffects.isEffectActive('sticky', x));
    if (stickyEntries.length) {
      for (const entry of group) {
        if (stickyEntries.includes(entry)) continue;
        removeEntry(entry);
      }
      hasStickyMap.set(key, true);
    }
    for (const entry of group.filter((x) => timedEffects.isEffectActive('cooldown', x)))
      removeEntry(entry);
    for (const entry of group.filter((x) => timedEffects.isEffectActive('delay', x)))
      removeEntry(entry);
  }
  return hasStickyMap;
}

export function filterByInclusionGroups(
  newEntries: WIEntry[],
  allActivatedEntries: Map<string, WIEntry>,
  buffer: WorldInfoBuffer,
  scanState: ScanState,
  timedEffects: WorldInfoTimedEffects,
  settings: WorldInfoSettings,
  random: () => number = Math.random,
  log: (message: string) => void = () => {},
): void {
  const grouped = newEntries
    .filter((x) => x.group)
    .reduce<Record<string, WIEntry[]>>((acc, item) => {
      item
        .group!.split(/,\s*/)
        .filter((x) => x)
        .forEach((group) => {
          (acc[group] ??= []).push(item);
        });
      return acc;
    }, {});
  if (Object.keys(grouped).length === 0) return;

  const removeEntry = (entry: WIEntry) => {
    const idx = newEntries.indexOf(entry);
    if (idx !== -1) newEntries.splice(idx, 1);
  };
  const removeAllBut = (group: WIEntry[], chosen: WIEntry | null) => {
    for (const entry of group) {
      if (entry === chosen) continue;
      removeEntry(entry);
    }
  };

  const hasStickyMap = filterGroupsByTimedEffects(grouped, timedEffects, removeEntry);
  filterGroupsByScoring(grouped, buffer, removeEntry, scanState, hasStickyMap, settings);

  const sortFn = (a: WIEntry, b: WIEntry) => (b.order ?? 0) - (a.order ?? 0);
  for (const [key, group] of Object.entries(grouped)) {
    if (hasStickyMap.get(key)) continue;
    if (Array.from(allActivatedEntries.values()).some((x) => x.group === key)) {
      removeAllBut(group, null);
      continue;
    }
    if (!Array.isArray(group) || group.length <= 1) continue;

    const prios = group.filter((x) => x.groupOverride).sort(sortFn);
    if (prios.length) {
      removeAllBut(group, prios[0]!);
      continue;
    }

    const totalWeight = group.reduce((acc, item) => acc + (item.groupWeight ?? DEFAULT_WEIGHT), 0);
    const rollValue = random() * totalWeight;
    let currentWeight = 0;
    let winner: WIEntry | null = null;
    for (const entry of group) {
      currentWeight += entry.groupWeight ?? DEFAULT_WEIGHT;
      if (rollValue <= currentWeight) {
        winner = entry;
        break;
      }
    }
    if (!winner) {
      log(`[WI] Failed to activate inclusion group '${key}', no winner found`);
      continue;
    }
    removeAllBut(group, winner);
  }
}

/** ST getWorldInfoPrompt（不发事件，激活条目在返回值里） */
export async function getWorldInfoPrompt(
  input: CheckWorldInfoInput,
  deps: WorldInfoScanDeps,
): Promise<WIPromptResult> {
  return worldInfoPromptOf(await checkWorldInfo(input, deps));
}

/** the shape ST getWorldInfoPrompt returns for a finished scan */
export function worldInfoPromptOf(activated: WIActivated): WIPromptResult {
  return {
    worldInfoString: activated.worldInfoBefore + activated.worldInfoAfter,
    worldInfoBefore: activated.worldInfoBefore,
    worldInfoAfter: activated.worldInfoAfter,
    worldInfoExamples: activated.EMEntries,
    worldInfoDepth: activated.WIDepthEntries,
    anBefore: activated.ANBeforeEntries,
    anAfter: activated.ANAfterEntries,
    outletEntries: activated.outletEntries,
    allActivatedEntries: Array.from(activated.allActivatedEntries),
  };
}

/** script.js: coreChat.map(x => include_names ? `${x.name}: ${x.mes}` : x.mes).reverse() */
export function buildChatForWorldInfo(
  chat: readonly { name?: string; mes: string }[],
  includeNames: boolean,
): string[] {
  return chat.map((x) => (includeNames ? `${x.name}: ${x.mes}` : x.mes)).reverse();
}
