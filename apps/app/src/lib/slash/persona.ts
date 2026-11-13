/** `/persona` (ST `persona-set`) and `/sync` (ST `persona-sync`), personas.js. */
import { currentAvatar, equalsIgnoreCaseAndAccents, selectPersona, thumbnailUrl } from '@tm/core';
import { isFalse } from '@tm/st-compat';
import { parseRange, record, text, type AddCommand, type Obj, type SlashEnv } from './shared';

type PersonaEnv = Pick<
  SlashEnv,
  | 'settings'
  | 'saveSettings'
  | 'mutateSettings'
  | 'chatName'
  | 'chatMetadata'
  | 'setChatMetadata'
  | 'messages'
  | 'spliceMessages'
  | 'userName'
  | 'warn'
  | 'ask'
>;

const MODES = ['lookup', 'temp', 'all'];

/**
 * ST `findPersona`: the avatar file of the persona called `name`. The current persona wins when
 * it matches, then a persona whose file is `name`, then the first with that name.
 */
export function findPersona(settings: Obj, name: string, warn: (message: string) => void) {
  const personas = record(record(settings['power_user'])?.['personas']) ?? {};
  const avatars = Object.keys(personas);
  const matches = (avatar: string) =>
    avatar === name || equalsIgnoreCaseAndAccents(String(personas[avatar]), name);
  const current = currentAvatar(settings);
  if (avatars.includes(current) && matches(current)) return current;
  if (avatars.includes(name)) return name;
  const found = avatars.filter(matches);
  if (found.length > 1) warn(`有多个叫「${name}」的用户角色，取第一个`);
  return found[0] ?? null;
}

/** What the persona page does on a tap: switch, save, and keep the chat lock in step */
async function select(env: PersonaEnv, avatar: string): Promise<void> {
  const next = structuredClone(env.settings());
  const metadata = env.chatName() === null ? null : structuredClone(env.chatMetadata());
  const { autoLocked } = selectPersona(next, metadata, avatar);
  await env.saveSettings(next);
  if (autoLocked) await env.setChatMetadata({ persona: avatar });
}

export function personaCommands(add: AddCommand, env: PersonaEnv): void {
  add(['persona', 'persona-set', 'name'], {
    run: async (named, unnamed) => {
      const name = text(unnamed).trim();
      // ST asks for a name here; scripts read the current one this way
      if (!name) return env.userName();
      const mode = named['mode'] === undefined ? 'all' : text(named['mode']);
      if (!MODES.includes(mode)) {
        env.warn('mode 只能是 lookup、temp、all');
        return '';
      }
      if (mode !== 'temp') {
        const avatar = findPersona(env.settings(), name, env.warn);
        if (avatar !== null) {
          await select(env, avatar);
          return '';
        }
        if (mode === 'lookup') {
          env.warn(`没有叫「${name}」的用户角色`);
          return '';
        }
      }
      // no such persona: only the name changes
      env.mutateSettings((settings) => {
        settings['username'] = name;
      });
      return '';
    },
  });

  add(['sync', 'persona-sync'], {
    run: async (named, unnamed) => {
      const messages = env.messages();
      const value = text(unnamed).trim();
      const range = value ? parseRange(value, 0, messages.length - 1) : null;
      if (value && !range) return '';
      const start = range?.start ?? 0;
      const end = range?.end ?? messages.length - 1;
      const from = typeof named['from'] === 'string' ? named['from'].trim() : '';
      const userName = env.userName();
      if (isFalse(named['quiet'])) {
        const scope = `${range ? '所选范围内' : '这个聊天里'}${from ? `署名「${from}」的` : '所有'}`;
        const sure = await env.ask({
          kind: 'confirm',
          title: '确定吗？',
          text: `${scope}用户消息都会改成由 ${userName} 发出。`,
        });
        if (sure !== true) return '';
      }
      const avatar = thumbnailUrl('persona', currentAvatar(env.settings()));
      let changed = false;
      const next = messages.slice(start, end + 1).map((message) => {
        if (!message.is_user) return message;
        if (from && !equalsIgnoreCaseAndAccents(message.name, from)) return message;
        if (message.name === userName && message.force_avatar === avatar) return message;
        changed = true;
        return { ...message, name: userName, force_avatar: avatar };
      });
      if (changed) env.spliceMessages(start, next.length, next);
      return '';
    },
  });
}
