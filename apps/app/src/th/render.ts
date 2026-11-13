// The hub's message renderer (DEV_NOTES §9.5 第 3 轮 → 显示接口): the formatter and sanitizer the
// chat page uses, fed from the catalog and the chat mirror instead of the chat store.
import {
  createMarkdownConverter,
  createMessageFormatter,
  decodeStyleTags,
  DEFAULT_FORMAT_POWER_USER,
  REGEX_PLACEMENT,
  RegexEngine,
  type FormatPowerUser,
  type MessageFormatter,
  type RegexScript,
  type RegexScriptSources,
} from '@tm/core';
import { createMessageSanitizer } from '@tm/ui';
import type { Hub, HubOptions } from '@tm/tavern-helper/hub';

type HubRenderer = ReturnType<NonNullable<HubOptions['render']>>;
type RegexSource = Parameters<HubRenderer['regex']>[1];

const PLACEMENT: Record<RegexSource, number> = {
  user_input: REGEX_PLACEMENT.USER_INPUT,
  ai_output: REGEX_PLACEMENT.AI_OUTPUT,
  slash_command: REGEX_PLACEMENT.SLASH_COMMAND,
  world_info: REGEX_PLACEMENT.WORLD_INFO,
  reasoning: REGEX_PLACEMENT.REASONING,
};

const scripts = (value: unknown): RegexScript[] =>
  Array.isArray(value) ? (value as RegexScript[]) : [];

export function createHubRenderer(hub: Hub): HubRenderer {
  // the `format` part is what `formatPowerUserFrom()` made of the settings
  let built: { formatter: MessageFormatter; markdown: (text: string) => string } | null = null;
  let mediaAllowed = false;
  const sanitize = createMessageSanitizer(window, { mediaAllowed: () => mediaAllowed });
  const substitute = (text: string): string => hub.substitute(text);

  const regex = new RegexEngine({
    substitute: (text, options) => hub.substitute(text, options?.postProcessFn),
    sources: (): RegexScriptSources => {
      const part = hub.part('regex');
      return {
        global: scripts(part['global']),
        preset: scripts(part['preset']),
        presetAllowed: !!part['presetEnabled'],
        scoped: scripts(part['character']),
        scopedAllowed: !!part['characterEnabled'],
        extensionDisabled: false,
      };
    },
  });

  const tools = () => {
    if (built) return built;
    const format = hub.part('format');
    const powerUser = { ...DEFAULT_FORMAT_POWER_USER, ...format } as FormatPowerUser;
    mediaAllowed = format['forbid_external_media'] === false;
    const converter = createMarkdownConverter({ powerUser, substitute });
    built = {
      formatter: createMessageFormatter({
        powerUser,
        substitute,
        applyRegex: (text, placement, params) => regex.getRegexedString(text, placement, params),
      }),
      markdown: (text) => converter.makeHtml(text),
    };
    return built;
  };
  hub.onCatalog((part) => {
    if (part === 'format') built = null;
  });

  return {
    regex: (text, source, destination, { depth, characterName }) =>
      regex.getRegexedString(text, PLACEMENT[source], {
        isMarkdown: destination === 'display',
        isPrompt: destination === 'prompt',
        ...(depth === undefined ? {} : { depth }),
        ...(characterName === undefined ? {} : { characterOverride: characterName }),
      }),
    message: (text, { index, name, isUser, isSystem }) => {
      const html = tools().formatter.format(text, {
        chName: name,
        isUser,
        isSystem,
        messageId: index,
        chat: hub.chat,
      });
      return decodeStyleTags(sanitize(html), { mediaAllowed });
    },
    markdown: (text) => sanitize(tools().markdown(text), { MESSAGE_SANITIZE: false }),
  };
}
