// ST authors-note.js：setFloatingPrompt 与 chat_metadata 中的 note_* 默认值。
import {
  EXTENSION_PROMPT_ROLES,
  EXTENSION_PROMPT_TYPES,
  MAX_INJECTION_DEPTH,
  setExtensionPrompt,
  type ExtensionPrompts,
} from './extension-prompts.js';
import type { ChatMessageLike } from '../state.js';

export const NOTE_MODULE_NAME = '2_floating_prompt';
export const NOTE_METADATA_KEYS = {
  prompt: 'note_prompt',
  interval: 'note_interval',
  depth: 'note_depth',
  position: 'note_position',
  role: 'note_role',
} as const;
export const CHARA_NOTE_POSITION = { replace: 0, before: 1, after: 2 } as const;

/** extension_settings.note */
export interface NoteSettings {
  default?: string;
  chara?: Array<{ name: string; prompt: string; useChara?: boolean; position?: number }>;
  wiAddition?: unknown[];
  allowWIScan?: boolean;
  defaultPosition?: number;
  defaultDepth?: number;
  defaultInterval?: number;
  defaultRole?: number;
  [key: string]: unknown;
}

const DEFAULTS = { depth: 4, position: 1, interval: 1, role: EXTENSION_PROMPT_ROLES.SYSTEM };

/** authors-note.js loadSettings：补齐 note 设置与 chat_metadata 的默认值 */
export function ensureNoteDefaults(
  chatMetadata: Record<string, unknown>,
  note: NoteSettings,
): void {
  if (note.defaultPosition === undefined) note.defaultPosition = DEFAULTS.position;
  if (note.defaultDepth === undefined) note.defaultDepth = DEFAULTS.depth;
  if (note.defaultInterval === undefined) note.defaultInterval = DEFAULTS.interval;
  if (note.defaultRole === undefined) note.defaultRole = DEFAULTS.role;
  chatMetadata[NOTE_METADATA_KEYS.prompt] =
    chatMetadata[NOTE_METADATA_KEYS.prompt] ?? note.default ?? '';
  chatMetadata[NOTE_METADATA_KEYS.interval] =
    chatMetadata[NOTE_METADATA_KEYS.interval] ?? note.defaultInterval;
  chatMetadata[NOTE_METADATA_KEYS.position] =
    chatMetadata[NOTE_METADATA_KEYS.position] ?? note.defaultPosition;
  chatMetadata[NOTE_METADATA_KEYS.depth] =
    chatMetadata[NOTE_METADATA_KEYS.depth] ?? note.defaultDepth;
  chatMetadata[NOTE_METADATA_KEYS.role] = chatMetadata[NOTE_METADATA_KEYS.role] ?? note.defaultRole;
}

export interface FloatingPromptInput {
  chat: readonly ChatMessageLike[];
  chatMetadata: Record<string, unknown>;
  note: NoteSettings;
  extensionPrompts: ExtensionPrompts;
  /** 不在聊天中（无角色也无群）时直接禁用 */
  inChat: boolean;
  /** 单人聊天时的角色文件名（无扩展名），群聊传 null */
  characterFilename?: string | null | undefined;
}

/** 返回 shouldWIAddPrompt */
export function setFloatingPrompt(input: FloatingPromptInput): boolean {
  const { chat, chatMetadata: meta, note, extensionPrompts } = input;
  if (!input.inChat) return false;

  let lastMessageNumber =
    Array.isArray(chat) && chat.length ? chat.filter((m) => m.is_user).length : 0;
  const interval = Number(meta[NOTE_METADATA_KEYS.interval]);
  if (interval === 1) lastMessageNumber = 1;

  if (lastMessageNumber <= 0 || interval <= 0) {
    setExtensionPrompt(
      extensionPrompts,
      NOTE_MODULE_NAME,
      '',
      EXTENSION_PROMPT_TYPES.NONE,
      MAX_INJECTION_DEPTH,
    );
    return false;
  }

  const messagesTillInsertion =
    lastMessageNumber >= interval ? lastMessageNumber % interval : interval - lastMessageNumber;
  const shouldAddPrompt = messagesTillInsertion == 0;

  let prompt = shouldAddPrompt ? String(meta[NOTE_METADATA_KEYS.prompt] ?? '') : '';
  if (shouldAddPrompt && note.chara && input.characterFilename) {
    const charaNote = note.chara.find((e) => e.name === input.characterFilename);
    if (charaNote && charaNote.useChara) {
      switch (charaNote.position) {
        case CHARA_NOTE_POSITION.before:
          prompt = charaNote.prompt + '\n' + prompt;
          break;
        case CHARA_NOTE_POSITION.after:
          prompt = prompt + '\n' + charaNote.prompt;
          break;
        default:
          prompt = charaNote.prompt;
          break;
      }
    }
  }
  setExtensionPrompt(
    extensionPrompts,
    NOTE_MODULE_NAME,
    String(prompt),
    Number(meta[NOTE_METADATA_KEYS.position]),
    Number(meta[NOTE_METADATA_KEYS.depth]),
    !!note.allowWIScan,
    Number(meta[NOTE_METADATA_KEYS.role]),
  );
  return shouldAddPrompt;
}

/** world-info.js checkWorldInfo 末尾：把 ANTop/ANBottom 并入作者注释 */
export function injectWorldInfoIntoAuthorsNote(
  extensionPrompts: ExtensionPrompts,
  chatMetadata: Record<string, unknown>,
  note: NoteSettings,
  anTop: readonly string[],
  anBottom: readonly string[],
): void {
  const originalAN = extensionPrompts[NOTE_MODULE_NAME]?.value ?? '';
  const ANWithWI = `${anTop.join('\n')}\n${originalAN}\n${anBottom.join('\n')}`.replace(
    /(^\n)|(\n$)/g,
    '',
  );
  setExtensionPrompt(
    extensionPrompts,
    NOTE_MODULE_NAME,
    ANWithWI,
    Number(chatMetadata[NOTE_METADATA_KEYS.position]),
    Number(chatMetadata[NOTE_METADATA_KEYS.depth]),
    !!note.allowWIScan,
    Number(chatMetadata[NOTE_METADATA_KEYS.role]),
  );
}
