<script lang="ts">
  /**
   * API connection (ST's "API Connections" drawer, Chat Completion only — DEV_NOTES §9.18):
   * source, key (keyring), per-source fields, reverse-proxy presets, model, connect / status.
   */
  import { onDestroy, onMount } from 'svelte';
  import {
    API_SOURCE_CONFIG,
    CHAT_COMPLETION_SOURCES as S,
    CHAT_COMPLETION_SOURCE_OPTIONS,
    MINIMAX_ENDPOINT_OPTIONS,
    SILICONFLOW_ENDPOINT_OPTIONS,
    STATIC_MODEL_LISTS,
    STATUS_BYPASSED,
    STATUS_NO_CONNECTION,
    STATUS_VALID,
    SERVER_URL_TYPES,
    TEXTGEN_SERVER_PLACEHOLDERS,
    TEXTGEN_TYPE_OPTIONS,
    TEXTGEN_TYPES,
    ZAI_ENDPOINT_OPTIONS,
    getTextGenServer,
    loadTextgenSettings,
    textgenModelKey,
    textgenSecretKey,
    type TextgenSettings,
    deleteProxyPreset,
    loadProxyPresets,
    modelSettingKey,
    setProxyPreset,
    type ModelInfo,
    type OaiSettings,
    type ProxyPreset,
    isImageInliningSupported,
    isVideoInliningSupported,
    isAudioInliningSupported,
  } from '@tm/core';
  import Button from '@tm/ui/components/Button.svelte';
  import Segmented from '@tm/ui/components/Segmented.svelte';
  import BottomSheet from '../lib/components/BottomSheet.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import { chatStore } from '../lib/chat/store.svelte';
  import {
    isTauri,
    proxyPasswordSet,
    secretBackendInfo,
    secretDelete,
    secretFind,
    secretRename,
    secretRotate,
    secretWrite,
    type SecretMeta,
  } from '../lib/ipc';
  import {
    connectChatCompletion,
    connectTextCompletion,
    flushSettings,
    oaiOf,
    persistSettings,
    oaiRuntime,
  } from '../lib/oai.svelte';
  import { mainApiOf } from '../lib/chat/core-state';
  import { askPopup } from '../lib/popup.svelte';

  const store = chatStore;
  let oai = $state<OaiSettings>({});
  // main_api: 'openai' (Chat Completion) | 'textgenerationwebui' (Text Completion, §9.19)
  let mainApi = $state('openai');
  let tg = $state<TextgenSettings>(loadTextgenSettings({}));
  let proxies = $state<ProxyPreset[]>([]);
  let proxyName = $state('None');
  let proxyUrl = $state('');
  let proxyPassword = $state('');
  let keyInput = $state('');
  let keyLabel = $state('');
  let keys = $state<SecretMeta[]>([]);
  let backend = $state<string | null>(null);
  let models = $state<ModelInfo[]>([]);
  let status = $state<string>(STATUS_NO_CONNECTION);
  let message = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let confirmUrl = $state<string | null>(null);
  let ready = $state(false);

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const source = $derived(String(oai['chat_completion_source'] ?? S.OPENAI));
  const cfg = $derived(API_SOURCE_CONFIG[source]);
  // ST is{Image,Video,Audio}InliningSupported(): the fetched list stands in for ST's model_list
  const inliningKinds = $derived.by(() => {
    const o = $state.snapshot(oai) as Record<string, unknown>;
    const list = oaiRuntime.source === source ? $state.snapshot(oaiRuntime.models) : null;
    const on = { ...o, media_inlining: true };
    return [
      isImageInliningSupported(on, list, mainApi) ? '图片' : '',
      isVideoInliningSupported(on, list, mainApi) ? '视频' : '',
      isAudioInliningSupported(on, list, mainApi) ? '音频' : '',
    ].filter(Boolean);
  });
  const isTc = $derived(mainApi === 'textgenerationwebui');
  const tgType = $derived(String(tg.type));
  const secretKey = $derived(isTc ? textgenSecretKey(tgType) : (cfg?.key ?? null));
  const keyless = $derived(isTc ? true : !!cfg?.keyless);
  const tgModelKey = $derived(textgenModelKey(tgType));
  const tgModel = $derived(tgModelKey ? String(tg[tgModelKey] ?? '') : '');
  const tgModelChoices = $derived.by<string[]>(() => {
    const set = new Set(models.map((m) => m.id));
    if (tgModel && !set.has(tgModel)) set.add(tgModel);
    return [...set];
  });
  const modelKey = $derived(modelSettingKey(source));
  const model = $derived(String(oai[modelKey] ?? ''));
  const selectedProxy = $derived(proxies.find((p) => p.name === proxyName) ?? null);
  const proxyActive = $derived(!!cfg?.proxy && !!String(oai['reverse_proxy'] ?? ''));
  const staticModels = $derived(STATIC_MODEL_LISTS[source] ?? []);
  const modelChoices = $derived.by<string[]>(() => {
    const fetched = models.map((m) => m.id);
    const base =
      source === S.OPENAI
        ? oai['show_external_models']
          ? [...staticModels, ...fetched]
          : [...staticModels]
        : fetched.length
          ? fetched
          : [...staticModels];
    const set = new Set(base);
    if (model && !set.has(model)) set.add(model);
    return [...set];
  });
  const statusTone = $derived(
    status === STATUS_NO_CONNECTION ? 'bad' : status === STATUS_VALID ? 'ok' : 'warn',
  );

  onMount(async () => {
    if (!isTauri()) return;
    await store.init();
    load();
    try {
      const info = await secretBackendInfo();
      backend = info.backend === 'memory' ? `钥匙串不可用（${info.error ?? '会话内暂存'}）` : null;
    } catch {
      backend = null;
    }
    await refreshKeys();
    ready = true;
  });
  onDestroy(() => void flushSettings());

  function load() {
    const settings = store.settings ? $state.snapshot(store.settings) : {};
    oai = oaiOf(settings);
    mainApi = mainApiOf(settings) === 'textgenerationwebui' ? 'textgenerationwebui' : 'openai';
    tg = loadTextgenSettings(settings);
    const p = loadProxyPresets(settings);
    proxies = p.proxies;
    proxyName = p.selected.name;
    proxyUrl = p.selected.url;
    proxyPassword = '';
  }

  /** settings.json: main_api, oai_settings + top-level proxies / selected_proxy, textgenerationwebui_settings */
  function persist() {
    const selected = selectedProxy ?? { name: 'None', url: '', password: '' };
    persistSettings({
      main_api: mainApi,
      textgenerationwebui_settings: $state.snapshot(tg),
      // proxy_password lives in the keyring (proxy_password_set); the file always carries ''
      oai_settings: { ...$state.snapshot(oai), proxy_password: '' },
      proxies: $state.snapshot(proxies).map((p) => ({ ...p, password: '' })),
      selected_proxy: { ...selected, password: '' },
    });
  }
  function set(key: string, value: unknown) {
    oai[key] = value;
    persist();
  }
  function setTg(key: string, value: unknown) {
    tg[key] = value;
    persist();
  }
  function setServer(url: string) {
    tg.server_urls = { ...tg.server_urls, [tgType]: url };
    persist();
  }
  function switchApi(next: string) {
    mainApi = next;
    models = [];
    status = STATUS_NO_CONNECTION;
    message = null;
    persist();
  }

  async function refreshKeys() {
    if (!secretKey) {
      keys = [];
      return;
    }
    try {
      keys = await secretFind(secretKey);
    } catch (e) {
      keys = [];
      error = msg(e);
    }
  }
  $effect(() => {
    void secretKey;
    if (ready) void refreshKeys();
  });

  async function saveKey() {
    const v = keyInput.trim();
    if (!v || !secretKey) return;
    busy = '保存密钥…';
    try {
      await secretWrite(secretKey, v, keyLabel.trim() || undefined);
      keyInput = '';
      keyLabel = '';
      await refreshKeys();
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
  /** a key saved without a name carries ST's default label */
  const keyName = (k: SecretMeta) => (k.label && k.label !== 'Unlabeled' ? k.label : '未命名');
  async function renameKey(k: SecretMeta) {
    if (!secretKey) return;
    const name = await askPopup({
      kind: 'input',
      title: '给密钥起个名字',
      text: `密钥 ${k.masked}`,
      value: k.label === 'Unlabeled' ? '' : k.label,
      okButton: '保存',
    });
    if (typeof name !== 'string' || !name.trim()) return;
    try {
      await secretRename(secretKey, k.id, name.trim());
      await refreshKeys();
    } catch (e) {
      error = msg(e);
    }
  }
  async function useKey(id: string) {
    if (!secretKey) return;
    try {
      await secretRotate(secretKey, id);
      await refreshKeys();
    } catch (e) {
      error = msg(e);
    }
  }
  async function removeKey(id: string) {
    if (!secretKey) return;
    try {
      await secretDelete(secretKey, id);
      await refreshKeys();
    } catch (e) {
      error = msg(e);
    }
  }

  // ---- reverse proxy presets ----
  function chooseProxy(name: string) {
    const p = proxies.find((x) => x.name === name);
    if (!p) return;
    proxyName = p.name;
    proxyUrl = p.url;
    proxyPassword = '';
    set('reverse_proxy', p.url);
  }
  async function saveProxy() {
    const name = proxyName.trim();
    if (!name) return;
    busy = '保存反代…';
    try {
      const sel = setProxyPreset(proxies, name, proxyUrl.trim());
      proxies = [...proxies];
      proxyName = sel.name;
      if (proxyPassword) {
        await proxyPasswordSet(name, proxyPassword);
        proxyPassword = '';
      }
      set('reverse_proxy', sel.url);
      message = '反代已保存';
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
  function removeProxy() {
    const next = deleteProxyPreset(proxies, proxyName);
    if (!next) return;
    proxies = [...proxies];
    proxyName = next.name;
    proxyUrl = next.url;
    proxyPassword = '';
    set('reverse_proxy', next.url);
  }

  // ---- connect ----
  async function connect(allowInsecure = false) {
    if (keyInput.trim()) await saveKey();
    busy = '连接中…';
    message = null;
    error = null;
    confirmUrl = null;
    try {
      await flushSettings();
      const r = isTc
        ? await connectTextCompletion($state.snapshot(tg) as TextgenSettings, { allowInsecure })
        : await connectChatCompletion($state.snapshot(oai), selectedProxy?.name ?? null, {
            allowInsecure,
          });
      if (r.needsConfirmUrl) {
        confirmUrl = r.needsConfirmUrl;
        return;
      }
      status = r.status;
      models = r.models;
      if (!isTc) {
        oaiRuntime.source = source;
        oaiRuntime.models = r.models;
      }
      message = r.message ?? null;
      if (isTc) {
        if (r.model !== undefined && tgModelKey && r.model !== tgModel) setTg(tgModelKey, r.model);
      } else if (r.model !== undefined && r.model !== model) set(modelKey, r.model);
    } catch (e) {
      error = msg(e);
      status = STATUS_NO_CONNECTION;
    } finally {
      busy = null;
    }
  }
</script>

{#if !isTauri()}
  <section class="tm-form"><p class="tm-form__hint">连接设置需要在 app 里运行。</p></section>
{:else}
  <section class="tm-form drawer-content" id="rm_api_block">
    {#if error}
      <p class="tm-form__error" role="alert">
        <span>{error}</span><button class="tm-form__link" onclick={() => (error = null)}
          >关闭</button
        >
      </p>
    {/if}
    {#if backend}<p class="tm-form__hint">{backend}：密钥只保存在本次运行的内存里。</p>{/if}

    <div class="tm-form__section">
      <div class="tm-form__field" id="main_api">
        <span class="tm-form__label">API 类型 <small>main_api</small></span>
        <Segmented
          label="API 类型"
          value={mainApi}
          options={[
            { value: 'openai', label: 'Chat Completion' },
            { value: 'textgenerationwebui', label: 'Text Completion' },
          ]}
          onchange={switchApi}
        />
      </div>
    </div>

    {#if isTc}
      <div class="tm-form__section">
        <label class="tm-form__field">
          <span class="tm-form__label">后端类型 <small>textgen type</small></span>
          <select
            id="textgen_type"
            class="text_pole tm-form__select"
            value={tgType}
            onchange={(e) => {
              models = [];
              status = STATUS_NO_CONNECTION;
              setTg('type', e.currentTarget.value);
            }}
          >
            {#each TEXTGEN_TYPE_OPTIONS as o (o.value)}
              <option value={o.value}>{o.label}</option>
            {/each}
          </select>
        </label>
        {#if SERVER_URL_TYPES.includes(tgType)}
          <label class="tm-form__field">
            <span class="tm-form__label">服务器地址</span>
            <input
              class="text_pole tm-form__input tm-form__input--mono"
              type="url"
              autocapitalize="off"
              autocorrect="off"
              placeholder={TEXTGEN_SERVER_PLACEHOLDERS[tgType] ?? 'http://127.0.0.1:5000'}
              value={String(tg.server_urls[tgType] ?? '')}
              onchange={(e) => setServer(e.currentTarget.value.trim())}
            />
          </label>
          <p class="tm-form__hint">
            本机 / 局域网的 http 地址可直接连；手机连电脑上的后端要填电脑的局域网 IP。
          </p>
        {:else}
          <p class="tm-form__hint">服务地址固定：{getTextGenServer(tg as TextgenSettings)}</p>
        {/if}
      </div>
    {:else}
      <div class="tm-form__section">
        <label class="tm-form__field">
          <span class="tm-form__label">API 来源 <small>Chat Completion</small></span>
          <select
            id="chat_completion_source"
            class="text_pole tm-form__select"
            value={source}
            onchange={(e) => {
              models = [];
              status = STATUS_NO_CONNECTION;
              set('chat_completion_source', e.currentTarget.value);
            }}
          >
            {#each CHAT_COMPLETION_SOURCE_OPTIONS as o (o.value)}
              <option value={o.value}>{o.label}</option>
            {/each}
          </select>
        </label>
      </div>
    {/if}

    {#if secretKey}
      <div class="tm-form__section">
        <h2 class="tm-form__heading"><span>API 密钥</span><small>{secretKey}</small></h2>
        {#each keys as k (k.id)}
          <div class="tm-form__item" class:is-off={!k.active}>
            <span class="tm-form__dot" class:tm-form__dot--ok={k.active}></span>
            <span>
              <span class="tm-form__item-name">{keyName(k)}</span>
              <span class="tm-form__item-meta">{k.masked}{k.active ? ' · 使用中' : ''}</span>
            </span>
            <span class="tm-form__item-actions">
              {#if !k.active}
                <button class="tm-form__icon" aria-label="改用这把密钥" onclick={() => useKey(k.id)}
                  ><Icon name="check" /></button
                >
              {/if}
              <button class="tm-form__icon" aria-label="改名" onclick={() => renameKey(k)}
                ><Icon name="pencil" /></button
              >
              <button class="tm-form__icon" aria-label="删除密钥" onclick={() => removeKey(k.id)}
                ><Icon name="trash" /></button
              >
            </span>
          </div>
        {/each}
        <label class="tm-form__field">
          <span class="tm-form__label">{keys.length ? '换一把密钥' : '录入密钥'}</span>
          <input
            class="text_pole tm-form__input"
            type="text"
            autocomplete="off"
            placeholder="名称，可选（如：主力、备用）"
            bind:value={keyLabel}
          />
          <span class="tm-form__inline">
            <input
              class="text_pole tm-form__input tm-form__input--mono"
              type="password"
              autocomplete="off"
              autocapitalize="off"
              placeholder={keyless ? '可留空' : 'sk-…'}
              bind:value={keyInput}
            />
            <Button variant="outline" disabled={!keyInput.trim() || !!busy} onclick={saveKey}
              >保存</Button
            >
          </span>
        </label>
        <p class="tm-form__hint">密钥只进系统钥匙串，不写进 settings.json，导出备份也不含。</p>
      </div>
    {/if}

    {#if isTc}
      <!-- Text Completion fields are in the type section above -->
    {:else if source === S.CUSTOM}
      <div class="tm-form__section">
        <h2 class="tm-form__heading"><span>自定义端点</span></h2>
        <label class="tm-form__field">
          <span class="tm-form__label">Base URL</span>
          <input
            id="custom_api_url_text"
            class="text_pole tm-form__input tm-form__input--mono"
            type="url"
            autocapitalize="off"
            placeholder="http://localhost:1234/v1"
            value={String(oai['custom_url'] ?? '')}
            onchange={(e) => set('custom_url', e.currentTarget.value.trim())}
          />
        </label>
        <label class="tm-form__field">
          <span class="tm-form__label">附加请求头 <small>JSON，可选</small></span>
          <textarea
            id="custom_include_headers"
            class="text_pole tm-form__textarea tm-form__input--mono"
            rows="2"
            value={String(oai['custom_include_headers'] ?? '')}
            onchange={(e) => set('custom_include_headers', e.currentTarget.value)}></textarea>
        </label>
      </div>
    {:else if source === S.AZURE_OPENAI}
      <div class="tm-form__section">
        <h2 class="tm-form__heading"><span>Azure</span></h2>
        <label class="tm-form__field">
          <span class="tm-form__label">Base URL</span>
          <input
            class="text_pole tm-form__input tm-form__input--mono"
            type="url"
            autocapitalize="off"
            value={String(oai['azure_base_url'] ?? '')}
            onchange={(e) => set('azure_base_url', e.currentTarget.value.trim())}
          />
        </label>
        <div class="tm-form__row tm-form__row--wrap">
          <label class="tm-form__field">
            <span class="tm-form__label">Deployment</span>
            <input
              class="text_pole tm-form__input"
              type="text"
              autocapitalize="off"
              value={String(oai['azure_deployment_name'] ?? '')}
              onchange={(e) => set('azure_deployment_name', e.currentTarget.value.trim())}
            />
          </label>
          <label class="tm-form__field">
            <span class="tm-form__label">API version</span>
            <input
              class="text_pole tm-form__input tm-form__input--mono"
              type="text"
              autocapitalize="off"
              value={String(oai['azure_api_version'] ?? '')}
              onchange={(e) => set('azure_api_version', e.currentTarget.value.trim())}
            />
          </label>
        </div>
      </div>
    {:else if source === S.WORKERS_AI}
      <label class="tm-form__field">
        <span class="tm-form__label">Cloudflare Account ID</span>
        <input
          class="text_pole tm-form__input tm-form__input--mono"
          type="text"
          autocapitalize="off"
          value={String(oai['workers_ai_account_id'] ?? '')}
          onchange={(e) => set('workers_ai_account_id', e.currentTarget.value.trim())}
        />
      </label>
    {:else if source === S.SILICONFLOW || source === S.MINIMAX || source === S.ZAI}
      {@const key =
        source === S.SILICONFLOW
          ? 'siliconflow_endpoint'
          : source === S.MINIMAX
            ? 'minimax_endpoint'
            : 'zai_endpoint'}
      {@const opts =
        source === S.SILICONFLOW
          ? SILICONFLOW_ENDPOINT_OPTIONS
          : source === S.MINIMAX
            ? MINIMAX_ENDPOINT_OPTIONS
            : ZAI_ENDPOINT_OPTIONS}
      <label class="tm-form__field">
        <span class="tm-form__label">端点</span>
        <select
          class="text_pole tm-form__select"
          value={String(oai[key] ?? opts[0].value)}
          onchange={(e) => set(key, e.currentTarget.value)}
        >
          {#each opts as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
        </select>
      </label>
    {/if}

    {#if !isTc && cfg?.proxy}
      <div class="tm-form__section">
        <h2 class="tm-form__heading">
          <span>反向代理</span>
          {#if proxyActive}<span class="tm-form__status"
              ><span class="tm-form__dot tm-form__dot--warn"></span>已启用</span
            >{/if}
        </h2>
        <label class="tm-form__field">
          <span class="tm-form__label">预设</span>
          <select
            id="openai_proxy_preset"
            class="text_pole tm-form__select"
            value={proxyName}
            onchange={(e) => chooseProxy(e.currentTarget.value)}
          >
            {#each proxies as p (p.name)}<option value={p.name}>{p.name}</option>{/each}
          </select>
        </label>
        <div class="tm-form__row tm-form__row--wrap">
          <label class="tm-form__field tm-form__field--narrow">
            <span class="tm-form__label">名称</span>
            <input
              id="openai_reverse_proxy_name"
              class="text_pole tm-form__input"
              type="text"
              autocapitalize="off"
              bind:value={proxyName}
            />
          </label>
          <label class="tm-form__field">
            <span class="tm-form__label">地址</span>
            <input
              id="openai_reverse_proxy"
              class="text_pole tm-form__input tm-form__input--mono"
              type="url"
              autocapitalize="off"
              placeholder="https://api.openai.com/v1"
              bind:value={proxyUrl}
            />
          </label>
        </div>
        <label class="tm-form__field">
          <span class="tm-form__label">密码 <small>进钥匙串；留空保持不变</small></span>
          <input
            id="openai_proxy_password"
            class="text_pole tm-form__input tm-form__input--mono"
            type="password"
            autocomplete="off"
            autocapitalize="off"
            bind:value={proxyPassword}
          />
        </label>
        <div class="tm-form__actions">
          <Button
            variant="outline"
            size="sm"
            disabled={!!busy || !proxyName.trim()}
            onclick={saveProxy}>保存反代</Button
          >
          <Button
            variant="outline"
            size="sm"
            disabled={!!busy || proxyName === 'None'}
            onclick={removeProxy}>删除</Button
          >
        </div>
        <p class="tm-form__hint">选「None」即直连。</p>
      </div>
    {/if}

    {#if isTc}
      <div class="tm-form__section">
        <h2 class="tm-form__heading">
          <span>模型</span><small>{tgModelKey ?? '由后端决定'}</small>
        </h2>
        {#if tgModelKey}
          {#if tgModelChoices.length}
            <label class="tm-form__field">
              <span class="tm-form__label">选择 <small>拉到 {models.length} 个</small></span>
              <select
                class="text_pole tm-form__select"
                value={tgModel}
                onchange={(e) => tgModelKey && setTg(tgModelKey, e.currentTarget.value)}
              >
                {#if !tgModel}<option value="">（未选择）</option>{/if}
                {#each tgModelChoices as m (m)}<option value={m}>{m}</option>{/each}
              </select>
            </label>
          {/if}
          <label class="tm-form__field">
            <span class="tm-form__label">模型 id <small>可留空，留空时由后端决定</small></span>
            <input
              class="text_pole tm-form__input tm-form__input--mono"
              type="text"
              autocapitalize="off"
              autocorrect="off"
              value={tgModel}
              onchange={(e) => tgModelKey && setTg(tgModelKey, e.currentTarget.value.trim())}
            />
          </label>
        {:else}
          <p class="tm-form__hint">这个后端用它当前加载的模型。</p>
        {/if}
        {#if tgType === TEXTGEN_TYPES.GENERIC || tgType === TEXTGEN_TYPES.OOBA}
          <label class="checkbox_label tm-form__check">
            <input
              type="checkbox"
              checked={!!tg['bypass_status_check']}
              onchange={(e) => setTg('bypass_status_check', e.currentTarget.checked)}
            />
            <span>跳过连接检查 <small>bypass_status_check</small></span>
          </label>
        {/if}
      </div>
    {:else}
      <div class="tm-form__section">
        <h2 class="tm-form__heading"><span>模型</span><small>{modelKey}</small></h2>
        <label class="tm-form__field">
          <span class="tm-form__label"
            >选择 <small>{models.length ? `拉到 ${models.length} 个` : '连接后可拉取列表'}</small
            ></span
          >
          <select
            class="text_pole tm-form__select"
            value={model}
            onchange={(e) => set(modelKey, e.currentTarget.value)}
          >
            {#if !model}<option value="">（未选择）</option>{/if}
            {#each modelChoices as m (m)}<option value={m}>{m}</option>{/each}
          </select>
        </label>
        <label class="tm-form__field">
          <span class="tm-form__label">或手动输入</span>
          <input
            class="text_pole tm-form__input tm-form__input--mono"
            type="text"
            autocapitalize="off"
            autocorrect="off"
            placeholder="模型 id"
            value={model}
            onchange={(e) => set(modelKey, e.currentTarget.value.trim())}
          />
        </label>
        <!-- ST #openai_image_inlining block: sends attached media when the model is multimodal -->
        <label class="checkbox_label tm-form__check">
          <input
            id="openai_image_inlining"
            type="checkbox"
            checked={!!oai['media_inlining']}
            onchange={(e) => set('media_inlining', e.currentTarget.checked)}
          />
          <span
            >把附件发给模型 <small
              >{inliningKinds.length
                ? `当前模型可收：${inliningKinds.join('、')}`
                : '当前模型不收附件 / 未知，发送时会跳过'}</small
            ></span
          >
        </label>
        {#if oai['media_inlining']}
          <label class="tm-form__field">
            <span class="tm-form__label">图片质量 <small>inline_image_quality</small></span>
            <select
              id="openai_inline_image_quality"
              class="text_pole tm-form__select"
              value={String(oai['inline_image_quality'] ?? 'auto')}
              onchange={(e) => set('inline_image_quality', e.currentTarget.value)}
            >
              <option value="auto">自动</option>
              <option value="low">低（省 token）</option>
              <option value="high">高</option>
            </select>
          </label>
        {/if}
        {#if source === S.OPENAI}
          <label class="checkbox_label tm-form__check">
            <input
              id="openai_show_external_models"
              type="checkbox"
              checked={!!oai['show_external_models']}
              onchange={(e) => set('show_external_models', e.currentTarget.checked)}
            />
            <span>显示账号可用的全部模型 <small>show_external_models</small></span>
          </label>
          <label class="checkbox_label tm-form__check">
            <input
              id="openai_bypass_status_check"
              type="checkbox"
              checked={!!oai['bypass_status_check']}
              onchange={(e) => set('bypass_status_check', e.currentTarget.checked)}
            />
            <span>跳过连接检查 <small>bypass_status_check</small></span>
          </label>
        {/if}
      </div>
    {/if}

    <div class="tm-form__section">
      <div class="tm-form__statusbar" id="online_status">
        <span class="tm-form__status">
          <span class="tm-form__status-line">
            <span
              class="tm-form__dot"
              class:tm-form__dot--ok={statusTone === 'ok'}
              class:tm-form__dot--bad={statusTone === 'bad'}
              class:tm-form__dot--warn={statusTone === 'warn'}
            ></span>
            {status === STATUS_NO_CONNECTION
              ? '未连接'
              : status === STATUS_VALID
                ? '已连接'
                : status === STATUS_BYPASSED
                  ? '已跳过检查'
                  : status}
          </span>
          {#if message}<span class="tm-form__status-msg">{message}</span>{/if}
        </span>
        <Button
          id="api_button_openai"
          variant={statusTone === 'ok' ? 'outline' : 'primary'}
          size="sm"
          disabled={!!busy}
          onclick={() => connect(false)}
          >{busy ?? (statusTone === 'ok' ? '重新连接' : '连接')}</Button
        >
      </div>
      <p class="tm-form__hint">改动会自动写进 settings.json；聊天页下一次生成就用新配置。</p>
    </div>
  </section>

  <BottomSheet open={!!confirmUrl} title="连接到明文 http 地址" onClose={() => (confirmUrl = null)}>
    <p class="tm-form__sheet-text">{confirmUrl}</p>
    <p class="tm-form__sheet-text">这个地址不在本机 / 局域网，密钥会以明文发送。确定继续？</p>
    <div class="tm-form__sheet-actions">
      <Button variant="outline" onclick={() => (confirmUrl = null)}>取消</Button>
      <Button variant="primary" onclick={() => connect(true)}>继续连接</Button>
    </div>
  </BottomSheet>
{/if}
