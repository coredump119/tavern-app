<script lang="ts">
  /**
   * Character editor = ST's #form_create / #character_popup on one scrolling page (DEV_NOTES §9.17):
   * avatar, name, favourite, tags (settings.json tag_map), the card fields, advanced definitions;
   * more-menu: open chat / duplicate / rename / delete. Saving rewrites the PNG's card chunks.
   */
  import { untrack } from 'svelte';
  import { parseCard, toV2, type CharacterEditForm } from '@tm/formats';
  import { describeExport, exportCardPng, exportText } from '../lib/export';
  import {
    charLoreOf,
    characterPersonaAvatar,
    personaFromCharacter,
    setCharLore,
    swapPersonaMacros,
  } from '@tm/core';
  import Button from '@tm/ui/components/Button.svelte';
  import BottomSheet from '../lib/components/BottomSheet.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import TagEditor from '../lib/components/TagEditor.svelte';
  import { chatStore } from '../lib/chat/store.svelte';
  import { fileUrl } from '../lib/ipc';
  import { pickFiles } from '../lib/files';
  import { cropForAvatar } from '../lib/crop.svelte';
  import { uploadPersonaAvatar } from '../lib/personas';
  import { embeddedWorldName, importEmbeddedWorld } from '../lib/worlds';
  import {
    deleteCharacter,
    duplicateCharacter,
    listWorlds,
    loadCharacter,
    renameCharacter,
    replaceAvatar,
    saveCharacter,
    type LoadedCharacter,
  } from '../lib/characters';

  interface Props {
    avatar: string;
    onClose: () => void;
    onOpenChat?: ((avatar: string) => void) | undefined;
    onRenamed?: ((avatar: string) => void) | undefined;
    onDeleted?: (() => void) | undefined;
  }
  let { avatar, onClose, onOpenChat, onRenamed, onDeleted }: Props = $props();
  const store = chatStore;

  // $state.raw: the stored card goes to @tm/formats as `existing`, and structuredClone rejects $state proxies
  let loaded = $state.raw<LoadedCharacter | null>(null);
  let form = $state<CharacterEditForm>({ ch_name: '' });
  let initial = $state('');
  let worlds = $state<string[]>([]);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let advanced = $state(false);
  let avatarVersion = $state(0);
  let moreOpen = $state(false);
  let deleteOpen = $state(false);
  let embedOpen = $state(false);
  let personaOpen = $state(false);
  let personaSwap = $state(true);
  let deleteChats = $state(true);
  let renameOpen = $state(false);
  let renameTo = $state('');
  let renameChats = $state(true);

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const dirty = $derived(JSON.stringify(form) !== initial);
  const avatarUrl = $derived(
    store.root ? `${fileUrl(`${store.root}/characters/${avatar}`)}?v=${avatarVersion}` : '',
  );
  const greetings = $derived(
    Array.isArray(form.alternate_greetings) ? form.alternate_greetings : [],
  );
  const talk = $derived(Number(form.talkativeness ?? 0.5));

  // ---- tags (settings.json `tags` / `tag_map`), saved immediately like ST ----
  const settingsPlain = $derived(store.settings ? $state.snapshot(store.settings) : null);
  // ---- world books: embedded book, extra books (DEV_NOTES §9.35) ----
  const stem = $derived(avatar.replace(/\.png$/i, ''));
  const embedded = $derived(loaded ? embeddedWorldName(loaded.raw) : null);
  /** ST `checkEmbeddedWorld`: the card carries a book and its linked world is not a file here */
  const embeddedPending = $derived(!!embedded && !(form.world && worlds.includes(form.world)));
  const extraBooks = $derived(settingsPlain ? charLoreOf(settingsPlain, stem) : []);
  const extraOptions = $derived([...worlds, ...extraBooks.filter((b) => !worlds.includes(b))]);
  async function setExtraBooks(books: string[]) {
    if (!settingsPlain) return;
    const copy = structuredClone(settingsPlain);
    setCharLore(copy, stem, books);
    try {
      await store.saveSettings(copy);
    } catch (e) {
      error = msg(e);
    }
  }
  /** ST `importEmbeddedWorldInfo`: the book becomes a world file and the card links to it */
  async function doImportEmbedded() {
    embedOpen = false;
    if (!store.root || !loaded) return;
    error = null;
    let name: string;
    try {
      name = await importEmbeddedWorld(store.root, loaded.raw);
      worlds = await listWorlds(store.root);
    } catch (e) {
      error = msg(e);
      return;
    }
    form.world = name;
    await save();
    if (!error) notice = `已导入世界书「${name}」并链接到这张卡`;
  }

  // ---- character → persona (ST convertCharacterToPersona) ----
  const personaName = $derived(loaded?.form.ch_name ?? '');
  const personaText = $derived(loaded?.form.description ?? '');
  const personaExists = $derived.by(() => {
    const pu = settingsPlain?.['power_user'] as { personas?: Record<string, unknown> } | undefined;
    return characterPersonaAvatar(personaName) in (pu?.personas ?? {});
  });
  const personaHasMacros = $derived(/\{\{(char|user)\}\}/i.test(personaText));
  async function doToPersona() {
    personaOpen = false;
    if (!store.root || !loaded || !settingsPlain) return;
    busy = '创建用户设定…';
    error = null;
    try {
      const file = await uploadPersonaAvatar(
        store.root,
        `${store.root}/characters/${avatar}`,
        settingsPlain,
        characterPersonaAvatar(personaName),
      );
      const copy = structuredClone(settingsPlain);
      const text = personaSwap && personaHasMacros ? swapPersonaMacros(personaText) : personaText;
      personaFromCharacter(copy, file, personaName, text);
      await store.saveSettings(copy);
      notice = `已创建用户设定「${personaName}」，在「用户设定」页可以选用`;
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }

  // ---- load / save ----
  async function load(a: string) {
    if (!store.root) await store.init();
    if (!store.root) return;
    busy = '读取中…';
    error = null;
    notice = null;
    try {
      const l = await loadCharacter(store.root, a);
      loaded = l;
      const f = structuredClone(l.form);
      f.tags = (Array.isArray(f.tags) ? f.tags : []).join(', ');
      form = f;
      initial = JSON.stringify(f);
      renameTo = f.ch_name;
      worlds = await listWorlds(store.root);
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
  $effect(() => {
    const a = avatar;
    untrack(() => void load(a));
  });

  async function save() {
    if (!store.root || !loaded) return;
    const name = form.ch_name.trim();
    if (!name || name === '.') {
      error = '名字不能为空';
      return;
    }
    busy = '保存中…';
    error = null;
    try {
      const snap = $state.snapshot(form);
      const out = await saveCharacter(store.root, loaded, snap);
      loaded = { ...loaded, raw: out };
      initial = JSON.stringify(snap);
      await store.refreshCharacters();
      if (store.character?.avatar === avatar) await store.reloadCharacter();
      notice = '已保存';
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }

  async function changeAvatar() {
    const root = store.root;
    if (!root) return;
    const [file] = await pickFiles({
      extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
      title: '头像',
    });
    if (!file) return;
    error = null;
    try {
      const done = await cropForAvatar(file, settingsPlain, async (image, crop) => {
        busy = '更换头像…';
        await replaceAvatar(root, avatar, image, settingsPlain, true, crop);
        return true;
      });
      if (!done) return;
      avatarVersion += 1;
      await store.refreshCharacters();
      notice = '头像已更换';
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }

  function setGreeting(i: number, v: string) {
    const next = greetings.slice();
    next[i] = v;
    form.alternate_greetings = next;
  }
  function addGreeting() {
    form.alternate_greetings = [...greetings, ''];
  }
  function removeGreeting(i: number) {
    form.alternate_greetings = greetings.filter((_, k) => k !== i);
  }

  // ---- more menu ----
  async function doDuplicate() {
    moreOpen = false;
    if (!store.root) return;
    busy = '复制中…';
    try {
      const a = await duplicateCharacter(store.root, avatar);
      await store.refreshCharacters();
      notice = `已复制为 ${a}`;
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
  /** ST `/api/characters/export`: png = the card with private fields unset; json = V2 card */
  async function doExport(format: 'png' | 'json') {
    moreOpen = false;
    if (!store.root || !loaded) return;
    busy = '导出…';
    error = null;
    try {
      const stem = avatar.replace(/\.png$/i, '');
      let target;
      if (format === 'png') target = await exportCardPng(store.root, avatar);
      else {
        const card = toV2(parseCard(structuredClone(loaded.raw))) as Record<string, unknown>;
        card['fav'] = false;
        delete card['chat'];
        const data = (card['data'] as Record<string, unknown> | undefined) ?? {};
        const ext = (data['extensions'] as Record<string, unknown> | undefined) ?? {};
        card['data'] = { ...data, extensions: { ...ext, fav: false } };
        target = await exportText(`${stem}.json`, JSON.stringify(card, null, 4));
      }
      if (target) notice = await describeExport(target);
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
  async function doDelete() {
    deleteOpen = false;
    if (!store.root) return;
    busy = '删除中…';
    try {
      // scripts may have left changes that are not in the files yet (DEV_NOTES §9.5)
      await store.flushDeferred();
      const next = await deleteCharacter(store.root, avatar, deleteChats, settingsPlain);
      if (next) await store.saveSettings(next);
      if (store.character?.avatar === avatar) await store.closeCharacter();
      // an open group keeps its file (ST leaves groups alone) but drops the missing member in memory
      else if (store.group?.members.includes(avatar)) await store.reloadGroup();
      await store.refreshCharacters();
      onDeleted?.();
    } catch (e) {
      error = msg(e);
      busy = null;
    }
  }
  async function doRename() {
    const name = renameTo.trim();
    if (!name || !store.root) return;
    if (name === form.ch_name) {
      renameOpen = false;
      notice = '名字没有变化';
      return;
    }
    if (dirty) {
      error = '请先保存（或放弃）未保存的修改，再重命名';
      renameOpen = false;
      return;
    }
    renameOpen = false;
    busy = '重命名中…';
    error = null;
    try {
      // scripts may have left changes that are not in the files yet (DEV_NOTES §9.5)
      await store.flushDeferred();
      const r = await renameCharacter(store.root, avatar, name, renameChats, settingsPlain);
      if (r.settings) await store.saveSettings(r.settings);
      await store.refreshCharacters();
      if (store.character?.avatar === avatar) await store.openCharacter(r.avatar);
      else if (store.group?.members.includes(avatar)) {
        // the group file and its chats were rewritten on disk: reload members + the open chat
        await store.reloadGroup();
        if (store.chatFile) await store.openChat(store.chatFile);
      }
      notice = renameChats
        ? `已重命名；更新了 ${r.chatsRewritten} 个聊天文件${r.groupsUpdated ? `、${r.groupsUpdated} 个群聊` : ''}`
        : '已重命名';
      onRenamed?.(r.avatar);
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }

  /** Textareas grow with their content (re-fit when the bound value changes). */
  function autogrow(node: HTMLTextAreaElement, _value: string | undefined) {
    const fit = () => {
      node.style.height = 'auto';
      node.style.height = `${node.scrollHeight}px`;
    };
    fit();
    node.addEventListener('input', fit);
    return {
      update() {
        fit();
      },
      destroy() {
        node.removeEventListener('input', fit);
      },
    };
  }
</script>

<section class="tm-ce drawer-content" id="rm_ch_create_block">
  <div class="tm-ce__bar">
    <button class="tm-ce__link" onclick={onClose}><Icon name="chevron-left" />角色列表</button>
    <span class="tm-ce__status">{busy ?? (dirty ? '未保存' : '')}</span>
    <Button variant="primary" size="sm" disabled={!!busy || !dirty || !loaded} onclick={save}
      >保存</Button
    >
  </div>

  {#if error}
    <p class="tm-ce__error" role="alert">
      <span>{error}</span><button class="tm-ce__link" onclick={() => (error = null)}>关闭</button>
    </p>
  {/if}
  {#if notice}
    <p class="tm-ce__notice">
      <span>{notice}</span><button class="tm-ce__link" onclick={() => (notice = null)}>关闭</button>
    </p>
  {/if}

  {#if loaded}
    <div class="tm-ce__head">
      <button class="tm-ce__avatar" onclick={changeAvatar} disabled={!!busy} aria-label="更换头像">
        <img src={avatarUrl} alt="" />
        <span class="tm-ce__avatar-hint"><Icon name="image" size="sm" />换头像</span>
      </button>
      <div class="tm-ce__head-fields">
        <label class="tm-ce__field">
          <span class="tm-ce__label">名字</span>
          <input
            id="character_name_pole"
            class="tm-ce__input"
            type="text"
            bind:value={form.ch_name}
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            placeholder="角色名"
          />
        </label>
        <div class="tm-ce__head-actions">
          <button
            id="favorite_button"
            class="tm-ce__chip"
            class:is-on={form.fav === true || form.fav === 'true'}
            onclick={() => (form.fav = !(form.fav === true || form.fav === 'true'))}
          >
            <Icon name="star" size="sm" />{form.fav === true || form.fav === 'true'
              ? '已收藏'
              : '收藏'}
          </button>
          <button class="tm-ce__chip" onclick={() => (moreOpen = true)}>
            <Icon name="ellipsis" size="sm" />更多
          </button>
        </div>
      </div>
    </div>

    <div class="tm-ce__field" id="tags_div">
      <span class="tm-ce__label">标签</span>
      <TagEditor entityKey={avatar} inputId="tagInput" onError={(m) => (error = m)} />
    </div>

    <label class="tm-ce__field">
      <span class="tm-ce__label">描述</span>
      <textarea
        id="description_textarea"
        class="tm-ce__textarea"
        rows="4"
        bind:value={form.description}
        use:autogrow={form.description}></textarea>
    </label>

    <label class="tm-ce__field">
      <span class="tm-ce__label">开场白</span>
      <textarea
        id="firstmessage_textarea"
        class="tm-ce__textarea"
        rows="4"
        bind:value={form.first_mes}
        use:autogrow={form.first_mes}></textarea>
    </label>

    <div class="tm-ce__field">
      <span class="tm-ce__label">备选开场白 <small>{greetings.length}</small></span>
      {#each greetings as g, i (i)}
        <div class="tm-ce__greeting">
          <textarea
            aria-label={`备选开场白 ${i + 1}`}
            class="tm-ce__textarea"
            rows="3"
            value={g}
            oninput={(e) => setGreeting(i, e.currentTarget.value)}
            use:autogrow={g}></textarea>
          <button class="tm-ce__icon" aria-label="删除备选开场白" onclick={() => removeGreeting(i)}
            ><Icon name="trash" /></button
          >
        </div>
      {/each}
      <button class="tm-ce__chip" onclick={addGreeting}
        ><Icon name="plus" size="sm" />添加备选开场白</button
      >
    </div>

    <button class="tm-ce__section" aria-expanded={advanced} onclick={() => (advanced = !advanced)}>
      <span>高级定义</span><Icon name={advanced ? 'chevron-up' : 'chevron-down'} />
    </button>
    {#if advanced}
      <div id="character_popup" class="tm-ce__advanced">
        <label class="tm-ce__field">
          <span class="tm-ce__label">主提示词覆盖 <small>system_prompt</small></span>
          <textarea
            id="system_prompt_textarea"
            class="tm-ce__textarea"
            rows="2"
            bind:value={form.system_prompt}
            use:autogrow={form.system_prompt}></textarea>
        </label>
        <label class="tm-ce__field">
          <span class="tm-ce__label">历史后指令覆盖 <small>post_history_instructions</small></span>
          <textarea
            id="post_history_instructions_textarea"
            class="tm-ce__textarea"
            rows="2"
            bind:value={form.post_history_instructions}
            use:autogrow={form.post_history_instructions}></textarea>
        </label>
        <label class="tm-ce__field">
          <span class="tm-ce__label">创作者备注</span>
          <textarea
            id="creator_notes_textarea"
            class="tm-ce__textarea"
            rows="2"
            bind:value={form.creator_notes}
            use:autogrow={form.creator_notes}></textarea>
        </label>
        <div class="tm-ce__row">
          <label class="tm-ce__field">
            <span class="tm-ce__label">创作者</span>
            <input
              id="creator_textarea"
              class="tm-ce__input"
              type="text"
              bind:value={form.creator}
            />
          </label>
          <label class="tm-ce__field">
            <span class="tm-ce__label">版本</span>
            <input
              id="character_version_textarea"
              class="tm-ce__input"
              type="text"
              bind:value={form.character_version}
            />
          </label>
        </div>
        <label class="tm-ce__field">
          <span class="tm-ce__label">卡内标签 <small>逗号分隔，随卡片导出</small></span>
          <input
            id="tags_textarea"
            class="tm-ce__input"
            type="text"
            value={typeof form.tags === 'string' ? form.tags : (form.tags ?? []).join(', ')}
            oninput={(e) => (form.tags = e.currentTarget.value)}
          />
        </label>
        <label class="tm-ce__field">
          <span class="tm-ce__label">性格</span>
          <textarea
            id="personality_textarea"
            class="tm-ce__textarea"
            rows="2"
            bind:value={form.personality}
            use:autogrow={form.personality}></textarea>
        </label>
        <label class="tm-ce__field">
          <span class="tm-ce__label">场景</span>
          <textarea
            id="scenario_pole"
            class="tm-ce__textarea"
            rows="2"
            bind:value={form.scenario}
            use:autogrow={form.scenario}></textarea>
        </label>
        <label class="tm-ce__field">
          <span class="tm-ce__label">对话示例</span>
          <textarea
            id="mes_example_textarea"
            class="tm-ce__textarea"
            rows="3"
            bind:value={form.mes_example}
            use:autogrow={form.mes_example}></textarea>
        </label>
        <label class="tm-ce__field">
          <span class="tm-ce__label">角色世界书</span>
          <select
            id="character_world"
            class="tm-ce__input"
            value={form.world ?? ''}
            onchange={(e) => (form.world = e.currentTarget.value)}
          >
            <option value="">（无）</option>
            {#each worlds as w (w)}<option value={w}>{w}</option>{/each}
            {#if form.world && !worlds.includes(form.world)}
              <option value={form.world}>{form.world}（文件不存在）</option>
            {/if}
          </select>
        </label>
        {#if embeddedPending}
          <p class="tm-ce__lore-hint">
            <span>这张卡自带世界书「{embedded}」，还没导入。</span>
            <button class="tm-ce__link" disabled={!!busy} onclick={() => (embedOpen = true)}
              >导入</button
            >
          </p>
        {/if}
        {#if extraOptions.length > 0}
          <label class="tm-ce__field">
            <span class="tm-ce__label">附加世界书 <small>可多选，选完立即生效</small></span>
            <select
              multiple
              class="tm-ce__input tm-ce__multi character_extra_world_info_selector"
              onchange={(e) =>
                void setExtraBooks(Array.from(e.currentTarget.selectedOptions, (o) => o.value))}
            >
              {#each extraOptions as w (w)}
                <option value={w} selected={extraBooks.includes(w)}
                  >{w}{worlds.includes(w) ? '' : '（文件不存在）'}</option
                >
              {/each}
            </select>
          </label>
        {/if}
        <label class="tm-ce__field">
          <span class="tm-ce__label"
            >健谈度 <small>群聊里主动发言的概率</small>
            <span class="tm-ce__value">{talk.toFixed(2)}</span></span
          >
          <input
            id="talkativeness_slider"
            class="tm-ce__range"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={talk}
            oninput={(e) => (form.talkativeness = e.currentTarget.value)}
          />
        </label>
        <div class="tm-ce__field">
          <span class="tm-ce__label">角色备注 <small>深度注入</small></span>
          <textarea
            aria-label="角色备注"
            id="depth_prompt_prompt"
            class="tm-ce__textarea"
            rows="2"
            bind:value={form.depth_prompt_prompt}
            use:autogrow={form.depth_prompt_prompt}></textarea>
          <div class="tm-ce__row">
            <label class="tm-ce__field">
              <span class="tm-ce__label">深度</span>
              <input
                id="depth_prompt_depth"
                class="tm-ce__input"
                type="number"
                min="0"
                max="9999"
                value={form.depth_prompt_depth ?? 4}
                oninput={(e) => (form.depth_prompt_depth = e.currentTarget.value)}
              />
            </label>
            <label class="tm-ce__field">
              <span class="tm-ce__label">角色</span>
              <select
                id="depth_prompt_role"
                class="tm-ce__input"
                value={form.depth_prompt_role ?? 'system'}
                onchange={(e) => (form.depth_prompt_role = e.currentTarget.value)}
              >
                <option value="system">system</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </select>
            </label>
          </div>
        </div>
      </div>
    {/if}
    <p class="tm-ce__meta">
      {avatar}{loaded.raw['create_date'] ? ` · ${loaded.raw['create_date']}` : ''}
    </p>
  {:else if !busy && !error}
    <p class="tm-ce__meta">没有读到角色。</p>
  {/if}
</section>

<BottomSheet open={moreOpen} title={form.ch_name || avatar} onClose={() => (moreOpen = false)}>
  {#if onOpenChat}
    <button
      class="tm-opt"
      onclick={() => {
        moreOpen = false;
        onOpenChat(avatar);
      }}><Icon name="arrow-right" /><span>打开聊天</span></button
    >
  {/if}
  <button id="export_button_png" class="tm-opt" disabled={!!busy} onclick={() => doExport('png')}
    ><Icon name="image" /><span>导出 PNG</span><small>卡片原图，收藏与当前聊天字段已清</small
    ></button
  >
  <button id="export_button_json" class="tm-opt" disabled={!!busy} onclick={() => doExport('json')}
    ><Icon name="copy" /><span>导出 JSON</span><small>酒馆格式角色卡（有 V3 数据时为 V3）</small
    ></button
  >
  {#if embedded}
    <button
      id="import_character_info"
      class="tm-opt"
      disabled={!!busy}
      onclick={() => {
        moreOpen = false;
        embedOpen = true;
      }}><Icon name="file-lines" /><span>导入卡内世界书</span><small>{embedded}</small></button
    >
  {/if}
  <button
    id="convert_to_persona"
    class="tm-opt"
    disabled={!!busy}
    onclick={() => {
      moreOpen = false;
      personaSwap = true;
      personaOpen = true;
    }}><Icon name="user" /><span>转成用户设定</span><small>用这张卡的头像和描述</small></button
  >
  <button id="dupe_button" class="tm-opt" disabled={!!busy} onclick={doDuplicate}
    ><Icon name="copy" /><span>复制角色</span><small>生成一份副本卡片</small></button
  >
  <button
    id="renameCharButton"
    class="tm-opt"
    disabled={!!busy}
    onclick={() => {
      moreOpen = false;
      renameTo = form.ch_name;
      renameOpen = true;
    }}><Icon name="pencil" /><span>重命名</span><small>同时改文件名与聊天目录</small></button
  >
  <button
    id="delete_button"
    class="tm-opt tm-opt--danger"
    disabled={!!busy}
    onclick={() => {
      moreOpen = false;
      deleteOpen = true;
    }}><Icon name="trash" /><span>删除角色</span></button
  >
</BottomSheet>

<BottomSheet open={deleteOpen} title="删除角色" onClose={() => (deleteOpen = false)}>
  <p class="tm-ce__sheet-text">
    删除「{form.ch_name}」（{avatar}）？卡片文件会被移除，无法撤销。
  </p>
  <label class="tm-ce__check">
    <input type="checkbox" bind:checked={deleteChats} />
    同时删除聊天记录（{store.character?.avatar === avatar ? store.chats.length : '全部'}）
  </label>
  <div class="tm-ce__sheet-actions">
    <Button variant="outline" onclick={() => (deleteOpen = false)}>取消</Button>
    <Button variant="primary" class="tm-ce__danger-btn" onclick={doDelete}>删除</Button>
  </div>
</BottomSheet>

<BottomSheet open={embedOpen} title="导入卡内世界书" onClose={() => (embedOpen = false)}>
  <p class="tm-ce__sheet-text">
    把卡里自带的世界书存成「{embedded}」并链接到这张卡，当前的修改会一起保存。{#if embedded && worlds.includes(embedded)}已经有同名的世界书，会被覆盖。{/if}
  </p>
  <div class="tm-ce__sheet-actions">
    <Button variant="outline" onclick={() => (embedOpen = false)}>取消</Button>
    <Button variant="primary" onclick={doImportEmbedded}>导入</Button>
  </div>
</BottomSheet>

<BottomSheet open={personaOpen} title="转成用户设定" onClose={() => (personaOpen = false)}>
  <p class="tm-ce__sheet-text">
    用「{personaName}」已保存的头像和描述新建一个用户设定。{#if personaExists}已经有同名的设定，会被覆盖。{/if}
  </p>
  {#if personaHasMacros}
    <label class="tm-ce__check">
      <input type="checkbox" bind:checked={personaSwap} />
      对调描述里的 {'{{char}}'} 和 {'{{user}}'}
    </label>
  {/if}
  <div class="tm-ce__sheet-actions">
    <Button variant="outline" onclick={() => (personaOpen = false)}>取消</Button>
    <Button variant="primary" onclick={doToPersona}>创建</Button>
  </div>
</BottomSheet>

<BottomSheet open={renameOpen} title="重命名角色" onClose={() => (renameOpen = false)}>
  <input
    aria-label="新名字"
    class="tm-ce__input"
    type="text"
    bind:value={renameTo}
    placeholder="新名字"
    autocapitalize="off"
    autocorrect="off"
    onkeydown={(e) => {
      if (e.key === 'Enter') void doRename();
    }}
  />
  <label class="tm-ce__check">
    <input type="checkbox" bind:checked={renameChats} />
    同时更新历史聊天里的角色名
  </label>
  <p class="tm-ce__sheet-text">文件会改名为新名字对应的 PNG，聊天目录一起移动。</p>
  <div class="tm-ce__sheet-actions">
    <Button variant="outline" onclick={() => (renameOpen = false)}>取消</Button>
    <Button variant="primary" onclick={doRename}>重命名</Button>
  </div>
</BottomSheet>

<style>
  .tm-ce {
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
  .tm-ce__bar {
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
  .tm-ce__status {
    flex: 1;
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
    text-align: right;
  }
  .tm-ce__link {
    display: inline-flex;
    align-items: center;
    gap: var(--tm-space-1);
    min-height: calc(var(--tm-touch-target) * 0.8);
    color: var(--tm-color-text-link);
    font-size: var(--tm-text-sm);
  }
  .tm-ce__error,
  .tm-ce__notice {
    display: flex;
    justify-content: space-between;
    gap: var(--tm-space-3);
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-secondary);
  }
  .tm-ce__error {
    color: var(--tm-color-danger);
  }
  .tm-ce__head {
    display: flex;
    gap: var(--tm-space-5);
    align-items: flex-start;
  }
  .tm-ce__avatar {
    position: relative;
    flex: none;
    width: calc(var(--tm-avatar-size) * 2.4);
    aspect-ratio: 2 / 3;
    border-radius: var(--tm-radius-lg);
    overflow: hidden;
    background: var(--tm-color-surface-sunken);
  }
  .tm-ce__avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .tm-ce__avatar-hint {
    position: absolute;
    inset: auto 0 0 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--tm-space-1);
    padding: var(--tm-space-2);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-on-accent);
    background: color-mix(in srgb, var(--tm-color-scrim) 70%, transparent);
  }
  .tm-ce__head-fields {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-3);
  }
  .tm-ce__head-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--tm-space-2);
  }
  .tm-ce__field {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-2);
    min-width: 0;
    flex: 1;
  }
  .tm-ce__label {
    display: flex;
    align-items: baseline;
    gap: var(--tm-space-2);
    font-size: var(--tm-text-xs);
    font-weight: 600;
    letter-spacing: var(--tm-tracking-wide);
    color: var(--tm-color-text-secondary);
  }
  .tm-ce__label small {
    font-weight: 400;
    letter-spacing: var(--tm-tracking-normal);
    color: var(--tm-color-text-muted);
  }
  .tm-ce__value {
    margin-left: auto;
    font-family: var(--tm-font-mono);
    font-weight: 400;
  }
  .tm-ce__input,
  .tm-ce__textarea {
    width: 100%;
    min-height: var(--tm-touch-target);
    padding: var(--tm-space-3) var(--tm-space-4);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-sunken);
    color: var(--tm-color-text);
    font-family: var(--tm-font-body);
    font-size: var(--tm-text-md);
    line-height: var(--tm-leading-normal);
  }
  .tm-ce__input {
    font-family: var(--tm-font-ui);
  }
  .tm-ce__textarea {
    resize: none;
    overflow: hidden;
  }
  .tm-ce__input:focus-visible,
  .tm-ce__textarea:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--tm-color-border-strong);
  }
  .tm-ce__range {
    width: 100%;
    accent-color: var(--tm-color-accent);
  }
  .tm-ce__row {
    display: flex;
    gap: var(--tm-space-4);
  }
  .tm-ce__chip {
    display: inline-flex;
    align-items: center;
    gap: var(--tm-space-2);
    min-height: calc(var(--tm-touch-target) * 0.8);
    padding: 0 var(--tm-space-4);
    border-radius: var(--tm-radius-full);
    border: var(--tm-border-width) solid var(--tm-color-border);
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text);
    align-self: flex-start;
  }
  .tm-ce__chip:hover {
    background: var(--tm-color-surface-sunken);
  }
  .tm-ce__chip.is-on {
    color: var(--tm-color-warning);
    border-color: var(--tm-color-warning);
  }
  .tm-ce__greeting {
    display: flex;
    gap: var(--tm-space-2);
    align-items: flex-start;
    margin-bottom: var(--tm-space-2);
  }
  .tm-ce__icon {
    flex: none;
    width: var(--tm-touch-target);
    height: var(--tm-touch-target);
    display: inline-grid;
    place-items: center;
    border-radius: var(--tm-radius-md);
    color: var(--tm-color-text-secondary);
  }
  .tm-ce__icon:hover {
    color: var(--tm-color-danger);
    background: var(--tm-color-surface-sunken);
  }
  .tm-ce__section {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    min-height: var(--tm-touch-target);
    padding: var(--tm-space-2) 0;
    border-top: var(--tm-border-width) solid var(--tm-color-border);
    border-bottom: var(--tm-border-width) solid var(--tm-color-border);
    font-size: var(--tm-text-md);
    font-weight: 600;
    color: var(--tm-color-text);
  }
  .tm-ce__advanced {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-5);
  }
  .tm-ce__meta {
    font-family: var(--tm-font-mono);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
    overflow-wrap: anywhere;
  }
  .tm-opt {
    display: grid;
    grid-template-columns: var(--tm-icon-md) minmax(0, 1fr);
    column-gap: var(--tm-space-4);
    align-items: center;
    text-align: left;
    width: 100%;
    min-height: var(--tm-touch-target);
    padding: var(--tm-space-2) var(--tm-space-3);
    border-radius: var(--tm-radius-md);
    color: var(--tm-color-text);
    font-size: var(--tm-text-md);
  }
  .tm-opt:hover:not(:disabled) {
    background: var(--tm-color-surface-sunken);
  }
  .tm-opt:disabled {
    opacity: 0.4;
  }
  .tm-opt small {
    grid-column: 2;
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }
  .tm-opt--danger {
    color: var(--tm-color-danger);
  }
  .tm-ce__lore-hint {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--tm-space-3);
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-secondary);
  }
  .tm-ce__multi {
    height: auto;
    min-height: var(--tm-touch-target);
  }
  .tm-ce__sheet-text {
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-secondary);
    line-height: var(--tm-leading-relaxed);
    padding: var(--tm-space-2) 0;
  }
  .tm-ce__check {
    display: flex;
    align-items: center;
    gap: var(--tm-space-3);
    min-height: var(--tm-touch-target);
    font-size: var(--tm-text-sm);
  }
  .tm-ce__check input {
    accent-color: var(--tm-color-accent);
    width: var(--tm-icon-md);
    height: var(--tm-icon-md);
  }
  .tm-ce__sheet-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--tm-space-3);
    padding-top: var(--tm-space-3);
  }
  :global(.tm-ce__danger-btn) {
    background: var(--tm-color-danger) !important;
  }
  @media (max-width: 599px) {
    .tm-ce__row {
      flex-direction: column;
    }
  }
</style>
