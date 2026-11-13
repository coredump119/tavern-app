// 示例对话解析：script.js parseMesExamples、openai.js parseExampleIntoIndividual、instruct-mode.js formatInstructModeExamples。
import { NAMES_BEHAVIOR, type CoreState } from '../state.js';

export interface ExampleMessage {
  role: 'system';
  content: string;
  name: 'example_user' | 'example_assistant';
}

/** 群聊成员名列表（getGroupNames） */
export function getGroupNames(state: CoreState): string[] {
  if (!state.selectedGroup) return [];
  const members = state.groups.find((x) => x.id == state.selectedGroup)?.members;
  return Array.isArray(members)
    ? members
        .map((x) => state.characters.find((y) => y.avatar === x)?.name)
        .filter((x): x is string => !!x)
    : [];
}

export function parseMesExamples(
  state: CoreState,
  substitute: (text: string) => string,
  examplesStr: string,
  isInstruct: boolean,
): string[] {
  if (!examplesStr || examplesStr.length === 0 || examplesStr === '<START>') return [];
  if (!examplesStr.startsWith('<START>')) examplesStr = '<START>\n' + examplesStr.trim();
  const sep = state.powerUser.context.example_separator;
  const exampleSeparator = sep ? `${substitute(sep)}\n` : '';
  const blockHeading = state.mainApi === 'openai' || isInstruct ? '<START>\n' : exampleSeparator;
  return examplesStr
    .split(/<START>/gi)
    .slice(1)
    .map((block) => `${blockHeading}${block.trim()}\n`);
}

export function parseExampleIntoIndividual(
  state: CoreState,
  name1: string,
  name2: string,
  messageExampleString: string,
  appendNamesForGroup = true,
): ExampleMessage[] {
  const groupBotNames = getGroupNames(state).map((name) => `${name}:`);
  const result: ExampleMessage[] = [];
  const tmp = messageExampleString.split('\n');
  let curMsgLines: string[] = [];
  let inUser = false;
  let inBot = false;
  let botName = name2;

  const addMsg = (name: string, systemName: ExampleMessage['name']) => {
    let parsed = curMsgLines
      .join('\n')
      .replace(name + ':', '')
      .trim();
    if (appendNamesForGroup && state.selectedGroup) parsed = `${name}: ${parsed}`;
    result.push({ role: 'system', content: parsed, name: systemName });
    curMsgLines = [];
  };

  for (let i = 1; i < tmp.length; i++) {
    const curStr = tmp[i]!;
    if (curStr.startsWith(name1 + ':')) {
      inUser = true;
      if (inBot) addMsg(botName, 'example_assistant');
      inBot = false;
    } else if (curStr.startsWith(name2 + ':') || groupBotNames.some((n) => curStr.startsWith(n))) {
      if (!curStr.startsWith(name2 + ':') && groupBotNames.length) botName = curStr.split(':')[0]!;
      inBot = true;
      if (inUser) addMsg(name1, 'example_user');
      inUser = false;
    }
    curMsgLines.push(curStr);
  }
  if (inUser) addMsg(name1, 'example_user');
  else if (inBot) addMsg(botName, 'example_assistant');
  return result;
}

export function formatInstructModeExamples(
  state: CoreState,
  substitute: (text: string, names?: { name1: string; name2: string }) => string,
  mesExamplesArray: string[],
  name1: string,
  name2: string,
): string[] {
  const instruct = state.powerUser.instruct;
  const sep = state.powerUser.context.example_separator;
  const blockHeading = sep ? `${substitute(sep)}\n` : '';

  if (instruct.skip_examples)
    return mesExamplesArray.map((x) => x.replace(/<START>\n/i, blockHeading));

  const includeNames = instruct.names_behavior === NAMES_BEHAVIOR.ALWAYS;
  const includeGroupNames =
    !!state.selectedGroup &&
    [NAMES_BEHAVIOR.ALWAYS, NAMES_BEHAVIOR.FORCE].includes(
      instruct.names_behavior as 'always' | 'force',
    );

  let inputPrefix = instruct.input_sequence || '';
  let outputPrefix = instruct.output_sequence || '';
  let inputSuffix = instruct.input_suffix || '';
  let outputSuffix = instruct.output_suffix || '';

  if (instruct.macro) {
    const names = { name1, name2 };
    inputPrefix = substitute(inputPrefix, names).replace(/{{name}}/gi, name1);
    outputPrefix = substitute(outputPrefix, names).replace(/{{name}}/gi, name2);
    inputSuffix = substitute(inputSuffix, names).replace(/{{name}}/gi, name1);
    outputSuffix = substitute(outputSuffix, names).replace(/{{name}}/gi, name2);
    if (!inputSuffix && instruct.wrap) inputSuffix = '\n';
    if (!outputSuffix && instruct.wrap) outputSuffix = '\n';
  }

  const separator = instruct.wrap ? '\n' : '';
  const formatted: string[] = [];
  for (const item of mesExamplesArray) {
    const cleaned = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
    const blockExamples = parseExampleIntoIndividual(
      state,
      name1,
      name2,
      cleaned,
      includeGroupNames,
    );
    if (blockExamples.length === 0) continue;
    if (blockHeading) formatted.push(blockHeading);
    for (const example of blockExamples) {
      const includeThisName =
        !includeGroupNames &&
        (includeNames ||
          (instruct.names_behavior === NAMES_BEHAVIOR.FORCE && example.name == 'example_user'));
      const prefix = example.name == 'example_user' ? inputPrefix : outputPrefix;
      const suffix = example.name == 'example_user' ? inputSuffix : outputSuffix;
      const name = example.name == 'example_user' ? name1 : name2;
      const messageContent = includeThisName ? `${name}: ${example.content}` : example.content;
      formatted.push([prefix, messageContent + suffix].filter((x) => x).join(separator));
    }
  }
  if (formatted.length === 0)
    return mesExamplesArray.map((x) => x.replace(/<START>\n/i, blockHeading));
  return formatted;
}
