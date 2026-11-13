// ST MacroCstWalker.js 移植：遍历 CST、解析嵌套/作用域宏、变量简写表达式。
import type { CstNode, IToken } from 'chevrotain';
import { logMacroInternalError, logMacroRuntimeWarning, type MacroLogger } from './diagnostics.js';
import { createEmptyFlags, MacroFlagType, parseFlags, type MacroFlags } from './flags.js';
import { macroParser } from './parser.js';
import type { MacroRegistry } from './registry.js';
import type { MacroEnv } from './env.js';
import { isFalseBoolean } from '../util/booleans.js';

export interface MacroCall {
  name: string;
  args: string[];
  flags: MacroFlags;
  isScoped: boolean;
  isVariableShorthand?: boolean;
  env: MacroEnv;
  rawInner: string;
  rawWithBraces: string;
  rawArgs: string[];
  range: TokenRange;
  globalOffset: number;
  cstNode: CstNode;
}

export interface TokenRange {
  startOffset: number;
  endOffset: number;
}

export interface MacroNodeInfo {
  name: string;
  isClosing: boolean;
  startOffset: number;
  endOffset: number;
  argCount: number;
}

export interface EvaluationContext {
  text: string;
  contextOffset: number;
  env: MacroEnv;
  resolveMacro: (call: MacroCall) => string;
  trimContent: (content: string, options?: { trimIndent?: boolean }) => string;
}

interface ScopedContent {
  startOffset: number;
  endOffset: number;
  closingEndOffset: number;
}
interface DocumentItemPlaintext {
  type: 'plaintext';
  startOffset: number;
  endOffset: number;
  token: IToken;
}
interface DocumentItemMacro {
  type: 'macro';
  startOffset: number;
  endOffset: number;
  node: CstNode;
  scopedContent?: ScopedContent;
  keepRaw?: boolean;
}
type DocumentItem = DocumentItemPlaintext | DocumentItemMacro;

type Children = Record<string, (IToken | CstNode)[] | undefined>;

const tokens = (children: Children, key: string): IToken[] => (children[key] ?? []) as IToken[];
const nodes = (children: Children, key: string): CstNode[] => (children[key] ?? []) as CstNode[];
const firstToken = (children: Children, key: string): IToken | undefined =>
  tokens(children, key)[0];
const firstNode = (children: Children, key: string): CstNode | undefined => nodes(children, key)[0];

export interface WalkerDeps {
  registry: MacroRegistry;
  logger: MacroLogger;
  normalize: (value: unknown) => string;
}

export class MacroCstWalker {
  readonly #registry: MacroRegistry;
  readonly #logger: MacroLogger;
  readonly #normalize: (value: unknown) => string;

  constructor({ registry, logger, normalize }: WalkerDeps) {
    this.#registry = registry;
    this.#logger = logger;
    this.#normalize = normalize;
  }

  evaluateDocument(options: EvaluationContext & { cst: CstNode }): string {
    const { text, cst, contextOffset, env, resolveMacro, trimContent } = options;
    if (typeof text !== 'string')
      throw new Error('MacroCstWalker.evaluateDocument: text must be a string');
    if (!cst || typeof cst !== 'object' || !cst.children)
      throw new Error('MacroCstWalker.evaluateDocument: cst must be a CstNode');
    const context: EvaluationContext = { text, contextOffset, env, resolveMacro, trimContent };
    let items = this.#collectDocumentItems(cst);
    items = this.#processScopedMacros(items);
    return this.#renderItems(items, text, context);
  }

  #renderItems(items: DocumentItem[], text: string, context: EvaluationContext): string {
    if (items.length === 0) return text;
    let result = '';
    let cursor = 0;
    for (const item of items) {
      if (item.startOffset > cursor) result += text.slice(cursor, item.startOffset);
      if (item.type === 'plaintext' || item.keepRaw) {
        result += text.slice(item.startOffset, item.endOffset + 1);
        cursor = item.endOffset + 1;
      } else {
        result += this.#evaluateMacroNode(item.node, context, item.scopedContent);
        if (item.scopedContent && item.scopedContent.closingEndOffset > item.endOffset) {
          cursor = item.scopedContent.closingEndOffset + 1;
        } else {
          cursor = item.endOffset + 1;
        }
      }
    }
    if (cursor < text.length) result += text.slice(cursor);
    return result;
  }

  /** 提取宏节点的名字、闭合标志、位置、参数个数；变量表达式返回 null */
  extractMacroInfo(macroNode: CstNode | undefined): MacroNodeInfo | null {
    const children = (macroNode?.children ?? {}) as Children;
    if (firstNode(children, 'variableExpr')) return null;
    const startToken = firstToken(children, 'Macro.Start');
    const endToken = firstToken(children, 'Macro.End');
    if (!startToken || !endToken) return null;
    const bodyChildren = (firstNode(children, 'macroBody')?.children ?? {}) as Children;
    const name = firstToken(bodyChildren, 'Macro.identifier')?.image || '';
    if (!name) return null;
    const argumentsNode = firstNode(bodyChildren, 'arguments');
    const argCount = nodes((argumentsNode?.children ?? {}) as Children, 'argument').length;
    const isClosing = tokens(children, 'flags').some(
      (t) => t.image === MacroFlagType.CLOSING_BLOCK,
    );
    return {
      name,
      isClosing,
      startOffset: startToken.startOffset,
      endOffset: endToken.endOffset ?? endToken.startOffset,
      argCount,
    };
  }

  /** 找出未闭合的作用域宏（自动补全用），最内层在最后 */
  findUnclosedScopes({ text, cst }: { text: string; cst: CstNode }): Array<{
    name: string;
    startOffset: number;
    endOffset: number;
    paddingBefore: string;
    paddingAfter: string;
  }> {
    if (typeof text !== 'string' || !cst?.children) return [];
    const items = this.#collectDocumentItems(cst);
    const unclosedStack: Array<{
      name: string;
      startOffset: number;
      endOffset: number;
      paddingBefore: string;
      paddingAfter: string;
    }> = [];
    for (const item of items) {
      if (item.type !== 'macro') continue;
      const info = this.#extractNameInfo(item.node);
      if (!info) continue;
      if (info.isClosing) {
        const matchIndex = unclosedStack.findLastIndex(
          (s) => s.name.toLowerCase() === info.name.toLowerCase(),
        );
        if (matchIndex !== -1) unclosedStack.splice(matchIndex);
      } else if (this.#canAcceptScopedContent(item.node, info.name)) {
        const { paddingBefore, paddingAfter } = this.#extractMacroPadding(item.node, text);
        unclosedStack.push({
          name: info.name,
          startOffset: item.startOffset,
          endOffset: item.endOffset,
          paddingBefore,
          paddingAfter,
        });
      }
    }
    return unclosedStack;
  }

  #extractMacroPadding(macroNode: CstNode, text: string) {
    const children = macroNode.children as Children;
    const startToken = firstToken(children, 'Macro.Start');
    const endToken = firstToken(children, 'Macro.End');
    if (!startToken || !endToken) return { paddingBefore: '', paddingAfter: '' };
    const innerText = text.slice(
      (startToken.endOffset ?? startToken.startOffset) + 1,
      endToken.startOffset,
    );
    return {
      paddingBefore: /^(\s*)/.exec(innerText)?.[1] ?? '',
      paddingAfter: /(\s*)$/.exec(innerText)?.[1] ?? '',
    };
  }

  #collectDocumentItems(cst: CstNode): DocumentItem[] {
    const children = cst.children as Children;
    const items: DocumentItem[] = [];
    for (const token of tokens(children, 'plaintext')) {
      if (typeof token.startOffset !== 'number' || typeof token.endOffset !== 'number') continue;
      items.push({
        type: 'plaintext',
        startOffset: token.startOffset,
        endOffset: token.endOffset,
        token,
      });
    }
    for (const macroNode of nodes(children, 'macro')) {
      const endToken = firstToken((macroNode.children ?? {}) as Children, 'Macro.End');
      if (this.#isRecoveryToken(endToken)) {
        this.#flattenIncompleteMacro(macroNode, endToken, items);
        continue;
      }
      const range = this.#getMacroRange(macroNode);
      items.push({
        type: 'macro',
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        node: macroNode,
      });
    }
    items.sort((a, b) =>
      a.startOffset !== b.startOffset ? a.startOffset - b.startOffset : a.endOffset - b.endOffset,
    );
    return items;
  }

  #evaluateMacroNode(
    macroNode: CstNode,
    context: EvaluationContext,
    scopedContent?: ScopedContent,
  ): string {
    const { text, contextOffset, env, resolveMacro, trimContent } = context;
    const children = (macroNode.children ?? {}) as Children;

    const variableExprNode = firstNode(children, 'variableExpr');
    if (variableExprNode) return this.#evaluateVariableExpr(macroNode, variableExprNode, context);

    const bodyChildren = (firstNode(children, 'macroBody')?.children ?? {}) as Children;
    const name = firstToken(bodyChildren, 'Macro.identifier')?.image || '';

    const flagSymbols = tokens(children, 'flags').map((t) => t.image);
    const flags =
      flagSymbols.length > 0
        ? parseFlags(flagSymbols, (symbol) =>
            this.#logger.warn(`Can't parse unknown macro flag: ${symbol}`),
          )
        : createEmptyFlags();

    const range = this.#getMacroRange(macroNode);
    const startToken = firstToken(children, 'Macro.Start');
    const endToken = firstToken(children, 'Macro.End');
    const innerStart = startToken
      ? (startToken.endOffset ?? startToken.startOffset) + 1
      : range.startOffset;
    const innerEnd = endToken ? endToken.startOffset - 1 : range.endOffset;

    const argumentNodes = nodes(
      (firstNode(bodyChildren, 'arguments')?.children ?? {}) as Children,
      'argument',
    );

    const macroDef = this.#registry.getMacro(name);
    const delayArgResolution = macroDef?.delayArgResolution === true;

    const args: string[] = [];
    const evaluatedArguments: ({ value: string } & TokenRange)[] = [];
    const rawArgs: string[] = [];

    for (const argNode of argumentNodes) {
      const location = this.#getArgumentLocation(argNode);
      const rawArgText = location ? text.slice(location.startOffset, location.endOffset + 1) : '';
      rawArgs.push(rawArgText);
      const argValue = delayArgResolution
        ? rawArgText
        : this.#evaluateArgumentNode(argNode, context);
      args.push(argValue);
      if (location) evaluatedArguments.push({ value: argValue, ...location });
    }

    if (scopedContent) {
      if (scopedContent.startOffset > scopedContent.endOffset) {
        args.push('');
        rawArgs.push('');
      } else {
        const rawScopedText = text.slice(scopedContent.startOffset, scopedContent.endOffset + 1);
        rawArgs.push(rawScopedText);
        let scopedValue: string;
        if (delayArgResolution) {
          scopedValue = rawScopedText;
        } else {
          scopedValue = this.#evaluateScopedContent(scopedContent, context);
          if (!flags.preserveWhitespace) scopedValue = trimContent(scopedValue);
        }
        args.push(scopedValue);
        evaluatedArguments.push({
          value: scopedValue,
          startOffset: scopedContent.startOffset,
          endOffset: scopedContent.endOffset,
        });
      }
    }

    evaluatedArguments.sort((a, b) => a.startOffset - b.startOffset);

    let rawInner = '';
    if (innerStart <= innerEnd) {
      let cursor = innerStart;
      for (const entry of evaluatedArguments) {
        if (entry.startOffset > cursor) rawInner += text.slice(cursor, entry.startOffset);
        rawInner += entry.value;
        cursor = entry.endOffset + 1;
      }
      if (cursor <= innerEnd) rawInner += text.slice(cursor, innerEnd + 1);
    }

    const call: MacroCall = {
      name,
      args,
      flags,
      isScoped: scopedContent != null,
      rawInner,
      rawWithBraces: text.slice(range.startOffset, range.endOffset + 1),
      rawArgs,
      range,
      globalOffset: contextOffset + range.startOffset,
      cstNode: macroNode,
      env,
    };

    const value = resolveMacro(call);
    return typeof value === 'string' ? value : String(value ?? '');
  }

  #evaluateVariableExpr(
    macroNode: CstNode,
    variableExprNode: CstNode,
    context: EvaluationContext,
  ): string {
    const varChildren = (variableExprNode.children ?? {}) as Children;
    const localPrefixToken = tokens(varChildren, 'Var.scope').find(
      (t) => t.tokenType?.name === 'Var.LocalPrefix',
    );
    const isGlobal = !localPrefixToken;
    const varName = firstToken(varChildren, 'Var.identifier')?.image || '';
    const operatorNode = firstNode(varChildren, 'variableOperator');
    const operatorChildren = (operatorNode?.children ?? {}) as Children;

    let operation = 'get';
    let hasValueExpr = false;
    const operatorToken = firstToken(operatorChildren, 'Var.operator');
    if (operatorNode && operatorToken) {
      const map: Record<string, [string, boolean]> = {
        '++': ['inc', false],
        '--': ['dec', false],
        '=': ['set', true],
        '+=': ['add', true],
        '-=': ['sub', true],
        '||': ['logicalOr', true],
        '??': ['nullishCoalescing', true],
        '||=': ['logicalOrAssign', true],
        '??=': ['nullishCoalescingAssign', true],
        '==': ['equals', true],
        '!=': ['notEquals', true],
        '>': ['greaterThan', true],
        '>=': ['greaterThanOrEqual', true],
        '<': ['lessThan', true],
        '<=': ['lessThanOrEqual', true],
      };
      const entry = map[operatorToken.image];
      if (entry) {
        [operation, hasValueExpr] = entry;
      } else {
        logMacroInternalError(this.#logger, {
          message: `Lexer found macro operator that is not implemented for variable shorthand expressions in macro node '${macroNode.name}'.`,
        });
      }
    }

    const lazyValue = hasValueExpr ? this.#createLazyValue(operatorChildren, context) : () => '';
    return this.#executeVariableOperation(varName, isGlobal, operation, lazyValue, context.env);
  }

  #createLazyValue(operatorChildren: Children, context: EvaluationContext): () => string {
    let cached = '';
    let resolved = false;
    return () => {
      if (!resolved) {
        cached = this.#evaluateVariableValue(operatorChildren, context);
        resolved = true;
      }
      return cached;
    };
  }

  #executeVariableOperation(
    varName: string,
    isGlobal: boolean,
    operation: string,
    lazyValue: () => string,
    env: MacroEnv,
  ): string {
    const vars = isGlobal ? env.runtime.variables.global : env.runtime.variables.local;
    const normalize = this.#normalize;
    const isFalsy = (val: unknown) => !val || isFalseBoolean(normalize(val));
    const warn = (message: string) => logMacroRuntimeWarning(this.#logger, { message });
    const numericCompare = (op: string, cmp: (a: number, b: number) => boolean) => {
      const currentNum = Number(vars.get(varName));
      const compareNum = Number(lazyValue());
      if (isNaN(currentNum) || isNaN(compareNum)) {
        warn(
          `Variable shorthand "${op}" operator requires numeric values. Got: "${String(vars.get(varName))}" ${op} "${lazyValue()}"`,
        );
        return 'false';
      }
      return cmp(currentNum, compareNum) ? 'true' : 'false';
    };

    switch (operation) {
      case 'get':
        return normalize(vars.get(varName));
      case 'set':
        vars.set(varName, lazyValue());
        return '';
      case 'inc':
        return normalize(vars.inc(varName));
      case 'dec':
        return normalize(vars.dec(varName));
      case 'add':
        vars.add(varName, lazyValue());
        return '';
      case 'sub': {
        const numValue = Number(lazyValue());
        if (!isNaN(numValue)) vars.add(varName, -numValue);
        else
          warn(`Variable shorthand "-=" operator requires a numeric value, got: "${lazyValue()}"`);
        return '';
      }
      case 'logicalOr': {
        const currentValue = vars.get(varName);
        return isFalsy(currentValue) ? normalize(lazyValue()) : normalize(currentValue);
      }
      case 'nullishCoalescing':
        return vars.has(varName) ? normalize(vars.get(varName)) : normalize(lazyValue());
      case 'logicalOrAssign': {
        const currentValue = vars.get(varName);
        if (isFalsy(currentValue)) {
          vars.set(varName, lazyValue());
          return normalize(lazyValue());
        }
        return normalize(currentValue);
      }
      case 'nullishCoalescingAssign': {
        if (!vars.has(varName)) {
          vars.set(varName, lazyValue());
          return normalize(lazyValue());
        }
        return normalize(vars.get(varName));
      }
      case 'equals':
        return normalize(vars.get(varName)) === normalize(lazyValue()) ? 'true' : 'false';
      case 'notEquals':
        return normalize(vars.get(varName)) !== normalize(lazyValue()) ? 'true' : 'false';
      case 'greaterThan':
        return numericCompare('>', (a, b) => a > b);
      case 'greaterThanOrEqual':
        return numericCompare('>=', (a, b) => a >= b);
      case 'lessThan':
        return numericCompare('<', (a, b) => a < b);
      case 'lessThanOrEqual':
        return numericCompare('<=', (a, b) => a <= b);
      default:
        warn(`Unknown variable shorthand operation: "${operation}"`);
        return '';
    }
  }

  #evaluateVariableValue(operatorChildren: Children, context: EvaluationContext): string {
    const { text } = context;
    const valueNode = firstNode(operatorChildren, 'Var.value');
    if (!valueNode) return '';
    const valueChildren = (valueNode.children ?? {}) as Children;
    const allTokens = [...tokens(valueChildren, 'Identifier'), ...tokens(valueChildren, 'Unknown')];
    const nestedMacros = nodes(valueChildren, 'macro');
    const allRanges: TokenRange[] = [
      ...allTokens.map((t) => ({
        startOffset: t.startOffset,
        endOffset: t.endOffset ?? t.startOffset,
      })),
      ...nestedMacros.map((m) => this.#getMacroRange(m)),
    ];
    if (allRanges.length === 0) return '';
    const startOffset = Math.min(...allRanges.map((r) => r.startOffset));
    const endOffset = Math.max(...allRanges.map((r) => r.endOffset));
    if (nestedMacros.length === 0) return text.slice(startOffset, endOffset + 1).trim();

    const nestedWithRange = nestedMacros
      .map((node) => ({ node, range: this.#getMacroRange(node) }))
      .sort((a, b) => a.range.startOffset - b.range.startOffset);
    let result = '';
    let cursor = startOffset;
    for (const entry of nestedWithRange) {
      if (entry.range.startOffset > cursor) result += text.slice(cursor, entry.range.startOffset);
      result += this.#evaluateMacroNode(entry.node, context);
      cursor = entry.range.endOffset + 1;
    }
    if (cursor <= endOffset) result += text.slice(cursor, endOffset + 1);
    return result.trim();
  }

  #evaluateArgumentNode(argNode: CstNode, context: EvaluationContext): string {
    const location = this.#getArgumentLocation(argNode);
    if (!location) return '';
    const { text, contextOffset } = context;
    const rawContent = text.slice(location.startOffset, location.endOffset + 1);
    return this.#evaluateRawContent(rawContent, contextOffset + location.startOffset, context);
  }

  #evaluateRawContent(
    rawContent: string,
    newContextOffset: number,
    context: EvaluationContext,
  ): string {
    if (!rawContent) return '';
    const { cst } = macroParser.parseDocument(rawContent);
    if (!cst || typeof cst !== 'object' || !cst.children) return rawContent;
    const contentContext: EvaluationContext = {
      ...context,
      text: rawContent,
      contextOffset: newContextOffset,
    };
    let items = this.#collectDocumentItems(cst);
    items = this.#processScopedMacros(items);
    if (items.length === 0) return rawContent;
    return this.#renderItems(items, rawContent, contentContext);
  }

  #getMacroRange(macroNode: CstNode): TokenRange {
    const children = (macroNode.children ?? {}) as Children;
    const startToken = firstToken(children, 'Macro.Start');
    const endToken = firstToken(children, 'Macro.End');
    if (startToken && endToken)
      return {
        startOffset: startToken.startOffset,
        endOffset: endToken.endOffset ?? endToken.startOffset,
      };
    if (macroNode.location) {
      return {
        startOffset: macroNode.location.startOffset,
        endOffset: macroNode.location.endOffset ?? macroNode.location.startOffset,
      };
    }
    return { startOffset: 0, endOffset: 0 };
  }

  #flattenIncompleteMacro(
    macroNode: CstNode,
    excludeToken: IToken | undefined,
    items: DocumentItem[],
  ) {
    const children = (macroNode.children ?? {}) as Children;
    for (const key of Object.keys(children)) {
      for (const element of children[key] ?? []) {
        if (element === excludeToken) continue;
        if (!this.#isCstNode(element)) {
          if (typeof element.startOffset === 'number') {
            items.push({
              type: 'plaintext',
              startOffset: element.startOffset,
              endOffset: element.endOffset ?? element.startOffset,
              token: element,
            });
          }
          continue;
        }
        const nestedChildren = (element.children ?? {}) as Children;
        const nestedEnd = firstToken(nestedChildren, 'Macro.End');
        const nestedStart = firstToken(nestedChildren, 'Macro.Start');
        if (nestedStart && nestedEnd) {
          if (!this.#isRecoveryToken(nestedEnd)) {
            const range = this.#getMacroRange(element);
            items.push({
              type: 'macro',
              startOffset: range.startOffset,
              endOffset: range.endOffset,
              node: element,
            });
          } else {
            this.#flattenIncompleteMacro(element, nestedEnd, items);
          }
        } else {
          this.#flattenIncompleteMacro(element, excludeToken, items);
        }
      }
    }
  }

  #isRecoveryToken(token: IToken | null | undefined): boolean {
    return (
      token?.isInsertedInRecovery === true ||
      typeof token?.startOffset !== 'number' ||
      Number.isNaN(token.startOffset)
    );
  }

  #getArgumentLocation(argNode: CstNode): TokenRange | null {
    const children = (argNode.children ?? {}) as Children;
    let startOffset = Number.POSITIVE_INFINITY;
    let endOffset = Number.NEGATIVE_INFINITY;
    for (const key of Object.keys(children)) {
      for (const element of children[key] ?? []) {
        if (this.#isCstNode(element)) {
          const location = element.location;
          if (!location) continue;
          if (location.startOffset < startOffset) startOffset = location.startOffset;
          if ((location.endOffset ?? -Infinity) > endOffset)
            endOffset = location.endOffset as number;
        } else if (element) {
          if (element.startOffset < startOffset) startOffset = element.startOffset;
          if ((element.endOffset ?? -Infinity) > endOffset) endOffset = element.endOffset as number;
        }
      }
    }
    if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset)) return null;
    return { startOffset, endOffset };
  }

  #isCstNode(value: unknown): value is CstNode {
    return !!value && typeof value === 'object' && 'name' in value && 'children' in value;
  }

  #evaluateScopedContent(scopedContent: ScopedContent, context: EvaluationContext): string {
    const { text, contextOffset } = context;
    const rawContent = text.slice(scopedContent.startOffset, scopedContent.endOffset + 1);
    return this.#evaluateRawContent(rawContent, contextOffset + scopedContent.startOffset, context);
  }

  #processScopedMacros(items: DocumentItem[]): DocumentItem[] {
    type Info = {
      index: number;
      item: DocumentItemMacro;
      name: string;
      isClosing: boolean;
      matched: boolean;
    };
    const macroInfos: Info[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.type !== 'macro') continue;
      const info = this.#extractNameInfo(item.node);
      if (!info) continue;
      macroInfos.push({
        index: i,
        item,
        name: info.name,
        isClosing: info.isClosing,
        matched: false,
      });
    }

    const pairs: Array<{ openingIndex: number; closingIndex: number }> = [];
    const insideScope = new Set<number>();

    for (let i = 0; i < macroInfos.length; i++) {
      const openInfo = macroInfos[i]!;
      if (openInfo.isClosing || openInfo.matched || insideScope.has(openInfo.index)) continue;
      const closingIdx = this.#findMatchingClosingMacro(macroInfos, i);
      if (closingIdx === -1) continue;
      const closing = macroInfos[closingIdx]!;
      if (!this.#canAcceptScopedContent(openInfo.item.node, openInfo.name)) {
        openInfo.item.keepRaw = true;
        closing.item.keepRaw = true;
        openInfo.matched = true;
        closing.matched = true;
        continue;
      }
      openInfo.matched = true;
      closing.matched = true;
      pairs.push({ openingIndex: openInfo.index, closingIndex: closing.index });
      for (let j = openInfo.index + 1; j < closing.index; j++) insideScope.add(j);
    }

    for (const info of macroInfos) {
      if (info.isClosing && !info.matched) info.item.keepRaw = true;
    }
    if (pairs.length === 0) return items;

    const itemsToRemove = new Set<number>();
    for (const pair of pairs) {
      const openingItem = items[pair.openingIndex] as DocumentItemMacro;
      const closingItem = items[pair.closingIndex] as DocumentItemMacro;
      openingItem.scopedContent = {
        startOffset: openingItem.endOffset + 1,
        endOffset: closingItem.startOffset - 1,
        closingEndOffset: closingItem.endOffset,
      };
      itemsToRemove.add(pair.closingIndex);
      for (let j = pair.openingIndex + 1; j < pair.closingIndex; j++) itemsToRemove.add(j);
    }
    return items.filter((_, index) => !itemsToRemove.has(index));
  }

  #extractNameInfo(macroNode: CstNode): { name: string; isClosing: boolean } | null {
    const children = (macroNode.children ?? {}) as Children;
    if (firstNode(children, 'variableExpr')) return null;
    const bodyChildren = (firstNode(children, 'macroBody')?.children ?? {}) as Children;
    const name = firstToken(bodyChildren, 'Macro.identifier')?.image || '';
    if (!name) return null;
    const isClosing = tokens(children, 'flags').some(
      (t) => t.image === MacroFlagType.CLOSING_BLOCK,
    );
    return { name, isClosing };
  }

  #canAcceptScopedContent(macroNode: CstNode, macroName: string): boolean {
    const def = this.#registry.getPrimaryMacro(macroName);
    if (!def) return true;
    const children = (macroNode.children ?? {}) as Children;
    const bodyChildren = (firstNode(children, 'macroBody')?.children ?? {}) as Children;
    const currentArgCount = nodes(
      (firstNode(bodyChildren, 'arguments')?.children ?? {}) as Children,
      'argument',
    ).length;
    if (def.list) return false;
    const newArgCount = currentArgCount + 1;
    return newArgCount >= def.minArgs && newArgCount <= def.maxArgs;
  }

  #findMatchingClosingMacro(
    macroInfos: Array<{
      index: number;
      item: DocumentItemMacro;
      name: string;
      isClosing: boolean;
      matched: boolean;
    }>,
    openingIdx: number,
  ): number {
    const targetName = macroInfos[openingIdx]!.name;
    let depth = 1;
    for (let i = openingIdx + 1; i < macroInfos.length; i++) {
      const info = macroInfos[i]!;
      if (info.name.toLowerCase() !== targetName.toLowerCase()) continue;
      if (info.matched) continue;
      if (info.isClosing) {
        depth--;
        if (depth === 0) return i;
      } else if (this.#canAcceptScopedContent(info.item.node, info.name)) {
        depth++;
      }
    }
    return -1;
  }
}
