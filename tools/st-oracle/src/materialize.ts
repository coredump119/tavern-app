/** 把场景写成 ST data 目录里的文件，并返回两边共用的合并后对象。 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeCardJson } from '@tm/formats';
import { getStringHash } from '@tm/core';
import {
  ORACLE_CHAT_NAME,
  ORACLE_OAI_DEFAULTS,
  ORACLE_PROXY_PASSWORD,
  ORACLE_USER_AVATAR,
  avatarFor,
  wiBook,
  type Scenario,
  type ScenarioMessage,
} from './scenario.js';

export interface Materialized {
  scenario: Scenario;
  avatar: string;
  chatName: string;
  /** ST V2 角色卡 JSON（含顶层镜像字段） */
  card: Record<string, unknown>;
  /** 写进 jsonl 的消息（header 之外） */
  messages: ScenarioMessage[];
  chatMetadata: Record<string, unknown>;
  worlds: Record<string, { entries: Record<string, Record<string, unknown>> }>;
  /** 完整 settings.json */
  settings: Record<string, unknown>;
  userName: string;
}

const CREATE_DATE = '2026-01-01@00h00m00s';
const SEND_DATE = '2026-01-01T00:00:00.000Z';

export function buildCard(sc: Scenario, avatar: string): Record<string, unknown> {
  const c = sc.character;
  const data = {
    name: c.name,
    description: c.description ?? '',
    personality: c.personality ?? '',
    scenario: c.scenario ?? '',
    first_mes: c.first_mes ?? '',
    mes_example: c.mes_example ?? '',
    creator_notes: c.creator_notes ?? '',
    system_prompt: c.system_prompt ?? '',
    post_history_instructions: c.post_history_instructions ?? '',
    tags: c.tags ?? [],
    creator: '',
    character_version: '',
    alternate_greetings: c.alternate_greetings ?? [],
    extensions: {
      talkativeness: c.talkativeness ?? 0.5,
      fav: false,
      world: c.world ?? '',
      depth_prompt: c.depth_prompt ?? { prompt: '', depth: 4, role: 'system' },
    },
    group_only_greetings: [],
  };
  return {
    name: data.name,
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
    creatorcomment: data.creator_notes,
    avatar: 'none',
    chat: ORACLE_CHAT_NAME,
    talkativeness: data.extensions.talkativeness,
    fav: false,
    tags: data.tags,
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data,
    create_date: CREATE_DATE,
    // ST 前端 characters[] 里的 avatar 由服务端按文件名注入；回放侧直接带上
    _avatar: avatar,
  };
}

export function buildMessages(sc: Scenario, userName: string): ScenarioMessage[] {
  return sc.chat.map((m) => ({
    name: m.name ?? (m.is_user ? userName : sc.character.name),
    is_user: !!m.is_user,
    is_system: !!m.is_system,
    send_date: m.send_date ?? SEND_DATE,
    mes: m.mes,
    extra: m.extra ?? {},
    ...(m.swipes ? { swipes: m.swipes, swipe_id: m.swipe_id ?? 0 } : {}),
    ...Object.fromEntries(
      Object.entries(m).filter(
        ([k]) =>
          ![
            'name',
            'is_user',
            'is_system',
            'send_date',
            'mes',
            'extra',
            'swipes',
            'swipe_id',
          ].includes(k),
      ),
    ),
  }));
}

function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    const b = out[k];
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      b &&
      typeof b === 'object' &&
      !Array.isArray(b)
    ) {
      out[k] = deepMerge(b as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface MaterializeOptions {
  stDir: string;
  dataRoot: string;
  /** mock 后端的 /v1 地址 */
  proxyUrl: string;
  /** 只构造对象，不写文件 */
  dryRun?: boolean;
}

export function materialize(sc: Scenario, opts: MaterializeOptions): Materialized {
  const userDir = join(opts.dataRoot, 'default-user');
  const userName = sc.userName ?? 'User';
  const avatar = avatarFor(sc);
  const card = buildCard(sc, avatar);
  const messages = buildMessages(sc, userName);
  const chatMetadata: Record<string, unknown> = { integrity: 'oracle', ...(sc.chatMetadata ?? {}) };
  const worlds = Object.fromEntries(
    Object.entries(sc.worlds ?? {}).map(([n, e]) => [n, wiBook(e)]),
  );

  const base = JSON.parse(
    readFileSync(join(opts.stDir, 'default', 'content', 'settings.json'), 'utf8'),
  ) as Record<string, unknown>;
  const basePU = base['power_user'] as Record<string, unknown>;
  const baseOai = base['oai_settings'] as Record<string, unknown>;
  const baseWI = base['world_info_settings'] as Record<string, unknown>;
  const baseExt = base['extension_settings'] as Record<string, unknown>;

  const persona = sc.powerUser?.['persona_description'];
  const personaPos = sc.powerUser?.['persona_description_position'];
  const settings: Record<string, unknown> = {
    ...base,
    firstRun: false,
    username: userName,
    user_avatar: ORACLE_USER_AVATAR,
    main_api: 'openai',
    active_character: avatar,
    active_group: null,
    power_user: {
      ...basePU,
      auto_load_chat: true,
      auto_connect: true,
      personas: { [ORACLE_USER_AVATAR]: userName },
      default_persona: ORACLE_USER_AVATAR,
      persona_descriptions:
        persona !== undefined
          ? {
              [ORACLE_USER_AVATAR]: {
                description: persona,
                position: personaPos ?? 0,
                depth: sc.powerUser?.['persona_description_depth'] ?? 2,
                role: sc.powerUser?.['persona_description_role'] ?? 0,
                lorebook: '',
              },
            }
          : {},
      ...(sc.powerUser ?? {}),
    },
    oai_settings: {
      ...baseOai,
      ...ORACLE_OAI_DEFAULTS,
      ...(sc.oai ?? {}),
      reverse_proxy: opts.proxyUrl,
      proxy_password: ORACLE_PROXY_PASSWORD,
    },
    // ST 1.18 的代理预设在顶层：loadProxyPresets(settings) 会用 selected_proxy 覆盖 oai_settings.reverse_proxy / proxy_password
    proxies: [
      { name: 'None', url: '', password: '' },
      { name: 'oracle', url: opts.proxyUrl, password: ORACLE_PROXY_PASSWORD },
    ],
    selected_proxy: { name: 'oracle', url: opts.proxyUrl, password: ORACLE_PROXY_PASSWORD },
    world_info_settings: {
      ...baseWI,
      ...(sc.worldInfoSettings ?? {}),
      world_info: { globalSelect: sc.globalBooks ?? [] },
    },
    extension_settings: deepMerge(baseExt, {
      note: {
        default: '',
        chara: [],
        wiAddition: [],
        ...(sc.note ?? {}),
        ...(Array.isArray(sc.note?.['chara'])
          ? {
              chara: (sc.note['chara'] as Array<Record<string, unknown>>).map((c) => ({
                ...c,
                name: c['name'] === '{{avatar}}' ? avatar.replace(/\.png$/, '') : c['name'],
              })),
            }
          : {}),
      },
      ...(sc.regex ? { regex: sc.regex } : {}),
    }),
    accountStorage: {
      [`Proxy_SkipConfirm_${getStringHash(opts.proxyUrl)}`]: 'true',
      slash_command_experimental_engine_warning_shown: 'true',
    },
  };

  const m: Materialized = {
    scenario: sc,
    avatar,
    chatName: ORACLE_CHAT_NAME,
    card,
    messages,
    chatMetadata,
    worlds,
    settings,
    userName,
  };
  if (opts.dryRun) return m;

  // 清掉上一场景的角色 / 聊天 / 世界书，保证 ST 只看到当前场景
  for (const sub of ['characters', 'chats', 'worlds']) {
    const dir = join(userDir, sub);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  const basePng = readFileSync(join(opts.stDir, 'default', 'content', 'default_Seraphina.png'));
  const { _avatar: _ignored, ...cardOnDisk } = card;
  void _ignored;
  writeFileSync(
    join(userDir, 'characters', avatar),
    writeCardJson(new Uint8Array(basePng), JSON.stringify(cardOnDisk)),
  );
  const chatDir = join(userDir, 'chats', avatar.replace(/\.png$/, ''));
  mkdirSync(chatDir, { recursive: true });
  const header = {
    user_name: userName,
    character_name: sc.character.name,
    create_date: CREATE_DATE,
    chat_metadata: chatMetadata,
  };
  writeFileSync(
    join(chatDir, `${ORACLE_CHAT_NAME}.jsonl`),
    [header, ...messages].map((x) => JSON.stringify(x)).join('\n'),
  );
  for (const [name, book] of Object.entries(worlds)) {
    writeFileSync(join(userDir, 'worlds', `${name}.json`), JSON.stringify(book, null, 4));
  }
  writeFileSync(join(userDir, 'settings.json'), JSON.stringify(settings, null, 4));
  return m;
}
