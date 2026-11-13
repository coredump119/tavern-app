/**
 * Script-driven generation: TavernHelper `generate` / `generateRaw`, and the `/gen` / `/genraw`
 * slash commands (DEV_NOTES §9.5). Runs beside the chat page: nothing is saved to the chat, and the
 * reply goes back to the caller only.
 */
import {
  CHAT_COMPLETION_SOURCES,
  EXTENSION_PROMPT_ROLES,
  EXTENSION_PROMPT_TYPES,
  applyChatCompletionPreset,
  applyTextgenPreset,
  loadOaiSettings,
  loadProxyPresets,
  loadTextgenSettings,
  normalizeChatModels,
  setExtensionPrompt,
  urlJoin,
  type ExtensionPrompts,
  type InlineMediaDeps,
  type ResolvedMedia,
  type WIActivated,
} from '@tm/core';
import type { ChatMessage } from '@tm/formats';
import type { GenerateEvents, GenerateKind } from '@tm/tavern-helper';
import { mainApiOf, tokenBudgetOf } from '../chat/core-state';
import { generationHooks } from '../chat/hooks';
import { inlineMediaDeps } from '../chat/media';
import {
  prepareGeneration,
  scanWorldInfo,
  RAW_BUILTIN_PROMPTS,
  type PipelineInput,
  type WorldInfoScanRequest,
  type RawBuiltinPrompt,
  type RawPromptPlan,
  type RawRolePrompt,
} from '../chat/pipeline';
import { plainChat } from '../chat/plain.svelte';
import { chatStore, messageTimeStamp } from '../chat/store.svelte';
import { runGeneration, type GenerationHandle } from '../generation';
import { netFetch, netUrlPolicy } from '../ipc';
import { oaiRuntime, readCcPreset, readJson, TC_PRESET_DIR } from '../oai.svelte';
import { askPopup } from '../popup.svelte';
import {
  applyCustomApi,
  confirmRequest,
  parseCustomApi,
  routeRequest,
  scriptAddress,
  type CustomApi,
  type CustomTarget,
} from './custom-api';
import { scriptInjects } from './injects.svelte';
import { applyMacroLikes } from './macro-like';

type Config = Record<string, unknown>;
type Settings = Record<string, unknown>;

/** overrides that are dropped with a warning */
const IGNORED_OVERRIDES = ['world_info_before', 'world_info_after'] as const;
const CARD_OVERRIDES = {
  char_description: 'description',
  char_personality: 'personality',
  scenario: 'scenario',
  dialogue_examples: 'mes_example',
} as const;
const ROLES = {
  system: EXTENSION_PROMPT_ROLES.SYSTEM,
  user: EXTENSION_PROMPT_ROLES.USER,
  assistant: EXTENSION_PROMPT_ROLES.ASSISTANT,
} as const;
/** these take an image as base64 only; the WebView may not fetch a remote one to convert it */
const BASE64_IMAGE_SOURCES: readonly string[] = [
  CHAT_COMPLETION_SOURCES.CLAUDE,
  CHAT_COMPLETION_SOURCES.MAKERSUITE,
  CHAT_COMPLETION_SOURCES.VERTEXAI,
];

/** One generation, ready to prepare and send */
interface Job {
  input: PipelineInput;
  api: CustomApi | null;
  target: CustomTarget;
  /** carries the injections of the open chat: they are spent once the request is out */
  injects: boolean;
}

interface Reply {
  text: string;
  reasoning: string;
  toolCalls: unknown[];
}

const running = new Map<string, GenerationHandle>();
/** generations a script did not ask to keep silent: the chat page offers to stop them */
export const scriptRuns = $state<{ visible: string[] }>({ visible: [] });

/** addresses the user let scripts send prompts to; forgotten when the app quits */
const allowed = new Set<string>();
/** one dialog per address, however many scripts ask at once */
const asking = new Map<string, Promise<boolean>>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isRole = (value: unknown): value is RawRolePrompt['role'] =>
  value === 'system' || value === 'user' || value === 'assistant';

function rolePrompts(value: unknown): RawRolePrompt[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter((p) => isRole(p['role']))
    .map((p) => ({
      role: p['role'] as RawRolePrompt['role'],
      content: String(p['content'] ?? ''),
    }));
}

function temporaryMessage(
  prompt: RawRolePrompt,
  userName: string,
  charName: string,
  images: readonly string[] = [],
): ChatMessage {
  const isUser = prompt.role === 'user';
  return {
    name: isUser ? userName : prompt.role === 'assistant' ? charName : 'System',
    is_user: isUser,
    is_system: false,
    send_date: messageTimeStamp(),
    mes: prompt.content,
    // the pipeline inlines these the way it inlines chat attachments (DEV_NOTES §9.30)
    extra: images.length > 0 ? { media: images.map((url) => ({ url, type: 'image' })) } : {},
  } as ChatMessage;
}

function rawPlan(config: Config, hasUserInput: boolean): RawPromptPlan {
  const given = Array.isArray(config['ordered_prompts']) ? config['ordered_prompts'] : null;
  const order: (RawBuiltinPrompt | RawRolePrompt)[] = [];
  for (const item of given ?? RAW_BUILTIN_PROMPTS) {
    if (typeof item === 'string') {
      if ((RAW_BUILTIN_PROMPTS as readonly string[]).includes(item)) {
        order.push(item as RawBuiltinPrompt);
      }
    } else {
      order.push(...rolePrompts([item]));
    }
  }
  return { order, hasUserInput };
}

/** The one-off `injects` of this call, plus (for `generate`) what scripts injected into the open chat */
function injectPrompts(value: unknown, withChatInjects: boolean): ExtensionPrompts | undefined {
  const prompts: ExtensionPrompts = {};
  const own = Array.isArray(value) ? value.filter(isRecord) : [];
  own.forEach((inject, i) => {
    const inChat = inject['position'] === 'in_chat';
    setExtensionPrompt(
      prompts,
      `TH-inject-${i}`,
      String(inject['content'] ?? ''),
      inChat ? EXTENSION_PROMPT_TYPES.IN_CHAT : EXTENSION_PROMPT_TYPES.NONE,
      Number(inject['depth'] ?? 0) || 0,
      inject['should_scan'] === true,
      isRole(inject['role']) ? ROLES[inject['role']] : ROLES.system,
    );
  });
  if (withChatInjects) {
    // extensions first: a script inject under the same key wins (DEV_NOTES §9.34)
    Object.assign(prompts, generationHooks.prompts?.());
    scriptInjects.addTo(prompts);
  }
  return Object.keys(prompts).length > 0 ? prompts : undefined;
}

/** What scripts injected into the open chat, for a generation the user started */
export function chatInjectPrompts(): ExtensionPrompts | undefined {
  return injectPrompts(undefined, true);
}

/** One-shot injections are spent by a generation that really went out, not by one that failed to start */
export function spendInjectsWhenSent(handle: GenerationHandle): void {
  void handle.id.then(
    () => scriptInjects.spend(),
    () => undefined,
  );
}

/**
 * The first time a script (or an extension, DEV_NOTES §9.34 第 6 轮) names an address, the user
 * decides whether prompts may go there; the answer holds for that exact address until the app quits.
 * `field` names the offending input in error messages.
 */
export async function confirmAddress(
  apiurl: string,
  from: string,
  field?: string,
): Promise<{ address: string; insecure: boolean }> {
  const address = scriptAddress(apiurl, field);
  const policy = await netUrlPolicy(address);
  if (!policy.ok && !policy.needs_confirm)
    throw new Error(policy.error ?? `不能向 ${address} 发送请求`);
  const insecure = policy.needs_confirm;
  if (allowed.has(address)) return { address, insecure };
  let answer = asking.get(address);
  if (!answer) {
    answer = askPopup({ kind: 'confirm', ...confirmRequest(from, address, insecure) })
      .then((result) => result === true)
      .finally(() => asking.delete(address));
    asking.set(address, answer);
  }
  if (!(await answer)) throw new Error(`用户拒绝了向 ${address} 发送提示词`);
  allowed.add(address);
  return { address, insecure };
}

async function resolveTarget(
  settings: Settings,
  api: CustomApi | null,
  from: string,
): Promise<CustomTarget> {
  if (!api) return { kind: 'own' };
  if (api.proxyPreset) {
    // the user saved this address and its password themselves: nothing to ask
    const preset = loadProxyPresets(settings).proxies.find(
      (p) => p.name === api.proxyPreset && p.url,
    );
    if (preset) return { kind: 'preset', name: preset.name, url: preset.url };
    if (!api.apiurl) throw new Error(`没有名为「${api.proxyPreset}」的代理预设`);
  }
  if (!api.apiurl) return { kind: 'own' };
  const { address, insecure } = await confirmAddress(api.apiurl, from);
  return { kind: 'address', url: address, key: api.key, insecure };
}

/** `preset_name`: the merge the Presets page does, onto the settings of this one generation */
async function applyPreset(root: string, settings: Settings, name: string): Promise<void> {
  const missing = new Error(`没有名为「${name}」的预设`);
  if (/[\\/]|^\.+$/.test(name)) throw missing;
  if (mainApiOf(settings) === 'openai') {
    const body = await readCcPreset(root, name).catch(() => null);
    if (!body) throw missing;
    settings['oai_settings'] = applyChatCompletionPreset(
      loadOaiSettings(settings['oai_settings']),
      body,
      name,
    );
    return;
  }
  const body = await readJson(root, TC_PRESET_DIR, name).catch(() => null);
  if (!body) throw missing;
  const textgen = loadTextgenSettings(settings);
  const budget = tokenBudgetOf(settings);
  const applied = applyTextgenPreset(textgen, body, name, {
    amountGen: budget.maxResponse,
    maxContext: budget.maxContext,
  });
  settings['textgenerationwebui_settings'] = textgen;
  if (applied.amountGen !== undefined) settings['amount_gen'] = applied.amountGen;
  if (applied.maxContext !== undefined) settings['max_context'] = applied.maxContext;
  if (isRecord(settings['power_user']))
    settings['power_user']['max_context_unlocked'] = applied.maxContextUnlocked;
}

function imageUrls(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => {
    if (typeof item !== 'string' || !/^(data:image\/|https?:\/\/)/i.test(item))
      throw new Error('image 只接受图片的 data URL 或 http(s) 地址');
    return item;
  });
}

/**
 * Read every image before the prompt is built. The pipeline skips an attachment it cannot read;
 * for an image a script passed on purpose that would be a silent wrong answer.
 */
async function withImages(
  urls: readonly string[],
  inline: InlineMediaDeps | undefined,
  source: string,
): Promise<InlineMediaDeps> {
  if (!inline?.image) throw new Error('当前的 API 或模型不支持图片输入，无法发送 image');
  const ready = new Map<string, ResolvedMedia>();
  for (const url of urls) {
    if (url.startsWith('data:')) {
      const resolved = await inline.resolve(url, 'image');
      if (!resolved) throw new Error('image 无法读取：不是有效的图片');
      ready.set(url, resolved);
    } else if (BASE64_IMAGE_SOURCES.includes(source)) {
      throw new Error('这个 API 的图片只能用 data URL，不能用 http(s) 地址');
    } else {
      // OpenAI-compatible bodies take the address as it is; the provider fetches it
      ready.set(url, { dataUrl: url });
    }
  }
  return {
    ...inline,
    resolve: (url, kind) => {
      const hit = kind === 'image' ? ready.get(url) : undefined;
      return hit ? Promise.resolve(hit) : inline.resolve(url, kind);
    },
  };
}

function toolFields(config: Config): Pick<PipelineInput, 'tools' | 'toolChoice' | 'jsonSchema'> {
  const tools = config['tools'];
  const choice = config['tool_choice'];
  const schema = config['json_schema'];
  if (tools !== undefined && !Array.isArray(tools)) throw new Error('tools 必须是数组');
  if (choice !== undefined && typeof choice !== 'string' && !isRecord(choice))
    throw new Error('tool_choice 必须是字符串或对象');
  if (schema !== undefined && !(isRecord(schema) && typeof schema['name'] === 'string'))
    throw new Error('json_schema 必须是带 name 和 value 的对象');
  if (tools?.length && schema) throw new Error('tools 和 json_schema 不能同时使用');
  return {
    tools: tools?.length ? (tools as unknown[]) : undefined,
    toolChoice: choice,
    jsonSchema: schema,
  };
}

async function buildJob(
  kind: GenerateKind,
  config: Config,
  from: string,
  quietPrompt?: string,
): Promise<Job> {
  const base = plainChat.settings;
  const root = chatStore.root;
  if (!base || !root || !chatStore.open) throw new Error('没有打开的聊天');
  const tools = toolFields(config);
  const images = imageUrls(config['image']);
  const api = parseCustomApi(config['custom_api']);

  // everything below changes a copy: a script never alters what the user has set
  const settings = structuredClone(base);
  const target = await resolveTarget(settings, api, from);
  if (target.kind !== 'own') settings['main_api'] = 'openai';
  const preset = config['preset_name'];
  if (typeof preset === 'string' && preset !== 'in_use') await applyPreset(root, settings, preset);
  if (api) applyCustomApi(settings, api, target);
  // the script decides whether this request streams, whatever the chat page is set to
  const stream = config['should_stream'] === true;
  const oai = settings['oai_settings'];
  if (isRecord(oai)) oai['stream_openai'] = stream;
  const textgen = settings['textgenerationwebui_settings'];
  if (isRecord(textgen)) textgen['streaming'] = stream;

  const overrides = isRecord(config['overrides']) ? config['overrides'] : {};
  for (const key of IGNORED_OVERRIDES) {
    if (overrides[key] !== undefined)
      console.warn(`[TavernHelper] overrides.${key} 尚未支持，已忽略`);
  }
  if (typeof overrides['persona_description'] === 'string' && isRecord(settings['power_user'])) {
    settings['power_user']['persona_description'] = overrides['persona_description'];
  }
  const card = (source: typeof plainChat.character) => {
    if (!source) return source;
    const next = { ...source } as Record<string, unknown>;
    for (const [key, field] of Object.entries(CARD_OVERRIDES)) {
      if (typeof overrides[key] === 'string') next[field] = overrides[key];
    }
    return next as typeof source;
  };
  const group = plainChat.group;
  const members = plainChat.members;
  const character = card(plainChat.character);
  const speaker = group ? members[0] : character;
  const charName = String((speaker as { name?: unknown } | null | undefined)?.name ?? '');

  let chat: ChatMessage[] = chatStore.messages.slice();
  const history = isRecord(overrides['chat_history']) ? overrides['chat_history'] : null;
  if (history) {
    for (const key of ['with_depth_entries', 'author_note']) {
      if (history[key] !== undefined) {
        console.warn(`[TavernHelper] overrides.chat_history.${key} 尚未支持，已忽略`);
      }
    }
    if (Array.isArray(history['prompts'])) {
      chat = rolePrompts(history['prompts']).map((p) =>
        temporaryMessage(p, chatStore.userName, charName),
      );
    }
  }
  const max = config['max_chat_history'];
  if (typeof max === 'number' && max >= 0) chat = max === 0 ? [] : chat.slice(-Math.floor(max));

  // user_input (and its images) rides along as a one-time user message; it is never saved
  const userInput = typeof config['user_input'] === 'string' ? config['user_input'] : '';
  const hasUserInput = userInput !== '' || images.length > 0;
  if (hasUserInput) {
    const prompt: RawRolePrompt = { role: 'user', content: userInput };
    chat.push(temporaryMessage(prompt, chatStore.userName, charName, images));
  }

  const source = String(isRecord(oai) ? (oai['chat_completion_source'] ?? '') : '');
  const inline = inlineMediaDeps(
    root,
    settings,
    oaiRuntime.source === source ? $state.snapshot(oaiRuntime.models) : null,
  );
  // generateRaw sends only the parts the script listed, so what was injected into the chat stays out
  const injects = kind !== 'raw';
  const input = {
    root,
    settings,
    subject: group
      ? { character: null, group, members, memberIndex: 0 }
      : { character, group: null, members: [], memberIndex: null },
    userName: chatStore.userName,
    chat,
    chatMetadata: structuredClone(plainChat.chatMetadata),
    type: quietPrompt === undefined ? 'normal' : 'quiet',
    textareaText: '',
    quietPrompt,
    extensionPrompts: injectPrompts(config['injects'], injects),
    raw: kind === 'raw' ? rawPlan(config, hasUserInput) : undefined,
    inlineMedia: images.length > 0 ? await withImages(images, inline, source) : inline,
    ...tools,
  } as PipelineInput;
  return { input, api, target, injects };
}

async function run(
  job: Job,
  id: string,
  onText?: (full: string, delta: string) => void,
): Promise<Reply> {
  const prep = await prepareGeneration(job.input);
  const { request, secret } = job.api ? routeRequest(prep, job.api, job.target) : prep;
  await applyMacroLikes(request);
  // the backend reports the whole text so far: hand scripts one update per frame, with the new part
  let sent = '';
  let latest = '';
  let frame = 0;
  const flush = () => {
    frame = 0;
    if (latest === sent || !onText) return;
    const delta = latest.startsWith(sent) ? latest.slice(sent.length) : latest;
    sent = latest;
    onText(latest, delta);
  };
  const handle = runGeneration(request, secret, {
    onDelta: (text) => {
      if (!onText) return;
      latest = text;
      frame ||= requestAnimationFrame(flush);
    },
  });
  if (job.injects) spendInjectsWhenSent(handle);
  running.set(id, handle);
  try {
    const outcome = await handle.result;
    if (frame) cancelAnimationFrame(frame);
    if (outcome.state === 'error') throw new Error(outcome.error || '生成失败');
    latest = outcome.text;
    flush();
    return { text: outcome.text, reasoning: outcome.reasoning, toolCalls: outcome.toolCalls };
  } finally {
    if (frame) cancelAnimationFrame(frame);
    running.delete(id);
  }
}

/** Claude answers a `json_schema` request through a forced tool call: its arguments are the JSON asked for */
function schemaAnswer(reply: Reply): Reply {
  const [call] = reply.toolCalls;
  if (reply.text || reply.toolCalls.length !== 1 || !isRecord(call)) return reply;
  const fn = call['function'];
  const json = isRecord(fn) ? fn['arguments'] : undefined;
  return typeof json === 'string' ? { ...reply, text: json, toolCalls: [] } : reply;
}

/** A string, or the detailed object when the script asked for reasoning or the model called tools */
function scriptResult(config: Config, reply: Reply): unknown {
  const { text, reasoning, toolCalls } = config['json_schema'] ? schemaAnswer(reply) : reply;
  if (config['should_return_reasoning'] !== true && toolCalls.length === 0) return text;
  return {
    content: text,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * TavernHelper `generate` / `generateRaw`; `on.text` only fires when the script asked to stream.
 * `from` is the name of the frame that asks, shown when the user has to agree to an address.
 */
export async function scriptGenerate(
  kind: GenerateKind,
  config: Config,
  generationId: string,
  on: GenerateEvents,
  from = '',
): Promise<unknown> {
  const job = await buildJob(kind, config, from);
  on.start();
  const visible = config['should_silence'] !== true;
  if (visible) scriptRuns.visible.push(generationId);
  try {
    const reply = await run(
      job,
      generationId,
      config['should_stream'] === true ? on.text : undefined,
    );
    return scriptResult(config, reply);
  } finally {
    if (visible) scriptRuns.visible = scriptRuns.visible.filter((id) => id !== generationId);
  }
}

/** stop one script generation, or all of them when no id is given */
export function stopScriptGeneration(generationId: string | null): void {
  for (const [id, handle] of running) {
    if (generationId === null || id === generationId) void handle.abort();
  }
}

/** `/gen`: ST generateQuietPrompt over the open chat */
export async function quietGenerate(prompt: string): Promise<string> {
  return (await run(await buildJob('generate', {}, '', prompt), crypto.randomUUID())).text;
}

/** ST `checkWorldInfo` over the open chat's lorebooks, with the prompts injected into it */
export async function scanOpenChatWorldInfo(request: WorldInfoScanRequest): Promise<WIActivated> {
  return scanWorldInfo((await buildJob('generate', {}, '')).input, request);
}

/** `/genraw`: only the given system prompt and instruction go out */
export async function rawGenerate(prompt: string, system: string): Promise<string> {
  const config: Config = {
    user_input: prompt,
    ordered_prompts: [...(system ? [{ role: 'system', content: system }] : []), 'user_input'],
  };
  return (await run(await buildJob('raw', config, ''), crypto.randomUUID())).text;
}

/** TavernHelper `getModelList`: the models an OpenAI-compatible address offers */
export async function listModels(
  config: { apiurl: string; key?: string },
  from = '',
): Promise<string[]> {
  const { address, insecure } = await confirmAddress(String(config.apiurl ?? ''), from);
  const key = typeof config.key === 'string' ? config.key.trim() : '';
  // the script's own key and nothing from the keychain, as for a generation sent there
  const response = await netFetch(
    {
      url: urlJoin(address, '/models'),
      method: 'GET',
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      allow_insecure_http: insecure,
    },
    { kind: 'none' },
  );
  if (!response.ok) throw new Error(`获取模型列表失败：HTTP ${response.status}`);
  return normalizeChatModels(CHAT_COMPLETION_SOURCES.CUSTOM, response.json).map((m) => m.id);
}

/** Names of the proxy presets the user saved. Names only: addresses and passwords stay on this side. */
export function proxyPresetNames(): string[] {
  return loadProxyPresets(plainChat.settings ?? {})
    .proxies.filter((p) => p.name && p.url)
    .map((p) => p.name);
}
