<script lang="ts">
  /**
   * Tags of one entity (ST `tag_map[key]`): a character's avatar file name or a group id.
   * Shared by the character and the group editor (DEV_NOTES §9.36).
   */
  import {
    addTagToMap,
    getTag,
    removeTagFromMap,
    tagStoreOf,
    tagsOfEntity,
    type Tag,
  } from '@tm/core';
  import { chatStore as store } from '../chat/store.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    entityKey: string;
    /** ST id of the input: `tagInput` (character) / `groupTagInput` (group) */
    inputId: string;
    onError?: ((message: string) => void) | undefined;
  }
  let { entityKey, inputId, onError }: Props = $props();

  let tagInput = $state('');
  const settingsPlain = $derived(store.settings ? $state.snapshot(store.settings) : null);
  const allTags = $derived((settingsPlain?.['tags'] as Tag[] | undefined) ?? []);
  const assignedTags = $derived.by<Tag[]>(() =>
    settingsPlain ? tagsOfEntity(tagStoreOf(structuredClone(settingsPlain)), entityKey) : [],
  );
  const suggestions = $derived.by<string[]>(() => {
    const have = new Set(assignedTags.map((t) => t.id));
    return allTags
      .filter((t) => !have.has(t.id))
      .map((t) => t.name)
      .sort((a, b) => a.localeCompare(b, 'zh'));
  });

  async function withSettings(fn: (s: ReturnType<typeof tagStoreOf>) => boolean) {
    if (!settingsPlain) return;
    const copy = structuredClone(settingsPlain);
    if (!fn(tagStoreOf(copy))) return;
    try {
      await store.saveSettings(copy);
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
    }
  }
  function addTag(name: string) {
    const n = name.trim();
    tagInput = '';
    if (!n) return;
    void withSettings((ts) => {
      const before = ts.tags.length;
      const tag = getTag(ts, n, { createNew: true })!;
      return addTagToMap(ts, tag.id, entityKey) || ts.tags.length !== before;
    });
  }
  function removeTag(id: string) {
    void withSettings((ts) => removeTagFromMap(ts, id, entityKey));
  }
</script>

<div class="tm-tags">
  {#each assignedTags as t (t.id)}
    <span class="tag tm-tags__tag">
      {t.name}
      <button class="tm-tags__x" aria-label="移除标签 {t.name}" onclick={() => removeTag(t.id)}
        ><Icon name="xmark" size="sm" /></button
      >
    </span>
  {/each}
  <input
    id={inputId}
    class="tm-tags__input"
    list="{inputId}-suggestions"
    placeholder="搜索 / 新建标签"
    autocapitalize="off"
    autocorrect="off"
    spellcheck="false"
    bind:value={tagInput}
    onkeydown={(e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTag(tagInput);
      }
    }}
    onchange={() => addTag(tagInput)}
  />
  <datalist id="{inputId}-suggestions">
    {#each suggestions as s (s)}<option value={s}></option>{/each}
  </datalist>
</div>

<style>
  .tm-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--tm-space-2);
    align-items: center;
  }
  .tm-tags__tag {
    display: inline-flex;
    align-items: center;
    gap: var(--tm-space-1);
    padding: var(--tm-space-1) var(--tm-space-2) var(--tm-space-1) var(--tm-space-3);
    border-radius: var(--tm-radius-full);
    background: var(--tm-color-surface-sunken);
    font-size: var(--tm-text-sm);
  }
  .tm-tags__x {
    display: inline-grid;
    place-items: center;
    width: calc(var(--tm-touch-target) * 0.6);
    height: calc(var(--tm-touch-target) * 0.6);
    border-radius: var(--tm-radius-full);
    color: var(--tm-color-text-muted);
  }
  .tm-tags__x:hover {
    color: var(--tm-color-danger);
  }
  .tm-tags__input {
    flex: 1;
    min-width: calc(var(--tm-avatar-size) * 3);
    min-height: calc(var(--tm-touch-target) * 0.8);
    padding: var(--tm-space-2) var(--tm-space-4);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-sunken);
    color: var(--tm-color-text);
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-sm);
    line-height: var(--tm-leading-normal);
  }
  .tm-tags__input:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--tm-color-border-strong);
  }
  /* the reset's iOS no-zoom clamp loses to the class rule above; re-apply it for touch */
  @media (pointer: coarse) {
    .tm-tags__input {
      font-size: max(var(--tm-text-input-min), var(--tm-text-sm));
    }
  }
</style>
