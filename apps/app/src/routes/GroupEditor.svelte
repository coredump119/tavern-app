<script lang="ts">
  /**
   * Group editor = ST's #rm_group_chats_block on one page (DEV_NOTES §9.21): name, favourite,
   * members (mute / order / remove, add from the character list), activation strategy, generation
   * mode, self responses, auto-mode delay. Saving writes `groups/<id>.json`; `id === null` creates.
   */
  import { untrack } from 'svelte';
  import type { Group } from '@tm/formats';
  import {
    GROUP_ACTIVATION_OPTIONS,
    GROUP_GENERATION_MODE_OPTIONS,
    GROUP_GENERATION_MODE,
    groupCollageAvatars,
    groupCustomAvatar,
    newGroup,
    tagStoreOf,
  } from '@tm/core';
  import Button from '@tm/ui/components/Button.svelte';
  import BottomSheet from '../lib/components/BottomSheet.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import TagEditor from '../lib/components/TagEditor.svelte';
  import { chatStore, humanizedDateTime } from '../lib/chat/store.svelte';
  import { fileUrl, groupAvatarUpload } from '../lib/ipc';
  import { pickFiles } from '../lib/files';
  import { cropPicked } from '../lib/crop.svelte';
  import GroupCollage from '../lib/components/GroupCollage.svelte';
  import { deleteGroup, readGroup, writeGroup } from '../lib/groups';

  interface Props {
    /** group id to edit, or null to create a new group */
    id: string | null;
    onClose: () => void;
    onOpenChat?: ((id: string) => void) | undefined;
    onSaved?: ((id: string) => void) | undefined;
    onDeleted?: (() => void) | undefined;
  }
  let { id, onClose, onOpenChat, onSaved, onDeleted }: Props = $props();
  const store = chatStore;

  interface Form {
    name: string;
    fav: boolean;
    members: string[];
    disabled_members: string[];
    activation_strategy: number;
    generation_mode: number;
    generation_mode_join_prefix: string;
    generation_mode_join_suffix: string;
    allow_self_responses: boolean;
    auto_mode_delay: number;
    hideMutedSprites: boolean;
  }
  const empty = (): Form => ({
    name: '',
    fav: false,
    members: [],
    disabled_members: [],
    activation_strategy: 0,
    generation_mode: GROUP_GENERATION_MODE.SWAP,
    generation_mode_join_prefix: '',
    generation_mode_join_suffix: '',
    allow_self_responses: false,
    auto_mode_delay: 5,
    hideMutedSprites: true,
  });
  // $state.raw: the stored group goes back to writeGroup untouched apart from the form fields
  let loaded = $state.raw<Group | null>(null);
  let form = $state<Form>(empty());
  let initial = $state('');
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let addOpen = $state(false);
  let moreOpen = $state(false);
  let deleteOpen = $state(false);
  const dirty = $derived(JSON.stringify($state.snapshot(form)) !== initial);
  const isNew = $derived(id === null);

  function fromGroup(g: Group): Form {
    return {
      name: g.name,
      fav: g.fav === true || g.fav === 'true',
      members: [...g.members],
      disabled_members: [...(g.disabled_members ?? [])],
      activation_strategy: Number(g.activation_strategy ?? 0),
      generation_mode: Number(g.generation_mode ?? GROUP_GENERATION_MODE.SWAP),
      generation_mode_join_prefix: g.generation_mode_join_prefix ?? '',
      generation_mode_join_suffix: g.generation_mode_join_suffix ?? '',
      allow_self_responses: !!g.allow_self_responses,
      auto_mode_delay: Number(g.auto_mode_delay ?? 5),
      hideMutedSprites: g.hideMutedSprites !== false,
    };
  }

  $effect(() => {
    const target = id;
    const root = store.root;
    untrack(() => void load(target, root));
  });
  async function load(target: string | null, root: string | null) {
    error = null;
    if (!root) return;
    if (target === null) {
      loaded = null;
      form = empty();
      initial = JSON.stringify($state.snapshot(form));
      return;
    }
    busy = '读取…';
    try {
      const g = await readGroup(root, target);
      loaded = g;
      form = fromGroup(g);
      initial = JSON.stringify($state.snapshot(form));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  const nameOf = (avatar: string) =>
    store.characters.find((c) => c.avatar === avatar)?.name ?? avatar.replace(/\.png$/i, '');
  const candidates = $derived(store.characters.filter((c) => !form.members.includes(c.avatar)));

  function addMember(avatar: string) {
    if (!form.members.includes(avatar)) form.members = [...form.members, avatar];
  }
  function removeMember(avatar: string) {
    form.members = form.members.filter((m) => m !== avatar);
    form.disabled_members = form.disabled_members.filter((m) => m !== avatar);
  }
  function toggleMuted(avatar: string) {
    form.disabled_members = form.disabled_members.includes(avatar)
      ? form.disabled_members.filter((m) => m !== avatar)
      : [...form.disabled_members, avatar];
  }
  function move(avatar: string, dir: -1 | 1) {
    const i = form.members.indexOf(avatar);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= form.members.length) return;
    const next = form.members.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    form.members = next;
  }

  /** Write the stored group with a new `avatar_url` only (unsaved form edits stay unsaved). */
  async function storeAvatar(avatarUrl: string) {
    if (!store.root || !loaded) return;
    const group: Group = { ...loaded, avatar_url: avatarUrl };
    await writeGroup(store.root, group);
    loaded = group;
    await store.refreshGroups();
    if (store.group?.id === group.id) await store.reloadGroup();
  }

  /** ST uploadGroupAvatar: crop → 200×300 thumbnail in `user/images/<id>/` → `avatar_url`. */
  async function uploadAvatar() {
    const root = store.root;
    const id = loaded?.id;
    if (!root || !id) return;
    const [file] = await pickFiles({
      extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
      title: '群头像',
    });
    if (!file) return;
    error = null;
    try {
      const url = await cropPicked(file, (image, crop) => {
        busy = '更换头像…';
        return groupAvatarUpload(root, id, `${id}_${humanizedDateTime()}`, image, crop);
      });
      if (url !== null) await storeAvatar(url);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  /** ST restoreGroupAvatar: back to the member collage (the picture file stays). */
  async function restoreAvatar() {
    busy = '恢复拼贴…';
    error = null;
    try {
      await storeAvatar('');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  async function save(): Promise<string | null> {
    if (!store.root) return null;
    if (form.members.length === 0) {
      error = '至少选择一个成员';
      return null;
    }
    busy = '保存…';
    error = null;
    try {
      const f = $state.snapshot(form);
      let group: Group;
      if (loaded) {
        group = {
          ...loaded,
          name: f.name.trim() || loaded.name,
          fav: f.fav,
          members: f.members,
          disabled_members: f.disabled_members,
          activation_strategy: f.activation_strategy,
          generation_mode: f.generation_mode,
          generation_mode_join_prefix: f.generation_mode_join_prefix,
          generation_mode_join_suffix: f.generation_mode_join_suffix,
          allow_self_responses: f.allow_self_responses,
          auto_mode_delay: f.auto_mode_delay,
          hideMutedSprites: f.hideMutedSprites,
        };
      } else {
        group = {
          ...(newGroup({
            name: f.name,
            members: f.members,
            memberNames: f.members.map(nameOf),
            allowSelfResponses: f.allow_self_responses,
            activationStrategy: f.activation_strategy,
            generationMode: f.generation_mode,
            autoModeDelay: f.auto_mode_delay,
            fav: f.fav,
            hideMutedSprites: f.hideMutedSprites,
            chatName: humanizedDateTime(),
          }) as unknown as Group),
          disabled_members: f.disabled_members,
          generation_mode_join_prefix: f.generation_mode_join_prefix,
          generation_mode_join_suffix: f.generation_mode_join_suffix,
          date_added: Date.now(),
        };
      }
      await writeGroup(store.root, group);
      loaded = group;
      form = fromGroup(group);
      initial = JSON.stringify($state.snapshot(form));
      await store.refreshGroups();
      if (store.group?.id === group.id) await store.reloadGroup();
      onSaved?.(group.id);
      return group.id;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      busy = null;
    }
  }

  async function openChat() {
    moreOpen = false;
    const gid = dirty || !loaded ? await save() : loaded.id;
    if (gid) onOpenChat?.(gid);
  }

  /** ST deleteGroup: chat files + group file, `tag_map[id]`, and the open chat if it was this group */
  async function doDelete() {
    if (!store.root || !loaded) return;
    deleteOpen = false;
    busy = '删除…';
    try {
      // scripts may have left changes that are not in the files yet (DEV_NOTES §9.5)
      await store.flushDeferred();
      await deleteGroup(store.root, loaded);
      if (store.settings) {
        const next = structuredClone($state.snapshot(store.settings));
        const tags = tagStoreOf(next);
        if (loaded.id in tags.tag_map) {
          delete tags.tag_map[loaded.id];
          await store.saveSettings(next);
        }
      }
      if (store.group?.id === loaded.id) await store.closeGroup();
      await store.refreshGroups();
      onDeleted?.();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }
</script>

<section class="tm-ge drawer-content" id="rm_group_chats_block">
  <div class="tm-ge__bar">
    <button class="tm-ge__link" onclick={onClose}><Icon name="chevron-left" />角色列表</button>
    <span class="tm-ge__status">{busy ?? (dirty ? '未保存' : '')}</span>
    <Button variant="primary" size="sm" disabled={!!busy || !dirty} onclick={() => void save()}
      >{isNew ? '创建' : '保存'}</Button
    >
  </div>

  {#if error}
    <p class="tm-ge__error" role="alert">
      <span>{error}</span><button class="tm-ge__link" onclick={() => (error = null)}>关闭</button>
    </p>
  {/if}

  <div class="tm-form__section">
    <label class="tm-form__field">
      <span class="tm-form__label">群名</span>
      <input
        id="rm_group_chat_name"
        class="text_pole tm-form__input"
        type="text"
        bind:value={form.name}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        placeholder={form.members.length
          ? `Group: ${form.members.map(nameOf).join(', ')}`
          : '留空则用成员名'}
      />
    </label>
    <div class="tm-ge__chips">
      <button
        id="rm_group_fav"
        class="tm-ge__chip"
        class:is-on={form.fav}
        onclick={() => (form.fav = !form.fav)}
      >
        <Icon name="star" size="sm" />{form.fav ? '已收藏' : '收藏'}
      </button>
      {#if loaded}
        <button class="tm-ge__chip" onclick={() => (moreOpen = true)}>
          <Icon name="ellipsis" size="sm" />更多
        </button>
      {/if}
    </div>
    {#if loaded}
      <div class="tm-ge__avatar-row">
        <span class="avatar tm-ge__avatar">
          <GroupCollage
            avatars={groupCollageAvatars(loaded, store.characters)}
            root={store.root ?? ''}
            custom={loaded.avatar_url}
          />
        </span>
        <button
          id="group_avatar_button"
          class="menu_button tm-form__chip"
          disabled={!!busy}
          onclick={() => void uploadAvatar()}>上传群头像</button
        >
        {#if groupCustomAvatar(loaded.avatar_url)}
          <button class="menu_button tm-form__chip" disabled={!!busy} onclick={restoreAvatar}
            >恢复拼贴</button
          >
        {/if}
      </div>
      <div class="tm-form__field" id="tags_div">
        <span class="tm-form__label">标签</span>
        <TagEditor entityKey={loaded.id} inputId="groupTagInput" onError={(m) => (error = m)} />
      </div>
    {/if}
  </div>

  <div class="tm-form__section">
    <h3 class="tm-form__heading">
      成员 <small>{form.members.length}</small>
      <button class="menu_button tm-form__chip" onclick={() => (addOpen = true)} disabled={!!busy}
        ><Icon name="plus" size="sm" />添加</button
      >
    </h3>
    {#if form.members.length === 0}
      <p class="tm-form__hint">还没有成员。点「添加」从角色列表里选。</p>
    {/if}
    <div id="rm_group_members" class="tm-form__list">
      {#each form.members as avatar, i (avatar)}
        {@const muted = form.disabled_members.includes(avatar)}
        <div class="tm-form__item group_member" class:is-off={muted} data-avatar={avatar}>
          <img class="tm-ge__avatar" src={fileUrl(`${store.root}/characters/${avatar}`)} alt="" />
          <span class="tm-ge__member">
            <span class="tm-form__item-name">{nameOf(avatar)}</span>
            <span class="tm-form__item-meta">{muted ? '已静音' : `第 ${i + 1} 位`}</span>
          </span>
          <span class="tm-form__item-actions">
            <button
              class="tm-form__icon"
              title={muted ? '取消静音' : '静音'}
              aria-label={muted ? '取消静音' : '静音'}
              onclick={() => toggleMuted(avatar)}
              ><Icon name={muted ? 'eye-slash' : 'eye'} size="sm" /></button
            >
            <button
              class="tm-form__icon"
              title="上移"
              aria-label="上移"
              disabled={i === 0}
              onclick={() => move(avatar, -1)}><Icon name="chevron-up" size="sm" /></button
            >
            <button
              class="tm-form__icon"
              title="下移"
              aria-label="下移"
              disabled={i === form.members.length - 1}
              onclick={() => move(avatar, 1)}><Icon name="chevron-down" size="sm" /></button
            >
            <button
              class="tm-form__icon tm-ge__danger"
              title="移出群聊"
              aria-label="移出群聊"
              onclick={() => removeMember(avatar)}><Icon name="xmark" size="sm" /></button
            >
          </span>
        </div>
      {/each}
    </div>
  </div>

  <div class="tm-form__section">
    <h3 class="tm-form__heading">发言顺序</h3>
    <div class="tm-form__list" role="radiogroup" aria-label="发言顺序">
      {#each GROUP_ACTIVATION_OPTIONS as o (o.value)}
        <label class="checkbox_label tm-form__check">
          <input
            type="radio"
            name="rm_group_activation_strategy"
            value={o.value}
            checked={form.activation_strategy === o.value}
            onchange={() => (form.activation_strategy = o.value)}
          />
          <span>{o.label} <small>{o.hint}</small></span>
        </label>
      {/each}
    </div>
    <label class="checkbox_label tm-form__check">
      <input
        id="rm_group_allow_self_responses"
        type="checkbox"
        bind:checked={form.allow_self_responses}
      />
      <span>允许连续发言 <small>同一成员可以接着自己说</small></span>
    </label>
  </div>

  <div class="tm-form__section">
    <h3 class="tm-form__heading">生成模式</h3>
    <div class="tm-form__list" role="radiogroup" aria-label="生成模式">
      {#each GROUP_GENERATION_MODE_OPTIONS as o (o.value)}
        <label class="checkbox_label tm-form__check">
          <input
            type="radio"
            name="rm_group_generation_mode"
            value={o.value}
            checked={form.generation_mode === o.value}
            onchange={() => (form.generation_mode = o.value)}
          />
          <span
            >{o.label}{#if 'hint' in o}<small> {o.hint}</small>{/if}</span
          >
        </label>
      {/each}
    </div>
    {#if form.generation_mode !== GROUP_GENERATION_MODE.SWAP}
      <div class="tm-form__row">
        <label class="tm-form__field">
          <span class="tm-form__label">合并前缀</span>
          <input
            class="text_pole tm-form__input"
            type="text"
            bind:value={form.generation_mode_join_prefix}
            autocapitalize="off"
            autocorrect="off"
            placeholder="每张卡片前"
          />
        </label>
        <label class="tm-form__field">
          <span class="tm-form__label">合并后缀</span>
          <input
            class="text_pole tm-form__input"
            type="text"
            bind:value={form.generation_mode_join_suffix}
            autocapitalize="off"
            autocorrect="off"
            placeholder="每张卡片后"
          />
        </label>
      </div>
    {/if}
    <label class="tm-form__field tm-form__field--narrow">
      <span class="tm-form__label">自动模式间隔 <small>秒；在聊天页的选项里开自动模式</small></span>
      <input
        id="rm_group_automode_delay"
        class="text_pole tm-form__input"
        type="number"
        min="0"
        max="300"
        bind:value={form.auto_mode_delay}
      />
    </label>
  </div>
</section>

<BottomSheet open={addOpen} title="添加成员" onClose={() => (addOpen = false)}>
  {#if candidates.length === 0}
    <p class="tm-ge__sheet-text">所有角色都已在群里。</p>
  {:else}
    <div id="rm_group_add_members" class="tm-form__list">
      {#each candidates as c (c.avatar)}
        <button class="tm-form__item tm-ge__candidate" onclick={() => addMember(c.avatar)}>
          <img class="tm-ge__avatar" src={fileUrl(`${store.root}/characters/${c.avatar}`)} alt="" />
          <span class="tm-form__item-name">{c.name}</span>
          <Icon name="plus" size="sm" />
        </button>
      {/each}
    </div>
  {/if}
</BottomSheet>

<BottomSheet open={moreOpen} title={form.name || '群聊'} onClose={() => (moreOpen = false)}>
  {#if onOpenChat}
    <button class="tm-opt" disabled={!!busy} onclick={openChat}
      ><Icon name="arrow-right" /><span>打开聊天</span></button
    >
  {/if}
  <button
    id="rm_group_delete"
    class="tm-opt tm-opt--danger"
    disabled={!!busy}
    onclick={() => {
      moreOpen = false;
      deleteOpen = true;
    }}><Icon name="trash" /><span>删除群聊</span><small>连同它的全部聊天记录</small></button
  >
</BottomSheet>

<BottomSheet open={deleteOpen} title="删除群聊" onClose={() => (deleteOpen = false)}>
  <p class="tm-ge__sheet-text">
    删除「{form.name}」？群组文件和 {loaded?.chats?.length ?? 0} 个聊天文件都会被移除，成员角色卡不受影响。
  </p>
  <div class="tm-ge__sheet-actions">
    <Button variant="outline" onclick={() => (deleteOpen = false)}>取消</Button>
    <Button variant="primary" class="tm-ge__danger-btn" onclick={doDelete}>删除</Button>
  </div>
</BottomSheet>

<style>
  .tm-ge {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--tm-space-4) var(--tm-gutter) calc(var(--tm-space-10) + var(--tm-safe-bottom));
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-5);
    font-family: var(--tm-font-ui);
    max-width: var(--tm-chat-measure);
    width: 100%;
    margin: 0 auto;
  }
  .tm-ge__bar {
    position: sticky;
    top: 0;
    z-index: var(--tm-z-sticky);
    display: flex;
    align-items: center;
    gap: var(--tm-space-3);
    margin: 0 calc(var(--tm-gutter) * -1);
    padding: var(--tm-space-2) var(--tm-gutter);
    background: var(--tm-color-bg);
    border-bottom: var(--tm-border-width) solid var(--tm-color-border);
  }
  .tm-ge__status {
    flex: 1;
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
    text-align: right;
  }
  .tm-ge__link {
    display: inline-flex;
    align-items: center;
    gap: var(--tm-space-1);
    min-height: calc(var(--tm-touch-target) * 0.8);
    color: var(--tm-color-text-link);
    font-size: var(--tm-text-sm);
  }
  .tm-ge__error {
    display: flex;
    justify-content: space-between;
    gap: var(--tm-space-3);
    font-size: var(--tm-text-sm);
    color: var(--tm-color-danger);
  }
  .tm-ge__chips {
    display: flex;
    gap: var(--tm-space-2);
  }
  .tm-ge__avatar-row {
    display: flex;
    align-items: center;
    gap: var(--tm-space-3);
  }
  .tm-ge__avatar {
    flex: none;
    width: var(--tm-avatar-size);
    height: var(--tm-avatar-height);
    border-radius: var(--tm-radius-avatar);
    overflow: hidden;
  }
  .tm-ge__chip {
    display: inline-flex;
    align-items: center;
    gap: var(--tm-space-1);
    min-height: calc(var(--tm-touch-target) * 0.8);
    padding: 0 var(--tm-space-3);
    border-radius: var(--tm-radius-full);
    border: var(--tm-border-width) solid var(--tm-color-border);
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-secondary);
  }
  .tm-ge__chip.is-on {
    color: var(--tm-color-warning);
    border-color: var(--tm-color-warning);
  }
  .tm-ge__avatar {
    width: var(--tm-avatar-size);
    height: var(--tm-avatar-size);
    border-radius: var(--tm-radius-avatar);
    object-fit: cover;
    background: var(--tm-color-surface-sunken);
  }
  .tm-ge__member {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: var(--tm-space-1);
  }
  .tm-ge__danger {
    color: var(--tm-color-danger);
  }
  .tm-ge__candidate {
    width: 100%;
    text-align: left;
  }
  .tm-ge__candidate:hover {
    background: var(--tm-color-surface-raised);
  }
  .tm-form__check small {
    display: block;
  }
  .tm-opt {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: var(--tm-space-3);
    align-items: center;
    width: 100%;
    min-height: var(--tm-touch-target);
    padding: var(--tm-space-2) var(--tm-space-2);
    border-radius: var(--tm-radius-md);
    text-align: left;
    font-size: var(--tm-text-md);
    color: var(--tm-color-text);
  }
  .tm-opt:hover:not(:disabled) {
    background: var(--tm-color-surface-sunken);
  }
  .tm-opt:disabled {
    opacity: 0.45;
  }
  .tm-opt small {
    grid-column: 2;
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }
  .tm-opt--danger {
    color: var(--tm-color-danger);
  }
  .tm-ge__sheet-text {
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-secondary);
    line-height: var(--tm-leading-relaxed);
    padding: var(--tm-space-2) 0;
  }
  .tm-ge__sheet-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--tm-space-3);
    padding-top: var(--tm-space-3);
  }
  :global(.tm-ge__danger-btn) {
    background: var(--tm-color-danger) !important;
  }
</style>
