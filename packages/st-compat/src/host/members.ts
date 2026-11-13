/**
 * `getContext()` members that are logic over a small port of the app (DEV_NOTES §9.34 第 7 轮),
 * and the summary shown once an extension is installed.
 */
import { variableOps, type VariableHost, type VariableKind } from '../slash/commands.js';
import type { ExtensionManifest } from './manifest.js';

/** ST `getContext().variables`: `local` is the open chat's, `global` is `extension_settings`'s */
export function createVariablesMember(host: VariableHost) {
  const ops = variableOps(host);
  const scope = (kind: VariableKind) => ({
    get: (name: string, args: { key?: string; index?: unknown } = {}) =>
      ops.getVariable(kind, args.key ?? name, args.index),
    set: (name: string, value: unknown, args: { index?: unknown; as?: unknown } = {}) => {
      if (!name) throw new Error('Variable name cannot be empty or undefined.');
      return ops.setVariable(kind, name, value, args);
    },
    del: (name: string): string => {
      host.delete(kind, name);
      return '';
    },
    add: (name: string, value: unknown) => ops.addVariable(kind, name, value),
    inc: (name: string) => ops.addVariable(kind, name, 1),
    dec: (name: string) => ops.addVariable(kind, name, -1),
    has: (name: string): boolean => host.get(kind, name) !== undefined,
  });
  return { local: scope('local'), global: scope('global') };
}

/** ST `SWIPE_SOURCE` values that skip the "may this message be swiped right now" checks */
const SWIPE_BYPASS: ReadonlySet<unknown> = new Set([
  'delete',
  'back',
  'auto_swipe',
  'slash_command',
  'swipe_picker',
]);

interface SwipeMessage {
  is_user?: boolean;
  is_system?: boolean;
  swipe_id?: number;
  swipes?: unknown[];
  extra?: { isSmallSys?: boolean; swipeable?: boolean; overswipe_behavior?: unknown };
}

export interface SwipeOptions {
  source?: unknown;
  message?: unknown;
  forceMesId?: unknown;
  forceSwipeId?: unknown;
}

/** Where a swipe lands: a stored swipe of a message, or one more generated for the last message. */
export type SwipeTarget = { index: number; swipeId: number } | { index: number; regenerate: true };

/** ST `isMessageSwipeable()` */
function isSwipeable(chat: readonly unknown[], index: number): boolean {
  const message = chat[index] as SwipeMessage;
  return (
    index === chat.length - 1 &&
    !message.is_user &&
    !message.extra?.isSmallSys &&
    message.extra?.swipeable !== false
  );
}

/** ST `getOverswipeBehavior()`, folded to what a swipe past the last one does */
function overswipe(
  message: SwipeMessage,
  index: number,
  pristine: boolean,
): 'none' | 'loop' | 'regenerate' {
  const own = message.extra?.overswipe_behavior;
  if (typeof own === 'string') {
    if (own === 'none') return 'none';
    return own === 'loop' || own === 'pristine_greeting' ? 'loop' : 'regenerate';
  }
  if (message.extra?.swipeable === false || message.extra?.isSmallSys) return 'none';
  if (index === 0 && pristine) return 'loop';
  return !message.is_user && !message.is_system ? 'regenerate' : 'loop';
}

/**
 * ST `swipe()` up to the point where it touches the chat: which message and which of its swipes
 * (DEV_NOTES §9.34 第 8 轮). `null` when ST would leave everything as it is.
 */
export function resolveSwipe(
  chat: readonly unknown[],
  direction: unknown,
  options: SwipeOptions,
  env: { hidden: boolean; pristine: boolean },
): SwipeTarget | null {
  const { source, message, forceMesId, forceSwipeId } = options;
  if (chat.length === 0) return null;
  const forced = typeof forceMesId === 'number';
  const found = message == null ? chat.length - 1 : chat.indexOf(message);
  if (found < 0 && !forced) return null;
  const index = forced ? forceMesId : found;
  const target = chat[index] as SwipeMessage | undefined;
  if (typeof target !== 'object' || target === null) return null;
  if (!SWIPE_BYPASS.has(source) && (env.hidden || !isSwipeable(chat, index))) return null;

  const count = Array.isArray(target.swipes) && target.swipes.length > 0 ? target.swipes.length : 1;
  const original = Number(target.swipe_id ?? 0);
  const stepped = typeof forceSwipeId !== 'number';
  let next = stepped ? original : forceSwipeId;
  if (source === 'delete' || source === 'back') {
    next = Math.min(Math.max(next, 0), count - 1);
  } else if (direction === 'left') {
    if (stepped) next--;
    if (next < 0 || next > count - 1) next = count - 1;
  } else if (direction === 'right') {
    if (stepped) next++;
    if (next < 0) next = 0;
    else if (next >= count) {
      const behavior = overswipe(target, index, env.pristine);
      if (behavior === 'none') return null;
      if (behavior === 'regenerate') {
        return index === chat.length - 1 ? { index, regenerate: true } : null;
      }
      next = 0;
    }
  } else {
    return null;
  }
  return next === original ? null : { index, swipeId: next };
}

/** What `swipe` needs from the chat page; every method is safe to call while the page is away. */
export interface SwipePage {
  /** the open chat, oldest first */
  chat(): readonly unknown[];
  /** a reply is being generated, or the chat page is not open */
  busy(): boolean;
  /** ST `!chat_metadata.tainted` */
  pristine(): boolean;
  /** show swipe `swipeId` of message `index` */
  load(index: number, swipeId: number): Promise<void>;
  /** ST `Generate('swipe')`: one more swipe for the last message */
  regenerate(): Promise<void>;
  /** ST `body.hideAllSwipeButtons` */
  setHidden(hidden: boolean): void;
}

/** ST `getContext().swipe` (script.js `swipe()`, DEV_NOTES §9.34 第 8 轮) */
export function createSwipeMember(page: SwipePage) {
  let hidden = false;
  let swiping = false;
  const isAllowed = (): boolean => page.chat().length > 0 && !hidden && !page.busy();
  const to = async (_event: unknown, direction: unknown, options?: SwipeOptions): Promise<void> => {
    if (swiping || page.busy()) return;
    const target = resolveSwipe(page.chat(), direction, options ?? {}, {
      hidden,
      pristine: page.pristine(),
    });
    if (!target) return;
    swiping = true;
    try {
      if ('regenerate' in target) await page.regenerate();
      else await page.load(target.index, target.swipeId);
    } finally {
      swiping = false;
    }
  };
  const refresh = (): void => page.setHidden(hidden);
  const setHidden = (value: boolean) => (): void => {
    hidden = value;
    refresh();
  };
  return {
    left: (event?: unknown, options?: SwipeOptions) => to(event, 'left', options),
    right: (event?: unknown, options?: SwipeOptions) => to(event, 'right', options),
    to,
    show: setHidden(false),
    hide: setHidden(true),
    refresh,
    isAllowed,
    state: (): 'none' | 'swiping' => (swiping ? 'swiping' : 'none'),
  };
}

/** ST `shouldSendOnEnter()`: `send_on_enter` AUTO (0) means "not on mobile", and this is mobile */
export const shouldSendOnEnter = (powerUser: Record<string, unknown> | undefined): boolean =>
  Number(powerUser?.['send_on_enter']) === 1;

/** host-module exports that tell what an extension is going to do, by summary line */
const IMPORT_HINTS: ReadonlyArray<[line: string, names: readonly string[]]> = [
  [
    '会自己发起生成（用你的连接和额度）',
    ['generateRaw', 'generateQuietPrompt', 'Generate', 'sendGenerationRequest', 'generateRawData'],
  ],
  ['会改写发给模型的提示词', ['setExtensionPrompt', 'extension_prompts']],
  [
    '会读写世界书',
    ['loadWorldInfo', 'saveWorldInfo', 'createWorldInfoEntry', 'checkWorldInfo', 'world_names'],
  ],
  [
    '会注册 slash 命令或宏',
    ['SlashCommandParser', 'registerSlashCommand', 'MacrosParser', 'macros'],
  ],
  ['会读写聊天记录', ['chat', 'saveChat', 'saveChatConditional', 'saveChatDebounced']],
];

/**
 * What to tell the user about a freshly installed extension, from its manifest and the host-module
 * names it imports. A hint, not a sandbox: the last line says so.
 */
export function permissionSummary(
  manifest: ExtensionManifest | null | undefined,
  imports: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const lines: string[] = [];
  const files = [manifest?.js, manifest?.css].filter((file) => typeof file === 'string' && file);
  lines.push(files.length > 0 ? `文件：${files.join('、')}` : '没有脚本也没有样式（装了不起作用）');
  if (typeof manifest?.generate_interceptor === 'string' && manifest.generate_interceptor)
    lines.push('有生成拦截器：每次生成前能改要发出去的消息，也能拦下这次生成');
  const used = new Set(Object.values(imports).flat());
  for (const [line, names] of IMPORT_HINTS)
    if (names.some((name) => used.has(name))) lines.push(line);
  lines.push('它的代码以应用的全部权限运行：没列在上面的事它也做得到');
  return lines;
}
