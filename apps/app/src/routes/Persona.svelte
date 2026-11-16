<script lang="ts">
  /**
   * Persona management = ST's #PersonaManagement drawer on one page (DEV_NOTES §9.24): pick the
   * active persona, edit name / title / description / injection, default + chat + character locks,
   * create (upload or default avatar), duplicate, rename avatar image, delete. Settings go through
   * core `persona` on a snapshot and are saved as a whole.
   */
  import { onMount } from 'svelte';
  import {
    PERSONA_DESCRIPTION_POSITIONS,
    PERSONA_POSITION_OPTIONS,
    UNNAMED_PERSONA,
    addMissingPersonas,
    backupPersonas,
    deletePersona,
    duplicatePersona,
    initPersona,
    listPersonas,
    migrateNonPersonaUser,
    newPersonaAvatarId,
    personaBackupFileName,
    renamePersona,
    restorePersonas,
    selectPersona,
    setPersonaFields,
    setPersonaLock,
    toggleDefaultPersona,
    type PersonaConnection,
    type PersonaView,
  } from '@tm/core';
  import Button from '@tm/ui/components/Button.svelte';
  import Segmented from '@tm/ui/components/Segmented.svelte';
  import BottomSheet from '../lib/components/BottomSheet.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import { chatStore } from '../lib/chat/store.svelte';
  import { isTauri } from '../lib/ipc';
  import { describeExport, exportText } from '../lib/export';
  import { pickFiles, readPickedJson } from '../lib/files';
  import { cropForAvatar } from '../lib/crop.svelte';
  import { listWorldNames } from '../lib/worlds';
  import {
    copyUserAvatarFile,
    deleteUserAvatarFile,
    ensureDefaultUserAvatar,
    listUserAvatars,
    uploadPersonaAvatar,
    userAvatarUrl,
    userForceAvatar,
  } from '../lib/personas';

  interface Props {
    onOpenWorlds?: (() => void) | undefined;
  }
  let { onOpenWorlds }: Props = $props();
  const store = chatStore;

  let files = $state<string[]>([]);
  let worlds = $state<string[]>([]);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let createOpen = $state(false);
  let createName = $state('');
  let createTitle = $state('');
  let createWithUpload = $state(false);
  let deleteOpen = $state(false);
  let syncOpen = $state(false);
  let avatarVersion = $state(0);

  const settingsPlain = $derived(store.settings ? $state.snapshot(store.settings) : null);
  const metaPlain = $derived(store.open ? $state.snapshot(store.chatMetadata) : null);
  const pu = $derived((settingsPlain?.['power_user'] as Record<string, unknown> | undefined) ?? {});
  /** what "bind to current character" means right now (ST getCurrentConnectionObj) */
  const connection = $derived<PersonaConnection | null>(
    store.group
      ? { type: 'group', id: store.group.id }
      : store.character
        ? { type: 'character', id: store.character.avatar }
        : null,
  );
  const personas = $derived<PersonaView[]>(
    settingsPlain ? listPersonas(structuredClone(settingsPlain), metaPlain, files, connection) : [],
  );
  const current = $derived(personas.find((p) => p.isCurrent) ?? null);
  const currentDescriptor = $derived(current?.descriptor ?? null);
  const position = $derived(
    Number(currentDescriptor?.position ?? PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT),
  );
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  onMount(async () => {
    await store.init();
    if (!store.root) return;
    try {
      await ensureDefaultUserAvatar(store.root);
      files = await listUserAvatars(store.root);
      worlds = await listWorldNames(store.root);
      // ST startup: the current avatar always has a persona; files without one get a placeholder
      if (store.settings) {
        const next = structuredClone($state.snapshot(store.settings)) as Record<string, unknown>;
        const changed = migrateNonPersonaUser(next) || addMissingPersonas(next, files) > 0;
        if (!next['user_avatar'] && files[0]) {
          selectPersona(next, null, files[0]);
          await store.saveSettings(next);
        } else if (changed) await store.saveSettings(next);
      }
    } catch (e) {
      error = msg(e);
    }
  });

  /**
   * iOS does not take focus away from a text field when a button is tapped, so the field's `change`
   * has not fired yet and the next settings write would put the old text back (DEV_NOTES §9.41).
   * Blurring commits it; the edit it triggers is queued ahead of the caller's.
   */
  let committing = false;
  function commitFocusedField() {
    if (committing) return;
    const el = document.activeElement;
    if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return;
    committing = true;
    el.blur();
    committing = false;
  }

  /** edits run one after another: each starts from the settings the previous one saved */
  let queue: Promise<void> = Promise.resolve();

  /** Edit settings on a snapshot through `fn`, then persist (and the chat header when `meta` changed). */
  function mutate(
    fn: (settings: Record<string, unknown>, meta: Record<string, unknown> | null) => void,
  ): Promise<void> {
    commitFocusedField();
    queue = queue.then(async () => {
      if (!store.settings) return;
      const next = structuredClone($state.snapshot(store.settings)) as Record<string, unknown>;
      const meta = metaPlain ? (structuredClone(metaPlain) as Record<string, unknown>) : null;
      const before = meta ? JSON.stringify(meta) : null;
      fn(next, meta);
      try {
        await store.saveSettings(next);
        if (meta && JSON.stringify(meta) !== before)
          await store.setChatMetadata({ persona: meta['persona'] });
      } catch (e) {
        error = msg(e);
      }
    });
    return queue;
  }

  // ---- backup / restore / name attribution (DEV_NOTES §9.35) ----
  /** ST `#personas_backup` */
  async function backup() {
    if (!settingsPlain) return;
    try {
      const text = JSON.stringify(backupPersonas(settingsPlain), null, 2);
      const target = await exportText(personaBackupFileName(), text);
      if (target) notice = await describeExport(target);
    } catch (e) {
      error = msg(e);
    }
  }
  /** ST `#personas_restore`: merges and never overwrites; a persona without an image gets the default one */
  async function restore() {
    if (!store.root || !store.settings) return;
    const [file] = await pickFiles({ extensions: ['json'], title: '用户设定备份' });
    if (!file) return;
    busy = '恢复用户设定…';
    error = null;
    try {
      const next = structuredClone($state.snapshot(store.settings)) as Record<string, unknown>;
      const r = restorePersonas(next, await readPickedJson(file), files);
      await ensureDefaultUserAvatar(store.root);
      const have = await listUserAvatars(store.root);
      const source = have.includes('user-default.png') ? 'user-default.png' : have[0];
      for (const f of r.needAvatar)
        if (source && /\.png$/i.test(f)) await copyUserAvatarFile(store.root, source, f);
      await store.saveSettings(next);
      files = await listUserAvatars(store.root);
      notice = `已恢复 ${r.added} 个设定${r.skipped ? `，已有的 ${r.skipped} 项没有改动` : ''}`;
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
  /** ST `#sync_name_button`: the user messages of the open chat take the current persona */
  async function syncName() {
    syncOpen = false;
    if (!current) return;
    try {
      const n = await store.attributeUserMessages(current.name, userForceAvatar(settingsPlain));
      notice = n
        ? `已把 ${n} 条用户消息归到「${current.name}」`
        : '本聊天的用户消息已经都是这个设定的了';
    } catch (e) {
      error = msg(e);
    }
  }

  const select = (avatar: string) =>
    mutate((s, m) => {
      const r = selectPersona(s, m, avatar);
      if (r.autoLocked) notice = '已选择并自动锁定到本聊天';
    });
  const setField = (patch: Parameters<typeof setPersonaFields>[2]) =>
    current && mutate((s) => setPersonaFields(s, current.avatar, patch));
  const rename = (name: string) => current && mutate((s) => renamePersona(s, current.avatar, name));
  const toggleDefault = () => current && mutate((s) => toggleDefaultPersona(s, current.avatar));
  const toggleLock = (type: 'chat' | 'character') =>
    current &&
    mutate((s, m) => {
      const locked = type === 'chat' ? current.lockedToChat : current.lockedToCharacter;
      const unlinked = setPersonaLock(s, m, type, current.avatar, connection, !locked);
      if (unlinked.length) notice = `已解除其他设定的绑定：${unlinked.join('、')}`;
    });

  async function create() {
    const root = store.root;
    if (!root || !createName.trim()) return;
    createOpen = false;
    busy = '新建…';
    error = null;
    try {
      let avatar: string;
      if (createWithUpload) {
        const [file] = await pickFiles({
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
          title: '头像',
        });
        if (!file) return;
        const uploaded = await cropForAvatar(file, settingsPlain, (image, crop) =>
          uploadPersonaAvatar(root, image, settingsPlain, undefined, crop),
        );
        if (uploaded === null) return;
        avatar = uploaded;
      } else {
        // ST createDummyPersona: date + ASCII name, image = the default avatar
        avatar = newPersonaAvatarId(createName.trim());
        await copyUserAvatarFile(root, files[0] ?? 'user-default.png', avatar);
      }
      await mutate((s) => {
        initPersona(s, avatar, createName.trim(), '', createTitle.trim());
        selectPersona(s, null, avatar);
      });
      files = await listUserAvatars(root);
      notice = `已创建「${createName.trim()}」`;
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }

  async function changeAvatar() {
    const root = store.root;
    const target = current?.avatar;
    if (!root || !target) return;
    const [file] = await pickFiles({
      extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
      title: '头像',
    });
    if (!file) return;
    try {
      const done = await cropForAvatar(file, settingsPlain, async (image, crop) => {
        busy = '更换头像…';
        await uploadPersonaAvatar(root, image, settingsPlain, target, crop);
        return true;
      });
      if (!done) return;
      avatarVersion += 1;
      notice = '头像已更换';
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }

  async function duplicate() {
    if (!store.root || !current) return;
    busy = '复制…';
    try {
      let id: string | null = null;
      await mutate((s) => {
        id = duplicatePersona(s, current.avatar);
      });
      if (id) await copyUserAvatarFile(store.root, current.avatar, id);
      files = await listUserAvatars(store.root);
      notice = '已复制';
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }

  async function doDelete() {
    deleteOpen = false;
    if (!store.root || !current) return;
    busy = '删除…';
    try {
      const avatar = current.avatar;
      await deleteUserAvatarFile(store.root, avatar);
      files = await listUserAvatars(store.root);
      await mutate((s, m) => {
        const r = deletePersona(s, m, avatar);
        if (r.defaultCleared) notice = '默认设定已删除，需要重新指定';
        // ST reloads the chat's persona afterwards; the fallback is the first remaining avatar
        if (files[0]) selectPersona(s, m, files[0]);
      });
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
</script>

{#if !isTauri()}
  <section class="tm-form"><p class="tm-form__hint">用户设定需要在 app 里运行。</p></section>
{:else}
  <section class="tm-form drawer-content" id="PersonaManagement">
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

    {#if current}
      <div class="tm-pe__head">
        <button
          class="tm-pe__avatar"
          onclick={changeAvatar}
          disabled={!!busy}
          aria-label="更换头像"
        >
          <img src="{userAvatarUrl(store.root ?? '', current.avatar)}?v={avatarVersion}" alt="" />
          <span class="tm-pe__avatar-hint"><Icon name="image" size="sm" />换头像</span>
        </button>
        <div class="tm-pe__head-fields">
          <label class="tm-form__field">
            <span class="tm-form__label">名字 <small>{'{{user}}'}</small></span>
            <input
              id="your_name"
              class="text_pole tm-form__input"
              type="text"
              value={current.name === UNNAMED_PERSONA ? '' : current.name}
              placeholder="未命名"
              autocapitalize="off"
              autocorrect="off"
              onchange={(e) => rename(e.currentTarget.value)}
            />
          </label>
          <label class="tm-form__field">
            <span class="tm-form__label">称号 <small>只用于显示</small></span>
            <input
              class="text_pole tm-form__input"
              type="text"
              value={current.title}
              autocapitalize="off"
              onchange={(e) => setField({ title: e.currentTarget.value })}
            />
          </label>
        </div>
      </div>
      <div class="tm-form__actions">
        <button
          class="menu_button tm-form__chip"
          class:is-on={current.isDefault}
          onclick={toggleDefault}
        >
          <Icon name="star" size="sm" />{current.isDefault ? '默认设定' : '设为默认'}
        </button>
        {#if store.open}
          <button
            class="menu_button tm-form__chip"
            class:is-on={current.lockedToChat}
            onclick={() => toggleLock('chat')}
          >
            <Icon name="check" size="sm" />{current.lockedToChat ? '已锁定本聊天' : '锁定到本聊天'}
          </button>
          <button
            class="menu_button tm-form__chip"
            class:is-on={current.lockedToCharacter}
            onclick={() => toggleLock('character')}
          >
            <Icon name="user" size="sm" />{current.lockedToCharacter
              ? `已绑定${store.group ? '本群' : store.displayName}`
              : `绑定到${store.group ? '本群' : store.displayName}`}
          </button>
          <button
            id="sync_name_button"
            class="menu_button tm-form__chip"
            disabled={!!busy}
            onclick={() => (syncOpen = true)}
          >
            <Icon name="pencil" size="sm" />归到本聊天
          </button>
        {/if}
        <button class="menu_button tm-form__chip" disabled={!!busy} onclick={duplicate}>
          <Icon name="copy" size="sm" />复制
        </button>
        <button
          class="menu_button tm-form__chip tm-form__chip--danger"
          disabled={!!busy || files.length <= 1}
          onclick={() => (deleteOpen = true)}
        >
          <Icon name="trash" size="sm" />删除
        </button>
      </div>

      <div class="tm-form__section">
        <label class="tm-form__field">
          <span class="tm-form__label">描述 <small>{'{{persona}}'}</small></span>
          <textarea
            id="persona_description"
            class="text_pole tm-form__textarea"
            rows="5"
            value={currentDescriptor?.description ?? ''}
            placeholder="你是谁、长什么样、和角色是什么关系…"
            onchange={(e) => setField({ description: e.currentTarget.value })}></textarea>
        </label>
        <div class="tm-form__field">
          <span class="tm-form__label">注入位置</span>
          <div class="tm-form__list" role="radiogroup" aria-label="注入位置">
            {#each PERSONA_POSITION_OPTIONS as o (o.value)}
              <label class="checkbox_label tm-form__check">
                <input
                  type="radio"
                  name="persona_description_position"
                  value={o.value}
                  checked={position === o.value}
                  onchange={() => setField({ position: o.value })}
                />
                <span
                  >{o.label}{#if 'hint' in o}<small> {o.hint}</small>{/if}</span
                >
              </label>
            {/each}
          </div>
        </div>
        {#if position === PERSONA_DESCRIPTION_POSITIONS.AT_DEPTH}
          <div class="tm-form__row">
            <label class="tm-form__field tm-form__field--narrow">
              <span class="tm-form__label">深度</span>
              <input
                id="persona_depth_value"
                class="text_pole tm-form__input"
                type="number"
                min="0"
                value={Number(currentDescriptor?.depth ?? 2)}
                onchange={(e) =>
                  setField({ depth: Math.max(0, Number(e.currentTarget.value) || 0) })}
              />
            </label>
            <div class="tm-form__field">
              <span class="tm-form__label">角色</span>
              <Segmented
                label="角色"
                value={String(currentDescriptor?.role ?? 0)}
                options={[
                  { value: '0', label: '系统' },
                  { value: '1', label: '用户' },
                  { value: '2', label: '助手' },
                ]}
                onchange={(v) => setField({ role: Number(v) })}
              />
            </div>
          </div>
        {/if}
        <label class="tm-form__field">
          <span class="tm-form__label"
            >世界书 <small>随这个设定一起扫描</small>
            {#if onOpenWorlds}<button class="tm-form__link" onclick={onOpenWorlds}>去编辑</button
              >{/if}</span
          >
          <select
            id="persona_lore"
            class="text_pole tm-form__select"
            value={currentDescriptor?.lorebook ?? ''}
            onchange={(e) => setField({ lorebook: e.currentTarget.value })}
          >
            <option value="">（无）</option>
            {#each worlds as w (w)}<option value={w}>{w}</option>{/each}
          </select>
        </label>
      </div>
    {/if}

    <div class="tm-form__section">
      <h2 class="tm-form__heading">
        <span>全部设定 <small>{files.length}</small></span>
        <span class="tm-form__actions">
          <button
            class="menu_button tm-form__chip"
            disabled={!!busy}
            onclick={() => {
              createName = '';
              createTitle = '';
              createWithUpload = false;
              createOpen = true;
            }}><Icon name="plus" size="sm" />新建</button
          >
          <button
            id="personas_backup"
            class="menu_button tm-form__chip"
            disabled={!!busy}
            onclick={() => void backup()}><Icon name="file-export" size="sm" />备份</button
          >
          <button
            id="personas_restore"
            class="menu_button tm-form__chip"
            disabled={!!busy}
            onclick={() => void restore()}>恢复</button
          >
        </span>
      </h2>
      <ul class="tm-pe__grid" id="user_avatar_block">
        {#each personas as p (p.avatar)}
          <li>
            <button
              class="tm-pe__card avatar-container"
              class:selected={p.isCurrent}
              class:default_persona={p.isDefault}
              class:is-active={p.isCurrent}
              data-avatar-id={p.avatar}
              onclick={() => select(p.avatar)}
            >
              <span class="avatar tm-pe__card-avatar-wrap"
                ><img
                  class="tm-pe__card-avatar"
                  src="{userAvatarUrl(store.root ?? '', p.avatar)}?v={avatarVersion}"
                  alt=""
                  loading="lazy"
                /></span
              >
              <span class="ch_name tm-pe__card-name"
                >{p.name === UNNAMED_PERSONA ? '未命名' : p.name}</span
              >
              {#if p.title}<span class="ch_description tm-pe__card-title">{p.title}</span>{/if}
              <span class="tm-pe__badges">
                {#if p.isDefault}<span class="tm-pe__badge">默认</span>{/if}
                {#if p.lockedToChat}<span class="tm-pe__badge">本聊天</span>{/if}
                {#if p.lockedToCharacter}<span class="tm-pe__badge">已绑定</span>{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </div>

    <div class="tm-form__section">
      <h2 class="tm-form__heading"><span>行为</span></h2>
      <label class="checkbox_label tm-form__check">
        <input
          id="persona_auto_lock"
          type="checkbox"
          checked={!!pu['persona_auto_lock']}
          onchange={(e) => {
            const v = e.currentTarget.checked;
            void mutate((s) => {
              const p = (s['power_user'] as Record<string, unknown>) ?? {};
              s['power_user'] = { ...p, persona_auto_lock: v };
            });
          }}
        />
        <span>选中即锁定到当前聊天 <small>persona_auto_lock</small></span>
      </label>
      <label class="checkbox_label tm-form__check">
        <input
          id="persona_allow_multi_connections"
          type="checkbox"
          checked={!!pu['persona_allow_multi_connections']}
          onchange={(e) => {
            const v = e.currentTarget.checked;
            void mutate((s) => {
              const p = (s['power_user'] as Record<string, unknown>) ?? {};
              s['power_user'] = { ...p, persona_allow_multi_connections: v };
            });
          }}
        />
        <span>允许多个设定绑定同一角色 <small>persona_allow_multi_connections</small></span>
      </label>
    </div>
  </section>

  <BottomSheet open={createOpen} title="新建用户设定" onClose={() => (createOpen = false)}>
    <div class="tm-pe__sheet">
      <label class="tm-form__field">
        <span class="tm-form__label">名字</span>
        <input
          class="text_pole tm-form__input"
          type="text"
          bind:value={createName}
          autocapitalize="off"
          autocorrect="off"
          placeholder="必填"
        />
      </label>
      <label class="tm-form__field">
        <span class="tm-form__label">称号 <small>可选</small></span>
        <input
          class="text_pole tm-form__input"
          type="text"
          bind:value={createTitle}
          autocapitalize="off"
        />
      </label>
      <label class="checkbox_label tm-form__check">
        <input type="checkbox" bind:checked={createWithUpload} />
        <span>从相册选头像 <small>不选则先用默认头像</small></span>
      </label>
      <div class="tm-form__sheet-actions">
        <Button variant="outline" onclick={() => (createOpen = false)}>取消</Button>
        <Button variant="primary" disabled={!createName.trim()} onclick={create}>创建</Button>
      </div>
    </div>
  </BottomSheet>

  <BottomSheet open={syncOpen} title="归到本聊天" onClose={() => (syncOpen = false)}>
    <p class="tm-form__sheet-text">
      把本聊天里所有用户消息的名字和头像改成「{current?.name}」？聊天文件会被改写，无法撤销。
    </p>
    <div class="tm-form__sheet-actions">
      <Button variant="outline" onclick={() => (syncOpen = false)}>取消</Button>
      <Button variant="primary" onclick={syncName}>改写</Button>
    </div>
  </BottomSheet>

  <BottomSheet open={deleteOpen} title="删除用户设定" onClose={() => (deleteOpen = false)}>
    <p class="tm-form__sheet-text">删除「{current?.name}」？头像文件和描述都会移除，无法撤销。</p>
    <div class="tm-form__sheet-actions">
      <Button variant="outline" onclick={() => (deleteOpen = false)}>取消</Button>
      <Button variant="primary" class="tm-pe__danger-btn" onclick={doDelete}>删除</Button>
    </div>
  </BottomSheet>
{/if}

<style>
  .tm-pe__head {
    display: flex;
    gap: var(--tm-space-5);
    align-items: flex-start;
  }
  .tm-pe__avatar {
    position: relative;
    flex: none;
    width: calc(var(--tm-avatar-size) * 2.4);
    aspect-ratio: 2 / 3;
    border-radius: var(--tm-radius-md);
    overflow: hidden;
    background: var(--tm-color-surface-sunken);
  }
  .tm-pe__avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .tm-pe__avatar-hint {
    position: absolute;
    inset: auto 0 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--tm-space-1);
    padding: var(--tm-space-1);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-on-accent);
    background: color-mix(in srgb, var(--tm-color-text) 55%, transparent);
  }
  .tm-pe__head-fields {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-3);
  }
  .tm-form__chip.is-on {
    color: var(--tm-color-accent);
    border-color: var(--tm-color-accent);
  }
  .tm-pe__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(var(--tm-avatar-size) * 2.6), 1fr));
    gap: var(--tm-space-3);
  }
  .tm-pe__card {
    position: relative;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--tm-space-1);
    padding: var(--tm-space-3);
    border-radius: var(--tm-radius-lg);
    border: var(--tm-border-width) solid var(--tm-color-border);
    background: var(--tm-color-surface);
    text-align: center;
  }
  .tm-pe__card.is-active {
    border-color: var(--tm-color-accent);
    box-shadow: inset 0 0 0 1px var(--tm-color-accent);
  }
  .tm-pe__card-avatar-wrap {
    display: block;
    line-height: 0;
  }
  .tm-pe__card-avatar {
    width: calc(var(--tm-avatar-size) * 1.6);
    height: calc(var(--tm-avatar-size) * 1.6);
    border-radius: var(--tm-radius-avatar);
    object-fit: cover;
    background: var(--tm-color-surface-sunken);
  }
  .tm-pe__card-name {
    font-size: var(--tm-text-sm);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .tm-pe__card-title,
  .tm-pe__badge {
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }
  .tm-pe__badges {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--tm-space-1);
    min-height: var(--tm-space-4);
  }
  .tm-pe__badge {
    padding: 0 var(--tm-space-2);
    border-radius: var(--tm-radius-full);
    border: var(--tm-border-width) solid var(--tm-color-border);
    color: var(--tm-color-text-secondary);
  }
  .tm-pe__sheet {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-4);
  }
  :global(.tm-pe__danger-btn) {
    background: var(--tm-color-danger) !important;
  }
</style>
