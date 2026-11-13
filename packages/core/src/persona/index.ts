/**
 * ST personas.js as data operations on `settings.json` + `chat_metadata` (DEV_NOTES §9.24).
 * Pure: the host lists / writes avatar files and persists the settings object.
 */
import { PERSONA_DESCRIPTION_POSITIONS } from '../prompt/persona.js';
import { uuidv4 } from '../tags/index.js';

export { PERSONA_DESCRIPTION_POSITIONS };

export const PERSONA_DEFAULT_DEPTH = 2;
export const PERSONA_DEFAULT_ROLE = 0;
/** personas.js addMissingPersonas / getUserAvatarBlock fallback name */
export const UNNAMED_PERSONA = '[Unnamed Persona]';
/** script.js default_user_name */
export const DEFAULT_USER_NAME = 'User';

export interface PersonaConnection {
  type: 'character' | 'group';
  id: string;
}

export interface PersonaDescriptor {
  description: string;
  position: number;
  depth: number;
  role: number;
  lorebook: string;
  title?: string;
  connections?: PersonaConnection[];
  [key: string]: unknown;
}

export interface PersonaView {
  avatar: string;
  name: string;
  title: string;
  descriptor: PersonaDescriptor | null;
  isCurrent: boolean;
  isDefault: boolean;
  lockedToChat: boolean;
  lockedToCharacter: boolean;
}

export const PERSONA_POSITION_OPTIONS = [
  { value: PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT, label: '提示词中', hint: '角色定义之后' },
  { value: PERSONA_DESCRIPTION_POSITIONS.TOP_AN, label: '作者注释前' },
  { value: PERSONA_DESCRIPTION_POSITIONS.BOTTOM_AN, label: '作者注释后' },
  { value: PERSONA_DESCRIPTION_POSITIONS.AT_DEPTH, label: '聊天中', hint: '按深度插入' },
  { value: PERSONA_DESCRIPTION_POSITIONS.NONE, label: '不注入' },
] as const;

type Obj = Record<string, unknown>;

function puOf(settings: Obj): Obj {
  const pu = (settings['power_user'] as Obj | undefined) ?? {};
  settings['power_user'] = pu;
  return pu;
}
function personasOf(pu: Obj): Record<string, string> {
  if (!pu['personas'] || typeof pu['personas'] !== 'object') pu['personas'] = {};
  return pu['personas'] as Record<string, string>;
}
function descriptorsOf(pu: Obj): Record<string, PersonaDescriptor> {
  if (!pu['persona_descriptions'] || typeof pu['persona_descriptions'] !== 'object')
    pu['persona_descriptions'] = {};
  return pu['persona_descriptions'] as Record<string, PersonaDescriptor>;
}

export function emptyDescriptor(): PersonaDescriptor {
  return {
    description: '',
    position: PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT,
    depth: PERSONA_DEFAULT_DEPTH,
    role: PERSONA_DEFAULT_ROLE,
    lorebook: '',
    connections: [],
    title: '',
  };
}

/** `user_avatar` / `username` live at the top level of settings.json */
export const currentAvatar = (settings: Obj): string => String(settings['user_avatar'] ?? '');
export const currentUserName = (settings: Obj): string =>
  String(settings['username'] ?? DEFAULT_USER_NAME);

/** personas.js `createDummyPersona` / `duplicatePersona` id: date + ASCII letters of the name */
export function newPersonaAvatarId(name: string, now = Date.now): string {
  return `${now()}-${name.replace(/[^a-zA-Z0-9]/g, '')}.png`;
}

/** `initPersona(avatarId, name, description, title, { position, depth, role, lorebook })` */
export function initPersona(
  settings: Obj,
  avatar: string,
  name: string,
  description = '',
  title = '',
  opts: Partial<Pick<PersonaDescriptor, 'position' | 'depth' | 'role' | 'lorebook'>> = {},
): void {
  const pu = puOf(settings);
  personasOf(pu)[avatar] = name;
  descriptorsOf(pu)[avatar] = {
    description,
    position: opts.position ?? PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT,
    depth: opts.depth ?? PERSONA_DEFAULT_DEPTH,
    role: opts.role ?? PERSONA_DEFAULT_ROLE,
    lorebook: opts.lorebook ?? '',
    title,
  };
}

/** `migrateNonPersonaUser`: the current avatar always has a persona entry */
export function migrateNonPersonaUser(settings: Obj): boolean {
  const avatar = currentAvatar(settings);
  if (!avatar) return false;
  const pu = puOf(settings);
  if (avatar in personasOf(pu)) return false;
  initPersona(settings, avatar, currentUserName(settings));
  return true;
}

/** `addMissingPersonas`: avatar files without a persona entry get the unnamed placeholder */
export function addMissingPersonas(settings: Obj, avatarFiles: readonly string[]): number {
  const pu = puOf(settings);
  const personas = personasOf(pu);
  let n = 0;
  for (const file of avatarFiles) {
    if (file in personas) continue;
    initPersona(settings, file, UNNAMED_PERSONA);
    n++;
  }
  return n;
}

/**
 * ST `setPersonaDescription` / `selectCurrentPersona` copy: descriptor → `power_user.persona_description*`.
 * (`AFTER_CHAR` is deprecated and read as IN_PROMPT.)
 */
export function applyDescriptorToPowerUser(pu: Obj, d: PersonaDescriptor | undefined): void {
  const position =
    d?.position === PERSONA_DESCRIPTION_POSITIONS.AFTER_CHAR
      ? PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT
      : (d?.position ?? PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT);
  pu['persona_description'] = d?.description ?? '';
  pu['persona_description_position'] = position;
  pu['persona_description_depth'] = d?.depth ?? PERSONA_DEFAULT_DEPTH;
  pu['persona_description_role'] = d?.role ?? PERSONA_DEFAULT_ROLE;
  pu['persona_description_lorebook'] = d?.lorebook ?? '';
}

export interface SelectPersonaResult {
  /** `persona_auto_lock` locked it to this chat (chat_metadata was changed) */
  autoLocked: boolean;
  nameChanged: boolean;
}

/** `setUserAvatar` + `selectCurrentPersona`: switch `user_avatar`, adopt name + description. */
export function selectPersona(
  settings: Obj,
  chatMetadata: Obj | null,
  avatar: string,
): SelectPersonaResult {
  settings['user_avatar'] = avatar;
  const pu = puOf(settings);
  const personas = personasOf(pu);
  const descriptors = descriptorsOf(pu);
  const result: SelectPersonaResult = { autoLocked: false, nameChanged: false };
  const name = personas[avatar];
  if (!name) return result;
  if (name !== currentUserName(settings)) {
    settings['username'] = name;
    result.nameChanged = true;
  }
  if (!descriptors[avatar]) descriptors[avatar] = emptyDescriptor();
  applyDescriptorToPowerUser(pu, descriptors[avatar]);
  if (chatMetadata && pu['persona_auto_lock'] && chatMetadata['persona'] !== avatar) {
    chatMetadata['persona'] = avatar;
    result.autoLocked = true;
  }
  return result;
}

/** `getOrCreatePersonaDescriptor` for any avatar (ST only does it for the current one) */
export function getOrCreateDescriptor(settings: Obj, avatar: string): PersonaDescriptor {
  const pu = puOf(settings);
  const descriptors = descriptorsOf(pu);
  if (!descriptors[avatar]) {
    descriptors[avatar] =
      avatar === currentAvatar(settings)
        ? {
            description: String(pu['persona_description'] ?? ''),
            position: Number(
              pu['persona_description_position'] ?? PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT,
            ),
            depth: Number(pu['persona_description_depth'] ?? PERSONA_DEFAULT_DEPTH),
            role: Number(pu['persona_description_role'] ?? PERSONA_DEFAULT_ROLE),
            lorebook: String(pu['persona_description_lorebook'] ?? ''),
            connections: [],
            title: '',
          }
        : emptyDescriptor();
  }
  return descriptors[avatar]!;
}

/** Description / position / depth / role / lorebook / title edits; mirrored to power_user when current */
export function setPersonaFields(
  settings: Obj,
  avatar: string,
  patch: Partial<
    Pick<PersonaDescriptor, 'description' | 'position' | 'depth' | 'role' | 'lorebook' | 'title'>
  >,
): void {
  const d = getOrCreateDescriptor(settings, avatar);
  Object.assign(d, patch);
  if (avatar === currentAvatar(settings)) applyDescriptorToPowerUser(puOf(settings), d);
}

/** `renamePersona`: the map entry, and `username` when it is the current persona */
export function renamePersona(settings: Obj, avatar: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  personasOf(puOf(settings))[avatar] = trimmed;
  if (avatar === currentAvatar(settings)) settings['username'] = trimmed;
}

/** `toggleDefaultPersona`; returns the new default (null when cleared) */
export function toggleDefaultPersona(settings: Obj, avatar: string): string | null {
  const pu = puOf(settings);
  if (!(avatar in personasOf(pu))) return (pu['default_persona'] as string | null) ?? null;
  if (pu['default_persona'] === avatar) {
    delete pu['default_persona'];
    return null;
  }
  pu['default_persona'] = avatar;
  return avatar;
}

export type PersonaLockType = 'chat' | 'character' | 'default';

export function isPersonaLocked(
  settings: Obj,
  chatMetadata: Obj | null,
  type: PersonaLockType,
  avatar: string,
  connection: PersonaConnection | null,
): boolean {
  const pu = puOf(settings);
  switch (type) {
    case 'default':
      return pu['default_persona'] === avatar;
    case 'chat':
      return !!chatMetadata && chatMetadata['persona'] == avatar;
    case 'character':
      return !!(
        connection &&
        descriptorsOf(pu)[avatar]?.connections?.some(
          (c) => c.type === connection.type && c.id === connection.id,
        )
      );
  }
}

/**
 * `lockPersona` / `unlockPersona` for one avatar. `connection` = current character
 * `{type:'character', id: avatar}` or group `{type:'group', id}`. Returns the persona names that
 * lost their connection because `persona_allow_multi_connections` is off.
 */
export function setPersonaLock(
  settings: Obj,
  chatMetadata: Obj | null,
  type: PersonaLockType,
  avatar: string,
  connection: PersonaConnection | null,
  locked: boolean,
): string[] {
  const pu = puOf(settings);
  const personas = personasOf(pu);
  const descriptors = descriptorsOf(pu);
  if (locked && !(avatar in personas)) {
    personas[avatar] = currentUserName(settings);
    descriptors[avatar] = emptyDescriptor();
  }
  const unlinked: string[] = [];
  switch (type) {
    case 'default':
      if (locked !== (pu['default_persona'] === avatar)) toggleDefaultPersona(settings, avatar);
      break;
    case 'chat':
      if (!chatMetadata) break;
      if (locked) chatMetadata['persona'] = avatar;
      else delete chatMetadata['persona'];
      break;
    case 'character': {
      if (!connection) break;
      const d = getOrCreateDescriptor(settings, avatar);
      const rest = (d.connections ?? []).filter(
        (c) => !(c.type === connection.type && c.id === connection.id),
      );
      if (!locked) {
        d.connections = rest;
        break;
      }
      d.connections = [...rest, connection];
      if (!pu['persona_allow_multi_connections']) {
        for (const [other, od] of Object.entries(descriptors)) {
          if (other === avatar || !od.connections) continue;
          const filtered = od.connections.filter(
            (c) => !(c.type === connection.type && c.id === connection.id),
          );
          if (filtered.length !== od.connections.length) {
            od.connections = filtered;
            unlinked.push(personas[other] ?? other);
          }
        }
      }
      break;
    }
  }
  return unlinked;
}

/** `getConnectedPersonas(characterKey)` */
export function getConnectedPersonas(settings: Obj, characterKey: string): string[] {
  const descriptors = descriptorsOf(puOf(settings));
  return Object.entries(descriptors)
    .filter(([, d]) => d.connections?.some((c) => c.id === characterKey))
    .map(([avatar]) => avatar);
}

export interface DeletePersonaResult {
  defaultCleared: boolean;
  chatLockCleared: boolean;
}

/** `deletePersona` bookkeeping (the host removes the avatar file) */
export function deletePersona(
  settings: Obj,
  chatMetadata: Obj | null,
  avatar: string,
): DeletePersonaResult {
  const pu = puOf(settings);
  delete personasOf(pu)[avatar];
  delete descriptorsOf(pu)[avatar];
  const r: DeletePersonaResult = { defaultCleared: false, chatLockCleared: false };
  if (pu['default_persona'] === avatar) {
    pu['default_persona'] = null;
    r.defaultCleared = true;
  }
  if (chatMetadata && chatMetadata['persona'] === avatar) {
    delete chatMetadata['persona'];
    r.chatLockCleared = true;
  }
  return r;
}

/** `duplicatePersona` bookkeeping; returns the new avatar id (host copies the image file) */
export function duplicatePersona(settings: Obj, avatar: string, now = Date.now): string | null {
  const pu = puOf(settings);
  const name = personasOf(pu)[avatar];
  if (!name) return null;
  const id = newPersonaAvatarId(name, now);
  const d = descriptorsOf(pu)[avatar];
  initPersona(settings, id, name, d?.description ?? '', d?.title ?? '', {
    position: d?.position ?? PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT,
    depth: d?.depth ?? PERSONA_DEFAULT_DEPTH,
    role: d?.role ?? PERSONA_DEFAULT_ROLE,
    lorebook: d?.lorebook ?? '',
  });
  return id;
}

export interface ResolvePersonaResult {
  /** avatar to select (already applied via `selectPersona`), or null when nothing changed */
  selected: string | null;
  connectType: 'chat' | 'character' | 'default' | 'fallback' | null;
  /** settings.json changed (stale default cleared, selection, name) */
  settingsChanged: boolean;
  /** chat_metadata changed (stale lock removed / auto-lock) */
  metadataChanged: boolean;
}

/**
 * `loadPersonaForCurrentChat`: chat lock → character/group connection → default persona; stale
 * references to missing avatar files are cleared. Multiple connections pick the first (no popup).
 */
export function resolvePersonaForChat(
  settings: Obj,
  chatMetadata: Obj,
  avatarFiles: readonly string[],
  characterKey: string | null,
): ResolvePersonaResult {
  const pu = puOf(settings);
  const result: ResolvePersonaResult = {
    selected: null,
    connectType: null,
    settingsChanged: false,
    metadataChanged: false,
  };
  const has = (a: unknown): a is string => typeof a === 'string' && avatarFiles.includes(a);
  const current = currentAvatar(settings);

  if (avatarFiles.length && !has(current)) {
    selectPersona(settings, null, avatarFiles[0]!);
    result.settingsChanged = true;
    result.selected = avatarFiles[0]!;
    result.connectType = 'fallback';
  }

  let chatPersona = '';
  if (chatMetadata['persona']) {
    if (has(chatMetadata['persona'])) {
      chatPersona = chatMetadata['persona'];
      result.connectType = 'chat';
    } else {
      delete chatMetadata['persona'];
      result.metadataChanged = true;
    }
  }
  if (!chatPersona && characterKey) {
    const connected = getConnectedPersonas(settings, characterKey).filter(has);
    if (connected.length) {
      chatPersona = connected[0]!;
      result.connectType = 'character';
    }
  }
  if (!chatPersona && typeof pu['default_persona'] === 'string' && pu['default_persona']) {
    if (has(pu['default_persona'])) {
      chatPersona = pu['default_persona'];
      result.connectType = 'default';
    } else {
      pu['default_persona'] = null;
      result.settingsChanged = true;
    }
  }

  if (chatPersona && currentAvatar(settings) !== chatPersona) {
    const r = selectPersona(settings, chatMetadata, chatPersona);
    result.selected = chatPersona;
    result.settingsChanged = true;
    if (r.autoLocked) result.metadataChanged = true;
  } else if (chatPersona && pu['persona_auto_lock'] && !chatMetadata['persona']) {
    setPersonaLock(settings, chatMetadata, 'chat', chatPersona, null, true);
    result.metadataChanged = true;
  }
  return result;
}

/** List for the persona page: every avatar file, with states; sorted by name (`persona_sort_order`). */
export function listPersonas(
  settings: Obj,
  chatMetadata: Obj | null,
  avatarFiles: readonly string[],
  connection: PersonaConnection | null,
): PersonaView[] {
  const pu = puOf(settings);
  const personas = personasOf(pu);
  const descriptors = descriptorsOf(pu);
  const current = currentAvatar(settings);
  const views = avatarFiles.map<PersonaView>((avatar) => ({
    avatar,
    name: personas[avatar] ?? UNNAMED_PERSONA,
    title: descriptors[avatar]?.title ?? '',
    descriptor: descriptors[avatar] ?? null,
    isCurrent: avatar === current,
    isDefault: pu['default_persona'] === avatar,
    lockedToChat: !!chatMetadata && chatMetadata['persona'] == avatar,
    lockedToCharacter: isPersonaLocked(settings, chatMetadata, 'character', avatar, connection),
  }));
  const desc = pu['persona_sort_order'] === 'desc';
  return views.sort((a, b) => {
    const r = a.name.localeCompare(b.name);
    return desc ? -r : r;
  });
}

// ---- character → persona (personas.js `convertCharacterToPersona`) ----

/** the avatar file a character's persona is stored under */
export const characterPersonaAvatar = (name: string): string => `${name} (Persona).png`;

/** swap `{{char}}` and `{{user}}`: a character description speaks of itself as {{char}} */
export function swapPersonaMacros(text: string): string {
  return text
    .replace(/{{char}}/gi, '{{personaChar}}')
    .replace(/{{user}}/gi, '{{personaUser}}')
    .replace(/{{personaUser}}/gi, '{{char}}')
    .replace(/{{personaChar}}/gi, '{{user}}');
}

/** Register the persona once its avatar file exists; an existing one under `avatar` is replaced. */
export function personaFromCharacter(
  settings: Obj,
  avatar: string,
  name: string,
  description: string,
): void {
  initPersona(settings, avatar, name, description, '');
  if (currentAvatar(settings) === avatar) puOf(settings)['persona_description'] = description;
}

// ---- backup / restore (`onBackupPersonas` / `onPersonasRestoreInput`) ----

export interface PersonaBackup {
  personas: Record<string, string>;
  persona_descriptions: Record<string, PersonaDescriptor>;
  default_persona: unknown;
}

export const personaBackupFileName = (now = new Date()): string =>
  `personas_${now.toISOString().slice(0, 10).replace(/-/g, '')}.json`;

export function backupPersonas(settings: Obj): PersonaBackup {
  const pu = puOf(settings);
  return {
    personas: personasOf(pu),
    persona_descriptions: descriptorsOf(pu),
    default_persona: pu['default_persona'] ?? null,
  };
}

export interface RestorePersonasResult {
  added: number;
  /** restored personas whose avatar file is missing: the caller seeds the default image */
  needAvatar: string[];
  skipped: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Merge a backup into settings: what already exists stays. Throws on a file that is not a backup. */
export function restorePersonas(
  settings: Obj,
  data: unknown,
  avatarFiles: readonly string[],
): RestorePersonasResult {
  if (!isObj(data) || !isObj(data['personas']) || !isObj(data['persona_descriptions']))
    throw new Error('不是用户设定的备份文件');
  const pu = puOf(settings);
  const personas = personasOf(pu);
  const descriptors = descriptorsOf(pu);
  const result: RestorePersonasResult = { added: 0, needAvatar: [], skipped: 0 };
  for (const [key, value] of Object.entries(data['personas'])) {
    if (key in personas) {
      result.skipped += 1;
      continue;
    }
    personas[key] = String(value);
    result.added += 1;
    if (!avatarFiles.includes(key)) result.needAvatar.push(key);
  }
  for (const [key, value] of Object.entries(data['persona_descriptions'])) {
    if (key in descriptors || !personas[key]) {
      result.skipped += 1;
      continue;
    }
    descriptors[key] = value as PersonaDescriptor;
  }
  const def = data['default_persona'];
  if (typeof def === 'string' && def) {
    if (def in personas) pu['default_persona'] = def;
    else result.skipped += 1;
  }
  return result;
}

// ---- `syncUserNameToPersona` ----

interface UserAttributable {
  is_user?: boolean | undefined;
  name?: string | undefined;
  force_avatar?: unknown;
}

/**
 * Every user message takes the persona's name and avatar. `first` is the first changed index
 * (-1 when nothing changed), so the caller rewrites the chat file from there.
 */
export function attributeUserMessages<T extends UserAttributable>(
  messages: readonly T[],
  name: string,
  forceAvatar: string | undefined,
): { messages: T[]; first: number; changed: number } {
  let first = -1;
  let changed = 0;
  const next = messages.map((m, i) => {
    if (!m.is_user) return m;
    if (m.name === name && (!forceAvatar || m.force_avatar === forceAvatar)) return m;
    if (first < 0) first = i;
    changed += 1;
    return { ...m, name, ...(forceAvatar ? { force_avatar: forceAvatar } : {}) };
  });
  return { messages: next, first, changed };
}

export { uuidv4 as personaUuid };
