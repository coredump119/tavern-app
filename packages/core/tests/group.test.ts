import { describe, expect, it, vi } from 'vitest';
import {
  DeletedGroupMemberSwipedError,
  GROUP_ACTIVATION_STRATEGY,
  activateImpersonate,
  activateListOrder,
  activateManual,
  activateNaturalOrder,
  activatePooledOrder,
  activateSwipe,
  buildGroupFirstMessages,
  countMessagesToRegenerate,
  extractAllWords,
  generateGroup,
  getEnabledMembers,
  getFirstCharacterMessage,
  getLastMessageGenerationId,
  onlyUnique,
  selectGroupMembers,
  shuffle,
  type ChatMessageLike,
  type CharacterLike,
  type GroupLike,
} from '../src/index.js';

/** 依次返回给定值的伪随机源（用完后返回 0） */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 0;
}

const characters: CharacterLike[] = [
  { name: 'Alice', avatar: 'alice.png', talkativeness: 0.5, first_mes: 'Hi from {{char}}' },
  { name: 'Bob Smith', avatar: 'bob.png', talkativeness: '0' },
  {
    name: 'Carol',
    avatar: 'carol.png',
    talkativeness: 1,
    first_mes: '',
    data: { alternate_greetings: ['Alt 1', 'Alt 2'] },
  },
  { name: 'Dave', avatar: 'dave.png' },
];
const members = ['alice.png', 'bob.png', 'carol.png'];
const group: GroupLike = {
  id: 'g1',
  members,
  disabled_members: ['bob.png'],
  activation_strategy: 0,
};

const user = (mes: string): ChatMessageLike => ({ name: 'User', is_user: true, mes });
const char = (avatar: string, mes = 'x', extra?: Record<string, unknown>): ChatMessageLike => ({
  name: characters.find((c) => c.avatar === avatar)?.name ?? avatar,
  is_user: false,
  mes,
  original_avatar: avatar,
  ...(extra ? { extra } : {}),
});
const narrator = (mes = 'n'): ChatMessageLike => ({
  name: 'Narrator',
  is_system: true,
  mes,
  extra: { type: 'narrator' },
});

describe('array utils', () => {
  it('shuffle is ST Fisher–Yates with injected random', () => {
    // currentIndex 3→ randomIndex floor(0.9*3)=2 swap(2,2); 2→ floor(0*2)=0 swap(1,0); 1→ floor(0.5*1)=0 swap(0,0)
    expect(shuffle(['a', 'b', 'c'], seq(0.9, 0, 0.5))).toEqual(['b', 'a', 'c']);
    expect([1, 1, 2, 3, 3].filter(onlyUnique)).toEqual([1, 2, 3]);
    expect(extractAllWords('Hello, World! Bob_Smith')).toEqual(['hello', 'world', 'bob_smith']);
    expect(extractAllWords('')).toEqual([]);
  });
});

describe('activation strategies', () => {
  it('list order: unique members in order, unknown avatars dropped', () => {
    const ctx = { characters, chat: [] };
    expect(activateListOrder(['carol.png', 'alice.png', 'carol.png', 'ghost.png'], ctx)).toEqual([
      2, 0,
    ]);
  });

  it('impersonate picks a random member', () => {
    expect(activateImpersonate(members, { characters, chat: [], random: seq(0.99) })).toEqual([2]);
    expect(activateImpersonate(members, { characters, chat: [], random: seq(0) })).toEqual([0]);
  });

  it('manual picks one shuffled member', () => {
    expect(
      activateManual(['alice.png', 'carol.png'], { characters, chat: [], random: seq(0, 0) }),
    ).toEqual([2]);
  });

  describe('swipe', () => {
    it('last message by a character → that character', () => {
      expect(activateSwipe(members, { characters, chat: [user('a'), char('carol.png')] })).toEqual([
        2,
      ]);
    });
    it('last message is user → walk back to the last character message', () => {
      const chat = [char('alice.png'), narrator(), user('hi')];
      expect(activateSwipe(members, { characters, chat })).toEqual([0]);
    });
    it('system messages are skipped unless allowSystem', () => {
      const sys: ChatMessageLike = {
        name: 'Alice',
        is_system: true,
        mes: 's',
        original_avatar: 'alice.png',
      };
      const chat = [char('carol.png'), sys];
      // ST quirk: the system message's own original_avatar is appended after the walk-back result
      expect(activateSwipe(members, { characters, chat })).toEqual([2, 0]);
      expect(
        activateSwipe(members, { characters, chat, random: seq(0) }, { allowSystem: true }),
      ).toEqual([0]);
    });
    it('no character message found → random member, then legacy name match by last message name', () => {
      // chat: only user messages → shuffle(members)[0] with random 0s → ['bob','carol','alice'][0]... compute:
      // shuffle ['alice','bob','carol'] with seq(0,0): i=3 r=0 swap(2,0) → [carol,bob,alice]; i=2 r=0 swap(1,0) → [bob,carol,alice]; i=1 r=0 swap(0,0)
      const chat = [user('hello')];
      expect(activateSwipe(members, { characters, chat, random: seq(0, 0, 0) })).toEqual([1]);
      // legacy message without original_avatar: match by name
      const legacy: ChatMessageLike = { name: 'Carol', is_user: false, mes: 'x' };
      expect(activateSwipe(members, { characters, chat: [legacy] })).toEqual([2]);
      // name matches a non-member → nothing
      const stranger: ChatMessageLike = { name: 'Dave', is_user: false, mes: 'x' };
      expect(activateSwipe(members, { characters, chat: [stranger] })).toEqual([]);
      expect(activateSwipe(members, { characters, chat: [] })).toEqual([]);
    });
  });

  describe('pooled', () => {
    const enabled = ['alice.png', 'carol.png'];
    it('prefers members who have not spoken since the last user message', () => {
      const chat = [user('q'), char('alice.png')];
      expect(
        activatePooledOrder(enabled, chat[chat.length - 1], false, {
          characters,
          chat,
          random: seq(0),
        }),
      ).toEqual([2]);
    });
    it('user input resets the pool (everyone eligible)', () => {
      const chat = [user('q'), char('alice.png'), char('carol.png')];
      expect(
        activatePooledOrder(enabled, chat[chat.length - 1], true, {
          characters,
          chat,
          random: seq(0),
        }),
      ).toEqual([0]);
    });
    it('everyone spoke → random excluding the last speaker', () => {
      const chat = [user('q'), char('alice.png'), char('carol.png')];
      expect(
        activatePooledOrder(enabled, chat[chat.length - 1], false, {
          characters,
          chat,
          random: seq(0.99),
        }),
      ).toEqual([0]);
      // single member: no exclusion
      expect(
        activatePooledOrder(['carol.png'], chat[chat.length - 1], false, {
          characters,
          chat,
          random: seq(0),
        }),
      ).toEqual([2]);
    });
    it('narrator / system messages are ignored when collecting speakers', () => {
      const chat = [user('q'), char('alice.png'), narrator()];
      expect(
        activatePooledOrder(enabled, chat[chat.length - 1], false, {
          characters,
          chat,
          random: seq(0),
        }),
      ).toEqual([2]);
    });
  });

  describe('natural', () => {
    const enabled = ['alice.png', 'bob.png', 'carol.png'];
    it('mentions activate members first (word match, case-insensitive), then talkativeness rolls', () => {
      // shuffle(3 members) consumes 3 randoms; then one roll per member in shuffled order
      // seq: shuffle(0.9,0,0.5) → [bob, alice, carol]; rolls bob(0.2: 0>=0.2 no, chatty no), alice(0.6: 0.5>=0.6 no), carol(0.5: 1>=0.5 yes)
      const r = seq(0.9, 0, 0.5, 0.2, 0.6, 0.5);
      const ids = activateNaturalOrder(
        enabled,
        'hey BOB, what do you think?',
        undefined,
        false,
        true,
        { characters, chat: [], random: r },
      );
      expect(ids).toEqual([1, 2]);
    });
    it('the last speaker is banned unless allow_self_responses', () => {
      const last = char('carol.png');
      // shuffle → [bob, alice, carol]; rolls: bob 0.5 (0>=0.5 no), alice 0.1 (0.5>=0.1 yes); carol banned → no roll consumed
      const ids = activateNaturalOrder(enabled, 'carol?', last, false, false, {
        characters,
        chat: [last],
        random: seq(0.9, 0, 0.5, 0.5, 0.1),
      });
      expect(ids).toEqual([0]);
      // allowed: carol mention counts and she rolls (1 >= anything)
      const ids2 = activateNaturalOrder(enabled, 'carol?', last, true, false, {
        characters,
        chat: [last],
        random: seq(0.9, 0, 0.5, 0.5, 0.9, 0.3),
      });
      // rolls bob 0.5 no, alice 0.9 no, carol 0.3 yes → dedup with the mention
      expect(ids2).toEqual([2]);
    });
    it('no one activated → random pick from members with talkativeness > 0', () => {
      // shuffle → [bob, alice, carol]; rolls bob 0.5 no; alice 0.9 no (0.5<0.9); carol: talkativeness 1 >= 0.99? yes... use 2-member pool instead
      const pool = ['alice.png', 'bob.png'];
      // shuffle 2: i=2 r=0.9 → floor(1.8)=1 swap(1,1); i=1 r=0 swap(0,0) → [alice,bob]; alice roll 0.9 no; bob roll 0.1 no (0>=0.1 false)
      // chatty = [alice] → random pick 0.7 → alice
      const ids = activateNaturalOrder(pool, '', undefined, false, true, {
        characters,
        chat: [],
        random: seq(0.9, 0, 0.9, 0.1, 0.7),
      });
      expect(ids).toEqual([0]);
      // talkativeness string "0" is honored; undefined → default 0.5
      const ids2 = activateNaturalOrder(['dave.png'], '', undefined, false, true, {
        characters,
        chat: [],
        random: seq(0, 0.4),
      });
      expect(ids2).toEqual([3]);
    });
    it('deduplicates mention + roll', () => {
      const ids = activateNaturalOrder(['carol.png'], 'carol carol', undefined, false, true, {
        characters,
        chat: [],
        random: seq(0, 0.5),
      });
      expect(ids).toEqual([2]);
    });
  });
});

describe('selectGroupMembers (generateGroupWrapper dispatch)', () => {
  const ctxOf = (chat: ChatMessageLike[], random?: () => number) => ({ characters, chat, random });
  it('user input is the activation text; auto mode uses the last non-system message', () => {
    const chat = [user('q'), char('carol.png', 'last words')];
    const a = selectGroupMembers(
      {
        group: { ...group, activation_strategy: 1 },
        type: 'normal',
        userInput: 'typed',
        byAutoMode: false,
      },
      ctxOf(chat),
    );
    expect(a.activationText).toBe('typed');
    expect(a.isUserInput).toBe(true);
    expect(a.activatedMembers).toEqual([0, 2]); // LIST, bob disabled
    expect(a.generateType).toBe('normal');
    const b = selectGroupMembers(
      {
        group: { ...group, activation_strategy: 1 },
        type: 'auto',
        userInput: 'typed',
        byAutoMode: true,
      },
      ctxOf(chat),
    );
    expect(b.activationText).toBe('last words');
    expect(b.isUserInput).toBe(false);
    const c = selectGroupMembers(
      { group, type: 'normal', userInput: '', byAutoMode: false },
      ctxOf([narrator()], seq(0, 0, 0, 0, 0)),
    );
    expect(c.activationText).toBe('');
  });
  it('force_chid wins over everything', () => {
    const s = selectGroupMembers(
      { group, type: 'swipe', userInput: '', byAutoMode: false, forceChid: 3 },
      ctxOf([]),
    );
    expect(s.activatedMembers).toEqual([3]);
    expect(s.generateType).toBe('swipe');
  });
  it('quiet: swipe target incl. system, else first member', () => {
    const s = selectGroupMembers(
      { group, type: 'quiet', userInput: '', byAutoMode: false },
      ctxOf([char('carol.png')]),
    );
    expect(s.activatedMembers).toEqual([2]);
    const empty = selectGroupMembers(
      { group, type: 'quiet', userInput: '', byAutoMode: false },
      ctxOf([]),
    );
    expect(empty.activatedMembers).toEqual([0]);
    expect(empty.generateType).toBe('quiet');
  });
  it('swipe / continue throw when the speaker left the group', () => {
    // only a character missing from `characters` entirely triggers the error
    const gone: ChatMessageLike = {
      name: 'Ghost',
      is_user: false,
      mes: 'x',
      original_avatar: 'ghost.png',
    };
    expect(() =>
      selectGroupMembers({ group, type: 'swipe', userInput: '', byAutoMode: false }, ctxOf([gone])),
    ).toThrow(DeletedGroupMemberSwipedError);
    const ok = selectGroupMembers(
      { group, type: 'continue', userInput: '', byAutoMode: false },
      ctxOf([char('bob.png')]),
    );
    expect(ok.activatedMembers).toEqual([1]); // disabled members can still be swiped
    // a character that left the group but still exists is still found
    const dave: ChatMessageLike = {
      name: 'Dave',
      is_user: false,
      mes: 'x',
      original_avatar: 'dave.png',
    };
    expect(
      selectGroupMembers({ group, type: 'swipe', userInput: '', byAutoMode: false }, ctxOf([dave]))
        .activatedMembers,
    ).toEqual([3]);
    expect(ok.generateType).toBe('continue');
  });
  it('impersonate / pooled / manual dispatch', () => {
    expect(
      selectGroupMembers(
        { group, type: 'impersonate', userInput: '', byAutoMode: false },
        ctxOf([], seq(0.5)),
      ).activatedMembers,
    ).toEqual([1]);
    const pooled = selectGroupMembers(
      {
        group: { ...group, activation_strategy: 3 },
        type: 'normal',
        userInput: '',
        byAutoMode: false,
      },
      ctxOf([user('q')], seq(0.99)),
    );
    expect(pooled.activatedMembers).toEqual([2]);
    const manual = selectGroupMembers(
      {
        group: { ...group, activation_strategy: 2 },
        type: 'normal',
        userInput: 'hi',
        byAutoMode: false,
      },
      ctxOf([]),
    );
    expect(manual.activatedMembers).toEqual([]); // MANUAL + user input → nobody
    const manualAuto = selectGroupMembers(
      {
        group: { ...group, activation_strategy: 2 },
        type: 'auto',
        userInput: '',
        byAutoMode: true,
      },
      ctxOf([], seq(0, 0)),
    );
    expect(manualAuto.activatedMembers).toEqual([2]);
    expect(getEnabledMembers({ id: 'x', members: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(GROUP_ACTIVATION_STRATEGY.POOLED).toBe(3);
  });
});

describe('regenerate bookkeeping', () => {
  it('gen_id of the last character message', () => {
    expect(getLastMessageGenerationId([])).toBeNull();
    expect(getLastMessageGenerationId([user('x')])).toBeNull();
    expect(getLastMessageGenerationId([char('alice.png', 'x', { gen_id: 7 })])).toBe(7);
    expect(getLastMessageGenerationId([char('alice.png')])).toBeNull();
  });
  it('deletes the whole last batch, stopping at a different batch or a user/system message', () => {
    const chat = [
      user('q'),
      char('alice.png', 'a', { gen_id: 1 }),
      char('alice.png', 'b', { gen_id: 2 }),
      char('carol.png', 'c', { gen_id: 2 }),
    ];
    expect(countMessagesToRegenerate(chat)).toBe(2);
    // legacy (no gen_id): delete until the user message
    expect(countMessagesToRegenerate([user('q'), char('alice.png'), char('carol.png')])).toBe(2);
    expect(countMessagesToRegenerate([user('q')])).toBe(0);
    expect(countMessagesToRegenerate([])).toBe(0);
  });
});

describe('first messages', () => {
  const deps = {
    substitute: (t: string, name2: string) => t.replace('{{char}}', name2),
    timestamp: () => 'T',
    now: () => 1000,
  };
  it('builds the ST message shape, picking from alternate greetings', () => {
    const m = getFirstCharacterMessage(characters[0]!, { ...deps, random: () => 0.5 });
    expect(m).toEqual({
      is_user: false,
      is_system: false,
      name: 'Alice',
      send_date: 'T',
      original_avatar: 'alice.png',
      extra: { gen_id: 1000 * 0.5 * 1000000 },
      mes: 'Hi from Alice',
      force_avatar: 'alice.png',
    });
    // carol: first_mes '' filtered out → alternates only
    const c = getFirstCharacterMessage(characters[2]!, { ...deps, random: () => 0.99 });
    expect(c.mes).toBe('Alt 2');
    const d = getFirstCharacterMessage(characters[3]!, deps);
    expect(d.mes).toBe('');
    const hooked = getFirstCharacterMessage(characters[0]!, {
      ...deps,
      onFirstMessageSelected: () => 'Overridden',
      thumbnailUrl: (a) => `/thumb/${a}`,
    });
    expect(hooked.mes).toBe('Overridden');
    expect(hooked.force_avatar).toBe('/thumb/alice.png');
    expect(
      getFirstCharacterMessage({ name: 'N', avatar: 'none', first_mes: 'x' }, deps).force_avatar,
    ).toBe('img/ai4.png');
  });
  it('group first messages follow member order and skip empty ones', () => {
    const msgs = buildGroupFirstMessages(
      { id: 'g', members: ['carol.png', 'ghost.png', 'Alice', 'dave.png'] },
      characters,
      { ...deps, random: () => 0 },
    );
    expect(msgs.map((m) => [m.name, m.mes])).toEqual([
      ['Carol', 'Alt 1'],
      ['Alice', 'Hi from Alice'],
    ]);
  });
});

describe('generateGroup orchestration', () => {
  it('runs Generate per activated member in order with auto-continue and queue callbacks', async () => {
    const calls: Array<[number, string, Record<string, unknown>]> = [];
    const queues: string[][] = [];
    let n = 0;
    const host = {
      generate: vi.fn(async (chId: number, type: string, params: Record<string, unknown>) => {
        calls.push([chId, type, params]);
        n++;
        return { messageChunk: n === 1 ? 'partial' : 'done' };
      }),
      shouldAutoContinue: (chunk: string) => chunk === 'partial',
      onQueueChanged: (q: ReadonlyMap<string, number>) =>
        queues.push([...q.entries()].map(([k, v]) => `${k}:${v}`)),
      onStarted: vi.fn(),
      onMemberDrafted: vi.fn(),
      onFinished: vi.fn(),
    };
    const out = await generateGroup(
      {
        group: { ...group, activation_strategy: 1 },
        type: 'normal',
        userInput: 'hello',
        byAutoMode: false,
        showQueue: true,
        params: { extra: 1 },
      },
      { characters, chat: [], now: () => 42 },
      host,
    );
    expect(out?.generationId).toBe(42);
    expect(out?.selection.activatedMembers).toEqual([0, 2]);
    expect(calls).toEqual([
      [0, 'normal', { automatic_trigger: false, extra: 1 }],
      [0, 'continue', { automatic_trigger: false, extra: 1 }],
      [2, 'normal', { automatic_trigger: false, extra: 1 }],
    ]);
    expect(queues).toEqual([['alice.png:1', 'carol.png:2'], ['carol.png:1'], [], []]);
    expect(host.onStarted).toHaveBeenCalledWith({ type: 'normal' });
    expect(host.onMemberDrafted).toHaveBeenNthCalledWith(1, 0);
    expect(host.onFinished).toHaveBeenCalledWith({ type: 'normal' });
    expect(out?.textResult).toEqual({ messageChunk: 'done' });
  });
  it('nobody activated → user message sent as is; empty group → undefined; abort stops before generating', async () => {
    const sendUserMessageAsIs = vi.fn(async () => {});
    const generate = vi.fn(async () => undefined);
    const out = await generateGroup(
      {
        group: { ...group, activation_strategy: 2 },
        type: 'normal',
        userInput: 'hi',
        byAutoMode: false,
      },
      { characters, chat: [] },
      { generate, sendUserMessageAsIs },
    );
    expect(sendUserMessageAsIs).toHaveBeenCalledWith('hi', 'normal');
    expect(generate).not.toHaveBeenCalled();
    expect(out?.selection.activatedMembers).toEqual([]);
    expect(
      await generateGroup(
        { group: { id: 'e', members: [] }, userInput: '', byAutoMode: false },
        { characters, chat: [] },
        { generate },
      ),
    ).toBeUndefined();
    const ac = new AbortController();
    ac.abort();
    await expect(
      generateGroup(
        { group, type: 'normal', userInput: 'x', byAutoMode: false },
        { characters, chat: [] },
        { generate, signal: ac.signal },
      ),
    ).rejects.toThrow(/AbortSignal/);
  });
  it('swipe of a deleted member propagates the error after onFinished is not needed (selection happens first)', async () => {
    // only a character missing from `characters` entirely triggers the error
    const gone: ChatMessageLike = {
      name: 'Ghost',
      is_user: false,
      mes: 'x',
      original_avatar: 'ghost.png',
    };
    const onFinished = vi.fn();
    await expect(
      generateGroup(
        { group, type: 'swipe', userInput: '', byAutoMode: false },
        { characters, chat: [gone] },
        { generate: async () => undefined, onFinished },
      ),
    ).rejects.toThrow(DeletedGroupMemberSwipedError);
    expect(onFinished).not.toHaveBeenCalled();
  });
});
