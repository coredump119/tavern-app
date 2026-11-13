<script lang="ts">
  /** Character list: search / favourites first / recent, plus card and ST-backup import. */
  import { onMount } from 'svelte';
  import { chatStore } from '../lib/chat/store.svelte';
  import { cardImport, fileUrl, isTauri, type CharacterRow } from '../lib/ipc';
  import { importBackup as importBackupZip } from '../lib/backup';
  import { pickFiles } from '../lib/files';
  import { embeddedWorldName } from '../lib/worlds';
  import {
    TAG_IMPORT_SETTING,
    groupCollageAvatars,
    tagStoreOf,
    tagsOfEntity,
    type TagStore,
  } from '@tm/core';
  import type { Group } from '@tm/formats';
  import GroupCollage from '../lib/components/GroupCollage.svelte';
  import BottomSheet from '../lib/components/BottomSheet.svelte';
  import Button from '@tm/ui/components/Button.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import {
    loadCharacter,
    planImportedTags,
    resolveTagImport,
    tagImportSetting,
    type PendingTagImport,
  } from '../lib/characters';

  interface Props {
    onOpen?: ((avatar: string) => void) | undefined;
    onEdit?: ((avatar: string) => void) | undefined;
    onEditGroup?: ((id: string) => void) | undefined;
    onNewGroup?: (() => void) | undefined;
  }
  let { onOpen, onEdit, onEditGroup, onNewGroup }: Props = $props();
  const store = chatStore;
  onMount(() => void store.init());

  // ST shows tag_map tags on the list; card-embedded tags are the fallback for untagged cards
  const settingsPlain = $derived(store.settings ? $state.snapshot(store.settings) : null);
  const tagStore = $derived<TagStore | null>(
    settingsPlain ? tagStoreOf(structuredClone(settingsPlain)) : null,
  );
  function tagsOf(c: CharacterRow): string[] {
    const mapped = tagStore ? tagsOfEntity(tagStore, c.avatar).map((t) => t.name) : [];
    return mapped.length ? mapped : c.tags;
  }

  // ST importTags after a card import: ASK ⇒ one popup per card (tags.js showTagImportPopup)
  let tagQueue = $state<PendingTagImport[]>([]);
  let tagSettings: Record<string, unknown> | null = null;
  let tagStoreLive: TagStore | null = null;
  let tagChanged = false;
  let rememberChoice = $state(false);
  async function importTagsFor(avatars: string[]) {
    if (!store.root || avatars.length === 0) return;
    tagSettings = structuredClone(settingsPlain ?? {});
    tagStoreLive = tagStoreOf(tagSettings);
    const { pending, imported } = await planImportedTags(
      store.root,
      tagStoreLive,
      avatars,
      tagImportSetting(settingsPlain),
    );
    tagChanged = imported.length > 0;
    tagQueue = pending;
    if (tagQueue.length === 0) await flushTagSettings();
  }
  async function flushTagSettings() {
    if (tagChanged && tagSettings) {
      try {
        await store.saveSettings(tagSettings);
      } catch (e) {
        notice = `标签写入失败：${e instanceof Error ? e.message : String(e)}`;
      }
    }
    tagSettings = null;
    tagStoreLive = null;
    tagChanged = false;
  }
  async function answerTagImport(choice: 'all' | 'existing' | 'none') {
    const item = tagQueue[0];
    if (!item || !tagStoreLive || !tagSettings) return;
    if (resolveTagImport(tagStoreLive, item, choice).length) tagChanged = true;
    let rest = tagQueue.slice(1);
    if (rememberChoice) {
      const setting =
        choice === 'all'
          ? TAG_IMPORT_SETTING.ALL
          : choice === 'existing'
            ? TAG_IMPORT_SETTING.ONLY_EXISTING
            : TAG_IMPORT_SETTING.NONE;
      const pu = (tagSettings['power_user'] as Record<string, unknown> | undefined) ?? {};
      tagSettings['power_user'] = { ...pu, tag_import_setting: setting };
      tagChanged = true;
      for (const it of rest)
        if (resolveTagImport(tagStoreLive, it, choice).length) tagChanged = true;
      rest = [];
    }
    tagQueue = rest;
    if (rest.length === 0) await flushTagSettings();
  }

  let query = $state('');
  let sort = $state<'recent' | 'name'>('recent');
  let busy = $state<string | null>(null);
  let notice = $state<string | null>(null);

  // ST's list mixes characters and groups (getEntitiesList), favourites first
  type Entry =
    | { kind: 'char'; key: string; name: string; fav: boolean; mtime: number; c: CharacterRow }
    | { kind: 'group'; key: string; name: string; fav: boolean; mtime: number; g: Group };
  const groupTags = (g: Group) => (tagStore ? tagsOfEntity(tagStore, g.id).map((t) => t.name) : []);
  const list = $derived.by<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (name: string, tags: string[]) =>
      !q || name.toLowerCase().includes(q) || tags.some((t) => t.toLowerCase().includes(q));
    // character mtimes come from the index in seconds; groups keep ms like ST
    const toMs = (t: number) => (t < 1e12 ? t * 1000 : t);
    const rows: Entry[] = [];
    for (const c of store.characters)
      if (match(c.name, tagsOf(c)))
        rows.push({
          kind: 'char',
          key: `c:${c.avatar}`,
          name: c.name,
          fav: c.fav,
          mtime: toMs(c.mtime),
          c,
        });
    for (const g of store.groups)
      if (match(g.name, groupTags(g)))
        rows.push({
          kind: 'group',
          key: `g:${g.id}`,
          name: g.name,
          fav: g.fav === true || g.fav === 'true',
          mtime: Number(g.date_last_chat ?? g.date_added ?? 0),
          g,
        });
    return rows.sort((a, b) => {
      if (a.fav !== b.fav) return a.fav ? -1 : 1;
      return sort === 'name' ? a.name.localeCompare(b.name, 'zh') : b.mtime - a.mtime;
    });
  });

  /** names of just-imported cards that carry a character_book (ST asks to import it on first open) */
  async function cardsWithEmbeddedLore(avatars: string[]): Promise<string[]> {
    const names: string[] = [];
    for (const a of avatars) {
      try {
        const card = (await loadCharacter(store.root ?? '', a)).raw;
        if (embeddedWorldName(card)) names.push(a.replace(/\.png$/i, ''));
      } catch {
        /* unreadable card: no hint */
      }
    }
    return names;
  }

  async function importCards() {
    if (!store.root) return;
    const files = await pickFiles({ extensions: ['png', 'json'], multiple: true, title: '角色卡' });
    if (files.length === 0) return;
    busy = '导入角色卡…';
    const done: string[] = [];
    const failed: string[] = [];
    for (const f of files) {
      try {
        done.push(await cardImport(store.root, f));
      } catch (e) {
        failed.push(`${f.split('/').pop()}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await store.refreshCharacters();
    busy = null;
    const lore = await cardsWithEmbeddedLore(done);
    notice =
      `已导入 ${done.length} 张${failed.length ? `，失败 ${failed.length}：${failed.join('；')}` : ''}` +
      (lore.length ? `。${lore.join('、')} 自带世界书，可在角色编辑页导入` : '');
    await importTagsFor(done);
  }

  async function importBackup() {
    if (!store.root) return;
    const [zip] = await pickFiles({ extensions: ['zip'], title: 'ST 备份' });
    if (!zip) return;
    busy = '导入 ST 备份…';
    try {
      // scripts may have left changes that are not in the files yet (DEV_NOTES §9.5)
      await store.flushDeferred();
      const r = await importBackupZip(zip);
      notice = `导入完成：${r.files} 个文件${r.skipped.length ? `，跳过 ${r.skipped.length} 个` : ''}`;
    } catch (e) {
      notice = `导入失败：${e instanceof Error ? e.message : String(e)}`;
    } finally {
      busy = null;
    }
  }

  async function open(avatar: string) {
    await store.openCharacter(avatar);
    onOpen?.(avatar);
  }
  async function openGroup(id: string) {
    await store.openGroup(id);
    onOpen?.(id);
  }
</script>

<section id="right-nav-panel" class="tm-chars drawer-content">
  {#if !isTauri()}
    <p class="tm-chars__hint">角色列表需要在 app 里运行。</p>
  {:else}
    <div class="tm-chars__toolbar">
      <input
        class="tm-chars__search"
        type="search"
        placeholder="搜索角色或标签"
        bind:value={query}
        aria-label="搜索角色"
      />
      <div class="tm-chars__actions">
        <button
          class="tm-chars__sort"
          onclick={() => (sort = sort === 'recent' ? 'name' : 'recent')}
        >
          {sort === 'recent' ? '按最近' : '按名字'}
        </button>
        <button class="tm-chars__btn" disabled={!!busy} onclick={importCards}>导入卡片</button>
        <button class="tm-chars__btn" disabled={!!busy} onclick={importBackup}>导入 ST 备份</button>
        {#if onNewGroup}
          <button
            id="rm_button_group_chats"
            class="tm-chars__btn"
            disabled={!!busy || store.characters.length === 0}
            onclick={onNewGroup}>新建群聊</button
          >
        {/if}
      </div>
    </div>
    {#if busy}<p class="tm-chars__hint">{busy}</p>{/if}
    {#if notice}
      <p class="tm-chars__notice">
        <span>{notice}</span>
        <button class="tm-chars__link" onclick={() => (notice = null)}>关闭</button>
      </p>
    {/if}
    {#if store.error}<p class="tm-chars__error">{store.error}</p>{/if}
    {#if store.loading && store.characters.length === 0}
      <p class="tm-chars__hint">读取中…</p>
    {:else if list.length === 0}
      <p class="tm-chars__hint">
        {store.characters.length === 0
          ? '还没有角色。用上面的按钮导入 PNG / JSON 角色卡，或整包导入 ST 备份 zip。'
          : '没有匹配的角色。'}
      </p>
      <p class="tm-chars__hint tm-chars__path">{store.root}</p>
    {:else}
      <ul id="rm_print_characters_block" class="tm-chars__grid">
        {#each list as entry (entry.key)}
          {#if entry.kind === 'group'}
            {@const g = entry.g}
            {@const tags = groupTags(g)}
            <li
              class="tm-chars__card tm-chars__card--group group_select entity_block"
              class:is_fav={entry.fav}
              grid={g.id}
            >
              <button class="tm-chars__open" onclick={() => openGroup(g.id)}>
                <span class="avatar tm-chars__avatar tm-chars__collage">
                  <GroupCollage
                    avatars={groupCollageAvatars(g, store.characters)}
                    custom={g.avatar_url}
                    root={store.root ?? ''}
                  />
                </span>
                <span class="ch_name tm-chars__name">{g.name}</span>
                <span class="tags tm-chars__tags"
                  >群聊 · {g.members.length} 人{tags.length
                    ? ` · ${tags.slice(0, 2).join(' · ')}`
                    : ''}</span
                >
              </button>
              {#if entry.fav}<span class="tm-chars__fav" aria-label="收藏">★</span>{/if}
              {#if onEditGroup}
                <button
                  class="tm-chars__edit"
                  aria-label="编辑群聊 {g.name}"
                  onclick={() => onEditGroup(g.id)}><Icon name="pencil" size="sm" /></button
                >
              {/if}
            </li>
          {:else}
            {@const c = entry.c}
            {@const tags = tagsOf(c)}
            <li
              class="tm-chars__card character_select entity_block"
              class:is_fav={c.fav}
              chid={c.avatar}
            >
              <button class="tm-chars__open" onclick={() => open(c.avatar)}>
                <span class="avatar tm-chars__avatar-wrap"
                  ><img
                    class="tm-chars__avatar"
                    src="{fileUrl(`${store.root}/characters/${c.avatar}`)}?v={c.mtime}"
                    alt=""
                    loading="lazy"
                  /></span
                >
                <span class="ch_name tm-chars__name">{c.name}</span>
                {#if tags.length}<span class="tags tm-chars__tags"
                    >{tags.slice(0, 3).join(' · ')}</span
                  >{/if}
              </button>
              {#if c.fav}<span class="tm-chars__fav" aria-label="收藏">★</span>{/if}
              {#if onEdit}
                <button
                  class="tm-chars__edit"
                  aria-label="编辑 {c.name}"
                  onclick={() => onEdit(c.avatar)}><Icon name="pencil" size="sm" /></button
                >
              {/if}
            </li>
          {/if}
        {/each}
      </ul>
    {/if}
  {/if}
</section>

{#if tagQueue[0]}
  {@const item = tagQueue[0]}
  <BottomSheet open={true} title="导入标签" onClose={() => answerTagImport('none')}>
    <p class="tm-chars__sheet-text">
      「{item.name}」带有标签。{tagQueue.length > 1 ? `（还有 ${tagQueue.length - 1} 张）` : ''}
    </p>
    {#if item.plan.existing.length}
      <p class="tm-chars__sheet-text">
        已有：{item.plan.existing.map((t) => t.name).join('、')}
      </p>
    {/if}
    {#if item.plan.fresh.length}
      <p class="tm-chars__sheet-text">新建：{item.plan.fresh.map((t) => t.name).join('、')}</p>
    {/if}
    <label class="tm-chars__check">
      <input type="checkbox" bind:checked={rememberChoice} />
      记住我的选择
    </label>
    <div class="tm-chars__sheet-actions">
      <Button variant="outline" size="sm" onclick={() => answerTagImport('none')}>不导入</Button>
      <Button
        variant="outline"
        size="sm"
        disabled={item.plan.existing.length === 0}
        onclick={() => answerTagImport('existing')}>只导入已有</Button
      >
      <Button variant="primary" size="sm" onclick={() => answerTagImport('all')}>全部导入</Button>
    </div>
  </BottomSheet>
{/if}

<style>
  .tm-chars {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--tm-space-6) var(--tm-gutter) calc(var(--tm-space-8) + var(--tm-safe-bottom));
    font-family: var(--tm-font-ui);
  }
  .tm-chars__toolbar {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-3);
    margin-bottom: var(--tm-space-5);
  }
  .tm-chars__search {
    width: 100%;
    min-height: var(--tm-touch-target);
    padding: 0 var(--tm-space-4);
    border-radius: var(--tm-radius-lg);
    background: var(--tm-color-surface-sunken);
    font-size: var(--tm-text-md);
  }
  .tm-chars__search:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--tm-color-border-strong);
  }
  .tm-chars__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--tm-space-2);
  }
  .tm-chars__btn,
  .tm-chars__sort {
    min-height: calc(var(--tm-touch-target) * 0.8);
    padding: 0 var(--tm-space-4);
    border-radius: var(--tm-radius-full);
    border: var(--tm-border-width) solid var(--tm-color-border);
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text);
  }
  .tm-chars__btn:hover,
  .tm-chars__sort:hover {
    background: var(--tm-color-surface-sunken);
  }
  .tm-chars__btn:disabled {
    opacity: 0.5;
  }
  .tm-chars__hint {
    color: var(--tm-color-text-secondary);
    font-size: var(--tm-text-sm);
    line-height: var(--tm-leading-relaxed);
  }
  .tm-chars__path {
    font-family: var(--tm-font-mono);
    font-size: var(--tm-text-xs);
    overflow-wrap: anywhere;
  }
  .tm-chars__notice {
    display: flex;
    justify-content: space-between;
    gap: var(--tm-space-3);
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-secondary);
  }
  .tm-chars__link {
    color: var(--tm-color-text-link);
    font-size: var(--tm-text-sm);
  }
  .tm-chars__error {
    color: var(--tm-color-danger);
    font-size: var(--tm-text-sm);
  }
  .tm-chars__grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(var(--tm-avatar-size) * 3.5), 1fr));
    gap: var(--tm-space-4);
  }
  .tm-chars__card {
    position: relative;
    border-radius: var(--tm-radius-lg);
    border: var(--tm-border-width) solid var(--tm-color-border);
    background: var(--tm-color-surface);
  }
  .tm-chars__card:hover {
    background: var(--tm-color-surface-raised);
  }
  .tm-chars__open {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--tm-space-2);
    padding: var(--tm-space-4);
    border-radius: var(--tm-radius-lg);
    color: var(--tm-color-text);
  }
  .tm-chars__edit {
    position: absolute;
    top: var(--tm-space-1);
    left: var(--tm-space-1);
    width: calc(var(--tm-touch-target) * 0.8);
    height: calc(var(--tm-touch-target) * 0.8);
    display: inline-grid;
    place-items: center;
    border-radius: var(--tm-radius-full);
    color: var(--tm-color-text-muted);
  }
  .tm-chars__edit:hover {
    color: var(--tm-color-text);
    background: var(--tm-color-surface-sunken);
  }
  .tm-chars__sheet-text {
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-secondary);
    line-height: var(--tm-leading-relaxed);
    padding: var(--tm-space-1) 0;
  }
  .tm-chars__check {
    display: flex;
    align-items: center;
    gap: var(--tm-space-3);
    min-height: var(--tm-touch-target);
    font-size: var(--tm-text-sm);
  }
  .tm-chars__check input {
    accent-color: var(--tm-color-accent);
    width: var(--tm-icon-md);
    height: var(--tm-icon-md);
  }
  .tm-chars__sheet-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--tm-space-2);
    padding-top: var(--tm-space-3);
  }
  .tm-chars__avatar {
    width: calc(var(--tm-avatar-size) * 2);
    height: calc(var(--tm-avatar-size) * 2);
    border-radius: var(--tm-radius-avatar);
    object-fit: cover;
    background: var(--tm-color-surface-sunken);
  }
  .tm-chars__collage {
    display: block;
    overflow: hidden;
  }
  .tm-chars__avatar-wrap {
    display: block;
    line-height: 0;
  }
  .tm-chars__name {
    font-size: var(--tm-text-sm);
    font-weight: 600;
    text-align: center;
  }
  .tm-chars__tags {
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
    text-align: center;
  }
  .tm-chars__fav {
    position: absolute;
    top: var(--tm-space-2);
    right: var(--tm-space-3);
    color: var(--tm-color-warning);
    font-size: var(--tm-text-xs);
  }
</style>
