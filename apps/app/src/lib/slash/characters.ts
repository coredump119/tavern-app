/** `/char-find` and the character lookup other commands share (ST utils.js `findChar`). */
import { equalsIgnoreCaseAndAccents } from '@tm/core';
import { isFalse, isTrue, SlashClosure, SlashError } from '@tm/st-compat';
import {
  record,
  tagList,
  text,
  type AddCommand,
  type Obj,
  type SlashCharacter,
  type SlashEnv,
} from './shared';

type CharacterEnv = Pick<SlashEnv, 'characters' | 'currentAvatars' | 'settings' | 'warn'>;

export interface FindCharacterOptions {
  /** a name, or an avatar file with or without `.png`; empty matches every character */
  name?: string;
  /** only characters carrying every one of these tag names */
  tags?: readonly string[] | null;
  /** the open character (or a group member) wins when it matches */
  preferCurrent?: boolean;
  quiet?: boolean;
}

/** Tag names per avatar, read without touching the settings object */
function tagNamesOf(settings: Obj): (avatar: string) => string[] {
  const tags = tagList(settings);
  const map = record(settings['tag_map']) ?? {};
  return (avatar) => {
    const ids = Array.isArray(map[avatar]) ? (map[avatar] as unknown[]) : [];
    return tags.filter((tag) => ids.includes(tag['id'])).map((tag) => String(tag['name']));
  };
}

export function findCharacter(
  env: CharacterEnv,
  { name = '', tags = null, preferCurrent = true, quiet = false }: FindCharacterOptions = {},
): SlashCharacter | null {
  const matches = (character: SlashCharacter) =>
    !name || character.avatar === name || equalsIgnoreCaseAndAccents(character.name, name);
  const several = (found: readonly SlashCharacter[]) => {
    if (found.length > 1 && !quiet) env.warn('有多个角色符合条件，取第一个');
  };

  let pool = env.characters();
  if (tags) {
    const tagNames = tagNamesOf(env.settings());
    pool = pool.filter((character) => {
      const own = tagNames(character.avatar);
      return tags.every((tag) => own.includes(tag));
    });
  }

  if (preferCurrent) {
    const current = env.currentAvatars();
    const preferred = pool.filter((c) => current.includes(c.avatar) && matches(c));
    several(preferred);
    if (preferred[0]) return preferred[0];
  }
  if (name) {
    const file = name.endsWith('.png') ? name : `${name}.png`;
    const byAvatar = pool.find((c) => c.avatar === name || c.avatar === file);
    if (byAvatar) return byAvatar;
  }
  const found = name ? pool.filter(matches) : pool;
  several(found);
  return found[0] ?? null;
}

export function characterCommands(add: AddCommand, env: CharacterEnv): void {
  add(['char-find', 'findchar'], {
    repeatable: ['tag'],
    run: (named, unnamed) => {
      const tags = named['tag'] as unknown[] | undefined;
      if (tags?.some((tag) => tag instanceof SlashClosure)) {
        throw new SlashError('/char-find 的 tag= 不能是闭包');
      }
      const found = findCharacter(env, {
        name: text(unnamed).trim(),
        tags: tags ? tags.map(text) : null,
        preferCurrent: !isFalse(named['preferCurrent']),
        quiet: isTrue(named['quiet']),
      });
      return found?.avatar ?? '';
    },
  });
}
