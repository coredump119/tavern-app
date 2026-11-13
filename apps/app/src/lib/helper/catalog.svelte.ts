/**
 * What the realm may read synchronously besides the chat and its variables (DEV_NOTES §9.5
 * 第 3 轮): the "catalog". Each part is a plain, curated copy; connection addresses, proxy
 * passwords and keys are never part of it. A part is sent again only when its JSON changed.
 */
import { PRESET_ST_KEYS, type HostController } from '@tm/tavern-helper';
import { themeToBodyClasses } from '@tm/ui';
import { mainApiOf } from '../chat/core-state';
import { createChatContext } from '../chat/pipeline';
import { plainChat } from '../chat/plain.svelte';
import { formatPowerUserFrom } from '../chat/render';
import { chatStore } from '../chat/store.svelte';
import { themeStore } from '../theme.svelte';
import { listCcPresets } from '../oai.svelte';
import { listWorldNames } from '../worlds';
import { proxyPresetNames } from './generate.svelte';
import { helperPage } from './page.svelte';

type Obj = Record<string, unknown>;

/** `extension_settings` key listing the extension ids scripts created through the variable API */
export const SCRIPT_EXTENSIONS_KEY = 'tm_script_extensions';

/**
 * Argument-less macros whose value does not depend on the chat's messages or on the clock: the
 * app evaluates them ahead of time so the hub can substitute them synchronously.
 */
const STATIC_MACROS = [
  'persona',
  'description',
  'charDescription',
  'personality',
  'charPersonality',
  'scenario',
  'charScenario',
  'mesExamples',
  'mesExamplesRaw',
  'charPrompt',
  'charInstruction',
  'charVersion',
  'charDepthPrompt',
  'creatorNotes',
  'charCreatorNotes',
  'charFirstMessage',
  'greeting',
  'group',
  'groupNotMuted',
  'charIfNotGroup',
  'notChar',
  'model',
  'maxPrompt',
  'maxPromptTokens',
  'maxContext',
  'maxContextTokens',
  'maxResponse',
  'maxResponseTokens',
  'systemPrompt',
  'isMobile',
] as const;

/**
 * ST theme variables scripts read off the page (`--SmartTheme*` and friends, st-aliases.css).
 * The stand-in gets their computed values: its own document has none of the app's tokens.
 */
const PAGE_VARIABLES = [
  '--SmartThemeBodyColor',
  '--SmartThemeEmColor',
  '--SmartThemeUnderlineColor',
  '--SmartThemeQuoteColor',
  '--SmartThemeBlurTintColor',
  '--SmartThemeChatTintColor',
  '--SmartThemeUserMesBlurTintColor',
  '--SmartThemeBotMesBlurTintColor',
  '--SmartThemeShadowColor',
  '--SmartThemeBorderColor',
  '--SmartThemeBlurStrength',
  '--mainFontSize',
  '--mainFontFamily',
  '--monoFontFamily',
  '--fontScale',
  '--blurStrength',
  '--shadowWidth',
] as const;

const record = (value: unknown): Obj | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : undefined;

/** A plain copy of a part of `$state`; reading it tracks that part only */
const plain = <T>(value: T): T => $state.snapshot(value) as T;

/** File lists: read from disk when a chat opens, the chat page appears, or a script changed them */
class CatalogNames {
  worlds = $state.raw<string[]>([]);
  presets = $state.raw<string[]>([]);
  private loading: Promise<void> | null = null;

  refresh(): Promise<void> {
    const root = chatStore.root;
    if (!root) return Promise.resolve();
    this.loading ??= Promise.all([listWorldNames(root), listCcPresets(root)])
      .then(([worlds, presets]) => {
        this.worlds = worlds;
        this.presets = presets;
      })
      .catch((e: unknown) => console.warn('[TavernHelper] 读取世界书 / 预设列表失败', e))
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }
}

export const catalogNames = new CatalogNames();

/** The extension ids scripts own: the only `extension_settings` entries the realm sees */
export function scriptExtensionIds(extensions: Obj | undefined): string[] {
  const list = extensions?.[SCRIPT_EXTENSIONS_KEY];
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
}

/** Declare the effects that keep the catalog current. Call inside an effect root. */
export function syncCatalog(controller: HostController): void {
  const settings = () => chatStore.settings;
  const oai = () => record(settings()?.['oai_settings']);
  const extensions = () => record(settings()?.['extension_settings']);

  $effect(() => {
    // a chat opening is also when lists made elsewhere in the app are picked up
    void chatStore.chatRel;
    void catalogNames.refresh();
  });

  $effect(() => {
    const character = chatStore.character;
    const group = chatStore.group;
    controller.syncCatalog('session', {
      character: character ? { avatar: character.avatar, name: character.name } : null,
      group: group ? { id: group.id, name: group.name } : null,
      mainApi: mainApiOf(settings()),
      presetName: String(oai()?.['preset_settings_openai'] ?? ''),
      userAvatar: String(settings()?.['user_avatar'] ?? ''),
      chatFile: chatStore.chatFile,
      // names only: addresses and passwords stay on this side
      proxyPresets: proxyPresetNames(),
    });
  });

  $effect(() => {
    controller.syncCatalog('character', chatStore.character ? plain(chatStore.character) : null);
  });

  $effect(() => {
    controller.syncCatalog(
      'characters',
      chatStore.characters.map(({ avatar, name }) => ({ avatar, name })),
    );
  });

  $effect(() => {
    controller.syncCatalog('worlds', {
      names: catalogNames.worlds,
      settings: plain(settings()?.['world_info_settings']) ?? {},
      chat: chatStore.chatMetadata['world_info'] ?? null,
      persona: record(settings()?.['power_user'])?.['persona_description_lorebook'] ?? null,
    });
  });

  $effect(() => {
    const bucket = oai();
    const current: Obj = {};
    if (bucket) {
      for (const key of PRESET_ST_KEYS) {
        if (key in bucket) current[key] = plain(bucket[key]);
      }
    }
    controller.syncCatalog('presets', {
      names: catalogNames.presets,
      inUse: String(bucket?.['preset_settings_openai'] ?? ''),
      current,
    });
  });

  $effect(() => {
    const ext = extensions();
    const character = chatStore.character;
    const cardExtensions = record(record(character?.data)?.['extensions']);
    const presetName = String(oai()?.['preset_settings_openai'] ?? '');
    const allowedCharacters = ext?.['character_allowed_regex'];
    const allowedPresets = record(ext?.['preset_allowed_regex'])?.['openai'];
    controller.syncCatalog('regex', {
      global: plain(ext?.['regex']) ?? [],
      character: plain(cardExtensions?.['regex_scripts']) ?? [],
      preset: plain(record(oai()?.['extensions'])?.['regex_scripts']) ?? [],
      characterEnabled:
        !!character &&
        Array.isArray(allowedCharacters) &&
        allowedCharacters.includes(character.avatar),
      presetEnabled: Array.isArray(allowedPresets) && allowedPresets.includes(presetName),
    });
  });

  $effect(() => {
    const power = record(settings()?.['power_user']);
    controller.syncCatalog('personas', {
      avatar: String(settings()?.['user_avatar'] ?? ''),
      name: chatStore.userName,
      names: plain(power?.['personas']) ?? {},
      descriptions: plain(power?.['persona_descriptions']) ?? {},
      description: String(power?.['persona_description'] ?? ''),
      default: power?.['default_persona'] ?? null,
    });
  });

  $effect(() => {
    const ext = extensions();
    const owned: Obj = {};
    for (const id of scriptExtensionIds(ext)) owned[id] = plain(ext?.[id]) ?? {};
    controller.syncCatalog('extensions', owned);
  });

  $effect(() => {
    controller.syncCatalog('format', formatPowerUserFrom(settings()));
  });

  $effect(() => {
    const { settings: plainSettings, character, group, members } = plainChat;
    const userName = chatStore.userName;
    if (!plainSettings || !(character || group)) {
      controller.syncCatalog('macro', {});
      return;
    }
    // no messages: none of these macros reads them, and the chat changes far more often
    const context = createChatContext(
      plainSettings,
      { character, group, members, memberIndex: null },
      userName,
      [],
      {},
    );
    const values: Obj = {};
    for (const name of STATIC_MACROS) {
      const written = `{{${name}}}`;
      const value = context.substitute(written);
      if (value !== written) values[name.toLowerCase()] = value;
    }
    controller.syncCatalog('macro', values);
  });

  // the theme's variables are computed from tokens: read them once it is applied
  let look = $state.raw<{ bodyClasses: string[]; vars: Record<string, string> }>({
    bodyClasses: [],
    vars: {},
  });
  $effect(() => {
    const bodyClasses = themeToBodyClasses(themeStore.current);
    // after the theme store's own effect wrote the variables
    queueMicrotask(() => {
      const computed = getComputedStyle(document.documentElement);
      const vars: Record<string, string> = {};
      for (const name of PAGE_VARIABLES) vars[name] = computed.getPropertyValue(name).trim();
      look = { bodyClasses, vars };
    });
  });
  $effect(() => {
    controller.syncCatalog('page', {
      draft: helperPage.draft,
      generating: helperPage.generating,
      ...look,
    });
  });
}
