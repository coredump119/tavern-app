import { describe, expect, it } from 'vitest';
import { DEFAULT_REASONING_SETTINGS, parseReasoningFromString } from '../src/index.js';

const t = DEFAULT_REASONING_SETTINGS;

describe('parseReasoningFromString（ST reasoning.js）', () => {
  it('开头的 <think> 块被切出，两边 trim', () => {
    expect(parseReasoningFromString('<think>\n想一想\n</think>\n\n答案', t)).toEqual({
      reasoning: '想一想',
      content: '答案',
    });
  });
  it('允许前导空白；strict 下中间的块不算', () => {
    expect(parseReasoningFromString('  <think>a</think>b', t)).toEqual({
      reasoning: 'a',
      content: 'b',
    });
    expect(parseReasoningFromString('前文 <think>a</think> 后文', t)).toEqual({
      reasoning: '',
      content: '前文 <think>a</think> 后文',
    });
    expect(parseReasoningFromString('前文 <think>a</think> 后文', t, { strict: false })).toEqual({
      reasoning: 'a',
      content: '前文  后文',
    });
  });
  it('没匹配到时原样返回、不 trim', () => {
    expect(parseReasoningFromString('  plain  ', t)).toEqual({
      reasoning: '',
      content: '  plain  ',
    });
  });
  it('trimSpaces=false 保留空白（power_user.trim_spaces 关）', () => {
    expect(parseReasoningFromString('<think> a </think> b ', t, { trimSpaces: false })).toEqual({
      reasoning: ' a ',
      content: ' b ',
    });
  });
  it('prefix / suffix 为空返回 null；特殊字符按字面匹配', () => {
    expect(
      parseReasoningFromString('<think>a</think>', { prefix: '', suffix: '</think>' }),
    ).toBeNull();
    expect(parseReasoningFromString('[[r]]x', { prefix: '[[', suffix: ']]' })).toEqual({
      reasoning: 'r',
      content: 'x',
    });
  });
  it('只切第一个块', () => {
    expect(parseReasoningFromString('<think>a</think>b<think>c</think>', t)).toEqual({
      reasoning: 'a',
      content: 'b<think>c</think>',
    });
  });
});
