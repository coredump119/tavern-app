<script lang="ts">
  /**
   * Text Completion presets + samplers + formatting templates (ST "AI Response Configuration" for
   * textgenerationwebui and "AI Response Formatting"; DEV_NOTES §9.19).
   */
  import { onDestroy, onMount } from 'svelte';
  import {
    AMOUNT_GEN_DEFAULT,
    AMOUNT_GEN_RANGE,
    TC_MAX_CONTEXT_DEFAULT,
    TC_MAX_CONTEXT_RANGE,
    TC_SAMPLER_SPECS,
    TC_UNLOCKED,
    applyContextTemplate,
    applyInstructTemplate,
    applySystemPromptTemplate,
    applyTextgenPreset,
    getTextgenPreset,
    loadTextgenSettings,
    type TextgenSettings,
  } from '@tm/core';
  import Button from '@tm/ui/components/Button.svelte';
  import BottomSheet from '../BottomSheet.svelte';
  import { chatStore } from '../../chat/store.svelte';
  import { pickFiles, readPickedJson } from '../../files';
  import { askPopup } from '../../popup.svelte';
  import { allowPresetRegexOnce } from '../../regex';
  import { mainApiOf } from '../../chat/core-state';
  import {
    TC_PRESET_DIR,
    TEMPLATE_DIRS,
    deleteTcPreset,
    flushSettings,
    listJsonNames,
    persistSettings,
    readJson,
    writeTcPreset,
    type TemplateKind,
  } from '../../oai.svelte';

  const store = chatStore;
  let tg = $state<TextgenSettings>(loadTextgenSettings({}));
  let pu = $state<Record<string, unknown>>({});
  let amountGen = $state(AMOUNT_GEN_DEFAULT);
  let maxContext = $state(TC_MAX_CONTEXT_DEFAULT);
  let presets = $state<string[]>([]);
  let templates = $state<Record<TemplateKind, string[]>>({
    instruct: [],
    context: [],
    sysprompt: [],
  });
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let saveAsOpen = $state(false);
  let saveAsName = $state('');
  let deleteOpen = $state(false);

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const presetName = $derived(String(tg['preset'] ?? ''));
  const unlocked = $derived(!!pu['max_context_unlocked']);
  const ctxMax = $derived(unlocked ? TC_UNLOCKED.maxContext : TC_MAX_CONTEXT_RANGE.max);
  const genMax = $derived(unlocked ? TC_UNLOCKED.amountGen : AMOUNT_GEN_RANGE.max);
  const instruct = $derived((pu['instruct'] as Record<string, unknown> | undefined) ?? {});
  const context = $derived((pu['context'] as Record<string, unknown> | undefined) ?? {});
  const sysprompt = $derived((pu['sysprompt'] as Record<string, unknown> | undefined) ?? {});
  const num = (k: string, d = 0) => {
    const v = Number(tg[k]);
    return Number.isFinite(v) ? v : d;
  };

  onMount(async () => {
    await store.init();
    const settings = store.settings ? $state.snapshot(store.settings) : {};
    tg = loadTextgenSettings(settings);
    pu = structuredClone((settings['power_user'] as Record<string, unknown> | undefined) ?? {});
    amountGen = Number(settings['amount_gen'] ?? AMOUNT_GEN_DEFAULT);
    maxContext = Number(settings['max_context'] ?? TC_MAX_CONTEXT_DEFAULT);
    await refreshLists();
  });
  onDestroy(() => void flushSettings());

  async function refreshLists() {
    if (!store.root) return;
    try {
      presets = await listJsonNames(store.root, TC_PRESET_DIR);
      templates = {
        instruct: await listJsonNames(store.root, TEMPLATE_DIRS.instruct),
        context: await listJsonNames(store.root, TEMPLATE_DIRS.context),
        sysprompt: await listJsonNames(store.root, TEMPLATE_DIRS.sysprompt),
      };
    } catch (e) {
      error = msg(e);
    }
  }

  function persist() {
    persistSettings({
      textgenerationwebui_settings: $state.snapshot(tg),
      amount_gen: amountGen,
      max_context: maxContext,
      power_user: $state.snapshot(pu),
    });
  }
  function setNumber(key: string, raw: string, min: number, max: number) {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    tg[key] = Math.min(max, Math.max(min, v));
    persist();
  }

  // ---- presets (TextGen Settings/*.json) ----
  async function choosePreset(name: string) {
    if (!store.root || !name) return;
    busy = '载入预设…';
    error = null;
    try {
      const body = await readJson(store.root, TC_PRESET_DIR, name);
      const r = applyTextgenPreset(tg, body, name, { amountGen, maxContext });
      if (r.amountGen !== undefined) amountGen = r.amountGen;
      if (r.maxContext !== undefined) maxContext = r.maxContext;
      pu['max_context_unlocked'] = r.maxContextUnlocked;
      persist();
      const regex = allowPresetRegexOnce(
        store.settings ? ($state.snapshot(store.settings) as Record<string, unknown>) : null,
        mainApiOf(store.settings),
        name,
        tg['extensions'],
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
      const body = getTextgenPreset($state.snapshot(tg) as TextgenSettings, amountGen, maxContext);
      const stored = await writeTcPreset(store.root, name, body);
      tg['preset'] = stored;
      persist();
      await refreshLists();
      notice = `预设「${stored}」已保存`;
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
      saveAsOpen = false;
    }
  }
  /** ST preset manager import: the file name becomes the preset name, then it is applied */
  async function importPreset() {
    if (!store.root) return;
    const [file] = await pickFiles({ extensions: ['json'], title: '预设' });
    if (!file) return;
    busy = '导入预设…';
    error = null;
    try {
      const body = await readPickedJson(file);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('不是预设文件');
      const base = decodeURIComponent(file.split(/[\\/]/).pop() ?? file);
      const name = base.replace(/\.[^/.]+$/, '');
      if (presets.includes(name)) {
        const ok = await askPopup({
          kind: 'confirm',
          title: '覆盖预设',
          text: `已经有叫「${name}」的预设，覆盖它？`,
          okButton: '覆盖',
        });
        if (ok !== true) return;
      }
      const stored = await writeTcPreset(store.root, name, body as Record<string, unknown>);
      await refreshLists();
      await choosePreset(stored);
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
  async function removePreset() {
    deleteOpen = false;
    if (!store.root || !presetName) return;
    busy = '删除预设…';
    try {
      await deleteTcPreset(store.root, presetName);
      await refreshLists();
      const next = presets[0] ?? '';
      if (next) await choosePreset(next);
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }

  // ---- formatting templates ----
  async function chooseTemplate(kind: TemplateKind, name: string, chained = false) {
    if (!store.root || !name) return;
    try {
      const body = await readJson(store.root, TEMPLATE_DIRS[kind], name);
      if (kind === 'instruct') {
        // ST #instruct_presets change: copy the template's fields (incl. `enabled` only when the file
        // has it); only the auto / slash path (selectInstructPreset) forces instruct mode on
        const bound = applyInstructTemplate(pu, body, name);
        if (bound && !chained && templates.context.includes(bound))
          await chooseTemplate('context', bound, true);
      } else if (kind === 'context') {
        const bound = applyContextTemplate(pu, body, name);
        if (bound && !chained && templates.instruct.includes(bound))
          await chooseTemplate('instruct', bound, true);
      } else {
        applySystemPromptTemplate(pu, body, name);
      }
      pu = { ...pu };
      persist();
    } catch (e) {
      error = msg(e);
    }
  }
  function toggle(kind: 'instruct' | 'sysprompt', on: boolean) {
    const block = { ...((pu[kind] as Record<string, unknown> | undefined) ?? {}), enabled: on };
    pu = { ...pu, [kind]: block };
    persist();
  }
</script>

<div class="tm-form__section">
  {#if error}
    <p class="tm-form__error" role="alert">
      <span>{error}</span><button class="tm-form__link" onclick={() => (error = null)}>关闭</button>
    </p>
  {/if}
  {#if notice}
    <p class="tm-form__notice">
      <span>{notice}</span><button class="tm-form__link" onclick={() => (notice = null)}
        >关闭</button
      >
    </p>
  {/if}
  <label class="tm-form__field">
    <span class="tm-form__label">预设 <small>TextGen Settings/</small></span>
    <select
      id="settings_preset_textgenerationwebui"
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
    <Button variant="outline" size="sm" disabled={!!busy} onclick={importPreset}>导入</Button>
    <Button
      variant="ghost"
      size="sm"
      disabled={!!busy || !presets.includes(presetName)}
      onclick={() => (deleteOpen = true)}>删除</Button
    >
  </div>
</div>

<div class="tm-form__section">
  <h2 class="tm-form__heading"><span>上下文</span></h2>
  <label class="tm-form__field">
    <span class="tm-form__label"
      >回复长度 <small>amount_gen</small><span class="tm-form__value">{amountGen}</span></span
    >
    <input
      id="amount_gen"
      class="neo-range-slider tm-form__range"
      type="range"
      min={AMOUNT_GEN_RANGE.min}
      max={genMax}
      step={AMOUNT_GEN_RANGE.step}
      value={amountGen}
      oninput={(e) => {
        amountGen = Math.min(genMax, Math.max(AMOUNT_GEN_RANGE.min, Number(e.currentTarget.value)));
        persist();
      }}
    />
  </label>
  <label class="tm-form__field">
    <span class="tm-form__label"
      >上下文长度 <small>max_context</small><span class="tm-form__value">{maxContext}</span></span
    >
    <input
      id="max_context"
      class="neo-range-slider tm-form__range"
      type="range"
      min={TC_MAX_CONTEXT_RANGE.min}
      max={ctxMax}
      step={TC_MAX_CONTEXT_RANGE.step}
      value={maxContext}
      oninput={(e) => {
        maxContext = Math.min(
          ctxMax,
          Math.max(TC_MAX_CONTEXT_RANGE.min, Number(e.currentTarget.value)),
        );
        persist();
      }}
    />
    <input
      class="text_pole tm-form__input tm-form__input--mono"
      type="number"
      min={TC_MAX_CONTEXT_RANGE.min}
      max={ctxMax}
      value={maxContext}
      onchange={(e) => {
        const v = Number(e.currentTarget.value);
        if (Number.isFinite(v))
          maxContext = Math.min(ctxMax, Math.max(TC_MAX_CONTEXT_RANGE.min, v));
        persist();
      }}
    />
  </label>
  <label class="checkbox_label tm-form__check">
    <input
      id="max_context_unlocked"
      type="checkbox"
      checked={unlocked}
      onchange={(e) => {
        pu = { ...pu, max_context_unlocked: e.currentTarget.checked };
        persist();
      }}
    />
    <span
      >解锁上限 <small>上下文 {TC_UNLOCKED.maxContext} / 回复 {TC_UNLOCKED.amountGen}</small></span
    >
  </label>
  <label class="checkbox_label tm-form__check">
    <input
      id="streaming_textgenerationwebui"
      type="checkbox"
      checked={!!tg.streaming}
      onchange={(e) => {
        tg.streaming = e.currentTarget.checked;
        persist();
      }}
    />
    <span>流式输出</span>
  </label>
</div>

<div class="tm-form__section">
  <h2 class="tm-form__heading"><span>采样</span></h2>
  {#each TC_SAMPLER_SPECS as sp (sp.key)}
    <label class="tm-form__field">
      <span class="tm-form__label"
        >{sp.label} <small>{sp.key}</small><span class="tm-form__value">{num(sp.key)}</span></span
      >
      <input
        id="{sp.key}_textgenerationwebui"
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
  <label class="tm-form__field">
    <span class="tm-form__label">Seed <small>-1 = 随机</small></span>
    <input
      id="seed_textgenerationwebui"
      class="text_pole tm-form__input tm-form__input--mono"
      type="number"
      min="-1"
      value={num('seed', -1)}
      onchange={(e) => setNumber('seed', e.currentTarget.value, -1, 2147483647)}
    />
  </label>
  <p class="tm-form__hint">
    后端不支持的参数会被忽略。采样顺序、DRY / Mirostat 细项、logit bias
    与禁用词还没做编辑界面，沿用预设里的值。
  </p>
</div>

<div class="tm-form__section">
  <h2 class="tm-form__heading"><span>格式模板</span></h2>
  <label class="checkbox_label tm-form__check">
    <input
      id="instruct_enabled"
      type="checkbox"
      checked={!!instruct['enabled']}
      onchange={(e) => toggle('instruct', e.currentTarget.checked)}
    />
    <span>Instruct 模式 <small>按模型的对话模板包装每条消息</small></span>
  </label>
  <label class="tm-form__field">
    <span class="tm-form__label">Instruct 模板 <small>instruct/</small></span>
    <select
      id="instruct_presets"
      class="text_pole tm-form__select"
      value={String(instruct['preset'] ?? '')}
      onchange={(e) => chooseTemplate('instruct', e.currentTarget.value)}
    >
      {#if !templates.instruct.includes(String(instruct['preset'] ?? ''))}
        <option value={String(instruct['preset'] ?? '')}>{instruct['preset'] || '（无）'}</option>
      {/if}
      {#each templates.instruct as t (t)}<option value={t}>{t}</option>{/each}
    </select>
  </label>
  <label class="tm-form__field">
    <span class="tm-form__label">Context 模板 <small>context/ · story string</small></span>
    <select
      id="context_presets"
      class="text_pole tm-form__select"
      value={String(context['preset'] ?? '')}
      onchange={(e) => chooseTemplate('context', e.currentTarget.value)}
    >
      {#if !templates.context.includes(String(context['preset'] ?? ''))}
        <option value={String(context['preset'] ?? '')}>{context['preset'] || '（无）'}</option>
      {/if}
      {#each templates.context as t (t)}<option value={t}>{t}</option>{/each}
    </select>
  </label>
  <label class="checkbox_label tm-form__check">
    <input
      id="sysprompt_enabled"
      type="checkbox"
      checked={!!sysprompt['enabled']}
      onchange={(e) => toggle('sysprompt', e.currentTarget.checked)}
    />
    <span>系统提示词</span>
  </label>
  <label class="tm-form__field">
    <span class="tm-form__label">系统提示词模板 <small>sysprompt/</small></span>
    <select
      id="sysprompt_select"
      class="text_pole tm-form__select"
      value={String(sysprompt['name'] ?? '')}
      onchange={(e) => chooseTemplate('sysprompt', e.currentTarget.value)}
    >
      {#if !templates.sysprompt.includes(String(sysprompt['name'] ?? ''))}
        <option value={String(sysprompt['name'] ?? '')}>{sysprompt['name'] || '（无）'}</option>
      {/if}
      {#each templates.sysprompt as t (t)}<option value={t}>{t}</option>{/each}
    </select>
  </label>
  {#if instruct['bind_to_context']}
    <p class="tm-form__hint">已绑定：选 Instruct 模板会同时切换同名 Context 模板，反之亦然。</p>
  {/if}
  <p class="tm-form__hint">模板只能整份切换，逐字段编辑还没做。</p>
</div>

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
