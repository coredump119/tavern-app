/**
 * The wider `SillyTavern` context (DEV_NOTES §9.5 第 3 轮 → SillyTavern 对象): the members scripts
 * reach for most, answered from the catalog. Everything here is a read of a snapshot or a call
 * from the app's whitelist; nothing hands out ST's live objects, which do not exist in the realm.
 */
import type { ApiContext, Hub } from '../hub.js';
import { tavern_events, type Listener } from '../events.js';
import { printable, uuid } from '../util.js';
import { characterRows, currentAvatar, record, requireAvatar, text } from './shared.js';

export function contextModule(hub: Hub): (context: ApiContext) => object {
  /** ST's `characters`: every card as its list row, the open one in full */
  const characters = (): Record<string, unknown>[] => {
    const open = currentAvatar(hub);
    return characterRows(hub).map((row) =>
      row.avatar === open ? { ...row, ...record(hub.catalog.character) } : { ...row },
    );
  };
  const characterIndex = (): number => {
    const open = currentAvatar(hub);
    return open ? characterRows(hub).findIndex((row) => row.avatar === open) : -1;
  };
  const runSlash = (command: unknown): Promise<{ pipe: string }> =>
    hub
      .request({ method: 'slash.run', params: { command: String(command) } })
      .then((result) => ({ pipe: printable(result) }));

  return ({ owner, give }) => {
    const { bus } = hub;
    /** ST's emitter under its own method names, on the bus `eventOn` uses */
    const eventSource = {
      on: (type: string, listener: Listener) => void bus.on(owner, type, listener),
      once: (type: string, listener: Listener) =>
        void bus.on(owner, type, listener, { once: true }),
      makeFirst: (type: string, listener: Listener) =>
        void bus.on(owner, type, listener, { position: 'first' }),
      makeLast: (type: string, listener: Listener) =>
        void bus.on(owner, type, listener, { position: 'last' }),
      removeListener: (type: string, listener: Listener) => bus.off(owner, type, listener),
      emit: (type: string, ...args: unknown[]): Promise<void> => bus.emit(type, args),
    };

    return {
      get characters() {
        return give(characters());
      },
      get characterId() {
        const index = characterIndex();
        return index < 0 ? undefined : String(index);
      },
      get groupId() {
        return text(record(hub.part('session')['group'])['id']) || null;
      },
      get mainApi() {
        return text(hub.part('session')['mainApi']);
      },
      get chatCompletionSettings() {
        return give(record(hub.part('presets')['current']));
      },
      get powerUserSettings() {
        return give(hub.part('format'));
      },
      get extensionSettings() {
        return give(hub.part('extensions'));
      },
      eventSource,
      eventTypes: tavern_events,
      event_types: tavern_events,
      substituteParamsExtended: (content: string) => hub.substitute(String(content)),
      uuidv4: uuid,
      getRequestHeaders: () => ({}),
      saveChat: (): Promise<void> => hub.call('chat.save'),
      saveMetadata: (): Promise<void> => hub.call('chat.save'),
      saveSettingsDebounced: (): void => void hub.call('settings.save').catch(() => undefined),
      reloadCurrentChat: (): Promise<void> => hub.call('chat.reload'),
      stopGeneration: (): boolean => {
        void hub.call('page.click', ['stop']).catch(() => undefined);
        return true;
      },
      executeSlashCommands: runSlash,
      executeSlashCommandsWithOptions: runSlash,
      messageFormatting: (
        mes: unknown,
        name: unknown,
        isSystem: unknown,
        isUser: unknown,
        messageId: unknown,
      ): string => {
        const index = typeof messageId === 'number' ? messageId : hub.chat.length - 1;
        const as = { index, name: text(name), isUser: !!isUser, isSystem: !!isSystem };
        return hub.renderer?.message(String(mes), as) ?? String(mes);
      },
      /** `characterId` is ST's index into `characters` */
      writeExtensionField: (characterId: unknown, key: unknown, value: unknown): Promise<void> => {
        const row = characterRows(hub)[Number(characterId)];
        const avatar = row?.avatar ?? requireAvatar(hub, characterId);
        return hub.call('character.extension', [avatar, String(key), value]);
      },
      getTokenCountAsync: (content: unknown): Promise<number> =>
        hub.call<number>('tokens.count', [String(content)]),
    };
  };
}
