/** groups/<id>.json — src/endpoints/groups.js create + public/scripts/group-chats.js createGroup/_save */
import { z } from 'zod';

export const GROUP_ACTIVATION_STRATEGY = { NATURAL: 0, LIST: 1, MANUAL: 2, POOLED: 3 } as const;
export const GROUP_GENERATION_MODE = { SWAP: 0, APPEND: 1, APPEND_DISABLED: 2 } as const;
export const DEFAULT_AUTO_MODE_DELAY = 5;

export const GroupSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  /** 成员头像文件名 */
  members: z.array(z.string()),
  avatar_url: z.string().nullable().optional(),
  allow_self_responses: z.boolean().optional(),
  activation_strategy: z.number().optional(),
  generation_mode: z.number().optional(),
  generation_mode_join_prefix: z.string().optional(),
  generation_mode_join_suffix: z.string().optional(),
  disabled_members: z.array(z.string()).optional(),
  hideMutedSprites: z.boolean().optional(),
  fav: z.union([z.boolean(), z.string()]).optional(),
  chat_id: z.string().optional(),
  chats: z.array(z.string()).optional(),
  auto_mode_delay: z.number().optional(),
  chat_metadata: z.record(z.string(), z.unknown()).optional(),
  past_metadata: z.record(z.string(), z.unknown()).optional(),
  date_added: z.number().optional(),
  date_last_chat: z.number().optional(),
});
export type Group = z.infer<typeof GroupSchema>;

export function parseGroup(raw: unknown): Group {
  return GroupSchema.parse(raw);
}
