/**
 * Typed wrappers for every Rust command. Components never call `invoke` directly (DEV_NOTES §12).
 * Falls back gracefully when running in a plain browser (`pnpm dev`).
 */
import { Channel, invoke, convertFileSrc } from '@tauri-apps/api/core';

export interface PingResponse {
  app: string;
  version: string;
  platform: string;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function ping(): Promise<PingResponse> {
  if (!isTauri()) return { app: 'tavern-mobile', version: 'web', platform: 'browser' };
  return invoke<PingResponse>('ping');
}

/** Character JSON (ccv3 preferred, else chara) from a card PNG on disk. Rust `card::read_card_file`. */
export async function cardRead(path: string): Promise<string> {
  return invoke<string>('card_read', { path });
}

/** Replace the chara/ccv3 chunks of an existing card PNG atomically. Rust `card::write_card_file`. */
export async function cardWrite(path: string, json: string): Promise<void> {
  return invoke<void>('card_write', { path, json });
}

export interface ChatTail {
  /** Raw JSON of the header line. */
  header: string;
  /** Raw JSON lines of the last n messages, in file order. */
  messages: string[];
  /** Total messages in the file (header excluded). */
  total: number;
  /** Index of messages[0] within the chat. */
  first_index: number;
}

/** Import a card PNG / JSON into `<root>/characters/`; returns the avatar file name. Rust `card::import_card`. */
export async function cardImport(root: string, path: string): Promise<string> {
  return invoke<string>('card_import', { root, path });
}

// ---- character editing (DEV_NOTES §9.17) ----

/** Delete `<root>/characters/<avatar>` and, when `deleteChats`, `chats/<stem>/`. Rust `card::delete_card`. */
export async function cardDelete(
  root: string,
  avatar: string,
  deleteChats: boolean,
): Promise<void> {
  return invoke<void>('card_delete', { root, avatar, deleteChats });
}

/** ST rename: new PNG named after `newName`, chats folder moved, old PNG removed. Returns the new avatar. */
export async function cardRename(root: string, avatar: string, newName: string): Promise<string> {
  return invoke<string>('card_rename', { root, avatar, newName });
}

/** ST duplicate: copy to `<base>_<n>.png`. Returns the new avatar. */
export async function cardDuplicate(root: string, avatar: string): Promise<string> {
  return invoke<string>('card_duplicate', { root, avatar });
}

/** The crop popup's rectangle, in source-image pixels (ST `Crop`). */
export interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Replace the card image, keeping the embedded JSON: `crop` is cut out first when given; the
 * result is brought to 512×768 when `resize`.
 */
export async function cardAvatarReplace(
  root: string,
  avatar: string,
  imagePath: string,
  resize: boolean,
  keepOriginal: boolean,
  crop?: ImageCrop,
): Promise<void> {
  return invoke<void>('card_avatar_replace', {
    root,
    avatar,
    imagePath,
    resize,
    keepOriginal,
    crop: crop ?? null,
  });
}

export interface ImagePreview {
  /** source size in pixels */
  width: number;
  height: number;
  /** the picture shrunk to `maxEdge`, as a JPEG data URL */
  dataUrl: string;
}

/** A picked image for the crop popup (a picked file is not readable from the webview). */
export async function imagePreview(imagePath: string, maxEdge: number): Promise<ImagePreview> {
  return invoke<ImagePreview>('image_preview', { imagePath, maxEdge });
}

/** Copy a picked file to where it stays readable (DEV_NOTES §9.37); returns the copy's path. */
export async function pickedStage(path: string): Promise<string> {
  return invoke<string>('picked_stage', { path });
}

/** Remove a copy made by `pickedStage`. */
export async function pickedUnstage(path: string): Promise<void> {
  return invoke<void>('picked_unstage', { path });
}

/** ST `uploadGroupAvatar`: a cropped 200×300 JPEG under `user/images/<group id>/`; returns its path. */
export async function groupAvatarUpload(
  root: string,
  groupId: string,
  fileName: string,
  imagePath: string,
  crop?: ImageCrop,
): Promise<string> {
  return invoke<string>('group_avatar_upload', {
    root,
    groupId,
    fileName,
    imagePath,
    crop: crop ?? null,
  });
}

/** The base64-decoded text of a picked PNG's first `tEXt` chunk under `keyword`; null when absent. */
export async function pngTextRead(
  path: string,
  keyword: string,
  maxBytes: number,
): Promise<string | null> {
  return invoke<string | null>('png_text_read', { path, keyword, maxBytes });
}

/** Rename a file inside the data root (chat files). Refuses to overwrite. */
export async function dataRename(root: string, from: string, to: string): Promise<void> {
  return invoke<void>('data_rename', { root, from, to });
}
/** Mobile export folder (iOS Documents → Files app; Android Downloads). */
export async function exportDir(): Promise<string> {
  return invoke<string>('export_dir');
}
export async function exportExists(dest: string): Promise<boolean> {
  return invoke<boolean>('export_exists', { dest });
}
export async function exportWriteText(dest: string, text: string): Promise<void> {
  return invoke<void>('export_write_text', { dest, text });
}
export async function exportCopy(src: string, dest: string): Promise<void> {
  return invoke<void>('export_copy', { src, dest });
}
/** ST `/api/characters/export` png: the card with `fav` / `chat` stripped. */
export async function cardExportPng(root: string, avatar: string, dest: string): Promise<void> {
  return invoke<void>('card_export_png', { root, avatar, dest });
}

/** ST `/api/avatars/upload`: persona avatar into `User Avatars/`; returns the file name. */
/** Read a picked file as UTF-8 text; rejects files over `maxBytes` or not valid UTF-8. */
export async function fileReadText(path: string, maxBytes: number): Promise<string> {
  return invoke<string>('file_read_text', { path, maxBytes });
}

/** ST `/api/images/upload`: copy a media file into `user/images/<character>/`; returns the stored rel path. */
export async function mediaUpload(
  root: string,
  chName: string,
  srcPath: string,
  fileName: string,
): Promise<string> {
  return invoke<string>('media_upload', { root, chName, srcPath, fileName });
}

/** ST `/api/images/upload` as an extension calls it: base64 body, caller-chosen name; returns the stored rel path. */
export async function mediaUploadBase64(
  root: string,
  file: { chName: string | null; fileName: string | null; format: string; image: string },
): Promise<string> {
  return invoke<string>('media_upload_base64', { root, ...file });
}

export interface MediaEntry {
  name: string;
  /** modification time, ms since the epoch */
  mtimeMs: number;
}

/** ST `/api/images/list`: the files directly inside `user/images/<folder>/`, in no particular order. */
export async function mediaList(root: string, folder: string): Promise<MediaEntry[]> {
  return invoke<MediaEntry[]>('media_list', { root, folder });
}

/** ST `/api/images/folders`: the folders inside `user/images/`. */
export async function mediaFolders(root: string): Promise<string[]> {
  return invoke<string[]>('media_folders', { root });
}

/** ST `/api/images/delete`: delete one file under `user/images/` by its data-root relative path. */
export async function mediaDelete(
  root: string,
  rel: string,
): Promise<'removed' | 'missing' | 'invalid'> {
  return invoke<'removed' | 'missing' | 'invalid'>('media_delete', { root, rel });
}

export async function userAvatarUpload(
  root: string,
  imagePath: string,
  resize: boolean,
  overwriteName?: string,
  crop?: ImageCrop,
): Promise<string> {
  return invoke<string>('user_avatar_upload', {
    root,
    imagePath,
    resize,
    crop: crop ?? null,
    overwriteName: overwriteName ?? null,
  });
}
export async function userAvatarCopy(root: string, from: string, to: string): Promise<void> {
  return invoke<void>('user_avatar_copy', { root, from, to });
}
/** Seeds ST's user-default.png when the folder has no PNG; true when written. */
export async function userAvatarSeedDefault(root: string): Promise<boolean> {
  return invoke<boolean>('user_avatar_seed_default', { root });
}

/** ST renamePastChats: rewrite the character name in every chat of `avatar`. Returns files touched. */
export async function chatRenameCharacter(
  root: string,
  avatar: string,
  newName: string,
): Promise<number> {
  return invoke<number>('chat_rename_character', { root, avatar, newName });
}

/** Seed ST's default templates / TC presets once (content.log). Returns the paths written. */
export async function contentSeed(root: string): Promise<string[]> {
  return invoke<string[]>('content_seed', { root });
}

/** Write a text file inside the data root (atomic; parent dir created). */
export async function dataWriteText(root: string, rel: string, text: string): Promise<void> {
  return invoke<void>('data_write_text', { root, rel, text });
}

/** Delete one file inside the data root. */
export async function dataDelete(root: string, rel: string): Promise<void> {
  return invoke<void>('data_delete', { root, rel });
}

/** Write / overwrite a chat jsonl from header + message lines. Rust `chat::write_chat`. */
export async function chatWrite(path: string, lines: string[]): Promise<void> {
  return invoke<void>('chat_write', { path, lines });
}

/** ST renameGroupMember on group chat files; returns files touched. */
export async function chatRenameGroupMember(
  root: string,
  chatIds: string[],
  oldAvatar: string,
  newAvatar: string,
  newName: string,
): Promise<number> {
  return invoke<number>('chat_rename_group_member', {
    root,
    chatIds,
    oldAvatar,
    newAvatar,
    newName,
  });
}

/** File names inside `<root>/<rel>` (worlds, presets…), optionally filtered by extension; sorted. */
export async function dataList(root: string, rel: string, ext?: string): Promise<string[]> {
  return invoke<string[]>('data_list', { root, rel, ext: ext ?? null });
}

/** Read a text file by path relative to the data root (worlds, presets…). Rust refuses `..` and private files. */
export async function dataReadText(root: string, rel: string): Promise<string> {
  return invoke<string>('data_read_text', { root, rel });
}

/** Last `n` messages of a chat jsonl without reading the whole file. Rust `fs::chat::read_tail`. */
export async function chatReadTail(path: string, n: number): Promise<ChatTail> {
  return invoke<ChatTail>('chat_read_tail', { path, n });
}

/** Create a new chat file (parent dir included) from header + message lines. Rust `chat::create_chat`. */
export async function chatCreate(path: string, lines: string[]): Promise<void> {
  return invoke<void>('chat_create', { path, lines });
}

/** Tauri asset URL for a file on disk (characters/*.png etc.); passthrough outside Tauri. */
export function fileUrl(path: string): string {
  return isTauri() ? convertFileSrc(path) : path;
}

/** Append one serialized message line. Rust `fs::chat::append_message`. */
export async function chatAppend(path: string, line: string): Promise<void> {
  return invoke<void>('chat_append', { path, line });
}

/** Replace messages from `index` to the end (edit / delete / swipe). Rust `fs::chat::rewrite_from`. */
export async function chatRewriteFrom(path: string, index: number, lines: string[]): Promise<void> {
  return invoke<void>('chat_rewrite_from', { path, index, lines });
}

/** Replace the header line only (chat metadata); messages stay as they are on disk. Rust `chat::rewrite_header`. */
export async function chatWriteHeader(path: string, header: string): Promise<void> {
  return invoke<void>('chat_write_header', { path, header });
}

/**
 * Base URL of the TavernHelper realm (DEV_NOTES §9.5), no trailing slash: `tmhelper://localhost`,
 * or `http://tmhelper.localhost` on Android and Windows. Null outside the app shell.
 */
export function helperRealmBase(): string | null {
  return isTauri() ? convertFileSrc('', 'tmhelper').replace(/\/+$/, '') : null;
}

// ---- ST extensions (DEV_NOTES §9.6, §9.34) ----

/** One folder under `<root>/extensions/`. Rust `extensions::ExtensionInfo`. */
export interface ExtensionInfo {
  name: string;
  /** parsed `manifest.json`; null when it is missing or not valid JSON */
  manifest: unknown;
  error: string | null;
  /** host module path (`/script.js`, `/scripts/utils.js`) → the names this extension imports from it */
  imports: Record<string, string[]>;
  /** repository address it was installed from; null for a zip install */
  source: string | null;
}

/**
 * Origin the extension host serves from, no trailing slash: `tmext://localhost`, or
 * `http://tmext.localhost` on Android and Windows. Null outside the app shell.
 */
export function extHostBase(): string | null {
  return isTauri() ? convertFileSrc('', 'tmext').replace(/\/+$/, '') : null;
}

export async function extensionList(root: string): Promise<ExtensionInfo[]> {
  return invoke<ExtensionInfo[]>('extension_list', { root });
}

/** Unpack a picked zip into `extensions/<name>/`, replacing an older copy of the same extension. */
export async function extensionInstallZip(root: string, zipPath: string): Promise<ExtensionInfo> {
  return invoke<ExtensionInfo>('extension_install_zip', { root, zipPath });
}

/** Download `https://github.com/<owner>/<repo>` and install it as `extensions/<repo>/`; also how an update runs. */
export async function extensionInstallGithub(root: string, url: string): Promise<ExtensionInfo> {
  return invoke<ExtensionInfo>('extension_install_github', { root, url });
}

export async function extensionRemove(root: string, name: string): Promise<void> {
  return invoke<void>('extension_remove', { root, name });
}

/** Tell the `tmext` protocol which names each stand-in host module exports. Call before loading extensions. */
export async function extShimsSet(table: Record<string, string[]>): Promise<void> {
  return invoke<void>('ext_shims_set', { table });
}

// ---- data root / settings / index / archive (Rust crate tm-data) ----

/** ST-compatible data root directory, created on first call. */
export async function dataRoot(): Promise<string> {
  return invoke<string>('data_root');
}

export async function settingsRead(root: string): Promise<unknown | null> {
  return invoke<unknown | null>('settings_read', { root });
}
export async function settingsWrite(root: string, value: unknown): Promise<void> {
  return invoke<void>('settings_write', { root, value });
}
export async function appSettingsRead(root: string): Promise<unknown | null> {
  return invoke<unknown | null>('app_settings_read', { root });
}
export async function appSettingsWrite(root: string, value: unknown): Promise<void> {
  return invoke<void>('app_settings_write', { root, value });
}

export interface ScanReport {
  characters_updated: number;
  characters_removed: number;
  chats_updated: number;
  chats_removed: number;
}
export interface CharacterRow {
  avatar: string;
  name: string;
  tags: string[];
  fav: boolean;
  create_date: string | null;
  mtime: number;
}
export interface ChatRow {
  char_avatar: string;
  file: string;
  mes_count: number;
  last_mes: string | null;
  last_name: string | null;
  mtime: number;
}
export interface SearchHit {
  chat_file: string;
  idx: number;
  name: string;
  snippet: string;
}

/** Incremental scan (or full rebuild) of the SQLite index. */
export async function indexScan(root: string, rebuild = false): Promise<ScanReport> {
  return invoke<ScanReport>('index_scan', { root, rebuild });
}
export async function indexCharacters(root: string): Promise<CharacterRow[]> {
  return invoke<CharacterRow[]>('index_characters', { root });
}
export async function indexChats(root: string, charAvatar: string): Promise<ChatRow[]> {
  return invoke<ChatRow[]>('index_chats', { root, charAvatar });
}
export async function indexSearch(root: string, query: string, limit = 50): Promise<SearchHit[]> {
  return invoke<SearchHit[]>('index_search', { root, query, limit });
}

export interface ExportReport {
  files: number;
  skipped_private: number;
  scrubbed_secrets: string[];
}
export interface ImportReport {
  files: number;
  skipped: string[];
  stripped_prefix: string | null;
  /** secrets.json content from the archive; never written to disk. */
  secrets: unknown | null;
}
/** With `password` the file is a sealed `.tmbackup` instead of a zip (DEV_NOTES §9.38). */
export async function dataExport(
  root: string,
  zipPath: string,
  includeSecrets = false,
  password: string | null = null,
): Promise<ExportReport> {
  return invoke<ExportReport>('data_export', { root, zipPath, includeSecrets, password });
}
/** `password` is only needed for a sealed backup (`dataBackupSealed`). */
export async function dataImport(
  zipPath: string,
  root: string,
  password: string | null = null,
): Promise<ImportReport> {
  return invoke<ImportReport>('data_import', { zipPath, root, password });
}
export async function dataBackupSealed(path: string): Promise<boolean> {
  return invoke<boolean>('data_backup_sealed', { path });
}

// ---- crash log (DEV_NOTES §9.38): a local file, redacted on write, never uploaded ----

export interface CrashEntry {
  /** unix millis */
  t: number;
  kind: 'js' | 'promise' | 'rust';
  message: string;
  source?: string;
  stack?: string;
}
export async function crashLogAppend(
  kind: 'js' | 'promise',
  message: string,
  source: string,
  stack: string,
): Promise<void> {
  return invoke<void>('crash_log_append', { kind, message, source, stack });
}
export async function crashLogRead(): Promise<CrashEntry[]> {
  return invoke<CrashEntry[]>('crash_log_read');
}
export async function crashLogClear(): Promise<void> {
  return invoke<void>('crash_log_clear');
}

// ---- tokenizers (Rust crate tm-tokenizers) ----

/** ST local tokenizer names (`/api/tokenizers/<name>/…`). `openai` additionally needs `model`. */
export type TokenizerName =
  | 'gpt2'
  | 'openai'
  | 'llama'
  | 'nerdstash'
  | 'nerdstash_v2'
  | 'mistral'
  | 'yi'
  | 'claude'
  | 'llama3'
  | 'gemma'
  | 'jamba'
  | 'qwen2'
  | 'command-r'
  | 'command-a'
  | 'nemo'
  | 'deepseek';

export interface EncodeResult {
  ids: number[];
  count: number;
}

/** `/api/tokenizers/<name>/encode`. Names without a registered vocab return `ids: []` and a byte estimate. */
export async function tokenizerEncode(
  name: TokenizerName,
  text: string,
  model?: string,
): Promise<EncodeResult> {
  return invoke<EncodeResult>('tokenizer_encode', { name, model: model ?? null, text });
}

/** `/api/tokenizers/<name>/decode`. */
export async function tokenizerDecode(
  name: TokenizerName,
  ids: number[],
  model?: string,
): Promise<string> {
  return invoke<string>('tokenizer_decode', { name, model: model ?? null, ids });
}

/** Token count only (what ST's `countTokensFromServer` reads). */
export async function tokenizerCount(
  name: TokenizerName,
  text: string,
  model?: string,
): Promise<number> {
  return invoke<number>('tokenizer_count', { name, model: model ?? null, text });
}

/** `/api/tokenizers/openai/count?model=` — server-side scheme; the client wrapper applies ST's −1/−2 adjustments. */
export async function tokenizerCountOpenAI(model: string, messages: unknown[]): Promise<number> {
  return invoke<number>('tokenizer_count_openai', { model, messages });
}

/** Register an HF tokenizer.json for a local tokenizer name (lazy-loaded). */
export async function tokenizerRegister(name: TokenizerName, path: string): Promise<void> {
  return invoke<void>('tokenizer_register', { name, path });
}

/** Register every `<root>/tokenizers/<name>.json` found; returns the registered names. */
export async function tokenizerAutoload(root: string): Promise<TokenizerName[]> {
  return invoke<TokenizerName[]>('tokenizer_autoload', { root });
}

/** Local tokenizer names that have a real vocab registered. */
export async function tokenizerList(): Promise<TokenizerName[]> {
  if (!isTauri()) return [];
  return invoke<TokenizerName[]>('tokenizer_list');
}

// ---- generation (Rust crate tm-net) ----

export type StreamFormat = 'sse' | 'json_lines';
export type ReplyFormat =
  { kind: 'chat_completion'; source: string } | { kind: 'text_completion'; api_type: string };

/** The upstream request as computed by @tm/core; Rust only sends and parses it. */
export interface GenerateRequest {
  url: string;
  headers?: Record<string, string>;
  /** Header that carries the key (e.g. `x-api-key` for Claude); default `Authorization: Bearer`. */
  auth_header?: string | null;
  body: unknown;
  stream: boolean;
  stream_format?: StreamFormat;
  format: ReplyFormat;
  allow_insecure_http?: boolean;
  timeout_ms?: number | null;
}

export type GenEvent =
  | { type: 'started'; status: number }
  | { type: 'delta'; text: string; chunk: string; reasoning: string; swipes: string[] }
  | {
      type: 'done';
      text: string;
      reasoning: string;
      swipes: string[];
      raw: unknown | null;
      /** tool calls the model asked for (OpenAI shape); only present when the request sent `tools` */
      tool_calls?: unknown[];
    }
  | { type: 'error'; status: number | null; message: string };

export type GenState = 'running' | 'done' | 'aborted' | 'error';

export interface GenSnapshot {
  text: string;
  reasoning: string;
  swipes: string[];
  state: GenState;
  done: boolean;
  aborted: boolean;
  error: string | null;
  started_at: number;
  updated_at: number;
}

export interface GenListItem {
  id: string;
  state: GenState;
  updated_at: number;
}

/** Generations the Rust side still holds (oldest first); used to find a run that outlived the page. */
export async function generateList(): Promise<GenListItem[]> {
  if (!isTauri()) return [];
  return invoke<GenListItem[]>('generate_list');
}

export interface UrlPolicy {
  ok: boolean;
  needs_confirm: boolean;
  error: string | null;
}

/** How a request gets its key: looked up in the keyring on the Rust side; the value never crosses IPC. */
export type SecretRef =
  | { kind: 'keyring'; key: string; id?: string | null }
  | { kind: 'proxy_password'; preset: string }
  | { kind: 'none' };

/** Start a generation; events arrive on `onEvent` (cumulative text). Returns the generation id. */
export async function generateStart(
  request: GenerateRequest,
  secret: SecretRef | null,
  onEvent: (event: GenEvent) => void,
): Promise<string> {
  const channel = new Channel<GenEvent>();
  channel.onmessage = onEvent;
  return invoke<string>('generate_start', { request, secret, onEvent: channel });
}

// ---- secrets (Rust crate tm-keys) ----

export interface SecretMeta {
  id: string;
  label: string;
  active: boolean;
  /** ST-style mask: 10 stars, or 7 stars + last 3 chars */
  masked: string;
}

export interface SecretBackendInfo {
  backend: 'keyring' | 'memory';
  platform: string | null;
  error: string | null;
}

export async function secretBackendInfo(): Promise<SecretBackendInfo> {
  return invoke<SecretBackendInfo>('secret_backend_info');
}

/** Store a key (becomes active). The only call where a secret value crosses IPC. */
export async function secretWrite(key: string, value: string, label?: string): Promise<string> {
  return invoke<string>('secret_write', { key, value, label: label ?? null });
}

export async function secretDelete(key: string, id: string): Promise<void> {
  return invoke<void>('secret_delete', { key, id });
}

export async function secretRotate(key: string, id: string): Promise<void> {
  return invoke<void>('secret_rotate', { key, id });
}

export async function secretRename(key: string, id: string, label: string): Promise<void> {
  return invoke<void>('secret_rename', { key, id, label });
}

export async function secretFind(key: string): Promise<SecretMeta[]> {
  return invoke<SecretMeta[]>('secret_find', { key });
}

export async function secretState(): Promise<Record<string, boolean>> {
  return invoke<Record<string, boolean>>('secret_state');
}

export async function proxyPasswordSet(preset: string, value: string): Promise<string> {
  return invoke<string>('proxy_password_set', { preset, value });
}

export async function generateAbort(id: string): Promise<boolean> {
  return invoke<boolean>('generate_abort', { id });
}

/** Snapshot of a running/finished generation (used after the webview was suspended). */
export async function generateSnapshot(id: string): Promise<GenSnapshot | null> {
  return invoke<GenSnapshot | null>('generate_snapshot', { id });
}

export async function generateForget(id: string): Promise<void> {
  return invoke<void>('generate_forget', { id });
}

/** http to a non-local host needs the user's confirmation (`allow_insecure_http`). */
export async function netUrlPolicy(url: string): Promise<UrlPolicy> {
  return invoke<UrlPolicy>('net_url_policy', { url });
}

// ---- generic fetch (model lists, connection checks) ----

export interface FetchRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  auth_header?: string | null;
  body?: unknown;
  allow_insecure_http?: boolean;
  timeout_ms?: number | null;
}

export interface FetchResponse {
  status: number;
  ok: boolean;
  json: unknown | null;
  text: string;
  headers: Record<string, string>;
}

/** Non-streaming HTTP through Rust (URL policy + keyring secret). Non-2xx is `ok: false`, not an error. */
export async function netFetch(
  request: FetchRequest,
  secret: SecretRef | null,
): Promise<FetchResponse> {
  return invoke<FetchResponse>('net_fetch', { request, secret });
}
