/** Macro-likes on their way out: which texts of a request make the round trip to the realm. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerateRequest } from '../src/lib/ipc';
import {
  applyMacroLikes,
  MacroDisplay,
  scriptMacros,
  type ShownText,
} from '../src/lib/helper/macro-like';

const request = (body: unknown): GenerateRequest => ({
  url: 'http://127.0.0.1:4010/v1/chat/completions',
  body,
  stream: false,
  format: { kind: 'chat_completion', source: 'openai' },
});
/** stands in for the realm: upper-cases what is between the braces */
const shout = vi.fn(async (items: { text: string }[]) =>
  items.map((item) =>
    item.text.replace(/\{\{(\w+)\}\}/g, (_all, name: string) => name.toUpperCase()),
  ),
);

afterEach(() => {
  scriptMacros.apply = null;
  scriptMacros.custom = false;
  shout.mockClear();
});

describe('applyMacroLikes', () => {
  it('leaves the request alone while no realm is up', async () => {
    const body = { messages: [{ role: 'user', content: '{{hp}}' }] };
    await applyMacroLikes(request(body));
    expect(body.messages[0]!.content).toBe('{{hp}}');
  });

  it('asks only about texts with braces, once, with their roles', async () => {
    scriptMacros.apply = shout;
    const body = {
      model: '{{not a prompt}}',
      messages: [
        { role: 'system', content: 'You are {{char}}.' },
        { role: 'user', content: 'plain' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look {{here}}' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,{{x}}' } },
          ],
        },
        { role: 'assistant', content: '{{ok}}', name: '{{name}}' },
      ],
    };
    await applyMacroLikes(request(body));
    expect(shout).toHaveBeenCalledTimes(1);
    expect(shout.mock.calls[0]![0]).toEqual([
      { text: 'You are {{char}}.', role: 'system' },
      { text: 'look {{here}}', role: 'user' },
      { text: '{{ok}}', role: 'assistant' },
    ]);
    expect(body).toEqual({
      model: '{{not a prompt}}',
      messages: [
        { role: 'system', content: 'You are CHAR.' },
        { role: 'user', content: 'plain' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look HERE' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,{{x}}' } },
          ],
        },
        { role: 'assistant', content: 'OK', name: '{{name}}' },
      ],
    });
  });

  it('never asks when nothing has braces', async () => {
    scriptMacros.apply = shout;
    await applyMacroLikes(request({ messages: [{ role: 'user', content: 'plain' }] }));
    await applyMacroLikes(request('not an object'));
    expect(shout).not.toHaveBeenCalled();
  });

  it('asks about every text once a script has an expression of its own', async () => {
    scriptMacros.apply = shout;
    scriptMacros.custom = true;
    const body = {
      messages: [
        { role: 'user', content: '<tag>' },
        { role: 'user', content: '' },
      ],
    };
    await applyMacroLikes(request(body));
    expect(shout.mock.calls[0]![0]).toEqual([{ text: '<tag>', role: 'user' }]);
  });

  it('reads a bare Text Completion prompt and a bare Claude system line', async () => {
    scriptMacros.apply = shout;
    const text = { prompt: 'Once {{upon}}' };
    await applyMacroLikes(request(text));
    expect(text.prompt).toBe('Once UPON');

    const claude = {
      system: '{{sys}}',
      messages: [{ role: 'user', content: [{ type: 'text', text: '{{q}}' }] }],
    };
    await applyMacroLikes(request(claude));
    expect(claude).toEqual({
      system: 'SYS',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Q' }] }],
    });
    expect(shout.mock.calls[1]![0]).toEqual([{ text: '{{q}}', role: 'user' }, { text: '{{sys}}' }]);
  });

  it('walks Gemini and Claude system blocks, naming the model the assistant', async () => {
    scriptMacros.apply = shout;
    const body = {
      systemInstruction: { parts: [{ text: '{{sys}}' }] },
      contents: [
        { role: 'user', parts: [{ text: '{{a}}' }] },
        { role: 'model', parts: [{ text: '{{b}}' }, { inlineData: { data: '{{raw}}' } }] },
      ],
      system: [{ type: 'text', text: '{{block}}' }],
    };
    await applyMacroLikes(request(body));
    expect(shout.mock.calls[0]![0]).toEqual([
      { text: '{{a}}', role: 'user' },
      { text: '{{b}}', role: 'assistant' },
      { text: '{{block}}', role: 'system' },
      { text: '{{sys}}', role: 'system' },
    ]);
    expect(body.contents[1]!.parts).toEqual([{ text: 'B' }, { inlineData: { data: '{{raw}}' } }]);
    expect(body.systemInstruction.parts[0]!.text).toBe('SYS');
  });

  it('keeps the request when the realm gives no usable answer', async () => {
    const body = () => ({
      messages: [
        { role: 'user', content: '{{a}}' },
        { role: 'user', content: '{{b}}' },
      ],
    });
    for (const answer of [undefined, 'text', ['only one'], [{ text: 'A' }, 7]]) {
      scriptMacros.apply = async () => answer;
      const sent = body();
      await applyMacroLikes(request(sent));
      expect(sent).toEqual(body());
    }
    // one good entry is still taken
    scriptMacros.apply = async () => ['A', null];
    const sent = body();
    await applyMacroLikes(request(sent));
    expect(sent.messages.map((message) => message.content)).toEqual(['A', '{{b}}']);
  });
});

describe('MacroDisplay', () => {
  const setup = () => {
    const shown = new Map<number, ShownText>();
    let bumps = 0;
    const display = new MacroDisplay({
      shown,
      read: () => undefined,
      bump: () => {
        bumps++;
      },
    });
    return { display, shown, bumps: () => bumps };
  };
  /** lets the queued question go out and its answer come back */
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it('shows a message as written until the realm answers, then replaced', async () => {
    scriptMacros.apply = shout;
    const { display } = setup();
    expect(display.text(3, 'hp {{hp}}')).toBe('hp {{hp}}');
    expect(display.text(4, 'plain')).toBe('plain');
    await settle();
    expect(shout).toHaveBeenCalledTimes(1);
    expect(shout.mock.calls[0]![0]).toEqual([{ text: 'hp {{hp}}', index: 3 }]);
    expect(display.text(3, 'hp {{hp}}')).toBe('hp HP');
    // the same text is not asked about twice; an edited one is
    await settle();
    expect(shout).toHaveBeenCalledTimes(1);
    expect(display.text(3, 'mp {{mp}}')).toBe('mp {{mp}}');
    await settle();
    expect(display.text(3, 'mp {{mp}}')).toBe('mp MP');
  });

  it('leaves fenced code to the card that will load it', async () => {
    scriptMacros.apply = shout;
    const { display } = setup();
    const source = 'a {{x}}\n```html\n<b>{{y}}</b>\n```\nz {{z}}';
    display.text(0, source);
    await settle();
    expect(shout.mock.calls[0]![0]).toEqual([
      { text: 'a {{x}}\n', index: 0 },
      { text: '\nz {{z}}', index: 0 },
    ]);
    expect(display.text(0, source)).toBe('a X\n```html\n<b>{{y}}</b>\n```\nz Z');
  });

  it('asks about every prose text once a script has an expression of its own', async () => {
    scriptMacros.apply = vi.fn(async (items: { text: string }[]) =>
      items.map((item) => item.text.replace('<tag>', 'TAG')),
    );
    scriptMacros.custom = true;
    const { display, shown } = setup();
    display.text(0, 'a <tag>');
    display.text(1, 'nothing here');
    await settle();
    expect(display.text(0, 'a <tag>')).toBe('a TAG');
    expect(shown.has(1)).toBe(false);
  });

  it('asks again after a refresh and drops an answer that came too late', async () => {
    let answer: (texts: string[]) => void = () => undefined;
    scriptMacros.apply = vi.fn(() => new Promise<string[]>((resolve) => void (answer = resolve)));
    const { display, bumps } = setup();
    display.text(0, '{{a}}');
    await settle();
    display.refresh();
    expect(bumps()).toBe(1);
    answer(['late']);
    await settle();
    expect(display.text(0, '{{a}}')).toBe('{{a}}');
    await settle();
    answer(['fresh']);
    await settle();
    expect(display.text(0, '{{a}}')).toBe('fresh');
    expect(scriptMacros.apply).toHaveBeenCalledTimes(2);
  });

  it('is a pass-through without a realm, and forgets everything on clear', async () => {
    const { display, shown } = setup();
    expect(display.text(0, '{{a}}')).toBe('{{a}}');
    scriptMacros.apply = shout;
    display.refresh();
    display.text(0, '{{a}}');
    await settle();
    expect(shown.size).toBe(1);
    display.clear();
    expect(shown.size).toBe(0);
  });
});
