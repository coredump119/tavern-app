/** Round 3 over the wire: the remaining variable scopes, macro-likes, injection filters, macros. */
import { describe, expect, it, vi } from 'vitest';
import { injectModule } from '../src/realm/api/inject.js';
import { helperField, withHelperFields } from '../src/scripts.js';
import { msg, setup } from './harness.js';

type Replacer = (context: { message_id?: number; role?: string }, all: string) => unknown;
interface InjectApi {
  registerMacroLike(regex: RegExp, replace: Replacer): { unregister(): void };
  unregisterMacroLike(regex: RegExp): void;
  injectPrompts(prompts: unknown[], option?: { once?: boolean }): { uninject(): void };
  uninjectPrompts(ids: string[]): void;
}

async function started() {
  const t = setup();
  t.hub.modules.push(injectModule(t.hub));
  await t.start();
  const owner = { structuredClone } as unknown as typeof globalThis;
  const frame = t.hub.createApi(owner, { name: 'TH-message--2--0', messageId: 2 });
  const ask = async (name: string, args: unknown[]): Promise<unknown> => {
    const answer = t.host.query(name, args);
    await t.pump();
    return answer;
  };
  const apply = async (text: string, more: Record<string, unknown> = {}): Promise<string> => {
    const out = (await ask('macro.apply', [[{ text, ...more }]])) as string[];
    return out[0]!;
  };
  return { ...t, owner, frame, inject: frame as unknown as InjectApi, ask, apply };
}

describe('bridge: character, preset and extension variables', () => {
  it('reads what the app synced and layers the scopes like upstream', async () => {
    const t = await started();
    t.host.syncVariables('character', { hp: 1, job: 'guide' });
    t.host.syncVariables('preset', { job: 'none', style: 'plain' });
    await t.pump();
    expect(t.api.getVariables({ type: 'character' })).toEqual({ hp: 1, job: 'guide' });
    expect(t.api.getVariables({ type: 'preset' })).toEqual({ job: 'none', style: 'plain' });
    // global < preset < character < chat
    expect(t.api.getAllVariables()).toEqual({ lang: 'zh', style: 'plain', job: 'guide', hp: 10 });
  });

  it('saves each scope as one write per tick', async () => {
    const t = await started();
    t.host.syncCatalog('session', { character: 'Seraphina' });
    await t.pump();
    t.api.insertOrAssignVariables({ a: 1 }, { type: 'character' });
    t.api.insertOrAssignVariables({ b: 2 }, { type: 'character' });
    t.api.replaceVariables({ tone: 'dry' }, { type: 'preset' });
    await t.pump();
    expect(t.saved['character']).toEqual({ a: 1, b: 2 });
    expect(t.saved['preset']).toEqual({ tone: 'dry' });
  });

  it('refuses character variables while no card is open', async () => {
    const t = await started();
    expect(() => t.api.replaceVariables({ a: 1 }, { type: 'character' })).toThrow(/没有打开角色卡/);
    await t.pump();
    expect(t.saved['character']).toBeUndefined();
  });

  it('extension variables live in the catalog and are saved by id', async () => {
    const t = await started();
    t.host.syncCatalog('extensions', { mvu: { on: true } });
    await t.pump();
    expect(t.api.getVariables({ type: 'extension', extension_id: 'mvu' })).toEqual({ on: true });
    expect(t.api.getVariables({ type: 'extension', extension_id: 'other' })).toEqual({});
    expect(() => t.api.getVariables({ type: 'extension' })).toThrow(/extension_id/);

    t.api.insertOrAssignVariables({ level: 2 }, { type: 'extension', extension_id: 'mvu' });
    await t.pump();
    expect(t.calls).toContainEqual([
      'call',
      'ext.set',
      ['mvu', { on: true, level: 2 }],
      expect.anything(),
    ]);
    expect(t.api.getVariables({ type: 'extension', extension_id: 'mvu' })).toEqual({
      on: true,
      level: 2,
    });
  });
});

describe('bridge: macro-likes', () => {
  it('answers the variable macros every script counts on', async () => {
    const t = await started();
    t.host.syncVariables('chat', { hp: 10, name: 'Ann', bag: { coins: 3, $meta: { seen: 1 } } });
    await t.pump();
    expect(await t.apply('HP {{get_chat_variable::hp}} / {{get_global_variable::lang}}')).toBe(
      'HP 10 / zh',
    );
    expect(await t.apply('{{get_chat_variable::name}}|{{get_chat_variable::bag}}')).toBe(
      'Ann|{"coins":3}',
    );
    expect(await t.apply('{{get_chat_variable::missing}}')).toBe('null');
  });

  it('formats a value as YAML lined up with where the macro stood', async () => {
    const t = await started();
    t.host.syncVariables('chat', { bag: { coins: 3, tag: 'old' } });
    await t.pump();
    expect(await t.apply('  bag: {{format_chat_variable::bag}}')).toBe(
      '  bag: coins: 3\n       tag: old',
    );
    expect(await t.apply('{{format_chat_variable_quoted::bag}}')).toBe('coins: 3\ntag: "old"');
  });

  it('a message macro reads the given 楼层, or the latest one with variables', async () => {
    const t = await started();
    t.appSet([msg('first', { variables: [{ mood: 'calm' }] }), msg('reply')]);
    await t.pump();
    expect(await t.apply('{{get_message_variable::mood}}')).toBe('calm');
    expect(await t.apply('{{get_message_variable::mood}}', { index: 1 })).toBe('null');
    expect(await t.apply('{{get_message_variable::mood}}', { index: 0 })).toBe('calm');
  });

  it('runs a script’s replacer with the message and role it is applied to', async () => {
    const t = await started();
    const seen: unknown[] = [];
    const handle = t.inject.registerMacroLike(/<now>/g, (context, all) => {
      seen.push(context, all);
      return 'NOW';
    });
    expect(await t.apply('it is <now>', { index: 1 })).toBe('it is NOW');
    expect(seen).toEqual([{ message_id: 1, role: 'user' }, '<now>']);
    // a prompt part outside the chat carries the role the app gave
    seen.length = 0;
    await t.apply('<now>', { role: 'system' });
    expect(seen[0]).toEqual({ role: 'system' });

    handle.unregister();
    expect(await t.apply('it is <now>')).toBe('it is <now>');
  });

  it('the same expression registered again replaces the earlier replacer', async () => {
    const t = await started();
    t.inject.registerMacroLike(/<x>/g, () => 'one');
    t.inject.registerMacroLike(/<x>/g, () => 'two');
    expect(await t.apply('<x>')).toBe('two');
    t.inject.unregisterMacroLike(/<x>/g);
    expect(await t.apply('<x>')).toBe('<x>');
  });

  it('a replacer that throws leaves the text and the others alone', async () => {
    const t = await started();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    t.inject.registerMacroLike(/<bad>/g, () => {
      throw new Error('boom');
    });
    t.inject.registerMacroLike(/<ok>/g, () => 'fine');
    expect(await t.apply('<bad> <ok>')).toBe('<bad> fine');
    warn.mockRestore();
  });

  it('a frame that goes away takes its macro-likes with it', async () => {
    const t = await started();
    t.inject.registerMacroLike(/<x>/g, () => 'one');
    t.hub.release(t.owner);
    expect(await t.apply('<x> {{get_chat_variable::hp}}')).toBe('<x> 10');
  });

  it('tells the app when the scripts’ own list changes, and whether any is left', async () => {
    const t = await started();
    const told = () => t.calls.filter((call) => call[1] === 'macro.changed').map((call) => call[2]);
    const first = t.inject.registerMacroLike(/<a>/g, () => 'a');
    t.inject.registerMacroLike(/<b>/g, () => 'b');
    first.unregister();
    t.inject.unregisterMacroLike(/<never>/g);
    await t.pump();
    expect(told()).toEqual([[true], [true], [true]]);
    t.hub.release(t.owner);
    await t.pump();
    expect(told()).toEqual([[true], [true], [true], [false]]);
  });

  it('card documents get them too', async () => {
    const t = await started();
    t.inject.registerMacroLike(/<floor>/g, (context) => context.message_id);
    const html = t.hub.cardFilters.reduce((text, filter) => filter(text, 2), '<p><floor></p>');
    expect(html).toBe('<p>2</p>');
  });

  it('answers nothing while the realm is not running', async () => {
    const t = setup();
    expect(await t.host.query('macro.apply', [[{ text: 'x' }]])).toBeUndefined();
  });

  it('stops waiting for an answer that never comes', async () => {
    vi.useFakeTimers();
    try {
      const t = await started();
      const answer = t.host.query('macro.apply', [[{ text: 'x' }]], 50);
      vi.advanceTimersByTime(60);
      expect(await answer).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('bridge: injected prompts', () => {
  it('sends the prompt without its filter and answers for it when asked', async () => {
    const t = await started();
    let active = true;
    t.inject.injectPrompts([
      {
        id: 'lore',
        position: 'in_chat',
        depth: 2,
        role: 'system',
        content: 'L',
        should_scan: true,
      },
      { id: 'mood', position: 'none', depth: 0, role: 'user', content: 'M', filter: () => active },
    ]);
    await t.pump();
    const sent = t.calls.find((call) => call[1] === 'inject.add')!;
    expect(sent[2]).toEqual([
      [
        {
          id: 'lore',
          position: 'in_chat',
          depth: 2,
          role: 'system',
          content: 'L',
          scan: true,
          filtered: false,
        },
        {
          id: 'mood',
          position: 'none',
          depth: 0,
          role: 'user',
          content: 'M',
          scan: false,
          filtered: true,
        },
      ],
      false,
    ]);
    expect(await t.ask('injects.active', ['mood'])).toBe(true);
    active = false;
    expect(await t.ask('injects.active', ['mood'])).toBe(false);
    // no filter: always in
    expect(await t.ask('injects.active', ['lore'])).toBe(true);
  });

  it('a filter that throws counts as active', async () => {
    const t = await started();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    t.inject.injectPrompts([
      {
        id: 'x',
        content: 'X',
        filter: () => {
          throw new Error('boom');
        },
      },
    ]);
    expect(await t.ask('injects.active', ['x'])).toBe(true);
    warn.mockRestore();
  });

  it('removes prompts by hand and when their frame goes away', async () => {
    const t = await started();
    const handle = t.inject.injectPrompts([{ id: 'a', content: 'A', filter: () => false }]);
    t.inject.injectPrompts([{ id: 'b', content: 'B', filter: () => false }], { once: true });
    await t.pump();
    expect(t.calls.filter((call) => call[1] === 'inject.add').map((call) => call[2])).toEqual([
      [expect.anything(), false],
      [expect.anything(), true],
    ]);
    handle.uninject();
    t.hub.release(t.owner);
    await t.pump();
    expect(t.calls.filter((call) => call[1] === 'inject.remove').map((call) => call[2])).toEqual([
      [['a']],
      [['b']],
    ]);
    expect(await t.ask('injects.active', ['a'])).toBe(true);
  });
});

describe('hub macros', () => {
  it('answers swipe numbers, the chat range and the input box', async () => {
    const t = await started();
    t.appSet([
      msg('first'),
      msg('hi', { is_user: true }),
      msg('two', { swipes: ['one', 'two', 'three'], swipe_id: 1 }),
    ]);
    t.host.syncCatalog('page', { draft: 'typing…' });
    await t.pump();
    const { substitudeMacros } = t.api;
    expect(substitudeMacros('{{lastSwipeId}}/{{currentSwipeId}}')).toBe('3/2');
    expect(substitudeMacros('{{allChatRange}}')).toBe('0-2');
    expect(substitudeMacros('[{{input}}]')).toBe('[typing…]');
    expect(substitudeMacros('a{{space}}b{{newline}}c{{noop}}')).toBe('a b\nc');
    expect(substitudeMacros('{{isotime}} {{isodate}}')).toMatch(/^\d\d:\d\d \d{4}-\d\d-\d\d$/);
  });

  it('takes argument-less macros from what the app evaluated, and leaves the rest', async () => {
    const t = await started();
    t.host.syncCatalog('macro', { persona: 'A traveller.', model: 'mock' });
    await t.pump();
    const { substitudeMacros } = t.api;
    expect(substitudeMacros('{{persona}} on {{Model}}')).toBe('A traveller. on mock');
    expect(substitudeMacros('{{roll::1d6}} {{unknown}}')).toBe('{{roll::1d6}} {{unknown}}');
  });

  it('an empty chat has no range and no swipes', async () => {
    const t = await started();
    t.appSet([]);
    await t.pump();
    expect(t.api.substitudeMacros('[{{allChatRange}}{{lastSwipeId}}{{currentSwipeId}}]')).toBe(
      '[]',
    );
  });
});

describe('the tavern_helper field of a card or preset', () => {
  it('reads the object form and the older list of entries', () => {
    expect(helperField({ tavern_helper: { scripts: [1], variables: { a: 1 } } })).toEqual({
      scripts: [1],
      variables: { a: 1 },
    });
    expect(
      helperField({
        tavern_helper: [['scripts', [1]], ['variables', { a: 1 }], 'junk'],
      }),
    ).toEqual({ scripts: [1], variables: { a: 1 } });
    expect(helperField(undefined)).toEqual({});
    expect(helperField({ tavern_helper: 'x' })).toEqual({});
  });

  it('sets one field and keeps the others, whatever form they were stored in', () => {
    const extensions = { depth_prompt: { depth: 4 }, tavern_helper: [['scripts', [1]]] };
    expect(withHelperFields(extensions, { variables: { hp: 3 } })).toEqual({
      depth_prompt: { depth: 4 },
      tavern_helper: { scripts: [1], variables: { hp: 3 } },
    });
    // the stored object is not touched
    expect(extensions.tavern_helper).toEqual([['scripts', [1]]]);
    expect(withHelperFields(null, { scripts: [] })).toEqual({ tavern_helper: { scripts: [] } });
  });
});
