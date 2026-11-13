// ST core-macros.js 移植：工具宏、if/else、roll/random/pick、banned、outlet。
import seedrandom from 'seedrandom';
import { ELSE_MARKER } from '../constants.js';
import { MACRO_VARIABLE_SHORTHAND_PATTERN } from '../lexer.js';
import { macroParser } from '../parser.js';
import { MacroCategory, MacroValueType, type MacroRegistry } from '../registry.js';
import type { MacroCstWalker } from '../walker.js';
import { getStringHash } from '../../util/hash.js';
import { isFalseBoolean } from '../../util/booleans.js';
import { rollDice, validateDice } from '../../util/dice.js';
import { currentChatId, customWiOutletId, type CoreState } from '../../state.js';

type MacroInfo = ReturnType<MacroCstWalker['extractMacroInfo']>;
type ExtractMacroInfo = (node: import('chevrotain').CstNode) => MacroInfo;

export function registerCoreMacros(
  registry: MacroRegistry,
  extractMacroInfo: ExtractMacroInfo,
): void {
  registry.registerMacro('space', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      {
        name: 'count',
        optional: true,
        defaultValue: '1',
        type: MacroValueType.INTEGER,
        description: 'Number of spaces to insert.',
      },
    ],
    description:
      'Returns one or more spaces. One space by default, more if the count argument is specified.',
    returns: 'One or more spaces.',
    exampleUsage: ['{{space}}', '{{space::4}}'],
    handler: ({ unnamedArgs: [count] }) => ' '.repeat(Number(count ?? 1)),
  });

  registry.registerMacro('newline', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      {
        name: 'count',
        optional: true,
        defaultValue: '1',
        type: MacroValueType.INTEGER,
        description: 'Number of newlines to insert.',
      },
    ],
    description:
      'Inserts one or more newlines. One newline by default, more if the count argument is specified.',
    returns: 'One or more \\n.',
    exampleUsage: ['{{newline}}', '{{newline::2}}'],
    handler: ({ unnamedArgs: [count] }) => '\n'.repeat(Number(count ?? 1)),
  });

  registry.registerMacro('noop', {
    category: MacroCategory.UTILITY,
    description: 'Does nothing and produces an empty string.',
    returns: '',
    handler: () => '',
  });

  registry.registerMacro('trim', {
    category: MacroCategory.UTILITY,
    description:
      'Trims whitespace. Non-scoped: trims newlines around the macro (post-processing). Scoped: returns the content (auto-trimmed by the engine).',
    unnamedArgs: [
      {
        name: 'content',
        description: 'Content to trim (when used as scoped macro)',
        optional: true,
      },
    ],
    returns: '',
    handler: ({ unnamedArgs: [content], isScoped }) => (isScoped ? (content ?? '') : '{{trim}}'),
  });

  function splitOnTopLevelElse(content: string): {
    thenBranch: string;
    elseBranch: string | undefined;
  } {
    const { cst } = macroParser.parseDocument(content);
    const macroNodes = (cst?.children?.['macro'] || []) as import('chevrotain').CstNode[];
    let depth = 0;
    for (const macroNode of macroNodes) {
      const info = extractMacroInfo(macroNode);
      if (!info) continue;
      if (info.name === 'if' && !info.isClosing && info.argCount === 1) depth++;
      else if (info.name === 'if' && info.isClosing) depth--;
      else if (info.name === 'else' && depth === 0) {
        return {
          thenBranch: content.slice(0, info.startOffset),
          elseBranch: content.slice(info.endOffset + 1),
        };
      }
    }
    return { thenBranch: content, elseBranch: undefined };
  }

  registry.registerMacro('if', {
    category: MacroCategory.UTILITY,
    description:
      'Conditional macro. Returns the content if the condition is truthy, otherwise returns nothing (or the else branch if present). Prefix the condition with ! to invert. If the condition is a registered macro name (without braces), it will be resolved first. Variable shorthands (.varname for local, $varname for global) are also supported.',
    unnamedArgs: [
      {
        name: 'condition',
        description:
          'The condition to evaluate. Prefix with ! to invert. Can be a macro name (auto-resolved), variable shorthand (.var or $var), or a value. Falsy: empty string, "false", "off", "0".',
      },
      {
        name: 'content',
        description:
          'The content to return if condition is truthy (typically provided as scoped content). May contain {{else}} to define an else branch.',
      },
    ],
    displayOverride: '{{if condition}}then{{else}}other{{/if}}',
    exampleUsage: [
      '{{if description}}# Description\n{{description}}{{/if}}',
      '{{if charVersion}}{{charVersion}}{{else}}No version{{/if}}',
      '{{if !personality}}No personality defined{{/if}}',
      '{{if {{getvar::showHeader}}}}# Header{{/if}}',
      '{{if .myvar}}Local var exists{{/if}}',
      '{{if $globalFlag}}Global flag is set{{/if}}',
    ],
    returns: 'The content if condition is truthy, else branch or empty string otherwise.',
    delayArgResolution: true,
    handler: ({
      unnamedArgs: [rawCondition = '', rawContent = ''],
      flags,
      resolve,
      trimContent,
      registry: reg,
    }) => {
      let inverted = false;
      let condition = rawCondition;
      if (/^\s*!/.test(rawCondition)) {
        inverted = true;
        condition = rawCondition.replace(/^\s*!\s*/, '');
      }
      condition = resolve(condition);

      const varShorthandRegex = new RegExp(`^([.$])(${MACRO_VARIABLE_SHORTHAND_PATTERN.source})$`);
      const varShorthandMatch = varShorthandRegex.exec(condition);
      if (varShorthandMatch) {
        const prefix = varShorthandMatch[1];
        const varName = varShorthandMatch[2];
        const varMacro = prefix === '.' ? 'getvar' : 'getglobalvar';
        condition = resolve(`{{${varMacro}::${varName}}}`);
      } else {
        const macroDef = reg.getPrimaryMacro(condition);
        if (macroDef && macroDef.minArgs === 0) condition = resolve(`{{${condition}}}`);
      }

      let isFalsy = condition === '' || isFalseBoolean(condition);
      if (inverted) isFalsy = !isFalsy;

      const { thenBranch, elseBranch } = splitOnTopLevelElse(rawContent);
      const chosenBranch = !isFalsy ? thenBranch : elseBranch;
      if (chosenBranch === undefined) return '';
      let result = resolve(chosenBranch);
      if (!flags.preserveWhitespace) result = trimContent(result);
      return result;
    },
  });

  registry.registerMacro('else', {
    category: MacroCategory.UTILITY,
    description:
      'Marks the else branch inside a scoped {{if}} block. Only works inside {{if}}...{{/if}}. If used outside, returns an invisible marker.',
    exampleUsage: ['{{if condition}}true branch{{else}}false branch{{/if}}'],
    returns: 'Invisible marker (consumed by the enclosing {{if}} macro).',
    handler: () => ELSE_MARKER,
  });

  registry.registerMacro('input', {
    category: MacroCategory.UTILITY,
    description: 'Current text from the send textarea.',
    returns: 'Current text from the send textarea.',
    handler: ({ env }) => env.runtime.input ?? '',
  });

  registry.registerMacro('maxPrompt', {
    aliases: [{ alias: 'maxPromptTokens', visible: true }],
    category: MacroCategory.STATE,
    description: 'Maximum prompt context size.',
    returns: 'Maximum prompt context size.',
    returnType: MacroValueType.INTEGER,
    handler: ({ env }) => String(env.runtime.tokens.maxPrompt()),
  });
  registry.registerMacro('maxContext', {
    aliases: [{ alias: 'maxContextTokens', visible: true }],
    category: MacroCategory.STATE,
    description: 'Maximum context token limit.',
    returns: 'Maximum context token limit.',
    returnType: MacroValueType.INTEGER,
    handler: ({ env }) => String(env.runtime.tokens.maxContext()),
  });
  registry.registerMacro('maxResponse', {
    aliases: [{ alias: 'maxResponseTokens', visible: true }],
    category: MacroCategory.STATE,
    description: 'Maximum response token limit.',
    returns: 'Maximum response token limit.',
    returnType: MacroValueType.INTEGER,
    handler: ({ env }) => String(env.runtime.tokens.maxResponse()),
  });

  registry.registerMacro('reverse', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'value', type: MacroValueType.STRING, description: 'The string to reverse.' },
    ],
    description: 'Reverses the characters of the argument provided.',
    returns: 'Reversed string.',
    exampleUsage: ['{{reverse::I am Lana}}'],
    handler: ({ unnamedArgs: [value = ''] }) => Array.from(value).reverse().join(''),
  });

  registry.registerMacro('//', {
    aliases: [{ alias: 'comment', visible: false }],
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'comment', type: MacroValueType.STRING, description: 'Any kind of text as comment.' },
    ],
    list: true,
    strictArgs: false,
    description:
      'Comment macro that produces an empty string. Can be used for writing into prompt definitions, without being passed to the context.',
    returns: '',
    displayOverride: '{{// ...}}',
    exampleUsage: ['{{// This is a comment}}'],
    handler: () => '',
  });

  registry.registerMacro('roll', {
    category: MacroCategory.RANDOM,
    unnamedArgs: [
      {
        name: 'formula',
        sampleValue: '1d20',
        description: 'Dice roll formula using droll syntax (e.g. 1d20).',
        type: 'string',
      },
    ],
    description: 'Rolls dice using droll syntax (e.g. {{roll 1d20}}).',
    returns: 'Dice roll result.',
    returnType: MacroValueType.INTEGER,
    exampleUsage: ['{{roll::1d20}}', '{{roll::6}}', '{{roll::3d6+4}}'],
    handler: ({ unnamedArgs: [formula = ''], warn }) => {
      if (/^\d+$/.test(formula)) formula = `1d${formula}`;
      if (!validateDice(formula)) {
        warn(`Invalid roll formula: ${formula}`);
        return '';
      }
      const result = rollDice(formula);
      if (result === false) return '';
      return String(result.total);
    },
  });

  registry.registerMacro('random', {
    category: MacroCategory.RANDOM,
    list: true,
    description:
      'Picks a random item from a list. Will be re-rolled every time macros are resolved.',
    returns: 'Randomly selected item from the list.',
    exampleUsage: ['{{random::blonde::brown::red::black::blue}}'],
    handler: ({ list }) => {
      let items = list ?? [];
      if (items.length === 1) items = readSingleArgsRandomList(items[0]!);
      if (items.length === 0) return '';
      const rng = seedrandom('added entropy.', { entropy: true });
      return items[Math.floor(rng() * items.length)] ?? '';
    },
  });

  registry.registerMacro('pick', {
    category: MacroCategory.RANDOM,
    list: true,
    description:
      'Picks a random item from a list, but keeps the choice stable for a given chat and macro position. Can be rerolled via /reroll-pick slash command.',
    returns: 'Stable randomly selected item from the list.',
    exampleUsage: ['{{pick::blonde::brown::red::black::blue}}'],
    handler: ({ list, globalOffset, env }) => {
      let items = list ?? [];
      if (items.length === 1) items = readSingleArgsRandomList(items[0]!);
      if (!items.length) return '';
      const chatIdHash = getChatIdHash(env.runtime);
      const rawContentHash = env.contentHash;
      const rerollSeed =
        (env.runtime.chatMetadata['pick_reroll_seed'] as string | number | undefined) || null;
      const combinedSeedString = [chatIdHash, rawContentHash, globalOffset, rerollSeed]
        .filter((it) => it !== null)
        .join('-');
      const finalSeed = getStringHash(combinedSeedString);
      const rng = seedrandom(String(finalSeed));
      return items[Math.floor(rng() * items.length)] ?? '';
    },
  });

  function readSingleArgsRandomList(listString: string): string[] {
    if (listString.includes('::')) return listString.split('::').map((item) => item.trim());
    return listString
      .replace(/\\,/g, '##�COMMA�##')
      .split(',')
      .map((item) => item.trim().replace(/##�COMMA�##/g, ','));
  }

  registry.registerMacro('banned', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      {
        name: 'word',
        sampleValue: 'word',
        description: 'Word to ban for Text Completion backend.',
        type: 'string',
      },
    ],
    description:
      'Bans a word for Text Completion backend. (Strips quotes surrounding the banned word, if present)',
    returns: '',
    exampleUsage: ['{{banned::delve}}'],
    handler: ({ unnamedArgs: [bannedWord = ''], env }) => {
      bannedWord = bannedWord.replace(/^"|"$/g, '');
      if (env.runtime.mainApi === 'textgenerationwebui') env.runtime.bannedWords.push(bannedWord);
      return '';
    },
  });

  registry.registerMacro('outlet', {
    category: MacroCategory.UTILITY,
    unnamedArgs: [
      { name: 'key', sampleValue: 'my-outlet-key', description: 'Outlet key.', type: 'string' },
    ],
    description: 'Returns the world info outlet prompt for a given outlet key.',
    returns: 'World info outlet prompt.',
    exampleUsage: ['{{outlet::character-achievements}}'],
    handler: ({ unnamedArgs: [outlet], env }) => {
      if (!outlet) return '';
      return env.runtime.extensionPrompts[customWiOutletId(outlet)]?.value || '';
    },
  });
}

export function getChatIdHash(state: CoreState): number {
  const cached = state.chatMetadata['chat_id_hash'];
  if (typeof cached === 'number') return cached;
  const chatId = (state.chatMetadata['main_chat'] as string | undefined) ?? currentChatId(state);
  const hash = getStringHash(chatId);
  state.chatMetadata['chat_id_hash'] = hash;
  return hash;
}
