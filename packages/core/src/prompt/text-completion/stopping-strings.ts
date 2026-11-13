// ST power-user.js getCustomStoppingStrings + script.js getStoppingStrings
import type { CoreState } from '../../state.js';
import { getInstructStoppingSequences, type Substitute } from './instruct.js';

const onlyUnique = <T>(value: T, index: number, array: T[]) => array.indexOf(value) === index;

export function getCustomStoppingStrings(
  state: CoreState,
  substitute: Substitute,
  { ephemeral = [] as string[], limit = 0 } = {},
): string[] {
  const getPermanent = (): string[] => {
    try {
      const raw = state.powerUser['custom_stopping_strings'];
      if (!raw || typeof raw !== 'string') return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      let strings = parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
      if (state.powerUser['custom_stopping_strings_macro'] ?? true)
        strings = strings.map((x) => substitute(x));
      return strings;
    } catch {
      return [];
    }
  };
  const strings = [...getPermanent(), ...ephemeral];
  return limit > 0 ? strings.slice(0, limit) : strings;
}

export function getStoppingStrings(
  state: CoreState,
  substitute: Substitute,
  isImpersonate: boolean,
  isContinue: boolean,
  { api = state.mainApi, ephemeral = [] as string[] }: { api?: string; ephemeral?: string[] } = {},
): string[] {
  if (api === 'openai') return getCustomStoppingStrings(state, substitute, { ephemeral });
  const name1 = state.userName;
  const name2 = state.charName;
  const result: string[] = [];
  if (state.powerUser.context['names_as_stop_strings'] ?? true) {
    const charString = `\n${name2}:`;
    const userString = `\n${name1}:`;
    result.push(isImpersonate ? charString : userString);
    result.push(userString);
    if (isContinue && state.chat.length && state.chat[state.chat.length - 1]?.is_user)
      result.push(charString);
    if (state.selectedGroup && (name2 || isImpersonate)) {
      const group = state.groups.find((x) => x.id === state.selectedGroup);
      if (group && Array.isArray(group.members)) {
        result.push(
          ...group.members
            .map((x) => state.characters.find((y) => y.avatar == x))
            .filter((x): x is NonNullable<typeof x> => !!x && !!x.name && x.name !== name2)
            .map((x) => `\n${x.name}:`),
        );
      }
    }
  }
  result.push(...getInstructStoppingSequences(state, substitute));
  result.push(...getCustomStoppingStrings(state, substitute, { ephemeral }));
  if (state.powerUser['single_line']) result.unshift('\n');
  return result.filter((x) => x).filter(onlyUnique);
}
