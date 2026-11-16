<script lang="ts">
  /**
   * Chat background picker: what ST's Backgrounds drawer does, inside the theme panel
   * (DEV_NOTES §9.42). Images live in `backgrounds/`; the choice is settings.json `background`,
   * a per-chat lock is `chat_metadata.custom_background`.
   */
  import {
    BACKGROUND_DIR,
    BACKGROUND_FITTINGS,
    BACKGROUND_IMAGE_EXTENSIONS,
    BG_METADATA_KEY,
    backgroundRelOf,
    backgroundSettingsOf,
    isBackgroundImage,
    setBackgroundFitting,
    setGlobalBackground,
    type BackgroundFitting,
  } from '@tm/core';
  import Button from '@tm/ui/components/Button.svelte';
  import { chatStore } from '../chat/store.svelte';
  import { backgroundUpload, dataDelete, dataList, fileUrl } from '../ipc';
  import { pickFiles } from '../files';
  import { askPopup } from '../popup.svelte';

  const store = chatStore;
  let names = $state<string[]>([]);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  /** bumped after an upload so a replaced file of the same name is fetched again */
  let version = $state(0);

  const settingsPlain = $derived(
    store.settings ? ($state.snapshot(store.settings) as Record<string, unknown>) : null,
  );
  const bg = $derived(backgroundSettingsOf(settingsPlain));
  const chosen = $derived(names.includes(bg.name) ? bg.name : null);
  const lockedRel = $derived(
    store.open ? backgroundRelOf(store.chatMetadata[BG_METADATA_KEY]) : null,
  );

  const FITTING_LABELS: Record<BackgroundFitting, string> = {
    classic: '经典',
    cover: '铺满',
    contain: '完整显示',
    stretch: '拉伸',
    center: '居中',
  };
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const pickedName = (path: string) => decodeURIComponent(path.split(/[\\/]/).pop() ?? path);

  async function refresh() {
    if (!store.root) return;
    try {
      names = (await dataList(store.root, BACKGROUND_DIR)).filter(isBackgroundImage);
    } catch {
      names = []; // no backgrounds/ folder yet
    }
  }
  $effect(() => {
    if (store.root) void refresh();
  });

  async function save(fn: (settings: Record<string, unknown>) => void) {
    if (!store.settings) return;
    const next = structuredClone($state.snapshot(store.settings)) as Record<string, unknown>;
    fn(next);
    try {
      await store.saveSettings(next);
    } catch (e) {
      error = msg(e);
    }
  }
  const choose = (name: string | null) => save((s) => setGlobalBackground(s, name));

  /** ST `#add_bg_button` */
  async function add() {
    if (!store.root) return;
    const files = await pickFiles({
      extensions: BACKGROUND_IMAGE_EXTENSIONS,
      multiple: true,
      title: '背景图片',
    });
    if (files.length === 0) return;
    busy = '添加中…';
    error = null;
    let last: string | null = null;
    try {
      for (const f of files) last = await backgroundUpload(store.root, f, pickedName(f));
    } catch (e) {
      error = msg(e);
    }
    version++;
    await refresh();
    if (last) await choose(last);
    busy = null;
  }

  /** ST `.bg_example_cross`: the file goes; a background that was in use falls back to none */
  async function remove(name: string) {
    if (!store.root) return;
    const ok = await askPopup({
      kind: 'confirm',
      title: '删除背景图',
      text: `删除「${name}」？图片文件会被移除，无法撤销。`,
      okButton: '删除',
    });
    if (ok !== true) return;
    try {
      await dataDelete(store.root, `${BACKGROUND_DIR}/${name}`);
      if (bg.name === name) await choose(null);
      if (lockedRel === `${BACKGROUND_DIR}/${name}`) await unlock();
      await refresh();
    } catch (e) {
      error = msg(e);
    }
  }

  /** ST "Lock": this chat keeps the background that is selected now */
  async function lock() {
    if (!chosen) return;
    try {
      await store.setChatMetadata({ [BG_METADATA_KEY]: bg.url });
    } catch (e) {
      error = msg(e);
    }
  }
  /** ST "Unlock" (an undefined value is dropped when the header is written) */
  async function unlock() {
    try {
      await store.setChatMetadata({ [BG_METADATA_KEY]: undefined });
    } catch (e) {
      error = msg(e);
    }
  }
</script>

<div id="Backgrounds" class="tm-bg">
  <ul id="bg_menu_content" class="tm-bg__grid">
    <li>
      <button
        class="tm-bg__cell tm-bg__cell--none"
        class:is-active={!chosen}
        aria-pressed={!chosen}
        onclick={() => choose(null)}>无</button
      >
    </li>
    {#each names as name (name)}
      <li class="bg_example" title={name}>
        <button
          class="tm-bg__cell"
          class:is-active={chosen === name}
          aria-pressed={chosen === name}
          aria-label="用 {name} 作背景"
          onclick={() => choose(name)}
        >
          <img
            class="tm-bg__thumb"
            src="{fileUrl(`${store.root}/${BACKGROUND_DIR}/${name}`)}?v={version}"
            alt=""
            loading="lazy"
          />
        </button>
      </li>
    {/each}
  </ul>
  <div class="tm-bg__actions">
    <Button id="add_bg_button" variant="outline" size="sm" disabled={!!busy} onclick={add}
      >{busy ?? '添加图片'}</Button
    >
    {#if chosen}
      <Button variant="ghost" size="sm" disabled={!!busy} onclick={() => remove(chosen)}
        >删除这张</Button
      >
    {/if}
  </div>
  {#if error}<p class="tm-bg__error">{error}</p>{/if}

  <label class="tm-bg__row">
    <span>适应方式</span>
    <select
      id="background_fitting"
      class="text_pole tm-bg__select"
      value={bg.fitting}
      onchange={(e) => {
        const fitting = e.currentTarget.value as BackgroundFitting;
        void save((s) => setBackgroundFitting(s, fitting));
      }}
    >
      {#each BACKGROUND_FITTINGS as f (f)}<option value={f}>{FITTING_LABELS[f]}</option>{/each}
    </select>
  </label>

  {#if store.open}
    {#if lockedRel}
      <div class="tm-bg__row">
        <span class="tm-bg__hint">本聊天锁定了「{lockedRel.split('/').pop()}」</span>
        <Button variant="outline" size="sm" onclick={unlock}>解除锁定</Button>
      </div>
    {:else}
      <div class="tm-bg__row">
        <span class="tm-bg__hint">只让当前聊天用选中的这张</span>
        <Button variant="outline" size="sm" disabled={!chosen} onclick={lock}>锁定到本聊天</Button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .tm-bg {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-3);
  }
  .tm-bg__grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(var(--tm-touch-target) * 1.6), 1fr));
    gap: var(--tm-space-2);
  }
  .tm-bg__cell {
    display: block;
    width: 100%;
    aspect-ratio: 3 / 4;
    overflow: hidden;
    border-radius: var(--tm-radius-md);
    border: var(--tm-border-width) solid var(--tm-color-border);
    background: var(--tm-color-surface-sunken);
    color: var(--tm-color-text-muted);
    font-size: var(--tm-text-sm);
  }
  .tm-bg__cell.is-active {
    border-color: var(--tm-color-accent);
    box-shadow: 0 0 0 1px var(--tm-color-accent);
    color: var(--tm-color-text);
  }
  .tm-bg__thumb {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .tm-bg__actions,
  .tm-bg__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--tm-space-3);
    min-height: var(--tm-touch-target);
    font-size: var(--tm-text-sm);
  }
  .tm-bg__actions {
    justify-content: flex-start;
  }
  .tm-bg__select {
    min-height: var(--tm-touch-target);
    padding: 0 var(--tm-space-3);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-sunken);
    color: var(--tm-color-text);
  }
  .tm-bg__hint {
    color: var(--tm-color-text-secondary);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tm-bg__error {
    font-size: var(--tm-text-sm);
    color: var(--tm-color-danger);
  }
</style>
