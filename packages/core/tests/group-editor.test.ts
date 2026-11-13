import { describe, expect, it } from 'vitest';
import {
  addGroupChat,
  groupChatHeader,
  groupCollageAvatars,
  groupCustomAvatar,
  groupMessageFields,
  newGroup,
  removeGroupChat,
  renameGroupMemberInGroup,
  renameGroupMemberInMessage,
  sortGroups,
  thumbnailUrl,
} from '../src/index.js';

describe('group editor helpers (ST group-chats.js)', () => {
  it('newGroup mirrors createGroup + /api/groups/create', () => {
    const g = newGroup({
      members: ['A.png', 'B.png'],
      memberNames: ['Ann', 'Bob'],
      chatName: '2026-11-7@10h0m0s',
      now: () => 1700000000000,
    });
    expect(g).toEqual({
      id: '1700000000000',
      name: 'Group: Ann, Bob',
      members: ['A.png', 'B.png'],
      avatar_url: 'img/ai4.png',
      allow_self_responses: false,
      hideMutedSprites: false,
      activation_strategy: 0,
      generation_mode: 0,
      disabled_members: [],
      fav: false,
      chat_id: '2026-11-7@10h0m0s',
      chats: ['2026-11-7@10h0m0s'],
      auto_mode_delay: 5,
      generation_mode_join_prefix: '',
      generation_mode_join_suffix: '',
    });
    expect(newGroup({ name: ' My group ', members: [], chatName: 'c' }).name).toBe('My group');
  });

  it('header, message fields, thumbnails', () => {
    expect(groupChatHeader({ a: 1 })).toEqual({
      chat_metadata: { a: 1 },
      user_name: 'unused',
      character_name: 'unused',
    });
    expect(thumbnailUrl('avatar', 'Sera (2).png')).toBe(
      '/thumbnail?type=avatar&file=Sera%20(2).png',
    );
    expect(groupMessageFields('Sera.png', 7)).toEqual({
      original_avatar: 'Sera.png',
      force_avatar: '/thumbnail?type=avatar&file=Sera.png',
      gen_id: 7,
    });
    expect(groupMessageFields('none', 1).force_avatar).toBe('img/ai4.png');
  });

  it('chat bookkeeping and collage', () => {
    const g = {
      id: 'g',
      members: ['A.png', 'none', 'B.png', 'C.png', 'D.png', 'E.png'],
      chats: ['c1'],
      chat_id: 'c1',
    };
    addGroupChat(g, 'c2', () => 5);
    expect(g.chats).toEqual(['c1', 'c2']);
    expect(g.chat_id).toBe('c2');
    expect((g as Record<string, unknown>)['date_last_chat']).toBe(5);
    expect(removeGroupChat(g, 'c2')).toBe('c1');
    expect(removeGroupChat(g, 'c1')).toBe('');
    const chars = ['A.png', 'B.png', 'C.png', 'D.png', 'E.png'].map((avatar) => ({ avatar }));
    expect(groupCollageAvatars(g, chars)).toEqual(['A.png', 'B.png', 'C.png', 'D.png']);
    expect(
      sortGroups([{ date_last_chat: 1 }, { date_last_chat: 3 }, {}]).map((x) => x.date_last_chat),
    ).toEqual([3, 1, undefined]);
  });

  it('renameGroupMember on groups and messages', () => {
    const g = { id: 'g', members: ['A.png', 'B.png'], disabled_members: ['A.png'] };
    expect(renameGroupMemberInGroup(g, 'A.png', 'Ann.png')).toBe(true);
    expect(g.members).toEqual(['Ann.png', 'B.png']);
    expect(g.disabled_members).toEqual(['Ann.png']);
    expect(renameGroupMemberInGroup(g, 'Z.png', 'Y.png')).toBe(false);
    const m: Record<string, unknown> & {
      name: string;
      mes: string;
      is_user?: boolean;
      is_system?: boolean;
    } = {
      name: 'A',
      mes: 'x',
      force_avatar: '/thumbnail?type=avatar&file=A.png',
      original_avatar: 'A.png',
    };
    expect(renameGroupMemberInMessage(m, 'A.png', 'Ann.png', 'Ann')).toBe(true);
    expect(m).toMatchObject({
      name: 'Ann',
      force_avatar: '/thumbnail?type=avatar&file=Ann.png',
      original_avatar: 'Ann.png',
    });
    expect(
      renameGroupMemberInMessage(
        { name: 'U', mes: '', is_user: true, force_avatar: 'A.png' },
        'A.png',
        'B.png',
        'B',
      ),
    ).toBe(false);
  });

  it('uses a stored picture as the group avatar, else the collage', () => {
    expect(groupCustomAvatar('/user/images/17/17_x.jpg')).toBe('user/images/17/17_x.jpg');
    expect(groupCustomAvatar('user/images/17/a.jpg')).toBe('user/images/17/a.jpg');
    expect(groupCustomAvatar('data:image/jpeg;base64,AAAA')).toBe('data:image/jpeg;base64,AAAA');
    for (const v of ['img/ai4.png', '', null, undefined, 'https://x.test/a.png', '/user/../x.png'])
      expect(groupCustomAvatar(v)).toBeNull();
  });
});
