/**
 * App state in the shapes ST's `getContext()` hands to extensions (st-context.js; DEV_NOTES
 * §9.34). Derived, so reading it again costs nothing until the state behind it changes.
 */
import { redactedCopy } from '@tm/st-compat';
import { mainApiOf, tokenBudgetOf } from '../chat/core-state';
import { plainChat } from '../chat/plain.svelte';
import { chatStore, type Character } from '../chat/store.svelte';
import { oaiRuntime } from '../oai.svelte';

type Obj = Record<string, unknown>;

/**
 * Connection addresses and credentials-in-settings (DEV_NOTES §9.4): blanked in every settings
 * copy an extension can read. API keys themselves never reach the page at all.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'reverse_proxy',
  'proxy_password',
  'custom_url',
  'custom_include_body',
  'custom_exclude_body',
  'custom_include_headers',
  'azure_base_url',
  'vertexai_express_project_id',
  'server_urls',
  'api_key',
  'api_key_custom',
]);

const section = (name: string): Obj => (plainChat.settings?.[name] as Obj | undefined) ?? {};

class ExtState {
  /**
   * ST `characters`: index rows (`shallow`, as ST's lazy loading leaves them) with the cards that
   * are open filled in. Read-only for extensions; cards are edited through the app.
   */
  readonly characters = $derived.by<Obj[]>(() => {
    const full = new Map<string, Character>();
    for (const member of plainChat.members as unknown as Character[])
      full.set(member.avatar, member);
    const open = plainChat.character;
    if (open) full.set(open.avatar, open);
    const chat = chatStore.group ? undefined : (chatStore.chatName ?? undefined);
    return chatStore.characters.map((row) => {
      const card = full.get(row.avatar);
      if (!card) return { ...row, date_added: row.mtime, shallow: true };
      return card === open ? { ...card, chat } : { ...card };
    });
  });

  readonly groups = $derived($state.snapshot(chatStore.groups) as unknown as Obj[]);

  /** ST `this_chid`: the index into `characters` as a string; undefined with no character open */
  readonly characterId = $derived.by<string | undefined>(() => {
    const avatar = chatStore.group ? undefined : chatStore.character?.avatar;
    if (!avatar) return undefined;
    const index = chatStore.characters.findIndex((row) => row.avatar === avatar);
    return index < 0 ? undefined : String(index);
  });

  /** ST `selected_group` */
  readonly groupId = $derived<string | null>(chatStore.group?.id ?? null);

  /** ST `getCurrentChatId()` */
  readonly chatId = $derived<string | undefined>(chatStore.chatName ?? undefined);

  readonly onlineStatus = $derived(oaiRuntime.models.length > 0 ? 'Valid' : 'no_connection');
  readonly mainApi = $derived(mainApiOf(plainChat.settings));
  readonly maxContext = $derived(
    plainChat.settings ? tokenBudgetOf(plainChat.settings).maxContext : 0,
  );

  readonly tags = $derived((plainChat.settings?.['tags'] as unknown[] | undefined) ?? []);
  readonly tagMap = $derived(section('tag_map'));

  readonly chatCompletionSettings = $derived(redactedCopy(section('oai_settings'), SECRET_KEYS));
  readonly textCompletionSettings = $derived(
    redactedCopy(section('textgenerationwebui_settings'), SECRET_KEYS),
  );
  readonly powerUserSettings = $derived(redactedCopy(section('power_user'), SECRET_KEYS));

  /** `disabledExtensions` as one string, so that unrelated settings edits do not look like a change */
  private readonly disabledKey = $derived.by(() => {
    const list = section('extension_settings')['disabledExtensions'];
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string').join('\n') : '';
  });
  /** ST `extension_settings.disabledExtensions` */
  readonly disabled = $derived(this.disabledKey ? this.disabledKey.split('\n') : []);
}

export const extState = new ExtState();
