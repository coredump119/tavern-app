import type { ChatMessage } from '@tm/formats';
import { describe, expect, it } from 'vitest';
import { withSwipe } from '../src/lib/chat/swipes';
import { followsUp, isBareToolReply, toolRecordMessage } from '../src/lib/chat/tool-calls';

const invocation = {
  id: 'c1',
  displayName: 'Clock',
  name: 'clock',
  parameters: '{}',
  result: '12:00',
  error: false,
  signature: null,
  reasoning: null,
};

describe('tool calls of one reply (DEV_NOTES §9.34 第 8 轮)', () => {
  it('drops a reply that is nothing but tool calls, except on a swipe', () => {
    expect(isBareToolReply('normal', '', '')).toBe(true);
    expect(isBareToolReply('regenerate', '...', '')).toBe(true);
    expect(isBareToolReply('normal', 'let me check', '')).toBe(false);
    expect(isBareToolReply('normal', '', 'thinking')).toBe(false);
    expect(isBareToolReply('swipe', '', '')).toBe(false);
  });

  it('follows up only when there is a result to send back and no stealth tool ran', () => {
    expect(followsUp({ invocations: [invocation], errors: [], stealthCalls: [] })).toBe(true);
    expect(followsUp({ invocations: [], errors: [], stealthCalls: [] })).toBe(false);
    expect(followsUp({ invocations: [invocation], errors: [], stealthCalls: ['ghost'] })).toBe(
      false,
    );
  });

  it('records the calls as a small system message', () => {
    const message = toolRecordMessage([invocation], 'custom', 'model-x');
    expect(message).toMatchObject({
      name: 'SillyTavern System',
      is_user: false,
      is_system: true,
      extra: { isSmallSys: true, tool_invocations: [invocation], api: 'custom', model: 'model-x' },
    });
    expect(message.mes.startsWith('<details><summary>Tool calls: Clock</summary>')).toBe(true);
  });
});

describe('withSwipe (ST loadFromSwipeId)', () => {
  const message: ChatMessage = {
    name: 'Sera',
    is_user: false,
    send_date: 'd0',
    mes: 'one',
    swipe_id: 0,
    swipes: ['one', 'two'],
    swipe_info: [
      { send_date: 'd0', extra: {} },
      { send_date: 'd1', extra: { model: 'm' } },
    ],
  };
  it('shows a stored swipe with its date and extra', () => {
    expect(withSwipe(message, 1)).toMatchObject({
      swipe_id: 1,
      mes: 'two',
      send_date: 'd1',
      extra: { model: 'm' },
    });
  });
  it('refuses an id outside the stored swipes', () => {
    expect(withSwipe(message, 2)).toBeNull();
    expect(withSwipe(message, -1)).toBeNull();
    expect(withSwipe({ ...message, swipes: undefined }, 0)?.mes).toBe('one');
  });
});
