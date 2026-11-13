/**
 * The ST extension host's app half (DEV_NOTES §9.34): finds the installed extensions, and when at
 * least one is enabled puts ST's globals in place, keeps the mirrors and stand-in modules in step
 * with the stores, and loads the extensions the way ST's `activateExtensions` does. With nothing
 * enabled none of this runs and none of its libraries are fetched.
 */
import { tick, untrack } from 'svelte';
import {
  ApiRouter,
  AUTO_FIRE_EVENTS,
  Coverage,
  MODULES_GLOBAL,
  Mirror,
  StEventEmitter,
  createGetContext,
  elementId,
  event_types,
  extensionId,
  extensionPath,
  planLoad,
  reportMissingImports,
  setExport,
  shimNames,
  MODULE_LOAD_HOOK,
  type ApiRoutes,
  type CoverageEntry,
  type ModuleTable,
  type PlannedExtension,
  runGenerationInterceptors,
} from '@tm/st-compat';
import { generationHooks } from '../chat/hooks';
import { plainChat } from '../chat/plain.svelte';
import { chatStore } from '../chat/store.svelte';
import { onAppEvent } from '../events';
import {
  extHostBase,
  extShimsSet,
  extensionInstallZip,
  extensionInstallGithub,
  extensionList,
  extensionRemove,
  generateAbort,
  generateForget,
  fileUrl,
  generateStart,
  mediaDelete,
  mediaFolders,
  mediaList,
  mediaUploadBase64,
  netFetch,
  type ExtensionInfo,
} from '../ipc';
import { listWorldNames } from '../worlds';
import { EXTENSION_ASKER } from '../helper/custom-api';
import { confirmAddress } from '../helper/generate.svelte';
import { qrBar } from './anchors';
import { backendRoutes } from './backend-routes';
import { ChatMirror, type EventCall } from './chat-mirror';
import { crashOwner, withCrash, type CrashEntry } from './crash';
import { LIVE_EXPORTS, createLibs, createSurface, createToastr, type HostLibs } from './context';
import { installAddressRewrite, installFetch } from './fetch';
import { activePrompts } from './prompts';
import { dataRoutes } from './routes';
import { installShadowFieldClamp } from './shadow-fields';
import { extState } from './state.svelte';
import { toolCallingSupported, toolRegistry, toolsForRequest } from './tools';
import './ext.css';

type Obj = Record<string, unknown>;

/** the ST version extensions are told they run on (`minimum_client_version`, `/version`) */
const CLIENT_VERSION = '1.18.0';
/** ST `HOOK_TIMEOUT` (extensions.js) */
const HOOK_TIMEOUT = 5000;
const FA_STYLE_ID = 'tm-ext-fa';
const FA_STYLESHEET = '/th/lib/fontawesome/css/all.min.css';

export type HostStatus = 'idle' | 'starting' | 'running' | 'unavailable';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** the data root; a route that needs it before it is known rejects */
function dataRootOrThrow(): string {
  const root = chatStore.root;
  if (!root) throw new Error('数据目录还没准备好');
  return root;
}

/** `<script type="module">`, as ST's `addExtensionScript`: settles when it has run or failed to load */
function loadScript(id: string, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = id;
    script.type = 'module';
    script.async = true;
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error('入口脚本加载失败（文件缺失，或它 import 的模块出错）'));
    document.body.appendChild(script);
  });
}

/** ST `addExtensionStyle`; a stylesheet that fails to load is not a reason to hold the extension back */
function loadStyle(id: string, href: string): void {
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.type = 'text/css';
  link.href = href;
  document.head.appendChild(link);
}

/** ST's delegated `.inline-drawer-toggle` click (script.js): open / close the drawer it sits in */
function onDrawerToggle(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element) || target.classList.contains('text_pole')) return;
  const drawer = target.closest('.inline-drawer-toggle')?.closest('.inline-drawer');
  if (!drawer) return;
  const content = drawer.querySelector<HTMLElement>(':scope > .inline-drawer-content');
  const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
  const open = content ? getComputedStyle(content).display === 'none' : false;
  if (content) content.style.display = open ? 'block' : 'none';
  if (icon) {
    for (const [name, on] of [
      ['down', !open],
      ['fa-circle-chevron-down', !open],
      ['up', open],
      ['fa-circle-chevron-up', open],
    ] as const) {
      icon.classList.toggle(name, on);
    }
  }
  drawer.dispatchEvent(new CustomEvent('inline-drawer-toggle', { bubbles: true }));
}

/** what a running host is made of */
interface Live {
  emitter: StEventEmitter;
  chat: ChatMirror;
  metadata: Mirror;
  settings: Mirror;
  modules: ModuleTable;
}

class ExtensionHost {
  /** every folder under `<root>/extensions/` */
  installed = $state.raw<ExtensionInfo[]>([]);
  status = $state<HostStatus>('idle');
  /** why an extension failed to load, by folder name */
  errors = $state.raw<Readonly<Record<string, string>>>({});
  /** uncaught errors thrown by extension code after it loaded (「运行时报错」) */
  crashes = $state.raw<readonly CrashEntry[]>([]);
  /** what the loaded extensions asked for that the app does not have (「缺的接口」) */
  missing = $state.raw<readonly CoverageEntry[]>([]);
  /** an install / remove is under way */
  busy = $state(false);
  /** the last list / install / remove failure */
  error = $state<string | null>(null);
  /** the wand menu (`#extensionsMenu`) is showing */
  menuOpen = $state(false);

  /** folder names the running host loaded, in load order */
  private loaded = $state.raw<readonly string[]>([]);
  /** a loaded extension's files were replaced or removed */
  private replaced = $state(false);
  private inited = false;
  private live: Live | null = null;
  /** event batches go out one after another */
  private pending: Promise<void> = Promise.resolve();

  readonly plan = $derived(planLoad(this.installed, extState.disabled, CLIENT_VERSION));

  /** modules cannot be unloaded: once running, any change to what should be loaded needs a new page */
  readonly reloadNeeded = $derived.by(() => {
    if (this.status !== 'running') return false;
    return this.replaced || this.plan.load.map((e) => e.name).join('\n') !== this.loaded.join('\n');
  });

  /** Call once, when the data root and settings are loaded. */
  async init(): Promise<void> {
    if (this.inited) return;
    this.inited = true;
    await this.refresh();
  }

  /** Read the extensions folder again; starts the host when there is now something to load. */
  async refresh(): Promise<void> {
    const root = chatStore.root;
    if (!root || !extHostBase()) {
      this.status = 'unavailable';
      return;
    }
    try {
      this.installed = await extensionList(root);
      this.error = null;
    } catch (e) {
      this.error = message(e);
    }
    this.startIfNeeded();
  }

  /** Install the zip at `path` (replaces an older copy of the same extension). */
  /** From a picked zip. */
  install(path: string): Promise<ExtensionInfo | null> {
    return this.installWith((root) => extensionInstallZip(root, path));
  }

  /** From a GitHub repository address; an update is the same call with the recorded address. */
  installFromGithub(url: string): Promise<ExtensionInfo | null> {
    return this.installWith((root) => extensionInstallGithub(root, url));
  }

  /** Resolves to what was installed (its code has not run: that takes a reload), null on failure. */
  private async installWith(
    run: (root: string) => Promise<ExtensionInfo>,
  ): Promise<ExtensionInfo | null> {
    const root = chatStore.root;
    if (!root || this.busy) return null;
    this.busy = true;
    this.error = null;
    try {
      const info = await run(root);
      if (this.loaded.includes(info.name)) this.replaced = true;
      await this.refresh();
      return info;
    } catch (e) {
      this.error = message(e);
      return null;
    } finally {
      this.busy = false;
    }
  }

  async remove(name: string): Promise<void> {
    const root = chatStore.root;
    if (!root || this.busy) return;
    this.busy = true;
    try {
      await extensionRemove(root, name);
      if (this.loaded.includes(name)) this.replaced = true;
      await this.refresh();
    } catch (e) {
      this.error = message(e);
    } finally {
      this.busy = false;
    }
  }

  /** ST's `disabledExtensions` list in `extension_settings` */
  setEnabled(name: string, on: boolean): void {
    const id = extensionId(name);
    chatStore.mutateSettings((all) => {
      all['extension_settings'] ??= {};
      const settings = all['extension_settings'] as Obj;
      const off = Array.isArray(settings['disabledExtensions'])
        ? (settings['disabledExtensions'] as unknown[]).filter((other) => other !== id)
        : [];
      if (!on) off.push(id);
      settings['disabledExtensions'] = off;
    });
    this.startIfNeeded();
  }

  /** What the 「重新载入」 button does: write what is pending, then load the page anew. */
  async reload(): Promise<void> {
    await chatStore.flushDeferred();
    location.reload();
  }

  private startIfNeeded(): void {
    if (this.status === 'idle' && this.plan.load.length > 0) void this.start();
  }

  private async start(): Promise<void> {
    const base = extHostBase();
    if (!base) return;
    this.status = 'starting';
    const plan = this.plan.load;
    try {
      const live = await this.prepare(base, plan);
      // ST's `world_names` is there before any extension runs
      if (chatStore.root) await listWorldNames(chatStore.root).catch(() => []);
      this.live = live;
      this.watch(live);
      this.catchCrashes(
        base,
        plan.map((e) => e.name),
      );
      const errors: Record<string, string> = {};
      // one after another, as ST does: an extension may count on an earlier one being there
      for (const extension of plan) {
        try {
          await this.activate(base, extension);
        } catch (e) {
          errors[extension.name] = message(e);
          console.error(`[ext] ${extension.name}`, e);
        }
      }
      this.errors = errors;
      this.loaded = plan.map((e) => e.name);
      await this.post([[event_types.APP_INITIALIZED], [event_types.APP_READY]]);
      // ST opens the chat after its extensions are up; here one may be open already, and an
      // extension still in its async start has to hear of it as well
      if (chatStore.open) await this.post(this.chatOpened(), true);
      this.status = 'running';
    } catch (e) {
      this.error = `扩展宿主启动失败：${message(e)}`;
      this.status = 'unavailable';
      console.error('[ext] host failed to start', e);
    }
  }

  private noteCrash(name: string, e: unknown): void {
    const next = withCrash(this.crashes, { name, message: message(e) });
    if (next === this.crashes) return;
    this.crashes = next;
    console.error(`[ext] ${name} 运行时：${message(e)}`);
  }

  /** Uncaught errors and rejections whose script address or stack lies in an extension's folder. */
  private catchCrashes(base: string, names: readonly string[]): void {
    const note = (where: string, e: unknown): void => {
      const name = crashOwner(base, where, names);
      if (name) this.noteCrash(name, e);
    };
    const stackOf = (e: unknown): string => (e instanceof Error ? (e.stack ?? '') : '');
    window.addEventListener('error', (event) =>
      note(`${event.filename}\n${stackOf(event.error)}`, event.error ?? event.message),
    );
    window.addEventListener('unhandledrejection', (event) =>
      note(stackOf(event.reason), event.reason),
    );
  }

  /** Everything an extension expects to find before its first line runs. */
  private async prepare(base: string, plan: readonly PlannedExtension[]): Promise<Live> {
    const [jquery, lodash, purify, moment, handlebars, hljs, popper, fuse, forage, diff, droll] =
      await Promise.all([
        import('jquery'),
        import('lodash'),
        import('dompurify'),
        import('moment'),
        import('handlebars'),
        import('highlight.js/lib/common'),
        import('@popperjs/core'),
        import('fuse.js'),
        import('localforage'),
        import('diff-match-patch'),
        import('droll'),
      ]);
    const [showdown, yaml] = await Promise.all([import('showdown'), import('yaml')]);
    const libs: HostLibs = {
      lodash: lodash.default,
      DOMPurify: purify.default,
      moment: moment.default,
      Handlebars: handlebars.default,
      hljs: hljs.default,
      Popper: popper,
      Fuse: fuse.default,
      localforage: forage.default,
      DiffMatchPatch: diff.diff_match_patch,
      droll: droll.default,
      showdown: showdown.default,
      yaml,
    };

    const coverage = new Coverage();
    let reporting = false;
    coverage.onNew = (entry) => {
      console.warn(`[ext] 缺的接口 ${entry.kind} ${entry.name}`);
      if (reporting) return;
      reporting = true;
      queueMicrotask(() => {
        reporting = false;
        this.missing = coverage.list();
      });
    };

    const emitter = new StEventEmitter(AUTO_FIRE_EVENTS);
    const chat = new ChatMirror();
    const metadata = new Mirror();
    const settings = new Mirror();
    metadata.reset(plainChat.chatMetadata);
    settings.reset(this.extensionSettings());
    this.syncMessages(chat);

    const { source, modules, extensionPrompts } = createSurface({
      emitter,
      chat,
      metadata,
      settings,
      coverage,
      libs,
      base,
      manifests: new Map(plan.map((e) => [e.id, e.manifest])),
      reloadChat: () => this.reloadChat(),
    });
    const getContext = createGetContext(source, coverage);
    modules['/scripts/extensions.js']!['getContext'] = getContext;
    modules['/scripts/st-context.js']!['getContext'] = getContext;

    // there before any extension looks for it, so none builds a second one
    qrBar();

    // what the loaded extensions add to a generation (DEV_NOTES §9.34 第 2 轮)
    const manifests = plan.map((e) => e.manifest);
    generationHooks.intercept = (messages, type) =>
      runGenerationInterceptors(
        manifests,
        window as unknown as Record<string, unknown>,
        messages,
        extState.maxContext,
        type,
      );
    generationHooks.prompts = () => activePrompts(extensionPrompts);
    generationHooks.emit = async (name, ...args) => {
      // the store change before this event has its own events queued first
      await tick();
      await this.post([[name, ...args]]);
    };
    generationHooks.token = (text) => {
      if (this.live?.emitter.has(event_types.STREAM_TOKEN_RECEIVED))
        void this.post([[event_types.STREAM_TOKEN_RECEIVED, text]]);
    };
    generationHooks.tools = {
      supported: toolCallingSupported,
      definitions: toolsForRequest,
      run: (toolCalls, notify) => toolRegistry.run(toolCalls, notify),
    };

    const installed = this.installed;
    await extShimsSet(
      shimNames(
        modules,
        installed.map((e) => e.imports),
      ),
    );
    const names = new Set(plan.map((e) => e.name));
    reportMissingImports(
      modules,
      installed.filter((e) => names.has(e.name)).map((e) => e.imports),
      coverage,
    );

    Object.assign(window, {
      [MODULES_GLOBAL]: modules,
      [MODULE_LOAD_HOOK]: (path: string) => coverage.miss('module', path),
      SillyTavern: { getContext, libs: createLibs(libs, coverage) },
      $: jquery.default,
      jQuery: jquery.default,
      _: libs.lodash,
      toastr: createToastr(libs),
      DOMPurify: libs.DOMPurify,
      moment: libs.moment,
      Handlebars: libs.Handlebars,
      // the rest of what ST's lib.js hangs on the page
      hljs: libs.hljs,
      Popper: libs.Popper,
      Fuse: libs.Fuse,
      localforage: libs.localforage,
      diff_match_patch: libs.DiffMatchPatch,
      droll: libs.droll,
      showdown: libs.showdown,
    });
    const dataFileUrl = (rel: string) =>
      chatStore.root ? fileUrl(`${chatStore.root}/${rel}`) : null;
    installFetch(new ApiRouter(this.routes(coverage), coverage), base, dataFileUrl);
    installAddressRewrite({ extensionBase: base, dataFileUrl });
    installShadowFieldClamp();
    document.addEventListener('click', onDrawerToggle);

    if (!document.getElementById(FA_STYLE_ID)) {
      // in a layer: every unlayered rule of the app outranks it
      const style = document.createElement('style');
      style.id = FA_STYLE_ID;
      style.textContent = `@import url("${FA_STYLESHEET}") layer(${FA_STYLE_ID});`;
      document.head.appendChild(style);
    }
    return { emitter, chat, metadata, settings, modules };
  }

  /** ST's server routes an extension can call; none of them carries a secret of the user's */
  private routes(coverage: Coverage): ApiRoutes {
    return {
      ...backendRoutes({
        confirm: (apiurl) => confirmAddress(apiurl, EXTENSION_ASKER, '扩展给的地址'),
        fetch: netFetch,
        start: generateStart,
        abort: generateAbort,
        forget: generateForget,
        unsupported: (what) => coverage.miss('api', what),
      }),
      ...dataRoutes({
        installed: () => this.installed,
        reinstall: async (source) => {
          await this.installFromGithub(source);
          if (this.error) throw new Error(this.error);
        },
        saveImage: (file) => mediaUploadBase64(dataRootOrThrow(), file),
        listImages: (folder) => mediaList(dataRootOrThrow(), folder),
        imageFolders: () => mediaFolders(dataRootOrThrow()),
        deleteImage: (path) => mediaDelete(dataRootOrThrow(), path),
      }),
      'GET /csrf-token': () => ({ status: 200, body: { token: '' } }),
      'GET /version': () => ({
        status: 200,
        body: {
          agent: `SillyTavern:${CLIENT_VERSION}:Tavern Mobile`,
          pkgVersion: CLIENT_VERSION,
          gitRevision: null,
          gitBranch: null,
        },
      }),
      'POST /api/extensions/discover': () => ({
        status: 200,
        body: this.installed
          .filter((e) => e.manifest !== null)
          .map((e) => ({ type: 'local', name: extensionId(e.name) })),
      }),
    };
  }

  /** Stylesheet, entry script, then the `activate` hook (ST `activateExtensions`). */
  private async activate(base: string, { name, id, manifest }: PlannedExtension): Promise<void> {
    if (typeof manifest.css === 'string' && manifest.css) {
      loadStyle(elementId(id, 'css'), base + extensionPath(name, manifest.css));
    }
    if (typeof manifest.js !== 'string' || !manifest.js) return;
    const url = base + extensionPath(name, manifest.js);
    // a module that throws while it evaluates is reported nowhere on WebKit, and importing it again
    // resolves: only this first import tells. The script tag after it (ST's way in) reuses the module.
    await import(/* @vite-ignore */ url).catch((e: unknown) => this.noteCrash(name, e));
    await loadScript(elementId(id, 'js'), url);

    const hook = manifest.hooks?.['activate'];
    if (typeof hook !== 'string' || !hook) return;
    try {
      // the same URL as the script tag: the module that just ran, not a second copy
      const module = (await import(/* @vite-ignore */ url)) as Obj;
      const run = module[hook];
      if (typeof run !== 'function') return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.resolve((run as () => unknown)()),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('activate 钩子超时')), HOOK_TIMEOUT);
        }),
      ]).finally(() => clearTimeout(timer));
    } catch (e) {
      // as in ST: a failing hook is logged, the extension stays loaded
      console.error(`[ext] ${name} activate`, e);
    }
  }

  /** Keep the mirrors and the stand-in modules in step with the stores, for the life of the page. */
  private watch({ metadata, settings, modules }: Live): void {
    $effect.root(() => {
      $effect(() => {
        // tracks the message array alone; one reference compare when nothing changed
        void chatStore.messages;
        untrack(() => this.syncChat());
      });
      $effect(() => {
        const plain = plainChat.chatMetadata;
        untrack(() => metadata.pull(plain));
      });
      $effect(() => {
        const plain = this.extensionSettings();
        untrack(() => settings.pull(plain));
      });
      for (const [path, name, read] of LIVE_EXPORTS) {
        $effect(() => setExport(modules, path, name, read()));
      }
    });
    onAppEvent((name, ...args) => void this.post([[name, ...args]]));
  }

  /** `extension_settings` as a plain copy; reading it tracks that subtree only */
  private extensionSettings(): Obj {
    const source = chatStore.settings?.['extension_settings'];
    return source ? ($state.snapshot(source) as Obj) : {};
  }

  /** Hand the store's messages to the mirror: all of them, or none while only a tail is loaded. */
  private syncMessages(chat: ChatMirror) {
    const messages = chatStore.messages;
    const key = chatStore.total === messages.length ? chatStore.chatRel : null;
    return chat.sync(key, key === null ? [] : messages);
  }

  /**
   * What ST emits once a chat is on screen: `getChat()` ends with `CHAT_LOADED` (character chats
   * only, groups have none), then its caller emits `CHAT_CHANGED`.
   */
  private chatOpened(): EventCall[] {
    const changed: EventCall = [event_types.CHAT_CHANGED, extState.chatId];
    const id = extState.characterId;
    if (id === undefined) return [changed];
    const detail = { id, character: extState.characters[Number(id)] };
    return [[event_types.CHAT_LOADED, { detail }], changed];
  }

  private syncChat(): void {
    const live = this.live;
    if (!live) return;
    const { changed, events } = this.syncMessages(live.chat);
    if (changed) {
      live.metadata.reset(plainChat.chatMetadata);
      void this.post(this.chatOpened());
    } else {
      void this.post(events);
    }
  }

  /** ST `reloadCurrentChat()`: read the chat from disk again and tell extensions it is a new one. */
  private async reloadChat(): Promise<void> {
    const live = this.live;
    if (!live) return;
    const file = chatStore.chatFile;
    live.chat.forget();
    if (file && chatStore.open) {
      await chatStore.flushDeferred();
      await chatStore.openChat(file);
    }
    this.syncChat();
    await this.pending;
  }

  /**
   * Emit `calls` in order once the batches before them are done and the page has rendered.
   * `late`: listeners that subscribe before the event's next emit get it too.
   */
  private post(calls: readonly EventCall[], late = false): Promise<void> {
    const emitter = this.live?.emitter;
    if (!emitter || calls.length === 0) return this.pending;
    this.pending = this.pending.then(async () => {
      await tick();
      for (const [name, ...args] of calls) {
        await (late ? emitter.emitLate(name, ...args) : emitter.emit(name, ...args));
      }
    });
    return this.pending;
  }
}

export const extensionHost = new ExtensionHost();
