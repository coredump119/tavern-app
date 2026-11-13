// ST instruct-mode.js：序列格式化（chat / story string / 末行 prompt）与 instruct 停止串。
import {
  NAMES_BEHAVIOR,
  type ContextSettings,
  type CoreState,
  type InstructSettings,
} from '../../state.js';
import { EXTENSION_PROMPT_TYPES } from '../extension-prompts.js';
import type { SubstituteOptions } from '../../macros/engine.js';

export const FORCE_OUTPUT_SEQUENCE = { FIRST: 1, LAST: 2 } as const;
export type ForceOutputSequence =
  (typeof FORCE_OUTPUT_SEQUENCE)[keyof typeof FORCE_OUTPUT_SEQUENCE] | false;

export type Substitute = (text: string, options?: SubstituteOptions) => string;

const onlyUnique = <T>(value: T, index: number, array: T[]) => array.indexOf(value) === index;

export function getInstructStoppingSequences(
  state: CoreState,
  substitute: Substitute,
  {
    customInstruct = null,
    useStopStrings = null,
  }: { customInstruct?: InstructSettings | null; useStopStrings?: boolean | null } = {},
): string[] {
  const instruct = structuredClone(customInstruct ?? state.powerUser.instruct);
  const context = state.powerUser.context;
  const name1 = state.userName;
  const name2 = state.charName;
  const result: string[] = [];

  const addInstructSequence = (sequence: string) => {
    const wrap = (s: string) => (instruct.wrap ? '\n' + s : s);
    if (typeof sequence === 'string' && sequence.length > 0 && sequence.trim().length > 0) {
      const wrapped = wrap(sequence);
      result.push(instruct.macro ? substitute(wrapped) : wrapped);
    }
  };

  if (customInstruct ?? instruct.enabled) {
    const rep = (s: string | undefined, name: string) => s?.replace(/{{name}}/gi, name) || '';
    const combined = [instruct.stop_sequence || ''];
    if (instruct['sequences_as_stop_strings'] ?? true) {
      combined.push(
        rep(instruct.input_sequence, name1),
        rep(instruct.output_sequence, name2),
        rep(instruct.first_output_sequence, name2),
        rep(instruct.last_output_sequence, name2),
        rep(instruct.system_sequence, 'System'),
        rep(instruct.last_system_sequence, 'System'),
      );
    }
    combined.join('\n').split('\n').filter(onlyUnique).forEach(addInstructSequence);
  }

  if (useStopStrings ?? context['use_stop_strings'] ?? true) {
    if (context.chat_start) result.push(`\n${substitute(context.chat_start)}`);
    if (context.example_separator) result.push(`\n${substitute(context.example_separator)}`);
  }
  return result;
}

export function formatInstructModeChat(
  state: CoreState,
  substitute: Substitute,
  name: string,
  mes: string,
  isUser: boolean,
  isNarrator: boolean,
  forceAvatar: unknown,
  name1: string,
  name2: string,
  forceOutputSequence: ForceOutputSequence | number,
  customInstruct: InstructSettings | null = null,
): string {
  const instruct = structuredClone(customInstruct ?? state.powerUser.instruct);
  let includeNames = isNarrator ? false : instruct.names_behavior === NAMES_BEHAVIOR.ALWAYS;
  if (
    !isNarrator &&
    instruct.names_behavior === NAMES_BEHAVIOR.FORCE &&
    ((state.selectedGroup && name !== name1) || (forceAvatar && name !== name1))
  )
    includeNames = true;

  const getPrefix = () => {
    if (isNarrator)
      return instruct['system_same_as_user'] ? instruct.input_sequence : instruct.system_sequence;
    if (isUser) {
      if (forceOutputSequence === FORCE_OUTPUT_SEQUENCE.FIRST)
        return instruct.first_input_sequence || instruct.input_sequence;
      if (forceOutputSequence === FORCE_OUTPUT_SEQUENCE.LAST)
        return instruct.last_input_sequence || instruct.input_sequence;
      return instruct.input_sequence;
    }
    if (forceOutputSequence === FORCE_OUTPUT_SEQUENCE.FIRST)
      return instruct.first_output_sequence || instruct.output_sequence;
    if (forceOutputSequence === FORCE_OUTPUT_SEQUENCE.LAST)
      return instruct.last_output_sequence || instruct.output_sequence;
    return instruct.output_sequence;
  };
  const getSuffix = () => {
    if (isNarrator)
      return instruct['system_same_as_user'] ? instruct.input_suffix : instruct.system_suffix;
    if (isUser) return instruct.input_suffix;
    return instruct.output_suffix;
  };

  let prefix = getPrefix() || '';
  let suffix = getSuffix() || '';
  if (instruct.macro) {
    prefix = substitute(prefix, { name1Override: name1, name2Override: name2 }).replace(
      /{{name}}/gi,
      name || 'System',
    );
    suffix = substitute(suffix, { name1Override: name1, name2Override: name2 }).replace(
      /{{name}}/gi,
      name || 'System',
    );
  }
  if (!suffix && instruct.wrap) suffix = '\n';
  const separator = instruct.wrap ? '\n' : '';
  const textArray =
    includeNames && name ? [prefix, `${name}: ${mes}` + suffix] : [prefix, mes + suffix];
  return textArray.filter((x) => x).join(separator);
}

export function formatInstructModeStoryString(
  state: CoreState,
  substitute: Substitute,
  storyString: string,
  {
    customContext = null,
    customInstruct = null,
  }: { customContext?: ContextSettings | null; customInstruct?: InstructSettings | null } = {},
): string {
  if (!storyString) return '';
  const instruct = structuredClone(customInstruct ?? state.powerUser.instruct);
  const context = structuredClone(customContext ?? state.powerUser.context);
  const position =
    (context['story_string_position'] as number | undefined) ?? EXTENSION_PROMPT_TYPES.IN_PROMPT;
  const applySequences = position !== EXTENSION_PROMPT_TYPES.IN_CHAT;
  const separator = instruct.wrap ? '\n' : '';
  if (applySequences && instruct.story_string_prefix) {
    const prefix = substitute(instruct.story_string_prefix).replace(/{{name}}/gi, 'System');
    storyString = prefix + separator + storyString;
  }
  if (applySequences && instruct.story_string_suffix)
    storyString = storyString + substitute(instruct.story_string_suffix);
  return storyString;
}

export function formatInstructModePrompt(
  state: CoreState,
  substitute: Substitute,
  name: string,
  isImpersonate: boolean,
  promptBias: string,
  name1: string,
  name2: string,
  isQuiet: boolean,
  isQuietToLoud: boolean,
  customInstruct: InstructSettings | null = null,
): string {
  const instruct = structuredClone(customInstruct ?? state.powerUser.instruct);
  const includeNames =
    !!name &&
    (instruct.names_behavior === NAMES_BEHAVIOR.ALWAYS ||
      (!!state.selectedGroup && instruct.names_behavior === NAMES_BEHAVIOR.FORCE)) &&
    !(isQuiet && !isQuietToLoud);

  const getSequence = () => {
    if (isImpersonate) return instruct.last_input_sequence || instruct.input_sequence;
    if (isQuiet && !isQuietToLoud) return instruct.last_system_sequence || instruct.output_sequence;
    return instruct.last_output_sequence || instruct.output_sequence;
  };

  let sequence = getSequence() || '';
  let nameFiller = '';
  if (
    includeNames &&
    instruct.last_output_sequence &&
    instruct.output_sequence &&
    sequence === instruct.last_output_sequence &&
    /\s$/.test(instruct.output_sequence) &&
    !/\s$/.test(instruct.last_output_sequence)
  ) {
    nameFiller = instruct.output_sequence.slice(-1);
  }
  if (instruct.macro)
    sequence = substitute(sequence, { name1Override: name1, name2Override: name2 }).replace(
      /{{name}}/gi,
      name || 'System',
    );

  const separator = instruct.wrap ? '\n' : '';
  let text = includeNames
    ? separator + sequence + separator + nameFiller + `${name}:`
    : separator + sequence;
  if (isQuiet && separator) text = text.slice(separator.length);
  if (!isImpersonate && promptBias)
    text += includeNames ? promptBias : separator + promptBias.trimStart();
  return (instruct.wrap ? text.trimEnd() : text) + (includeNames ? '' : separator);
}
