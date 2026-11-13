/**
 * Character card (the JSON inside a card PNG, V2 / V3 with ST's flattened V1 mirror) ⇄ the
 * `Character` shape of the TavernHelper script API. Pure data in, pure data out: no DOM, no I/O.
 */
import { readExtensions, writeExtensions, type TavernRegex } from './preset.js';

export interface Character {
  /** the card's file name; a script may hand a `Blob` when creating, which the app does not take */
  avatar: string;
  version: string;
  creator: string;
  creator_notes: string;
  /** the linked World Info file, `null` when none */
  worldbook: string | null;
  description: string;
  /** `first_mes` followed by the alternate greetings */
  first_messages: string[];
  extensions: {
    regex_scripts: TavernRegex[];
    tavern_helper: { scripts: Record<string, unknown>[]; variables: Record<string, unknown> };
    [other: string]: unknown;
  };
}

type Dict = Record<string, unknown>;
const isRecord = (v: unknown): v is Dict =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const record = (v: unknown): Dict => (isRecord(v) ? v : {});
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

/** The V2 `data` block; a bare V1 card is its own data */
const dataOf = (card: Dict): Dict => (isRecord(card['data']) ? card['data'] : card);

/** `data.name`, else the V1 name, else the file name without `.png` */
export function characterName(card: unknown, avatar = ''): string {
  const raw = record(card);
  return text(dataOf(raw)['name']) || text(raw['name']) || avatar.replace(/\.png$/i, '');
}

/** Stored card → `Character`. The result shares nothing with `card`. */
export function toCharacter(card: unknown, avatar: string): Character {
  const data = dataOf(record(card));
  const world = text(record(data['extensions'])['world']);
  return {
    avatar,
    version: text(data['character_version']),
    creator: text(data['creator']),
    creator_notes: text(data['creator_notes']) || text(record(card)['creatorcomment']),
    worldbook: world || null,
    description: text(data['description']),
    first_messages: [text(data['first_mes']), ...strings(data['alternate_greetings'])],
    extensions: readExtensions(data['extensions']) as Character['extensions'],
  };
}

/**
 * `Character` (or a part of one) over a stored card → the card to store. Fields the script did not
 * give keep their stored value; everything `Character` does not model (personality, scenario,
 * examples, tags, the embedded lorebook, …) is carried over. `name` is written when given.
 */
export function fromCharacter(character: unknown, previous?: unknown, name?: string): Dict {
  const input = record(character);
  const card: Dict = structuredClone(record(previous));
  const stored = isRecord(card['data']) ? card['data'] : {};
  const data: Dict = { ...stored };
  card['data'] = data;
  card['spec'] ??= 'chara_card_v2';
  card['spec_version'] ??= '2.0';

  // ST keeps a V1 copy of these beside `data`
  const mirror = (key: string, value: string, v1Key = key) => {
    data[key] = value;
    card[v1Key] = value;
  };
  if (name !== undefined) mirror('name', name);
  else if (!text(data['name'])) mirror('name', text(card['name']));
  if (typeof input['description'] === 'string') mirror('description', input['description']);
  if (typeof input['creator_notes'] === 'string')
    mirror('creator_notes', input['creator_notes'], 'creatorcomment');
  if (typeof input['version'] === 'string') data['character_version'] = input['version'];
  if (typeof input['creator'] === 'string') data['creator'] = input['creator'];
  if (Array.isArray(input['first_messages'])) {
    const [first = '', ...rest] = strings(input['first_messages']);
    mirror('first_mes', first);
    data['alternate_greetings'] = rest;
  }

  const before = record(stored['extensions']);
  const extensions: Dict = isRecord(input['extensions'])
    ? { ...before, ...writeExtensions(input['extensions'], before) }
    : { ...before };
  if ('worldbook' in input) {
    const world = text(input['worldbook']);
    if (world) extensions['world'] = world;
    else delete extensions['world'];
  }
  data['extensions'] = extensions;
  for (const key of ['description', 'personality', 'scenario', 'first_mes', 'mes_example']) {
    data[key] = text(data[key]) || text(card[key]);
  }
  return card;
}
