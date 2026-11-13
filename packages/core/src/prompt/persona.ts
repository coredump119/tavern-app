// ST personas.js / script.js addPersonaDescriptionExtensionPrompt
import { NOTE_METADATA_KEYS, NOTE_MODULE_NAME, type NoteSettings } from './authors-note.js';
import {
  EXTENSION_PROMPT_TYPES,
  setExtensionPrompt,
  type ExtensionPrompts,
} from './extension-prompts.js';

export const PERSONA_DESCRIPTION_POSITIONS = {
  IN_PROMPT: 0,
  AFTER_CHAR: 1,
  TOP_AN: 2,
  BOTTOM_AN: 3,
  AT_DEPTH: 4,
  NONE: 9,
} as const;
export const PERSONA_INJECT_TAG = 'PERSONA_DESCRIPTION';

export interface PersonaSettings {
  persona_description: string;
  persona_description_position: number;
  persona_description_role?: number;
  persona_description_depth?: number;
}

export function addPersonaDescriptionExtensionPrompt(
  extensionPrompts: ExtensionPrompts,
  chatMetadata: Record<string, unknown>,
  note: NoteSettings,
  persona: PersonaSettings,
  shouldWIAddPrompt: boolean,
): void {
  setExtensionPrompt(extensionPrompts, PERSONA_INJECT_TAG, '', EXTENSION_PROMPT_TYPES.IN_PROMPT, 0);
  if (
    !persona.persona_description ||
    persona.persona_description_position === PERSONA_DESCRIPTION_POSITIONS.NONE
  )
    return;

  const anPositions: number[] = [
    PERSONA_DESCRIPTION_POSITIONS.BOTTOM_AN,
    PERSONA_DESCRIPTION_POSITIONS.TOP_AN,
  ];
  if (anPositions.includes(persona.persona_description_position) && shouldWIAddPrompt) {
    const originalAN = extensionPrompts[NOTE_MODULE_NAME]?.value ?? '';
    const ANWithDesc =
      persona.persona_description_position === PERSONA_DESCRIPTION_POSITIONS.TOP_AN
        ? `${persona.persona_description}\n${originalAN}`
        : `${originalAN}\n${persona.persona_description}`;
    setExtensionPrompt(
      extensionPrompts,
      NOTE_MODULE_NAME,
      ANWithDesc,
      Number(chatMetadata[NOTE_METADATA_KEYS.position]),
      Number(chatMetadata[NOTE_METADATA_KEYS.depth]),
      !!note.allowWIScan,
      Number(chatMetadata[NOTE_METADATA_KEYS.role]),
    );
  }
  if (persona.persona_description_position === PERSONA_DESCRIPTION_POSITIONS.AT_DEPTH) {
    setExtensionPrompt(
      extensionPrompts,
      PERSONA_INJECT_TAG,
      persona.persona_description,
      EXTENSION_PROMPT_TYPES.IN_CHAT,
      persona.persona_description_depth ?? 2,
      true,
      persona.persona_description_role ?? 0,
    );
  }
}
