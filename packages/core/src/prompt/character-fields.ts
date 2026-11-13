// ST script.js getCharacterCardFieldsLazy / baseChatReplace / createLazyFields 与 group-chats.js getGroupCharacterCardsLazy 的移植。
import { GROUP_GENERATION_MODE, type CharacterLike, type CoreState } from '../state.js';

export interface CharacterCardFields {
  system: string;
  mesExamples: string;
  description: string;
  personality: string;
  persona: string;
  scenario: string;
  jailbreak: string;
  version: string;
  charDepthPrompt: string;
  creatorNotes: string;
  firstMessage: string;
  alternateGreetings: string[];
}

/** substituteParams(value, { name1Override, name2Override, replaceCharacterCard: false }) */
export type BaseSubstitute = (
  value: string,
  name1Override: string | null,
  name2Override: string | null,
) => string;

export function collapseNewlines(x: string): string {
  return x.replaceAll(/\n+/g, '\n');
}

export function baseChatReplace(
  state: CoreState,
  substitute: BaseSubstitute,
  value: string | undefined,
  name1Override: string | null = null,
  name2Override: string | null = null,
): string {
  if (typeof value === 'string' && value.length > 0) {
    value = substitute(value, name1Override, name2Override);
    if (state.powerUser.collapse_newlines) value = collapseNewlines(value);
    value = value.replace(/\r/g, '');
  }
  return value ?? '';
}

export function createLazyFields<T extends object>(resolvers: { [K in keyof T]: () => T[K] }): T {
  const result = {} as T;
  for (const key of Object.keys(resolvers) as (keyof T)[]) {
    let cached: unknown;
    let resolved = false;
    Object.defineProperty(result, key, {
      get() {
        if (!resolved) {
          cached = resolvers[key]();
          resolved = true;
        }
        return cached;
      },
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

type GroupCardFields = Pick<
  CharacterCardFields,
  'description' | 'personality' | 'scenario' | 'mesExamples'
>;

export function getGroupCharacterCardsLazy(
  state: CoreState,
  substitute: BaseSubstitute,
  groupId: string,
  characterId: number | undefined,
): GroupCardFields | null {
  const group = state.groups.find((x) => x.id === groupId);
  if (!group || !group.generation_mode || !Array.isArray(group.members) || !group.members.length)
    return null;
  const disabled = group.disabled_members ?? [];

  const customTransform = (
    value: string | undefined,
    fieldName: string,
    characterName: string,
    trim: boolean,
  ) => {
    if (!value) return '';
    value = value.replace(/<FIELDNAME>/gi, fieldName);
    value = trim ? value.trim() : value;
    return baseChatReplace(state, substitute, value, null, characterName);
  };
  const replaceAndPrepareForJoin = (
    value: string | undefined,
    characterName: string,
    fieldName: string,
    preprocess: ((v: string) => string) | null = null,
  ) => {
    value = value?.trim() ?? '';
    if (!value) return '';
    if (typeof preprocess === 'function') value = preprocess(value);
    const prefix = customTransform(
      group.generation_mode_join_prefix,
      fieldName,
      characterName,
      false,
    );
    const suffix = customTransform(
      group.generation_mode_join_suffix,
      fieldName,
      characterName,
      false,
    );
    value = customTransform(value, fieldName, characterName, true);
    return `${prefix}${value}${suffix}`;
  };
  const collectField = (
    fieldName: string,
    getter: (c: CharacterLike) => string | undefined,
    preprocess: ((v: string) => string) | null = null,
  ) => {
    const values: string[] = [];
    for (const member of group.members) {
      const index = state.characters.findIndex((x) => x.avatar === member);
      const character = state.characters[index];
      if (index === -1 || !character) continue;
      if (
        disabled.includes(member) &&
        characterId !== index &&
        group.generation_mode !== GROUP_GENERATION_MODE.APPEND_DISABLED
      )
        continue;
      values.push(
        replaceAndPrepareForJoin(getter(character), character.name, fieldName, preprocess),
      );
    }
    return values.filter((x) => x.length).join('\n');
  };

  const scenarioOverride = String(state.chatMetadata['scenario'] || '');
  const mesExamplesOverride = String(state.chatMetadata['mes_example'] || '');

  return createLazyFields<GroupCardFields>({
    description: () => collectField('Description', (c) => c.description),
    personality: () => collectField('Personality', (c) => c.personality),
    scenario: () =>
      baseChatReplace(state, substitute, scenarioOverride.trim()) ||
      collectField('Scenario', (c) => c.scenario),
    mesExamples: () =>
      baseChatReplace(state, substitute, mesExamplesOverride.trim()) ||
      collectField(
        'Example Messages',
        (c) => c.mes_example,
        (x) => (!x.startsWith('<START>') ? `<START>\n${x}` : x),
      ),
  });
}

export function getCharacterCardFieldsLazy(
  state: CoreState,
  substitute: BaseSubstitute,
  chid?: number,
): CharacterCardFields {
  const currentChid = chid ?? state.characterId;
  const character = currentChid !== undefined ? state.characters[currentChid] : undefined;
  const groupCardsLazy =
    state.selectedGroup && character
      ? getGroupCharacterCardsLazy(state, substitute, state.selectedGroup, currentChid)
      : null;
  const meta = state.chatMetadata;
  const rep = (v: string | undefined) => baseChatReplace(state, substitute, v);

  return createLazyFields<CharacterCardFields>({
    persona: () => rep(state.powerUser.persona_description?.trim()),
    system: () => {
      if (!character) return '';
      const systemPrompt = String(meta['system_prompt'] || character.data?.system_prompt || '');
      return state.powerUser.prefer_character_prompt ? rep(systemPrompt.trim()) : '';
    },
    jailbreak: () => {
      if (!character) return '';
      return state.powerUser.prefer_character_jailbreak
        ? rep(character.data?.post_history_instructions?.trim())
        : '';
    },
    version: () => character?.data?.character_version ?? '',
    charDepthPrompt: () =>
      character ? rep(character.data?.extensions?.depth_prompt?.prompt?.trim()) : '',
    creatorNotes: () => (character ? rep(character.data?.creator_notes?.trim()) : ''),
    description: () =>
      groupCardsLazy
        ? groupCardsLazy.description
        : character
          ? rep(character.description?.trim())
          : '',
    personality: () =>
      groupCardsLazy
        ? groupCardsLazy.personality
        : character
          ? rep(character.personality?.trim())
          : '',
    scenario: () => {
      if (groupCardsLazy) return groupCardsLazy.scenario;
      if (!character) return '';
      return rep(String(meta['scenario'] || character.scenario || '').trim());
    },
    mesExamples: () => {
      if (groupCardsLazy) return groupCardsLazy.mesExamples;
      if (!character) return '';
      return rep(String(meta['mes_example'] || character.mes_example || '').trim());
    },
    firstMessage: () => (character ? rep(character.first_mes?.trim() || '') : ''),
    alternateGreetings: () => {
      if (!character) return [];
      const alt = character.data?.alternate_greetings;
      return Array.isArray(alt) ? alt.map((g) => rep(g?.trim())) : [];
    },
  });
}

/** 一次性解析全部字段（getCharacterCardFields） */
export function getCharacterCardFields(
  state: CoreState,
  substitute: BaseSubstitute,
  chid?: number,
): CharacterCardFields {
  const lazy = getCharacterCardFieldsLazy(state, substitute, chid);
  return {
    system: lazy.system,
    mesExamples: lazy.mesExamples,
    description: lazy.description,
    personality: lazy.personality,
    persona: lazy.persona,
    scenario: lazy.scenario,
    jailbreak: lazy.jailbreak,
    version: lazy.version,
    charDepthPrompt: lazy.charDepthPrompt,
    creatorNotes: lazy.creatorNotes,
    firstMessage: lazy.firstMessage,
    alternateGreetings: lazy.alternateGreetings,
  };
}
