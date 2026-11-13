import { describe, expect, it } from 'vitest';
import {
  buildClaudeRequest,
  cachingAtDepthForClaude,
  calculateClaudeBudgetTokens,
  convertClaudeMessages,
  convertClaudePrompt,
  type ClaudeMessage,
  type GenerateData,
} from '../src/index.js';

const names = { charName: 'Sera', userName: 'Yun', groupNames: ['Alice'] };

describe('convertClaudeMessages', () => {
  it('collects leading system messages into system prompt with example names, merges roles, adds prefill', () => {
    const r = convertClaudeMessages(
      [
        { role: 'system', content: 'main' },
        { role: 'system', content: 'ex u', name: 'example_user' },
        { role: 'system', content: 'Sera: already', name: 'example_assistant' },
        { role: 'system', content: 'Alice: group', name: 'example_assistant' },
        { role: 'user', content: 'hi', name: 'Yun' },
        { role: 'system', content: 'mid system' },
        { role: 'assistant', content: 'yo' },
        { role: 'assistant', content: '' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          ],
        },
      ],
      'pre  ',
      true,
      false,
      names,
    );
    expect(r.systemPrompt).toEqual([
      { type: 'text', text: 'main' },
      { type: 'text', text: 'Yun: ex u' },
      { type: 'text', text: 'Sera: already' },
      { type: 'text', text: 'Alice: group' },
    ]);
    expect(r.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Yun: hi' },
          { type: 'text', text: 'mid system' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'yo' },
          { type: 'text', text: '' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '​' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'pre' }] },
    ]);
  });
  it('without system prompt everything becomes user; empty with sysprompt gets the placeholder', () => {
    const r = convertClaudeMessages(
      [
        { role: 'system', content: 'a' },
        { role: 'system', content: 'b', name: 'example_user' },
      ],
      undefined,
      false,
      false,
      names,
    );
    expect(r.systemPrompt).toEqual([]);
    expect(r.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'Yun: b' },
        ],
      },
    ]);
    const e = convertClaudeMessages(
      [{ role: 'system', content: 'only' }],
      undefined,
      true,
      false,
      names,
      'Go.',
    );
    expect(e.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Go.' }] }]);
  });
  it('tool calls become text when tools are off; images in assistant move to the next user message', () => {
    const r = convertClaudeMessages(
      [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{"a":1}' } }],
        },
        { role: 'tool', content: 'result', tool_call_id: 't1' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } },
          ],
        },
      ],
      undefined,
      false,
      false,
      names,
    );
    expect(r.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'text', text: '{"a":1}' }] },
      { role: 'user', content: [{ type: 'text', text: 'result' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'see' }] },
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } },
        ],
      },
    ]);
    const t = convertClaudeMessages(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 't1', function: { name: 'f', arguments: { a: 1 } } }],
        },
      ],
      undefined,
      false,
      true,
      names,
    );
    expect(t.messages[0]?.content).toEqual([
      { type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } },
    ]);
  });
});

describe('convertClaudePrompt (legacy text, tokenizer path)', () => {
  it('matches the ST shape', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'system', content: 'ex', name: 'example_user' },
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2', name: 'Yun' },
      { role: 'assistant', content: 'a1' },
    ];
    expect(convertClaudePrompt(msgs)).toBe(
      '\n\nHuman: sys\n\nH: ex\n\nHuman: u1\n\nFirst message: Yun: u2\n\nAssistant: a1',
    );
    expect(convertClaudePrompt([])).toBe('');
  });
});

describe('budget tokens and caching', () => {
  it('calculateClaudeBudgetTokens', () => {
    expect(calculateClaudeBudgetTokens(300, 'auto', true, false)).toBeNull();
    expect(calculateClaudeBudgetTokens(300, 'medium', true, false)).toBe(1024);
    expect(calculateClaudeBudgetTokens(40000, 'high', true, false)).toBe(20000);
    expect(calculateClaudeBudgetTokens(40000, 'max', false, false)).toBe(21333);
    expect(calculateClaudeBudgetTokens(300, 'min', true, true)).toBe('low');
    expect(calculateClaudeBudgetTokens(300, 'max', true, true)).toBe('max');
    expect(calculateClaudeBudgetTokens(300, 'auto', true, true)).toBeNull();
  });
  it('cachingAtDepthForClaude skips the prefill and marks depth and depth+2', () => {
    const msgs: ClaudeMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'u0' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a0' }] },
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'u2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'prefill' }] },
    ];
    cachingAtDepthForClaude(msgs, 0, '5m');
    expect(msgs[4]?.content[0]).toEqual({
      type: 'text',
      text: 'u2',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });
    expect(msgs[2]?.content[0]).toEqual({
      type: 'text',
      text: 'u1',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });
    expect(msgs[5]?.content[0]).toEqual({ type: 'text', text: 'prefill' });
    expect(msgs[3]?.content[0]).toEqual({ type: 'text', text: 'a1' });
  });
});

describe('buildClaudeRequest', () => {
  const data = (over: Record<string, unknown> = {}): GenerateData => ({
    type: 'normal',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    model: 'claude-sonnet-4-5',
    chat_completion_source: 'claude',
    temperature: 1,
    top_p: 1,
    top_k: 0,
    max_tokens: 300,
    stream: false,
    stop: [],
    use_sysprompt: true,
    assistant_prefill: '',
    user_name: 'Yun',
    char_name: 'Sera',
    group_names: [],
    reasoning_effort: 'auto',
    ...over,
  });
  it('base body and headers; limited sampling drops top_p when it is 1', () => {
    const r = buildClaudeRequest(data());
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.headers).toEqual({
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'output-128k-2025-02-19,context-1m-2025-08-07',
    });
    expect(Object.keys(r.body)).toEqual([
      'system',
      'messages',
      'model',
      'max_tokens',
      'stop_sequences',
      'temperature',
      'top_k',
      'stream',
    ]);
    expect(r.body['system']).toEqual([{ type: 'text', text: 'sys' }]);
    expect(r.body['messages']).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    const lp = buildClaudeRequest(data({ top_p: 0.9 }));
    expect(lp.body['temperature']).toBeUndefined();
    expect(lp.body['top_p']).toBe(0.9);
    const nosys = buildClaudeRequest(data({ use_sysprompt: false }));
    expect('system' in nosys.body).toBe(false);
    expect(nosys.body['messages']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'sys' },
          { type: 'text', text: 'hi' },
        ],
      },
    ]);
  });
  it('thinking budget bumps max_tokens, strips sampling and turns a prefill into a user turn', () => {
    const r = buildClaudeRequest(
      data({
        model: 'claude-3-7-sonnet-latest',
        reasoning_effort: 'medium',
        assistant_prefill: 'pre',
      }),
    );
    expect(r.body['max_tokens']).toBe(1324);
    expect(r.body['thinking']).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(r.body['temperature']).toBeUndefined();
    const msgs = r.body['messages'] as ClaudeMessage[];
    expect(msgs[msgs.length - 1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'pre' }],
    });
  });
  it('adaptive models use effort strings; verbosity fills output_config when thinking did not', () => {
    const adaptiveCfg = {
      enableSystemPromptCache: false,
      cachingAtDepth: -1,
      extendedTTL: false,
      enableAdaptiveThinking: true,
      promptPlaceholder: 'x',
    };
    const a = buildClaudeRequest(
      data({ model: 'claude-opus-4-6', reasoning_effort: 'low', verbosity: 'high' }),
      adaptiveCfg,
    );
    // 出厂配置 enableAdaptiveThinking=false：opus-4-6 走传统预算
    const classic = buildClaudeRequest(
      data({ model: 'claude-opus-4-6', reasoning_effort: 'low', verbosity: 'high' }),
    );
    expect(classic.body['thinking']).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(classic.body['output_config']).toEqual({ effort: 'high' });
    expect(a.body['thinking']).toEqual({ type: 'adaptive' });
    expect(a.body['output_config']).toEqual({ effort: 'low' });
    expect(a.body['top_k']).toBeUndefined();
    expect(a.headers['anthropic-beta']).not.toContain('effort-2025-11-24');
    const v = buildClaudeRequest(
      data({ model: 'claude-opus-4-7', verbosity: 'medium', include_reasoning: true }),
    );
    expect(v.body['thinking']).toBeUndefined();
    expect(v.body['output_config']).toEqual({ effort: 'medium' });
    expect(v.body['temperature']).toBeUndefined();
    expect(v.headers['anthropic-beta']).toContain('effort-2025-11-24');
    const s = buildClaudeRequest(
      data({ model: 'claude-opus-4-7', reasoning_effort: 'high', include_reasoning: true }),
    );
    expect(s.body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
  });
  it('tools, json schema and caching config', () => {
    const t = buildClaudeRequest(
      data({
        tools: [
          {
            type: 'function',
            function: { name: 'f', description: 'd', parameters: { type: 'object' } },
          },
        ],
        tool_choice: 'auto',
        enable_web_search: true,
        model: 'claude-sonnet-4-5',
        json_schema: { name: 'out', value: { type: 'object' } },
      }),
      {
        enableSystemPromptCache: true,
        cachingAtDepth: 0,
        extendedTTL: true,
        enableAdaptiveThinking: true,
        promptPlaceholder: 'x',
      },
    );
    expect(t.body['tools']).toEqual([
      { type: 'web_search_20250305', name: 'web_search' },
      {
        name: 'f',
        description: 'd',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      { name: 'out', description: 'Well-formed JSON object', input_schema: { type: 'object' } },
    ]);
    expect(t.body['tool_choice']).toEqual({ type: 'tool', name: 'out' });
    expect((t.body['system'] as Array<Record<string, unknown>>)[0]?.['cache_control']).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    expect(t.headers['anthropic-beta']).toBe(
      'output-128k-2025-02-19,context-1m-2025-08-07,tools-2024-05-16,prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11',
    );
    const msgs = t.body['messages'] as ClaudeMessage[];
    expect(msgs[0]?.content[0]?.['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});
