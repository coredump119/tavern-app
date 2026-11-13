/** Quick Reply sets: QuickReplies/<name>.json (v2). The legacy v1 default (quickReplySlots) is still shipped by ST. */
import { z } from 'zod';

const str = z.string();
const bool = z.boolean();

export const QuickReplySchema = z.looseObject({
  id: z.number(),
  showLabel: bool.optional(),
  label: str,
  title: str.optional(),
  message: str,
  contextList: z.array(z.looseObject({ set: str, isChained: bool.optional() })).optional(),
  preventAutoExecute: bool.optional(),
  isHidden: bool.optional(),
  executeOnStartup: bool.optional(),
  executeOnUser: bool.optional(),
  executeOnAi: bool.optional(),
  executeOnChatChange: bool.optional(),
  executeOnGroupMemberDraft: bool.optional(),
  executeOnNewChat: bool.optional(),
  executeBeforeGeneration: bool.optional(),
  automationId: str.optional(),
});

export const QuickReplySetSchema = z.looseObject({
  version: z.literal(2),
  name: str,
  disableSend: bool.optional(),
  placeBeforeInput: bool.optional(),
  injectInput: bool.optional(),
  color: str.optional(),
  onlyBorderColor: bool.optional(),
  qrList: z.array(QuickReplySchema),
  idIndex: z.number().optional(),
});

/** Pre-v2 shape (ST default/content/presets/quick-replies/Default.json). */
export const QuickReplySetV1Schema = z.looseObject({
  name: str,
  quickReplyEnabled: bool.optional(),
  numberOfSlots: z.number().optional(),
  quickReplySlots: z.array(
    z.looseObject({ mes: str, label: str, enabled: bool.optional(), hidden: bool.optional() }),
  ),
  selectedPreset: str.optional(),
});

export type QuickReply = z.infer<typeof QuickReplySchema>;
export type QuickReplySet = z.infer<typeof QuickReplySetSchema>;
export type QuickReplySetV1 = z.infer<typeof QuickReplySetV1Schema>;

export function parseQuickReplySet(raw: unknown): QuickReplySet | QuickReplySetV1 {
  const o = raw as { version?: unknown };
  return o && typeof o === 'object' && o.version === 2
    ? QuickReplySetSchema.parse(raw)
    : QuickReplySetV1Schema.parse(raw);
}

/** v1 → v2, the way ST's quick-reply extension migrates on load. */
export function upgradeQuickReplySet(set: QuickReplySetV1): QuickReplySet {
  const qrList: QuickReply[] = set.quickReplySlots.map((s, i) => ({
    id: i + 1,
    showLabel: false,
    label: s.label,
    title: '',
    message: s.mes,
    contextList: [],
    preventAutoExecute: true,
    isHidden: s.hidden ?? false,
    executeOnStartup: false,
    executeOnUser: false,
    executeOnAi: false,
    executeOnChatChange: false,
    executeOnGroupMemberDraft: false,
    automationId: '',
  }));
  return {
    version: 2,
    name: set.name,
    disableSend: false,
    placeBeforeInput: false,
    injectInput: false,
    qrList,
    idIndex: qrList.length,
  };
}
