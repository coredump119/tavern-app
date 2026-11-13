import { describe, expect, it } from 'vitest';
import { GROUP_ACTIVATION_STRATEGY, parseGroup } from '../src/index.js';

describe('group json', () => {
  it('round-trips an ST group file without injecting defaults', () => {
    const raw = {
      id: '1700000000000',
      name: 'Group: Alice, Carol',
      members: ['alice.png', 'carol.png'],
      avatar_url: 'img/ai4.png',
      allow_self_responses: false,
      activation_strategy: GROUP_ACTIVATION_STRATEGY.NATURAL,
      generation_mode: 0,
      disabled_members: [],
      fav: 'true',
      chat_id: '2024-01-01@00h00m00s',
      chats: ['2024-01-01@00h00m00s'],
      auto_mode_delay: 5,
      generation_mode_join_prefix: '',
      generation_mode_join_suffix: '',
      chat_metadata: { tainted: true },
      past_metadata: {},
      date_added: 1700000000000,
      date_last_chat: 1700000000001,
      unknown_field: { keep: 'me' },
    };
    expect(parseGroup(raw)).toEqual(raw);
    expect(parseGroup({ id: 'x', name: 'n', members: [] })).toEqual({
      id: 'x',
      name: 'n',
      members: [],
    });
    expect(() => parseGroup({ id: 'x', members: [] })).toThrow();
  });
});
