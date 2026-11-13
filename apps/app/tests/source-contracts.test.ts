/**
 * Contracts that live in component sources (DEV_NOTES §9.3, §9.34 第 8 轮). App tests run in node
 * without a DOM, so these read the sources: a renamed or removed ST id / class turns the test red.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.(svelte|ts)$/.test(entry.name)) out.push(readFileSync(path, 'utf8'));
  }
  return out;
}

const text = [
  ...sources(join(root, 'apps/app/src')),
  ...sources(join(root, 'packages/ui/src')),
].join('\n');

/** every quoted string in the sources, split into words: classes and ids set from script count too */
const quoted = new Set<string>();
for (const m of text.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g))
  for (const word of m[2]!.split(/[\s.#>]+/)) quoted.add(word);
const idAttributes = new Set([...text.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]!));
const directives = new Set([...text.matchAll(/\bclass:([\w-]+)/g)].map((m) => m[1]!));
const attributes = new Set([...text.matchAll(/\s([\w-]+)=[{"']/g)].map((m) => m[1]!));

/** set from the nav list's drawer table, not written as an attribute */
const NAV_IDS = `rightNavHolder ai-config-button sys-settings-button WI-SP-button
  persona-management-button extensions-settings-button`;
/** created once from script and kept for the whole session (lib/ext/anchors.ts), not an attribute */
const SCRIPT_IDS = 'send_form';
const IDS = `top-bar top-settings-holder user-settings-button
  right-nav-panel left-nav-panel rm_api_block WorldInfo PersonaManagement rm_extensions_block
  regex_container user-settings-block rm_ch_create_block rm_group_chats_block
  rm_print_characters_block user_avatar_block sheld chat form_sheld nonQRFormItems
  leftSendForm options_button extensionsMenuButton send_textarea rightSendForm mes_impersonate
  mes_continue mes_stop send_but attachFile file_form options option_new_bookmark
  option_back_to_main dialogue_del_mes select_chat_popup`;
const CLASSES = `drawer-toggle drawer-icon drawer drawer-content character_select entity_block
  group_select is_fav avatar ch_name tags avatar-container selected default_persona
  ch_description mes last_mes mesAvatarWrapper mes_block name_text timestamp mes_text
  mes_buttons extraMesButtons mes_button mes_edit_buttons swipe_left swipe_right swipes-counter
  mes_bookmark mes_create_bookmark mes_create_branch mes_media_wrapper mes_media_container
  mes_img_container mes_img mes_img_controls mes_media_delete mes_img_swipes mes_file_wrapper
  welcomePanel popup popup-body popup-content text_pole menu_button checkbox_label
  neo-range-slider inline-drawer-header`;
const BODY_CLASSES = `bubblechat documentstyle big-avatars square-avatars rounded-avatars
  hideChatAvatars no-timestamps no-blur noShadows reduced-motion no-timer no-mesIDDisplay
  no-tokenCount no-modelIcons compact expandMessageActions swipeAllMessages`;
const ATTRIBUTES = 'mesid is_user ch_name chid grid';

const words = (list: string) => list.split(/\s+/).filter(Boolean);

describe('ST DOM contract (DEV_NOTES §9.3)', () => {
  it('keeps every contract id', () => {
    expect(words(IDS).filter((id) => !idAttributes.has(id))).toEqual([]);
    expect(words(NAV_IDS).filter((id) => !quoted.has(id))).toEqual([]);
    expect(words(SCRIPT_IDS).filter((id) => !quoted.has(id))).toEqual([]);
  });
  it('keeps every contract class', () => {
    const missing = words(CLASSES).filter((c) => !quoted.has(c) && !directives.has(c));
    expect(missing).toEqual([]);
  });
  it('keeps the body classes themes rely on', () => {
    expect(words(BODY_CLASSES).filter((c) => !quoted.has(c))).toEqual([]);
  });
  it('keeps the message and list attributes', () => {
    expect(words(ATTRIBUTES).filter((a) => !attributes.has(a))).toEqual([]);
  });
});

describe('generation event order (DEV_NOTES §9.34 第 8 轮)', () => {
  const chat = readFileSync(join(root, 'apps/app/src/routes/Chat.svelte'), 'utf8');
  const body = (name: string): string => {
    const start = chat.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    return chat.slice(start, chat.indexOf('\n  }\n', start));
  };
  const inOrder = (source: string, anchors: string[]) => {
    const at = anchors.map((a) => source.indexOf(a));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  };

  it('announces the generation before the user message is added', () => {
    inOrder(body('send'), [
      "announceStart('normal')",
      'await store.append(message)',
      "await generate('normal'",
    ]);
  });
  it('runs one generation in the ST order', () => {
    inOrder(body('generateOne'), [
      'announceStart(type)',
      'event_types.GENERATION_AFTER_COMMANDS',
      'generationHooks.intercept',
      'onPrompt: announcePrompt',
      'runGeneration(',
      'await finalize(',
      'runToolCalls(',
      "emitAppEvent('generation_ended'",
    ]);
    inOrder(body('announcePrompt'), [
      'event_types.CHAT_COMPLETION_PROMPT_READY',
      'event_types.GENERATE_AFTER_DATA',
    ]);
    inOrder(body('runToolCalls'), [
      'store.append(toolRecordMessage(',
      'event_types.TOOL_CALLS_PERFORMED',
      'event_types.TOOL_CALLS_RENDERED',
    ]);
  });
});
