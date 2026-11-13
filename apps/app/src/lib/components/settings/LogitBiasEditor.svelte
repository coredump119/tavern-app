<script lang="ts">
  /**
   * Logit bias presets (ST `#openai_logit_bias_preset` + entry list — DEV_NOTES §9.36).
   * Stateless about storage: every edit hands the parent the new selection and preset map.
   */
  import {
    exportLogitBiasPreset,
    importLogitBiasPreset,
    LOGIT_BIAS_MAX,
    LOGIT_BIAS_MIN,
    logitBiasEntries,
    uuidv4,
    type LogitBiasEntry,
  } from '@tm/core';
  import Button from '@tm/ui/components/Button.svelte';
  import Icon from '../Icon.svelte';
  import { pickFiles, readPickedJson } from '../../files';
  import { describeExport, exportText } from '../../export';

  interface Props {
    selected: string;
    presets: Record<string, unknown>;
    /** false when the current source ignores logit bias */
    supported: boolean;
    onChange: (selected: string, presets: Record<string, LogitBiasEntry[]>) => void;
  }
  let { selected, presets, supported, onChange }: Props = $props();

  let newName = $state('');
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let confirmDelete = $state(false);

  const names = $derived(Object.keys(presets));
  const entries = $derived(logitBiasEntries(presets[selected]));
  const all = (): Record<string, LogitBiasEntry[]> =>
    Object.fromEntries(names.map((n) => [n, logitBiasEntries(presets[n])]));

  function commit(list: LogitBiasEntry[]) {
    if (!selected) return;
    onChange(selected, { ...all(), [selected]: list });
  }
  function create() {
    const name = newName.trim();
    if (!name) return;
    if (names.includes(name)) {
      error = '已经有同名的偏置预设。';
      return;
    }
    error = null;
    newName = '';
    onChange(name, { ...all(), [name]: [] });
  }
  function remove() {
    const rest = all();
    delete rest[selected];
    confirmDelete = false;
    onChange(Object.keys(rest)[0] ?? '', rest);
  }
  /** ST `#openai_logit_bias_import_file`: the preset takes the file's name and gets selected */
  async function importPreset() {
    error = null;
    notice = null;
    try {
      const [file] = await pickFiles({ extensions: ['json'], title: 'Logit bias 预设' });
      if (!file) return;
      const fileName = decodeURIComponent(file.split(/[\\/]/).pop() ?? file);
      const got = importLogitBiasPreset(await readPickedJson(file), fileName, names, uuidv4);
      if ('error' in got) {
        error =
          got.error === 'duplicate' ? '预设名不能重复。' : '这不是有效的 logit bias 预设文件。';
        return;
      }
      confirmDelete = false;
      onChange(got.name, { ...all(), [got.name]: got.entries });
      notice = `已导入「${got.name}」`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  /** ST `#openai_logit_bias_export_preset`: nothing happens without a selected preset */
  async function exportPreset() {
    if (!selected || !names.includes(selected)) return;
    error = null;
    notice = null;
    try {
      const target = await exportText(`${selected}.json`, exportLogitBiasPreset(entries));
      if (target) notice = await describeExport(target);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  function patch(index: number, edit: Partial<LogitBiasEntry>) {
    commit(entries.map((e, i) => (i === index ? { ...e, ...edit } : e)));
  }
  function setValue(index: number, raw: string) {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    patch(index, { value: Math.min(LOGIT_BIAS_MAX, Math.max(LOGIT_BIAS_MIN, v)) });
  }
</script>

<div class="tm-form__section">
  {#if !supported}
    <p class="tm-form__hint">当前的接口来源不支持 logit bias，这里的设置不会发出去。</p>
  {/if}
  <label class="tm-form__field">
    <span class="tm-form__label">偏置预设</span>
    <select
      id="openai_logit_bias_preset"
      class="text_pole tm-form__select"
      value={selected}
      onchange={(e) => {
        confirmDelete = false;
        onChange(e.currentTarget.value, all());
      }}
    >
      {#if !selected || !names.includes(selected)}<option value="">（未选择）</option>{/if}
      {#each names as n (n)}<option value={n}>{n}</option>{/each}
    </select>
  </label>
  <div class="tm-form__row">
    <label class="tm-form__field">
      <span class="tm-form__label">新预设的名字</span>
      <input
        class="text_pole tm-form__input"
        autocapitalize="off"
        bind:value={newName}
        onkeydown={(e) => e.key === 'Enter' && create()}
      />
    </label>
    <Button variant="outline" disabled={!newName.trim()} onclick={create}>新建</Button>
  </div>
  <div class="tm-form__actions">
    <button
      id="openai_logit_bias_import_preset"
      class="menu_button tm-form__chip"
      onclick={() => void importPreset()}>导入</button
    >
    <button
      id="openai_logit_bias_export_preset"
      class="menu_button tm-form__chip"
      disabled={!selected || !names.includes(selected)}
      onclick={() => void exportPreset()}>导出</button
    >
  </div>
  {#if error}<p class="tm-form__hint tm-lb__error">{error}</p>{/if}
  {#if notice}<p class="tm-form__hint">{notice}</p>{/if}

  {#if selected && names.includes(selected)}
    <div class="tm-form__list logit_bias_list">
      {#each entries as entry, i (i)}
        <div class="tm-lb__entry logit_bias_form">
          <input
            class="text_pole tm-form__input logit_bias_text"
            aria-label="文本或 token id 数组"
            placeholder="文本，或 [1234, 5678]"
            autocapitalize="off"
            autocomplete="off"
            value={entry.text}
            onchange={(e) => patch(i, { text: e.currentTarget.value })}
          />
          <input
            class="text_pole tm-form__input tm-lb__value logit_bias_value"
            type="number"
            inputmode="decimal"
            aria-label="偏置值"
            min={LOGIT_BIAS_MIN}
            max={LOGIT_BIAS_MAX}
            value={entry.value}
            onchange={(e) => setValue(i, e.currentTarget.value)}
          />
          <button
            class="tm-lb__remove logit_bias_remove"
            aria-label="删除这条偏置"
            onclick={() => commit(entries.filter((_, j) => j !== i))}
            ><Icon name="xmark" size="sm" /></button
          >
        </div>
      {:else}
        <p class="tm-form__hint">这个预设还没有条目。</p>
      {/each}
    </div>
    <p class="tm-form__hint">
      值从 {LOGIT_BIAS_MIN}（禁止出现）到 {LOGIT_BIAS_MAX}（强制出现）。多数 token
      前面带一个空格；整段写成数字数组时按 token id 处理。
    </p>
    <div class="tm-form__actions">
      <Button
        variant="outline"
        onclick={() => commit([...entries, { id: uuidv4(), text: '', value: 0 }])}>添加条目</Button
      >
      {#if confirmDelete}
        <Button variant="primary" onclick={remove}>确认删除</Button>
        <Button variant="outline" onclick={() => (confirmDelete = false)}>取消</Button>
      {:else}
        <Button variant="outline" onclick={() => (confirmDelete = true)}>删除预设</Button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tm-lb__entry {
    display: grid;
    grid-template-columns: minmax(0, 1fr) calc(var(--tm-touch-target) * 1.8) auto;
    align-items: center;
    gap: var(--tm-space-2);
  }
  .tm-lb__value {
    text-align: right;
  }
  .tm-lb__remove {
    width: var(--tm-touch-target);
    height: var(--tm-touch-target);
    display: inline-grid;
    place-items: center;
    border-radius: var(--tm-radius-md);
    color: var(--tm-color-text-secondary);
  }
  .tm-lb__error {
    color: var(--tm-color-danger);
  }
</style>
