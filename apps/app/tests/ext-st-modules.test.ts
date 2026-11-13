import { describe, expect, it } from 'vitest';
import {
  EventSourceStream,
  SlashCommandEnumValue,
  countOccurrences,
  createCommonEnumProviders,
  enumTypes,
  extractReasoningFromData,
  getExtensionPromptRoleByName,
  getStreamingReply,
  isDataURL,
  lastMessageId,
  pureModules,
  tryParseStreamingError,
  type ReplySettings,
} from '../src/lib/ext/st-modules';

const live: ReplySettings = {
  mainApi: 'openai',
  source: 'custom',
  showThoughts: true,
  textGenType: '',
};
const streamState = () => ({ reasoning: '', images: [], signature: '', toolSignatures: {} });

describe('ST module stand-ins: pure exports', () => {
  it('names every pure export an extension can import', () => {
    const table = pureModules();
    const names = (path: string) => Object.keys(table[path] ?? {});
    expect(names('/script.js')).toEqual(
      expect.arrayContaining(['MAX_INJECTION_DEPTH', 'system_message_types', 'isOdd']),
    );
    expect(names('/scripts/openai.js')).toEqual(
      expect.arrayContaining(['ChatCompletion', 'Message', 'MessageCollection', 'proxies']),
    );
    expect(names('/scripts/world-info.js')).toEqual(
      expect.arrayContaining(['world_info_position', 'world_info_logic', 'DEFAULT_DEPTH']),
    );
    for (const exports of Object.values(table)) {
      for (const [name, value] of Object.entries(exports)) {
        expect(value, name).not.toBeUndefined();
      }
    }
    // connection proxies are never handed to extensions
    expect(table['/scripts/openai.js']!['proxies']).toEqual([]);
  });

  it('small helpers behave like ST', () => {
    expect(getExtensionPromptRoleByName('assistant')).toBe(2);
    expect(getExtensionPromptRoleByName('user')).toBe(1);
    expect(getExtensionPromptRoleByName('nobody')).toBe(0);
    expect(countOccurrences('a"b"c"', '"')).toBe(3);
    expect(isDataURL('data:image/png;base64,AAAA')).toBe(true);
    expect(isDataURL('https://example.test/a.png')).toBe(false);
    expect(isDataURL(42)).toBe(false);
  });

  it('getLastMessageId skips a swipe still being generated', () => {
    const chat = [{}, { swipes: ['a'], swipe_id: 0 }, { swipes: ['a'], swipe_id: 1 }];
    expect(lastMessageId(chat)).toBe(1);
    expect(lastMessageId(chat, { exclude_swipe_in_propress: false })).toBe(2);
    expect(lastMessageId(chat, { filter: (m) => m === chat[0] })).toBe(0);
    expect(lastMessageId([])).toBeNull();
  });

  it('reads reasoning from a finished reply by source', () => {
    const data = { choices: [{ message: { content: 'hi', reasoning_content: 'because' } }] };
    expect(extractReasoningFromData(data, {}, live)).toBe('because');
    expect(extractReasoningFromData(data, {}, { ...live, showThoughts: false })).toBe('');
    expect(
      extractReasoningFromData(
        data,
        { ignoreShowThoughts: true },
        { ...live, showThoughts: false },
      ),
    ).toBe('because');
    const claude = {
      content: [
        { type: 'thinking', thinking: 'hm' },
        { type: 'text', text: 'x' },
      ],
    };
    expect(extractReasoningFromData(claude, { chatCompletionSource: 'claude' }, live)).toBe('hm');
  });

  it('reads one streamed chunk and collects reasoning in the state', () => {
    const state = streamState();
    const chunk = { choices: [{ delta: { content: 'he', reasoning_content: 'th' } }] };
    expect(getStreamingReply(chunk, state, {}, live)).toBe('he');
    expect(state.reasoning).toBe('th');
    const quiet = streamState();
    expect(getStreamingReply(chunk, quiet, { overrideShowThoughts: false }, live)).toBe('he');
    expect(quiet.reasoning).toBe('');
    expect(
      getStreamingReply(
        { delta: { text: 'c' } },
        streamState(),
        { chatCompletionSource: 'claude' },
        live,
      ),
    ).toBe('c');
  });

  it('reports a streamed error body once, never a normal chunk', () => {
    const seen: string[] = [];
    const report = (message: string) => seen.push(message);
    tryParseStreamingError({ statusText: 'Bad' }, '{"error":{"message":"quota"}}', {}, report);
    tryParseStreamingError({ statusText: 'Bad' }, '{"error":{}}', {}, report);
    tryParseStreamingError(null, '{"choices":[]}', {}, report);
    tryParseStreamingError(null, 'data: not json', {}, report);
    tryParseStreamingError(null, '{"message":"hidden"}', { quiet: true }, report);
    expect(seen).toEqual(['quota', 'Bad']);
  });

  it('enum providers keep ST call shapes', () => {
    const providers = createCommonEnumProviders({
      characters: () => [{ name: 'Seraphina', avatar: 'Seraphina.png' }],
      groups: () => [{ id: 'g1', name: 'Party' }],
      personas: () => ({ 'user-default.png': 'User' }),
      worldNames: () => ['Eldoria'],
      messageCount: () => 3,
    });
    const names = (list: SlashCommandEnumValue[]) => list.map((item) => item.value);
    expect(names(providers.boolean('onOff')())).toEqual(['on', 'off']);
    expect(names(providers.characters('all')())).toEqual(['Seraphina', 'Party']);
    expect(names(providers.characters('character')())).toEqual(['Seraphina']);
    expect(names(providers.worlds())).toEqual(['Eldoria']);
    expect(names(providers.messages()())).toEqual(['0', '1', '2']);
    expect(providers.variables()()).toEqual([]);
    expect(new SlashCommandEnumValue('x', null, enumTypes.name).toString()).toBe('x');
  });

  it('splits a byte stream into server-sent events', async () => {
    const stream = new EventSourceStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    void writer.write(new TextEncoder().encode('data: {"a":1}\n\nda'));
    void writer.write(new TextEncoder().encode('ta: [DONE]\n\n'));
    void writer.close();
    const events: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(value.data);
    }
    expect(events).toEqual(['{"a":1}', '[DONE]']);
  });
});
