import { describe, expect, it } from 'vitest';
import {
  buildUpstreamRequest,
  excludeKeysByYaml,
  mergeObjectWithYaml,
  type GenerateData,
} from '../src/index.js';

describe('mergeObjectWithYaml / excludeKeysByYaml (ST util.js)', () => {
  it('merges an object, or every object of a list', () => {
    const obj: Record<string, unknown> = { a: 1 };
    mergeObjectWithYaml(obj, 'b: 2\nc: "x"');
    mergeObjectWithYaml(obj, '- d: true\n- e: [1, 2]\n- just a string');
    expect(obj).toEqual({ a: 1, b: 2, c: 'x', d: true, e: [1, 2] });
  });

  it('ignores empty input, scalars and broken YAML', () => {
    const obj: Record<string, unknown> = { a: 1 };
    mergeObjectWithYaml(obj, '');
    mergeObjectWithYaml(obj, undefined);
    mergeObjectWithYaml(obj, 'plain');
    mergeObjectWithYaml(obj, 'a: [unclosed');
    expect(obj).toEqual({ a: 1 });
  });

  it('excludes by list, by object keys or by a single name', () => {
    const make = () => ({ a: 1, b: 2, c: 3 }) as Record<string, unknown>;
    const byList = make();
    excludeKeysByYaml(byList, '- a\n- c');
    expect(byList).toEqual({ b: 2 });
    const byObject = make();
    excludeKeysByYaml(byObject, 'b: anything');
    expect(byObject).toEqual({ a: 1, c: 3 });
    const byName = make();
    excludeKeysByYaml(byName, 'c');
    excludeKeysByYaml(byName, 'a: [unclosed');
    expect(byName).toEqual({ a: 1, b: 2 });
  });
});

describe('custom source: include / exclude YAML (chat-completions.js)', () => {
  const data = (over: Record<string, unknown> = {}) =>
    ({
      chat_completion_source: 'custom',
      custom_url: 'http://localhost:1234/v1',
      model: 'local',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      max_tokens: 64,
      stream: false,
      ...over,
    }) as unknown as GenerateData;

  it('adds body fields and headers, then drops excluded keys', () => {
    const built = buildUpstreamRequest(
      data({
        custom_include_body: 'min_p: 0.1\ntemperature: 0.2',
        custom_include_headers: 'Authorization: Bearer abc\nX-Count: 3',
        custom_exclude_body: '- max_tokens',
      }),
    );
    const body = built.body as Record<string, unknown>;
    expect(built.url).toBe('http://localhost:1234/v1/chat/completions');
    expect(body['min_p']).toBe(0.1);
    expect(body['temperature']).toBe(0.2);
    expect('max_tokens' in body).toBe(false);
    expect(built.headers).toMatchObject({ Authorization: 'Bearer abc', 'X-Count': '3' });
  });

  it('leaves other sources alone', () => {
    const built = buildUpstreamRequest(
      data({
        chat_completion_source: 'openai',
        reverse_proxy: 'http://localhost:1234/v1',
        custom_include_body: 'min_p: 0.1',
        custom_exclude_body: '- max_tokens',
      }),
    );
    const body = built.body as Record<string, unknown>;
    expect('min_p' in body).toBe(false);
    expect(body['max_tokens']).toBe(64);
  });
});
