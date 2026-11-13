import type { ChatMessage } from '@tm/formats';
import { describe, expect, it } from 'vitest';
import { characterCommands } from '../src/lib/slash/characters';
import { injectCommands } from '../src/lib/slash/inject';
import { personaCommands } from '../src/lib/slash/persona';
import { popupCommands } from '../src/lib/slash/popup';
import { fakeEnv, slashRunner } from './slash-env';

describe('/inject', () => {
  it('stores an injection with ST defaults and returns its id', async () => {
    const env = fakeEnv();
    const run = slashRunner(env, injectCommands);
    expect(await run('/inject id=lore The moon is green.')).toBe('lore');
    expect(env.state.injects.get('lore')).toEqual({
      id: 'lore',
      position: 0,
      depth: 4,
      role: 0,
      content: 'The moon is green.',
      scan: false,
      once: false,
      filtered: false,
    });
  });

  it('reads position, depth, role, scan and ephemeral', async () => {
    const env = fakeEnv();
    const run = slashRunner(env, injectCommands);
    await run('/inject id=a position=chat depth=2 role=assistant scan=true ephemeral=true Hi');
    expect(env.state.injects.get('a')).toMatchObject({
      position: 1,
      depth: 2,
      role: 2,
      scan: true,
      once: true,
    });
    await run('/inject id=b position=sideways depth=deep role=narrator Hi');
    expect(env.state.injects.get('b')).toMatchObject({ position: 0, depth: 4, role: 0 });
  });

  it('removes an injection given no text, and makes up an id when none is given', async () => {
    const env = fakeEnv();
    const run = slashRunner(env, injectCommands);
    await run('/inject id=a One');
    expect(await run('/inject id=a')).toBe('a');
    expect(env.state.injects.size).toBe(0);
    const id = await run('/inject Two');
    expect(typeof id === 'string' && id.length > 0).toBe(true);
    expect(env.state.injects.get(id as string)?.content).toBe('Two');
  });

  it('does not take a filter closure', async () => {
    const run = slashRunner(fakeEnv(), injectCommands);
    await expect(run('/inject id=a filter={: /return true :} Hi')).rejects.toThrow('filter');
  });

  it('lists the injections as ST keeps them, and flushes one or all', async () => {
    const env = fakeEnv();
    const run = slashRunner(env, injectCommands);
    await run('/inject id=a One | /inject id=b position=before Two');
    expect(JSON.parse((await run('/listinjects')) as string)).toEqual({
      a: { value: 'One', position: 0, depth: 4, scan: false, role: 0, filter: null },
      b: { value: 'Two', position: 2, depth: 4, scan: false, role: 0, filter: null },
    });
    expect(await run('/listinjects return=none')).toBe('');
    await run('/flushinject a');
    expect([...env.state.injects.keys()]).toEqual(['b']);
    await run('/flushinjects');
    expect(env.state.injects.size).toBe(0);
  });
});

describe('/popup, /input, /buttons', () => {
  it('/popup shows the text and returns it, or the answer with result=true', async () => {
    const env = fakeEnv({ answers: [true, true, false, null] });
    const run = slashRunner(env, popupCommands);
    expect(await run('/popup okButton=Go header=Note <b>Ready?</b>')).toBe('<b>Ready?</b>');
    expect(env.state.asked[0]).toEqual({
      kind: 'confirm',
      text: '<b>Ready?</b>',
      title: 'Note',
      okButton: 'Go',
    });
    expect(await run('/popup result=true Sure?')).toBe('1');
    expect(await run('/popup result=true Sure?')).toBe('0');
    expect(await run('/popup result=true Sure?')).toBe('');
  });

  it('/input returns what was typed, empty when cancelled, and runs the handlers', async () => {
    const env = fakeEnv({ answers: ['typed', null, ''] });
    const run = slashRunner(env, popupCommands);
    expect(await run('/input default=seed rows=2 Your name?')).toBe('typed');
    expect(env.state.asked[0]).toEqual({
      kind: 'input',
      text: 'Your name?',
      rows: 2,
      value: 'seed',
    });
    const handlers = 'onSuccess={: /setvar key=did ok :} onCancel={: /setvar key=did cancel :}';
    expect(await run(`/input ${handlers} Again?`)).toBe('');
    expect(env.state.variables.local['did']).toBe('cancel');
    // an empty answer is still an answer
    expect(await run(`/input ${handlers} Again?`)).toBe('');
    expect(env.state.variables.local['did']).toBe('ok');
    expect(env.state.asked[1]).toMatchObject({ rows: 4 });
  });

  it('/buttons offers the labels and returns the chosen one', async () => {
    const env = fakeEnv({ answers: ['Left', null] });
    const run = slashRunner(env, popupCommands);
    expect(await run('/buttons labels=["Left","Right","Left"] Which way?')).toBe('Left');
    expect(env.state.asked[0]).toEqual({
      kind: 'buttons',
      text: 'Which way?',
      labels: ['Left', 'Right'],
    });
    expect(await run('/buttons labels=["Left",{"text":"Right"}] Which way?')).toBe('');
    expect(env.state.asked[1]).toMatchObject({ labels: ['Left', 'Right'] });
  });

  it('/buttons reads the labels from a variable, and asks nothing for a bad list', async () => {
    const env = fakeEnv({ answers: ['B'] });
    const run = slashRunner(env, popupCommands);
    expect(await run('/setvar key=ways ["A","B"] | /buttons labels=ways Pick')).toBe('B');
    expect(await run('/buttons labels=nonsense Pick')).toBe('');
    expect(await run('/buttons labels=[] Pick')).toBe('');
    expect(env.state.asked).toHaveLength(1);
    await expect(run('/buttons multiple=true labels=["A"] Pick')).rejects.toThrow('multiple');
  });
});

describe('/char-find', () => {
  const cast = () =>
    fakeEnv({
      characters: [
        { avatar: 'ada.png', name: 'Ada' },
        { avatar: 'ada2.png', name: 'Ada' },
        { avatar: 'zoe.png', name: 'Zoé' },
      ],
      current: ['ada2.png'],
      settings: {
        tags: [
          { id: 't1', name: 'elf' },
          { id: 't2', name: 'mage' },
        ],
        tag_map: { 'ada.png': ['t1', 't2'], 'ada2.png': ['t2'] },
      },
    });

  it('finds by name ignoring case and accents, or by avatar file', async () => {
    const run = slashRunner(cast(), characterCommands);
    expect(await run('/char-find zoe')).toBe('zoe.png');
    expect(await run('/findchar ada.png')).toBe('ada.png');
    expect(await run('/char-find ada2')).toBe('ada2.png');
    expect(await run('/char-find Nobody')).toBe('');
  });

  it('prefers the open character among namesakes unless told not to', async () => {
    const env = cast();
    const run = slashRunner(env, characterCommands);
    expect(await run('/char-find Ada')).toBe('ada2.png');
    expect(env.state.notes).toEqual([]);
    expect(await run('/char-find preferCurrent=false Ada')).toBe('ada.png');
    expect(env.state.notes).toHaveLength(1);
    expect(await run('/char-find preferCurrent=false quiet=true Ada')).toBe('ada.png');
    expect(env.state.notes).toHaveLength(1);
  });

  it('narrows by every tag given', async () => {
    const run = slashRunner(cast(), characterCommands);
    expect(await run('/char-find tag=mage tag=elf Ada')).toBe('ada.png');
    expect(await run('/char-find tag=mage Ada')).toBe('ada2.png');
    expect(await run('/char-find tag=dwarf Ada')).toBe('');
  });
});

describe('/persona', () => {
  const settings = () => ({
    user_avatar: 'me.png',
    username: 'Mira',
    power_user: {
      personas: { 'me.png': 'Mira', 'knight.png': 'Sir Tomé' },
      persona_descriptions: {
        'knight.png': { description: 'A tired knight.', position: 0, lorebook: 'Keep' },
      },
    },
  });

  it('returns the current name without an argument', async () => {
    const env = fakeEnv({ settings: settings(), userName: 'Mira' });
    expect(await slashRunner(env, personaCommands)('/persona')).toBe('Mira');
  });

  it('switches to a persona by name or avatar file and saves at once', async () => {
    const env = fakeEnv({ settings: settings() });
    const run = slashRunner(env, personaCommands);
    expect(await run('/persona sir tome')).toBe('');
    expect(env.state.settings).toMatchObject({ user_avatar: 'knight.png', username: 'Sir Tomé' });
    expect(env.state.settings['power_user']).toMatchObject({
      persona_description: 'A tired knight.',
      persona_description_lorebook: 'Keep',
    });
    expect(env.state.saved).toBe(1);
    await run('/persona-set me.png');
    expect(env.state.settings).toMatchObject({ user_avatar: 'me.png', username: 'Mira' });
  });

  it('locks the persona to the chat when auto-lock is on', async () => {
    const base = settings();
    const env = fakeEnv({
      settings: { ...base, power_user: { ...base.power_user, persona_auto_lock: true } },
    });
    await slashRunner(env, personaCommands)('/persona Sir Tomé');
    expect(env.state.metadata['persona']).toBe('knight.png');
  });

  it('falls back to a plain name change, except in lookup mode', async () => {
    const env = fakeEnv({ settings: settings() });
    const run = slashRunner(env, personaCommands);
    await run('/persona mode=lookup Stranger');
    expect(env.state.settings['username']).toBe('Mira');
    expect(env.state.notes).toHaveLength(1);
    await run('/name Stranger');
    expect(env.state.settings).toMatchObject({ user_avatar: 'me.png', username: 'Stranger' });
    await run('/persona mode=temp Sir Tomé');
    expect(env.state.settings).toMatchObject({ user_avatar: 'me.png', username: 'Sir Tomé' });
    await run('/persona mode=sideways Mira');
    expect(env.state.notes).toHaveLength(2);
  });
});

describe('/sync', () => {
  const message = (name: string, is_user: boolean): ChatMessage =>
    ({ name, is_user, is_system: false, send_date: '', mes: 'x' }) as ChatMessage;
  const chat = () =>
    fakeEnv({
      settings: { user_avatar: 'me.png' },
      userName: 'Mira',
      messages: [
        message('Old Me', true),
        message('Ada', false),
        message('Other Me', true),
        message('Old Me', true),
      ],
    });
  const avatar = '/thumbnail?type=persona&file=me.png';

  it('attributes every user message to the current persona', async () => {
    const env = chat();
    expect(await slashRunner(env, personaCommands)('/sync')).toBe('');
    expect(env.state.messages.map((m) => m.name)).toEqual(['Mira', 'Ada', 'Mira', 'Mira']);
    expect(env.state.messages.map((m) => m.force_avatar)).toEqual([
      avatar,
      undefined,
      avatar,
      avatar,
    ]);
    expect(env.state.asked).toEqual([]);
  });

  it('keeps to a range and to one old name', async () => {
    const env = chat();
    const run = slashRunner(env, personaCommands);
    await run('/persona-sync from="old me" 1-3');
    expect(env.state.messages.map((m) => m.name)).toEqual(['Old Me', 'Ada', 'Other Me', 'Mira']);
    await run('/sync 7-9');
    expect(env.state.messages[0]!.name).toBe('Old Me');
  });

  it('asks first with quiet=false', async () => {
    const env = chat();
    env.state.answers = [false, true];
    const run = slashRunner(env, personaCommands);
    await run('/sync quiet=false');
    expect(env.state.messages[0]!.name).toBe('Old Me');
    await run('/sync quiet=false');
    expect(env.state.messages[0]!.name).toBe('Mira');
    expect(env.state.asked).toHaveLength(2);
  });
});
