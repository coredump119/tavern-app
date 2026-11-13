import { describe, expect, it } from 'vitest';
import {
  calculateLogitBias,
  exportLogitBiasPreset,
  importLogitBiasPreset,
  logitBiasEntries,
} from '../src/index.js';

const encode = async (text: string) => {
  if (text === 'boom') throw new Error('no tokenizer');
  return [...text].map((c) => c.charCodeAt(0));
};

describe('logit bias (ST /bias)', () => {
  it('maps every token of an entry to its value; later entries win', async () => {
    const bias = await calculateLogitBias(
      [
        { id: '1', text: 'ab', value: 5 },
        { id: '2', text: 'b', value: -7 },
      ],
      encode,
    );
    expect(bias).toEqual({ '97': 5, '98': -7 });
  });

  it('uses a JSON number array as raw token ids', async () => {
    const bias = await calculateLogitBias([{ id: '1', text: ' [1, 22] ', value: 3 }], encode);
    expect(bias).toEqual({ '1': 3, '22': 3 });
    const text = await calculateLogitBias([{ id: '1', text: '[x]', value: 3 }], encode);
    expect(Object.keys(text)).toHaveLength(3);
  });

  it('clamps values, skips empty text and encoder failures', async () => {
    const bias = await calculateLogitBias(
      [
        { id: '1', text: 'a', value: 500 },
        { id: '2', text: '', value: 1 },
        { id: '3', text: 'boom', value: 1 },
        { id: '4', text: 'c', value: -500 },
      ],
      encode,
    );
    expect(bias).toEqual({ '97': 100, '99': -100 });
  });

  it('reads preset rows defensively', () => {
    expect(logitBiasEntries(undefined)).toEqual([]);
    expect(logitBiasEntries([null, { id: 'a', text: 't', value: '4' }, { text: 1 }])).toEqual([
      { id: 'a', text: 't', value: 4 },
      { id: '', text: '1', value: 0 },
    ]);
  });

  it('imports a preset file as ST does and exports it back', () => {
    const file = [
      { id: 'a', text: ' the', value: -100 },
      { text: 'hi', value: 5 },
      { text: 'no value' },
      'junk',
      null,
    ];
    const got = importLogitBiasPreset(file, 'My bias.v2.json', ['Other'], () => 'new-id');
    expect(got).toEqual({
      name: 'My bias.v2',
      entries: [
        { id: 'a', text: ' the', value: -100 },
        { id: 'new-id', text: 'hi', value: 5 },
      ],
    });
    expect(importLogitBiasPreset(file, 'Other.json', ['Other'], () => 'x')).toEqual({
      error: 'duplicate',
    });
    expect(importLogitBiasPreset({ a: 1 }, 'New.json', [], () => 'x')).toEqual({
      error: 'invalid',
    });
    expect(exportLogitBiasPreset([{ id: 'a', text: 't', value: 1 }])).toBe(
      '[\n    {\n        "id": "a",\n        "text": "t",\n        "value": 1\n    }\n]',
    );
  });
});
