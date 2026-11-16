<script lang="ts">
  /**
   * Chat Completion presets + samplers + prompt manager (ST's AI Response Configuration drawer,
   * DEV_NOTES §9.18). Edits go to oai_settings (settings.json); presets are OpenAI Settings/*.json.
   */
  import { onDestroy, onMount } from 'svelte';
  import {
    CC_SAMPLER_SPECS,
    LOGIT_BIAS_SOURCES,
    CONTINUE_POSTFIX_OPTIONS,
    MAX_CONTEXT,
    NAMES_BEHAVIOR_OPTIONS,
    POST_PROCESSING_OPTIONS,
    PROMPT_MANAGER_DUMMY_CHARACTER_ID,
    REASONING_EFFORT_OPTIONS,
    VERBOSITY_OPTIONS,
    applyChatCompletionPreset,
    getChatCompletionPreset,
    maxContextFor,
    promptManagerDefaultPromptOrder,
    uuidv4,
    type OaiSettings,
    type PromptDef,
    type PromptOrder,
    type PromptOrderEntry,
    chatCompletionDefaultPrompts,
  } from '@tm/core';
  import Button from '@tm/ui/components/Button.svelte';
  import BottomSheet from '../lib/components/BottomSheet.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import { chatStore } from '../lib/chat/store.svelte';
  import { isTauri } from '../lib/ipc';
  import { pickFiles, readPickedJson } from '../lib/files';
  import { describeExport, exportText } from '../lib/export';
  import { askPopup } from '../lib/popup.svelte';
  import { allowPresetRegexOnce } from '../lib/regex';
  import { mainApiOf } from '../lib/chat/core-state';
  import LogitBiasEditor from '../lib/components/settings/LogitBiasEditor.svelte';
  import TextCompletionPresets from '../lib/components/settings/TextCompletionPresets.svelte';
  import {
    deleteCcPreset,
    flushSettings,
    listCcPresets,
    oaiOf,
    persistSettings,
    readCcPreset,
    writeCcPreset,
  } from '../lib/oai.svelte';

  const store = chatStore;
  // which preset panel to show follows settings.json main_api (switched on the API page)
  let mainApi = $state(mainApiOf(chatStore.settings));
  let oai = $state<OaiSettings>({});
  let presets = $state<string[]>([]);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let saveAsOpen = $state(false);
  let saveAsName = $state('');
  let deleteOpen = $state(false);
  let utilityOpen = $state(false);
  let advancedOpen = $state(false);
  let biasOpen = $state(false);
  let editing = $state<PromptDef | null>(null);
  let editingIsNew = $state(false);

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const UTILITY_PROMPTS: ReadonlyArray<readonly [string, string]> = [
    ['impersonation_prompt', 'AI 帮答'],
    ['new_chat_prompt', '新聊天'],
    ['new_group_chat_prompt', '新群聊'],
    ['new_example_chat_prompt', '示例对话'],
    ['continue_nudge_prompt', '续写提示'],
    ['group_nudge_prompt', '群聊提示'],
    ['send_if_empty', '空发送时'],
    ['wi_format', '世界书格式'],
    ['scenario_format', '场景格式'],
    ['personality_format', '性格格式'],
  ];
  const presetName = $derived(String(oai['preset_settings_openai'] ?? ''));
  const source = $derived(String(oai['chat_completion_source'] ?? 'openai'));
  const unlocked = $derived(!!oai['max_context_unlocked']);
  const maxContext = $derived(maxContextFor(source, unlocked));
  const num = (k: string, d = 0) => {
    const v = Number(oai[k]);
    return Number.isFinite(v) ? v : d;
  };
  const str = (k: string) => String(oai[k] ?? '');

  // ---- prompt manager (global strategy: dummy character 100001) ----
  const prompts = $derived((oai['prompts'] as PromptDef[] | undefined) ?? []);
  const order = $derived.by<PromptOrderEntry[]>(() => {
    const list = (oai['prompt_order'] as PromptOrder[] | undefined) ?? [];
    const mine = list.find(
      (o) => String(o.character_id) === String(PROMPT_MANAGER_DUMMY_CHARACTER_ID),
    );
    return mine?.order ?? [];
  });
  function ensureOrder(): PromptOrderEntry[] {
    const list = ((oai['prompt_order'] as PromptOrder[] | undefined) ?? []).slice();
    let mine = list.find(
      (o) => String(o.character_id) === String(PROMPT_MANAGER_DUMMY_CHARACTER_ID),
    );
    if (!mine) {
      mine = {
        character_id: PROMPT_MANAGER_DUMMY_CHARACTER_ID,
        order: structuredClone(promptManagerDefaultPromptOrder),
      };
      list.push(mine);
      oai['prompt_order'] = list;
    }
    return mine.order;
  }
  // ST sanitizeServiceSettings adds missing default prompts on load; older settings files may lack
  // e.g. personaDescription, so fall back to the defaults for display and editing
  const promptById = (id: string) =>
    prompts.find((p) => p.identifier === id) ??
    (chatCompletionDefaultPrompts.find((p) => p.identifier === id) as
      (typeof prompts)[number] | undefined);

  onMount(async () => {
    if (!isTauri()) return;
    await store.init();
    mainApi = mainApiOf(store.settings);
    oai = oaiOf(store.settings ? $state.snapshot(store.settings) : {});
    if (order.length === 0) {
      ensureOrder();
      persist();
    }
    await refreshPresets();
  });
  onDestroy(() => void flushSettings());

  function persist() {
    persistSettings({ oai_settings: $state.snapshot(oai) });
  }
  function set(key: string, value: unknown) {
    oai[key] = value;
    persist();
  }
  function setNumber(key: string, raw: string, min: number, max: number) {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    set(key, Math.min(max, Math.max(min, v)));
  }

  async function refreshPresets() {
    if (!store.root) return;
    try {
      presets = await listCcPresets(store.root);
    } catch (e) {
      error = msg(e);
    }
  }
  async function choosePreset(name: string) {
    if (!store.root || !name) return;
    busy = '载入预设…';
    error = null;
    try {
      const body = await readCcPreset(store.root, name);
      applyChatCompletionPreset(oai, body, name);
      ensureOrder();
      persist();
      const regex = allowPresetRegexOnce(
        store.settings ? ($state.snapshot(store.settings) as Record<string, unknown>) : null,
        'openai',
        name,
        oai['extensions'],
      );
      if (regex) persistSettings({ extension_settings: regex.extensionSettings });
      await flushSettings();
      notice = `已应用预设「${name}」${regex ? `，它自带的 ${regex.count} 条正则已开启（可在「正则脚本」里关）` : ''}`;
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
  async function savePreset(name: string) {
    if (!store.root) return;
    busy = '保存预设…';
    error = null;
    try {
      const stored = await writeCcPreset(
        store.root,
        name,
        getChatCompletionPreset($state.snapshot(oai)),
      );
      set('preset_settings_openai', stored);
      await refreshPresets();
      notice = `预设「${stored}」已保存`;
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
      saveAsOpen = false;
    }
  }
  /** ST `sensitiveFields` (openai.js): connection details a shared preset file should not carry */
  const PRESET_SENSITIVE = [
    'reverse_proxy',
    'proxy_password',
    'custom_url',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
    'vertexai_region',
    'vertexai_express_project_id',
    'azure_base_url',
    'azure_deployment_name',
    'workers_ai_account_id',
  ];
  const pickedName = (path: string) => decodeURIComponent(path.split(/[\\/]/).pop() ?? path);
  /**
   * ST `#import_oai_preset`: the file name becomes the preset name and the preset is applied.
   * Unlike ST we never take the file's connection fields (DEV_NOTES §9.41).
   */
  async function importPreset() {
    if (!store.root) return;
    const [file] = await pickFiles({ extensions: ['json'], title: '预设' });
    if (!file) return;
    busy = '导入预设…';
    error = null;
    try {
      const body = await readPickedJson(file);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('不是预设文件');
      const preset = body as Record<string, unknown>;
      const name = pickedName(file).replace(/\.[^/.]+$/, '');
      const dropped = PRESET_SENSITIVE.filter((k) => preset[k]);
      for (const k of dropped) delete preset[k];
      if (presets.includes(name)) {
        const ok = await askPopup({
          kind: 'confirm',
          title: '覆盖预设',
          text: `已经有叫「${name}」的预设，覆盖它？`,
          okButton: '覆盖',
        });
        if (ok !== true) return;
      }
      const stored = await writeCcPreset(store.root, name, preset);
      await refreshPresets();
      await choosePreset(stored);
      if (!error && dropped.length) notice = `${notice}。文件里带的代理 / 自定义地址没有导入`;
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
  /** ST `#export_oai_preset`: the stored preset file, without connection fields */
  async function exportPreset() {
    if (!store.root || !presets.includes(presetName)) return;
    error = null;
    try {
      const body = await readCcPreset(store.root, presetName);
      for (const k of PRESET_SENSITIVE) delete body[k];
      const target = await exportText(`${presetName}.json`, JSON.stringify(body, null, 4));
      if (target) notice = await describeExport(target);
    } catch (e) {
      error = msg(e);
    }
  }
  async function removePreset() {
    deleteOpen = false;
    if (!store.root || !presetName) return;
    busy = '删除预设…';
    try {
      await deleteCcPreset(store.root, presetName);
      await refreshPresets();
      const next = presets[0] ?? '';
      if (next) await choosePreset(next);
      else set('preset_settings_openai', '');
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }

  // ---- prompt list ops ----
  function toggle(id: string) {
    const o = ensureOrder();
    const e = o.find((x) => x.identifier === id);
    if (e) e.enabled = !e.enabled;
    persist();
  }
  function move(id: string, dir: -1 | 1) {
    const o = ensureOrder();
    const i = o.findIndex((x) => x.identifier === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j]!, o[i]!];
    persist();
  }
  function openEdit(id: string | null) {
    if (id) {
      const p = promptById(id);
      if (!p) return;
      editing = structuredClone($state.snapshot(p));
      editingIsNew = false;
    } else {
      editing = {
        identifier: uuidv4(),
        name: '新 prompt',
        role: 'system',
        content: '',
        system_prompt: false,
        marker: false,
        injection_position: 0,
        injection_depth: 4,
        injection_order: 100,
      };
      editingIsNew = true;
    }
  }
  function commitEdit() {
    if (!editing) return;
    const def = $state.snapshot(editing) as PromptDef;
    const list = prompts.slice();
    const i = list.findIndex((p) => p.identifier === def.identifier);
    if (i >= 0) list[i] = def;
    else list.push(def);
    oai['prompts'] = list;
    if (editingIsNew) ensureOrder().push({ identifier: def.identifier, enabled: true });
    editing = null;
    persist();
  }
  function removePrompt(id: string) {
    const p = promptById(id);
    if (!p || p.system_prompt || p.marker) return;
    oai['prompts'] = prompts.filter((x) => x.identifier !== id);
    const o = ensureOrder();
    const i = o.findIndex((x) => x.identifier === id);
    if (i >= 0) o.splice(i, 1);
    editing = null;
    persist();
  }
</script>

{#if !isTauri()}
  <section class="tm-form"><p class="tm-form__hint">预设需要在 app 里运行。</p></section>
{:else if mainApi === 'textgenerationwebui'}
  <section class="tm-form drawer-content" id="left-nav-panel">
    <p class="tm-form__hint">当前是 Text Completion（在「API 连接」页切换 API 类型）。</p>
    <TextCompletionPresets />
  </section>
{:else}
  <section class="tm-form">
    {#if error}
      <p class="tm-form__error" role="alert">
        <span>{error}</span><button class="tm-form__link" onclick={() => (error = null)}
          >关闭</button
        >
      </p>
    {/if}
    {#if notice}
      <p class="tm-form__notice">
        <span>{notice}</span><button class="tm-form__link" onclick={() => (notice = null)}
          >关闭</button
        >
      </p>
    {/if}

    <div class="tm-form__section">
      <label class="tm-form__field">
        <span class="tm-form__label">预设 <small>OpenAI Settings/</small></span>
        <select
          id="settings_preset_openai"
          class="text_pole tm-form__select"
          value={presetName}
          disabled={!!busy}
          onchange={(e) => choosePreset(e.currentTarget.value)}
        >
          {#if !presets.includes(presetName)}<option value={presetName}
              >{presetName || '（未保存）'}</option
            >{/if}
          {#each presets as p (p)}<option value={p}>{p}</option>{/each}
        </select>
      </label>
      <div class="tm-form__actions">
        <Button
          variant="outline"
          size="sm"
          disabled={!!busy || !presetName}
          onclick={() => savePreset(presetName)}>保存到当前预设</Button
        >
        <Button
          variant="outline"
          size="sm"
          disabled={!!busy}
          onclick={() => {
            saveAsName = presetName;
            saveAsOpen = true;
          }}>另存为…</Button
        >
        <Button
          id="import_oai_preset"
          variant="outline"
          size="sm"
          disabled={!!busy}
          onclick={importPreset}>导入</Button
        >
        <Button
          id="export_oai_preset"
          variant="outline"
          size="sm"
          disabled={!!busy || !presets.includes(presetName)}
          onclick={exportPreset}>导出</Button
        >
        <Button
          variant="ghost"
          size="sm"
          disabled={!!busy || !presets.includes(presetName)}
          onclick={() => (deleteOpen = true)}>删除</Button
        >
      </div>
      <label class="checkbox_label tm-form__check">
        <input
          type="checkbox"
          checked={!!oai['bind_preset_to_connection']}
          onchange={(e) => set('bind_preset_to_connection', e.currentTarget.checked)}
        />
        <span>预设绑定连接 <small>切换预设时一并切换来源 / 模型 / 反代</small></span>
      </label>
    </div>

    <div class="tm-form__section">
      <h2 class="tm-form__heading"><span>上下文</span></h2>
      <label class="tm-form__field">
        <span class="tm-form__label"
          >上下文长度 <small>openai_max_context</small><span class="tm-form__value"
            >{num('openai_max_context')}</span
          ></span
        >
        <input
          id="openai_max_context"
          class="neo-range-slider tm-form__range"
          type="range"
          min="512"
          max={maxContext}
          step="1"
          value={num('openai_max_context')}
          oninput={(e) => setNumber('openai_max_context', e.currentTarget.value, 512, maxContext)}
        />
        <input
          class="text_pole tm-form__input tm-form__input--mono"
          type="number"
          min="512"
          max={maxContext}
          value={num('openai_max_context')}
          onchange={(e) => setNumber('openai_max_context', e.currentTarget.value, 512, maxContext)}
        />
      </label>
      <label class="checkbox_label tm-form__check">
        <input
          id="oai_max_context_unlocked"
          type="checkbox"
          checked={unlocked}
          onchange={(e) => set('max_context_unlocked', e.currentTarget.checked)}
        />
        <span>解锁上下文上限 <small>最高 {MAX_CONTEXT.unlocked_max}</small></span>
      </label>
      <label class="tm-form__field">
        <span class="tm-form__label">回复最大 token <small>openai_max_tokens</small></span>
        <input
          id="openai_max_tokens"
          class="text_pole tm-form__input tm-form__input--mono"
          type="number"
          min="1"
          max="128000"
          value={num('openai_max_tokens')}
          onchange={(e) => setNumber('openai_max_tokens', e.currentTarget.value, 1, 128000)}
        />
      </label>
      <label class="checkbox_label tm-form__check">
        <input
          id="stream_toggle"
          type="checkbox"
          checked={!!oai['stream_openai']}
          onchange={(e) => set('stream_openai', e.currentTarget.checked)}
        />
        <span>流式输出</span>
      </label>
    </div>

    <div class="tm-form__section">
      <h2 class="tm-form__heading"><span>采样</span></h2>
      {#each CC_SAMPLER_SPECS as sp (sp.key)}
        <label class="tm-form__field">
          <span class="tm-form__label"
            >{sp.label} <small>{sp.key}</small><span class="tm-form__value">{num(sp.key)}</span
            ></span
          >
          <input
            id={sp.key}
            class="neo-range-slider tm-form__range"
            type="range"
            min={sp.min}
            max={sp.max}
            step={sp.step}
            value={num(sp.key)}
            oninput={(e) => setNumber(sp.key, e.currentTarget.value, sp.min, sp.max)}
          />
        </label>
      {/each}
      <div class="tm-form__row tm-form__row--wrap">
        <label class="tm-form__field">
          <span class="tm-form__label">Seed <small>-1 = 随机</small></span>
          <input
            id="seed_openai"
            class="text_pole tm-form__input tm-form__input--mono"
            type="number"
            min="-1"
            max="2147483647"
            value={num('seed', -1)}
            onchange={(e) => setNumber('seed', e.currentTarget.value, -1, 2147483647)}
          />
        </label>
        <label class="tm-form__field">
          <span class="tm-form__label">推理强度 <small>reasoning_effort</small></span>
          <select
            id="openai_reasoning_effort"
            class="text_pole tm-form__select"
            value={str('reasoning_effort') || 'auto'}
            onchange={(e) => set('reasoning_effort', e.currentTarget.value)}
          >
            {#each REASONING_EFFORT_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option
              >{/each}
          </select>
        </label>
      </div>
    </div>

    <button
      class="tm-form__heading"
      style:width="100%"
      aria-expanded={advancedOpen}
      onclick={() => (advancedOpen = !advancedOpen)}
    >
      <span>更多选项</span><Icon name={advancedOpen ? 'chevron-up' : 'chevron-down'} />
    </button>
    {#if advancedOpen}
      <div class="tm-form__section">
        <label class="tm-form__field">
          <span class="tm-form__label">角色名处理 <small>names_behavior</small></span>
          <select
            id="names_behavior"
            class="text_pole tm-form__select"
            value={String(num('names_behavior'))}
            onchange={(e) => set('names_behavior', Number(e.currentTarget.value))}
          >
            {#each NAMES_BEHAVIOR_OPTIONS as o (o.value)}<option value={String(o.value)}
                >{o.label}</option
              >{/each}
          </select>
        </label>
        <label class="tm-form__field">
          <span class="tm-form__label">续写拼接 <small>continue_postfix</small></span>
          <select
            id="continue_postfix"
            class="text_pole tm-form__select"
            value={str('continue_postfix')}
            onchange={(e) => set('continue_postfix', e.currentTarget.value)}
          >
            {#each CONTINUE_POSTFIX_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option
              >{/each}
          </select>
        </label>
        <label class="tm-form__field">
          <span class="tm-form__label">提示后处理 <small>custom_prompt_post_processing</small></span
          >
          <select
            id="custom_prompt_post_processing"
            class="text_pole tm-form__select"
            value={str('custom_prompt_post_processing')}
            onchange={(e) => set('custom_prompt_post_processing', e.currentTarget.value)}
          >
            {#each POST_PROCESSING_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option
              >{/each}
          </select>
        </label>
        <label class="tm-form__field">
          <span class="tm-form__label">详细程度 <small>verbosity</small></span>
          <select
            id="openai_verbosity"
            class="text_pole tm-form__select"
            value={str('verbosity') || 'auto'}
            onchange={(e) => set('verbosity', e.currentTarget.value)}
          >
            {#each VERBOSITY_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option
              >{/each}
          </select>
        </label>
        <label class="checkbox_label tm-form__check">
          <input
            id="squash_system_messages"
            type="checkbox"
            checked={!!oai['squash_system_messages']}
            onchange={(e) => set('squash_system_messages', e.currentTarget.checked)}
          />
          <span>合并连续的系统消息 <small>squash_system_messages</small></span>
        </label>
        <label class="checkbox_label tm-form__check">
          <input
            id="openai_function_calling"
            type="checkbox"
            checked={!!oai['function_calling']}
            onchange={(e) => set('function_calling', e.currentTarget.checked)}
          />
          <span>允许工具调用（扩展和脚本注册的工具）<small>function_calling</small></span>
        </label>
        <label class="checkbox_label tm-form__check">
          <input
            id="use_sysprompt"
            type="checkbox"
            checked={!!oai['use_sysprompt']}
            onchange={(e) => set('use_sysprompt', e.currentTarget.checked)}
          />
          <span>使用系统提示 <small>use_sysprompt（Claude / Gemini）</small></span>
        </label>
        <label class="checkbox_label tm-form__check">
          <input
            id="continue_prefill"
            type="checkbox"
            checked={!!oai['continue_prefill']}
            onchange={(e) => set('continue_prefill', e.currentTarget.checked)}
          />
          <span>续写用 prefill <small>continue_prefill</small></span>
        </label>
        <label class="checkbox_label tm-form__check">
          <input
            id="openai_show_thoughts"
            type="checkbox"
            checked={!!oai['show_thoughts']}
            onchange={(e) => set('show_thoughts', e.currentTarget.checked)}
          />
          <span>请求模型思考过程 <small>show_thoughts</small></span>
        </label>
        <label class="tm-form__field">
          <span class="tm-form__label">Assistant 预填 <small>assistant_prefill</small></span>
          <textarea
            id="claude_assistant_prefill"
            class="text_pole tm-form__textarea"
            rows="2"
            value={str('assistant_prefill')}
            onchange={(e) => set('assistant_prefill', e.currentTarget.value)}></textarea>
        </label>
        <label class="tm-form__field">
          <span class="tm-form__label">AI 帮答预填 <small>assistant_impersonation</small></span>
          <textarea
            id="claude_assistant_impersonation"
            class="text_pole tm-form__textarea"
            rows="2"
            value={str('assistant_impersonation')}
            onchange={(e) => set('assistant_impersonation', e.currentTarget.value)}></textarea>
        </label>
      </div>
    {/if}

    <button
      class="tm-form__heading"
      style:width="100%"
      aria-expanded={biasOpen}
      onclick={() => (biasOpen = !biasOpen)}
    >
      <span>Logit bias</span><Icon name={biasOpen ? 'chevron-up' : 'chevron-down'} />
    </button>
    {#if biasOpen}
      <LogitBiasEditor
        selected={String(oai['bias_preset_selected'] ?? '')}
        presets={(oai['bias_presets'] as Record<string, unknown> | undefined) ?? {}}
        supported={LOGIT_BIAS_SOURCES.includes(source)}
        onChange={(selected, presets) => {
          oai['bias_preset_selected'] = selected;
          oai['bias_presets'] = presets;
          persist();
        }}
      />
    {/if}

    <button
      class="tm-form__heading"
      style:width="100%"
      aria-expanded={utilityOpen}
      onclick={() => (utilityOpen = !utilityOpen)}
    >
      <span>辅助提示词</span><Icon name={utilityOpen ? 'chevron-up' : 'chevron-down'} />
    </button>
    {#if utilityOpen}
      <div class="tm-form__section">
        {#each UTILITY_PROMPTS as [key, label] (key)}
          <label class="tm-form__field">
            <span class="tm-form__label">{label} <small>{key}</small></span>
            <textarea
              class="text_pole tm-form__textarea"
              rows="2"
              value={str(key)}
              onchange={(e) => set(key, e.currentTarget.value)}></textarea>
          </label>
        {/each}
      </div>
    {/if}

    <div class="tm-form__section">
      <h2 class="tm-form__heading">
        <span>Prompt 顺序</span>
        <button class="menu_button tm-form__chip" onclick={() => openEdit(null)}
          ><Icon name="plus" size="sm" />新建</button
        >
      </h2>
      <div class="tm-form__list" id="completion_prompt_manager_list">
        {#each order as entry, i (entry.identifier)}
          {@const p = promptById(entry.identifier)}
          <div class="tm-form__item" class:is-off={!entry.enabled}>
            <input
              type="checkbox"
              checked={entry.enabled}
              aria-label="启用"
              onchange={() => toggle(entry.identifier)}
            />
            <button
              class="tm-form__item-name"
              style:text-align="left"
              onclick={() => openEdit(entry.identifier)}
            >
              {p?.name ?? entry.identifier}
              <span class="tm-form__item-meta">
                {p?.marker ? ' · 标记' : p?.role ? ` · ${p.role}` : ''}{p?.injection_position === 1
                  ? ` · 深度 ${p.injection_depth ?? 4}`
                  : ''}
              </span>
            </button>
            <span class="tm-form__item-actions">
              <button
                class="tm-form__icon"
                aria-label="上移"
                disabled={i === 0}
                onclick={() => move(entry.identifier, -1)}><Icon name="chevron-up" /></button
              >
              <button
                class="tm-form__icon"
                aria-label="下移"
                disabled={i === order.length - 1}
                onclick={() => move(entry.identifier, 1)}><Icon name="chevron-down" /></button
              >
            </span>
          </div>
        {/each}
      </div>
    </div>
  </section>

  <BottomSheet open={saveAsOpen} title="另存为预设" onClose={() => (saveAsOpen = false)}>
    <input
      aria-label="预设名"
      class="text_pole tm-form__input"
      type="text"
      bind:value={saveAsName}
      placeholder="预设名"
      autocapitalize="off"
    />
    <div class="tm-form__sheet-actions">
      <Button variant="outline" onclick={() => (saveAsOpen = false)}>取消</Button>
      <Button
        variant="primary"
        disabled={!saveAsName.trim()}
        onclick={() => savePreset(saveAsName.trim())}>保存</Button
      >
    </div>
  </BottomSheet>

  <BottomSheet open={deleteOpen} title="删除预设" onClose={() => (deleteOpen = false)}>
    <p class="tm-form__sheet-text">删除「{presetName}」的文件？当前设置不会变。</p>
    <div class="tm-form__sheet-actions">
      <Button variant="outline" onclick={() => (deleteOpen = false)}>取消</Button>
      <Button variant="primary" onclick={removePreset}>删除</Button>
    </div>
  </BottomSheet>

  <BottomSheet
    open={!!editing}
    title={editingIsNew ? '新建 prompt' : '编辑 prompt'}
    onClose={() => (editing = null)}
  >
    {#if editing}
      <label class="tm-form__field">
        <span class="tm-form__label">名称</span>
        <input class="text_pole tm-form__input" type="text" bind:value={editing.name} />
      </label>
      {#if !editing.marker}
        <div class="tm-form__row tm-form__row--wrap">
          <label class="tm-form__field">
            <span class="tm-form__label">角色</span>
            <select
              class="text_pole tm-form__select"
              value={editing.role ?? 'system'}
              onchange={(e) => {
                if (editing) editing.role = e.currentTarget.value;
              }}
            >
              <option value="system">system</option>
              <option value="user">user</option>
              <option value="assistant">assistant</option>
            </select>
          </label>
          <label class="tm-form__field">
            <span class="tm-form__label">位置</span>
            <select
              class="text_pole tm-form__select"
              value={String(editing.injection_position ?? 0)}
              onchange={(e) => {
                if (editing) editing.injection_position = Number(e.currentTarget.value);
              }}
            >
              <option value="0">相对（按顺序）</option>
              <option value="1">绝对（聊天内深度）</option>
            </select>
          </label>
        </div>
        {#if editing.injection_position === 1}
          <div class="tm-form__row tm-form__row--wrap">
            <label class="tm-form__field">
              <span class="tm-form__label">深度</span>
              <input
                class="text_pole tm-form__input tm-form__input--mono"
                type="number"
                min="0"
                value={editing.injection_depth ?? 4}
                onchange={(e) => {
                  if (editing) editing.injection_depth = Number(e.currentTarget.value);
                }}
              />
            </label>
            <label class="tm-form__field">
              <span class="tm-form__label">次序</span>
              <input
                class="text_pole tm-form__input tm-form__input--mono"
                type="number"
                value={editing.injection_order ?? 100}
                onchange={(e) => {
                  if (editing) editing.injection_order = Number(e.currentTarget.value);
                }}
              />
            </label>
          </div>
        {/if}
        <label class="tm-form__field">
          <span class="tm-form__label">内容</span>
          <textarea class="text_pole tm-form__textarea" rows="6" bind:value={editing.content}
          ></textarea>
        </label>
      {:else}
        <p class="tm-form__sheet-text">这是一个标记项（由程序填入内容），只能调整位置与开关。</p>
      {/if}
      <div class="tm-form__sheet-actions">
        {#if !editingIsNew && !editing.system_prompt && !editing.marker}
          <button
            class="menu_button tm-form__chip tm-form__chip--danger"
            onclick={() => editing && removePrompt(editing.identifier)}>删除</button
          >
        {/if}
        <Button variant="outline" onclick={() => (editing = null)}>取消</Button>
        <Button variant="primary" onclick={commitEdit}>确定</Button>
      </div>
    {/if}
  </BottomSheet>
{/if}
