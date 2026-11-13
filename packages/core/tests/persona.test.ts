import { describe, expect, it } from 'vitest';
import {
  attributeUserMessages,
  backupPersonas,
  characterPersonaAvatar,
  personaBackupFileName,
  personaFromCharacter,
  restorePersonas,
  swapPersonaMacros,
} from '../src/persona/index.js';
import {
  PERSONA_DESCRIPTION_POSITIONS,
  addMissingPersonas,
  deletePersona,
  duplicatePersona,
  getConnectedPersonas,
  initPersona,
  listPersonas,
  migrateNonPersonaUser,
  renamePersona,
  resolvePersonaForChat,
  selectPersona,
  setPersonaFields,
  setPersonaLock,
  toggleDefaultPersona,
} from '../src/index.js';

const base = () => ({
  username: 'User',
  user_avatar: 'user-default.png',
  power_user: { personas: {}, persona_descriptions: {}, persona_description: '' } as Record<
    string,
    unknown
  >,
});
const pu = (s: ReturnType<typeof base>) => s.power_user as Record<string, any>;

describe('persona data operations (ST personas.js)', () => {
  it('migrateNonPersonaUser binds the current avatar to the user name once', () => {
    const s = base();
    expect(migrateNonPersonaUser(s)).toBe(true);
    expect(pu(s).personas['user-default.png']).toBe('User');
    expect(pu(s).persona_descriptions['user-default.png']).toMatchObject({
      depth: 2,
      role: 0,
      position: 0,
    });
    expect(migrateNonPersonaUser(s)).toBe(false);
  });

  it('selectPersona adopts name + description and auto-locks when enabled', () => {
    const s = base();
    initPersona(s, 'a.png', 'Alice', 'desc A', '', {
      position: PERSONA_DESCRIPTION_POSITIONS.AT_DEPTH,
      depth: 5,
      role: 2,
    });
    const meta: Record<string, unknown> = {};
    const r = selectPersona(s, meta, 'a.png');
    expect(s.user_avatar).toBe('a.png');
    expect(s.username).toBe('Alice');
    expect(r.nameChanged).toBe(true);
    expect(pu(s).persona_description).toBe('desc A');
    expect(pu(s).persona_description_position).toBe(4);
    expect(pu(s).persona_description_depth).toBe(5);
    expect(pu(s).persona_description_role).toBe(2);
    expect(r.autoLocked).toBe(false);
    pu(s).persona_auto_lock = true;
    initPersona(s, 'b.png', 'Bob');
    expect(selectPersona(s, meta, 'b.png').autoLocked).toBe(true);
    expect(meta['persona']).toBe('b.png');
    // an avatar without a persona entry: only user_avatar changes
    const r2 = selectPersona(s, meta, 'plain.png');
    expect(r2.nameChanged).toBe(false);
    expect(s.username).toBe('Bob');
  });

  it('deprecated AFTER_CHAR reads as IN_PROMPT', () => {
    const s = base();
    initPersona(s, 'a.png', 'A', '', '', { position: PERSONA_DESCRIPTION_POSITIONS.AFTER_CHAR });
    selectPersona(s, null, 'a.png');
    expect(pu(s).persona_description_position).toBe(PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT);
  });

  it('field edits mirror to power_user only for the current persona; rename syncs username', () => {
    const s = base();
    initPersona(s, 'a.png', 'A');
    initPersona(s, 'b.png', 'B');
    selectPersona(s, null, 'a.png');
    setPersonaFields(s, 'b.png', { description: 'bee' });
    expect(pu(s).persona_description).toBe('');
    setPersonaFields(s, 'a.png', { description: 'ay', lorebook: 'Eldoria' });
    expect(pu(s).persona_description).toBe('ay');
    expect(pu(s).persona_description_lorebook).toBe('Eldoria');
    renamePersona(s, 'a.png', 'Ayla');
    expect(s.username).toBe('Ayla');
    renamePersona(s, 'b.png', 'Bea');
    expect(s.username).toBe('Ayla');
  });

  it('default persona toggles; locks to chat and character respect multi-connection setting', () => {
    const s = base();
    initPersona(s, 'a.png', 'A');
    initPersona(s, 'b.png', 'B');
    expect(toggleDefaultPersona(s, 'a.png')).toBe('a.png');
    expect(toggleDefaultPersona(s, 'a.png')).toBeNull();
    expect(toggleDefaultPersona(s, 'nobody.png')).toBeNull();
    const meta: Record<string, unknown> = {};
    setPersonaLock(s, meta, 'chat', 'a.png', null, true);
    expect(meta['persona']).toBe('a.png');
    setPersonaLock(s, meta, 'chat', 'a.png', null, false);
    expect(meta['persona']).toBeUndefined();
    const conn = { type: 'character' as const, id: 'Sera.png' };
    expect(setPersonaLock(s, meta, 'character', 'a.png', conn, true)).toEqual([]);
    expect(getConnectedPersonas(s, 'Sera.png')).toEqual(['a.png']);
    // single-connection mode: B takes over, A is unlinked
    expect(setPersonaLock(s, meta, 'character', 'b.png', conn, true)).toEqual(['A']);
    expect(getConnectedPersonas(s, 'Sera.png')).toEqual(['b.png']);
    pu(s).persona_allow_multi_connections = true;
    expect(setPersonaLock(s, meta, 'character', 'a.png', conn, true)).toEqual([]);
    expect(getConnectedPersonas(s, 'Sera.png').sort()).toEqual(['a.png', 'b.png']);
    // locking an avatar without a persona creates one named after the user
    setPersonaLock(s, meta, 'chat', 'new.png', null, true);
    expect(pu(s).personas['new.png']).toBe('User');
  });

  it('delete clears default + chat lock; duplicate copies the descriptor with a new id', () => {
    const s = base();
    initPersona(s, 'a.png', 'Ann Lee', 'd', 't', { lorebook: 'L' });
    toggleDefaultPersona(s, 'a.png');
    const meta: Record<string, unknown> = { persona: 'a.png' };
    const dup = duplicatePersona(s, 'a.png', () => 1700000000000);
    expect(dup).toBe('1700000000000-AnnLee.png');
    expect(pu(s).persona_descriptions[dup!]).toMatchObject({
      description: 'd',
      title: 't',
      lorebook: 'L',
    });
    expect(duplicatePersona(s, 'missing.png')).toBeNull();
    const r = deletePersona(s, meta, 'a.png');
    expect(r).toEqual({ defaultCleared: true, chatLockCleared: true });
    expect(pu(s).default_persona).toBeNull();
    expect(meta['persona']).toBeUndefined();
    expect(pu(s).personas['a.png']).toBeUndefined();
  });

  it('resolvePersonaForChat: chat lock → connection → default, clearing stale references', () => {
    const s = base();
    initPersona(s, 'a.png', 'A');
    initPersona(s, 'b.png', 'B');
    initPersona(s, 'c.png', 'C');
    const files = ['user-default.png', 'a.png', 'b.png', 'c.png'];
    // default persona wins when nothing else is set
    pu(s).default_persona = 'c.png';
    let r = resolvePersonaForChat(s, {}, files, 'Sera.png');
    expect(r.selected).toBe('c.png');
    expect(r.connectType).toBe('default');
    expect(s.username).toBe('C');
    // a character connection beats the default
    setPersonaLock(s, null, 'character', 'b.png', { type: 'character', id: 'Sera.png' }, true);
    r = resolvePersonaForChat(s, {}, files, 'Sera.png');
    expect(r.selected).toBe('b.png');
    expect(r.connectType).toBe('character');
    // a chat lock beats both
    r = resolvePersonaForChat(s, { persona: 'a.png' }, files, 'Sera.png');
    expect(r.selected).toBe('a.png');
    expect(r.connectType).toBe('chat');
    // stale chat lock + stale default are cleared
    pu(s).default_persona = 'gone.png';
    const meta: Record<string, unknown> = { persona: 'gone-too.png' };
    r = resolvePersonaForChat(s, meta, files, null);
    expect(meta['persona']).toBeUndefined();
    expect(pu(s).default_persona).toBeNull();
    expect(r.metadataChanged).toBe(true);
    expect(r.settingsChanged).toBe(true);
    // nothing applicable and current avatar valid → no selection
    r = resolvePersonaForChat(s, {}, files, null);
    expect(r.selected).toBeNull();
    // current avatar file missing → first file
    s.user_avatar = 'deleted.png';
    r = resolvePersonaForChat(s, {}, files, null);
    expect(r.selected).toBe('user-default.png');
    expect(r.connectType).toBe('fallback');
    // auto-lock with same persona already selected still locks the chat
    pu(s).persona_auto_lock = true;
    pu(s).default_persona = 'user-default.png';
    const meta2: Record<string, unknown> = {};
    r = resolvePersonaForChat(s, meta2, files, null);
    expect(meta2['persona']).toBe('user-default.png');
  });

  it('listPersonas shows every avatar file, placeholder names, states and sort order', () => {
    const s = base();
    initPersona(s, 'b.png', 'Bob', '', 'the title');
    pu(s).default_persona = 'b.png';
    expect(addMissingPersonas(s, ['a.png', 'b.png'])).toBe(1);
    const views = listPersonas(s, { persona: 'a.png' }, ['b.png', 'a.png'], {
      type: 'character',
      id: 'X.png',
    });
    expect(views.map((v) => v.name)).toEqual(['[Unnamed Persona]', 'Bob']);
    expect(views[1]).toMatchObject({ isDefault: true, title: 'the title', lockedToChat: false });
    expect(views[0]).toMatchObject({ lockedToChat: true, isCurrent: false });
    pu(s).persona_sort_order = 'desc';
    expect(listPersonas(s, null, ['b.png', 'a.png'], null)[0]!.name).toBe('Bob');
  });
});

describe('character → persona, backup and name attribution (DEV_NOTES §9.35)', () => {
  it('personaFromCharacter registers ST defaults and follows the current persona', () => {
    const s = base();
    const avatar = characterPersonaAvatar('Seraphina');
    expect(avatar).toBe('Seraphina (Persona).png');
    personaFromCharacter(s, avatar, 'Seraphina', 'desc');
    expect(pu(s).personas[avatar]).toBe('Seraphina');
    expect(pu(s).persona_descriptions[avatar]).toEqual({
      description: 'desc',
      position: 0,
      depth: 2,
      role: 0,
      lorebook: '',
      title: '',
    });
    expect(pu(s).persona_description).not.toBe('desc');
    s.user_avatar = avatar;
    personaFromCharacter(s, avatar, 'Seraphina', 'again');
    expect(pu(s).persona_description).toBe('again');
  });

  it('swapPersonaMacros exchanges the two macros in any case', () => {
    expect(swapPersonaMacros('{{char}} guards {{User}}; {{CHAR}} heals {{user}}')).toBe(
      '{{user}} guards {{char}}; {{user}} heals {{char}}',
    );
  });

  it('backup → restore merges without overwriting', () => {
    const src = base();
    initPersona(src, 'a.png', 'Alice', 'A desc');
    initPersona(src, 'b.png', 'Bob', 'B desc');
    pu(src).default_persona = 'b.png';
    const file = JSON.parse(JSON.stringify(backupPersonas(src))) as Record<string, unknown>;
    expect(personaBackupFileName(new Date('2026-11-12T03:04:05Z'))).toBe('personas_20261112.json');

    const dst = base();
    initPersona(dst, 'a.png', 'Mine', 'kept');
    const r = restorePersonas(dst, file, ['a.png']);
    expect(pu(dst).personas['a.png']).toBe('Mine');
    expect(pu(dst).persona_descriptions['a.png'].description).toBe('kept');
    expect(pu(dst).personas['b.png']).toBe('Bob');
    expect(pu(dst).persona_descriptions['b.png'].description).toBe('B desc');
    expect(pu(dst).default_persona).toBe('b.png');
    expect(r.needAvatar).toContain('b.png');
    expect(r.added).toBeGreaterThanOrEqual(1);
    expect(r.skipped).toBeGreaterThanOrEqual(2);

    expect(() => restorePersonas(base(), { personas: [] }, [])).toThrow();
    // a description without its persona and an unknown default are left out
    const odd = base();
    const before = Object.keys(pu(odd).persona_descriptions ?? {}).length;
    restorePersonas(
      odd,
      { personas: {}, persona_descriptions: { 'x.png': {} }, default_persona: 'x.png' },
      [],
    );
    expect(Object.keys(pu(odd).persona_descriptions ?? {}).length).toBe(before);
    expect(pu(odd).default_persona).not.toBe('x.png');
  });

  it('attributeUserMessages renames user messages only and reports where to rewrite from', () => {
    const chat = [
      { name: 'Bot', is_user: false, mes: 'hi' },
      { name: 'Old', is_user: true, mes: 'a' },
      { name: 'Me', is_user: true, mes: 'b', force_avatar: '/p' },
      { name: 'Old', is_user: true, mes: 'c', force_avatar: '/other' },
    ];
    const r = attributeUserMessages(chat, 'Me', '/p');
    expect(r.first).toBe(1);
    expect(r.changed).toBe(2);
    expect(r.messages.map((m) => m.name)).toEqual(['Bot', 'Me', 'Me', 'Me']);
    expect(r.messages[3]).toMatchObject({ force_avatar: '/p', mes: 'c' });
    expect(r.messages[0]).toBe(chat[0]);
    expect(r.messages[2]).toBe(chat[2]);
    expect(chat[1]!.name).toBe('Old');
    expect(attributeUserMessages(r.messages, 'Me', '/p')).toMatchObject({ first: -1, changed: 0 });
  });
});
