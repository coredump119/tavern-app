/**
 * Persona interfaces (DEV_NOTES §9.5 第 3 轮 → 数据接口 → Persona). Everything is read from the
 * `personas` catalog part, which carries ST's own shape: `names` is `power_user.personas`
 * (avatar file → name) and `descriptions` is `power_user.persona_descriptions`.
 */
import type { ApiModule, Hub } from '../hub.js';
import { isThenable, own } from '../util.js';
import { patchPart, record, records, text, type Dict } from './shared.js';

interface PersonaConnection {
  type: 'character' | 'group';
  id: string;
}
interface Persona {
  avatar_id: string;
  avatar: string;
  name: string;
  title: string;
  description: string;
  /** ST's numbers: where the description goes, and the role it takes at a depth */
  position: number;
  depth: number;
  role: number;
  lorebook: string;
  connections: PersonaConnection[];
  is_default: boolean;
}
type Updater = (persona: Persona) => Persona | PromiseLike<Persona>;

/** ST's defaults for a persona that has no description entry yet */
const DEFAULT_DEPTH = 2;

const USER_AVATARS = 'User Avatars';

export function personaModule(hub: Hub): ApiModule {
  const part = (): Dict => hub.part('personas');
  const names = (): Record<string, string> => record(part()['names']) as Record<string, string>;
  const current = (): string | null => text(part()['avatar']) || null;

  /** `'current'`, an avatar file name, or a persona name; null when there is none */
  const find = (id: unknown = 'current'): string | null => {
    if (id === 'current' || id === undefined || id === null) return current();
    const wanted = String(id);
    const all = names();
    if (Object.hasOwn(all, wanted)) return wanted;
    return Object.keys(all).find((avatar) => all[avatar] === wanted) ?? null;
  };
  const need = (id: unknown): string => {
    const avatar = find(id);
    if (avatar) return avatar;
    throw new Error(
      id === 'current' || id === undefined
        ? '当前没有选中 persona'
        : `persona '${String(id)}' 不存在`,
    );
  };

  const read = (avatar: string): Persona => {
    const stored = record(record(part()['descriptions'])[avatar]);
    return {
      avatar_id: avatar,
      avatar,
      name: text(names()[avatar]),
      title: text(stored['title']),
      description: text(stored['description']),
      position: Number(stored['position'] ?? 0),
      depth: Number(stored['depth'] ?? DEFAULT_DEPTH),
      role: Number(stored['role'] ?? 0),
      lorebook: text(stored['lorebook']),
      connections: records(stored['connections']) as unknown as PersonaConnection[],
      is_default: part()['default'] === avatar,
    };
  };

  /** Store a persona; `avatar` '' makes a new one. The app answers with the avatar file name. */
  const write = async (avatar: string, persona: Persona): Promise<string> => {
    if (typeof persona.avatar !== 'string') throw new Error('persona 头像暂不支持传入 Blob');
    const { avatar_id: _id, avatar: _avatar, name, is_default, ...description } = persona;
    const saved = await hub.call<string>('persona.write', [
      avatar,
      { name, is_default, description },
    ]);
    const before = part();
    const isCurrent = saved === current();
    patchPart(hub, 'personas', {
      names: { ...names(), [saved]: name },
      descriptions: { ...record(before['descriptions']), [saved]: description },
      default: is_default ? saved : before['default'] === saved ? null : before['default'],
      ...(isCurrent ? { name, description: description.description } : {}),
    });
    return saved;
  };

  const merged = (base: Persona, patch: unknown): Persona => ({
    ...base,
    ...(own(patch ?? {}) as Partial<Persona>),
    avatar_id: base.avatar_id,
  });
  const blank = (name: string): Persona => ({ ...read(''), name, is_default: false });

  const replace = async (id: unknown, persona: unknown): Promise<void> => {
    const avatar = need(id);
    await write(avatar, merged(read(avatar), persona));
  };

  return ({ give }) => ({
    getPersonaNames: (): string[] => give(Object.values(names())),
    getPersonaIds: (): string[] => give(Object.keys(names())),
    getCurrentPersonaName: (): string | null => {
      const avatar = current();
      return avatar ? (names()[avatar] ?? text(part()['name'])) : null;
    },
    getCurrentPersonaId: current,
    getPersonaAvatarPath: (id?: string): string | null => {
      const avatar = find(id);
      return avatar ? `${USER_AVATARS}/${avatar}` : null;
    },
    getPersona: (id?: string): Persona => give(read(need(id))),
    createPersona: async (name: string, persona?: unknown): Promise<boolean> => {
      if (find(name)) return false;
      await write('', merged(blank(String(name)), persona));
      return true;
    },
    createOrReplacePersona: async (name: string, persona?: unknown): Promise<boolean> => {
      const avatar = find(name);
      const base = avatar ? read(avatar) : blank(String(name));
      await write(avatar ?? '', merged(base, persona));
      return !avatar;
    },
    deletePersona: async (id?: string): Promise<boolean> => {
      const avatar = find(id);
      if (!avatar) return false;
      await hub.call('persona.delete', [avatar]);
      const { [avatar]: _name, ...restNames } = names();
      const { [avatar]: _description, ...restDescriptions } = record(part()['descriptions']);
      patchPart(hub, 'personas', { names: restNames, descriptions: restDescriptions });
      return true;
    },
    replacePersona: replace,
    updatePersonaWith: async (id: string, updater: Updater): Promise<Persona> => {
      const avatar = need(id);
      const result = updater(give(read(avatar)));
      await write(avatar, merged(read(avatar), isThenable(result) ? await result : result));
      return give(read(avatar));
    },
  });
}
