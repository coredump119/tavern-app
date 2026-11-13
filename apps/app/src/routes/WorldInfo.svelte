<script lang="ts">
  /**
   * World Info editor (ST "Worlds/Lorebooks" drawer — DEV_NOTES §9.20): pick / create / rename /
   * delete books, global activation, entry list with search, entry editor sheet, global scan settings.
   */
  import { onDestroy, onMount } from 'svelte';
  import {
    DEFAULT_WORLD_INFO_SETTINGS,
    WI_LOGIC_OPTIONS,
    WI_POSITION_OPTIONS,
    WI_TRIGGER_OPTIONS,
    WORLD_INFO_INSERTION_STRATEGY,
    createWorldInfoEntry,
    deleteWorldInfoEntry,
    duplicateWorldInfoEntry,
    entryStrategy,
    entryTitle,
    globalSelectOf,
    joinKeywords,
    positionOptionId,
    setEntryPosition,
    setEntryStrategy,
    setWorldInfoEntryField,
    reorderWorldEntries,
    sortWorldEntries,
    splitKeywordsAndRegexes,
    WI_SORT_CUSTOM,
    WI_SORT_OPTIONS,
    type WIBookData,
    type WIEntryData,
    type WIEntryStrategy,
  } from '@tm/core';
  import Button from '@tm/ui/components/Button.svelte';
  import Segmented from '@tm/ui/components/Segmented.svelte';
  import BottomSheet from '../lib/components/BottomSheet.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import { chatStore } from '../lib/chat/store.svelte';
  import { isTauri, pngTextRead } from '../lib/ipc';
  import { flushSettings, persistSettings } from '../lib/oai.svelte';
  import { describeExport, exportText } from '../lib/export';
  import { pickFiles, readPickedJson } from '../lib/files';
  import {
    createWorld,
    deleteWorld,
    importWorldBook,
    listWorldNames,
    readWorld,
    relinkCharacters,
    renameWorld,
    writeWorld,
  } from '../lib/worlds';

  const store = chatStore;
  let names = $state<string[]>([]);
  let current = $state('');
  let book = $state.raw<WIBookData | null>(null);
  // the book is mutated in place by @tm/core; bump to re-derive the views
  let version = $state(0);
  let globalSelect = $state<string[]>([]);
  let query = $state('');
  let editingUid = $state<number | null>(null);
  let keysText = $state('');
  let secondaryText = $state('');
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let moreOpen = $state(false);
  let renameOpen = $state(false);
  let renameTo = $state('');
  let deleteOpen = $state(false);
  let relink = $state<{ name: string; avatars: string[] } | null>(null);
  let newOpen = $state(false);
  let newName = $state('');
  let settingsOpen = $state(false);
  let advancedOpen = $state(false);
  let wi = $state<Record<string, unknown>>({});

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // ---- list order (ST #world_info_sort_order; the choice lives in localStorage like ST's) ----
  const SORT_KEY = 'world_info_sort_order';
  function loadSortOrder(): number {
    try {
      const v = Number(localStorage.getItem(SORT_KEY) ?? 0);
      return WI_SORT_OPTIONS.some((o) => o.value === v) ? v : 0;
    } catch {
      return 0;
    }
  }
  let sortOrder = $state(loadSortOrder());
  function setSortOrder(value: number) {
    sortOrder = value;
    try {
      localStorage.setItem(SORT_KEY, String(value));
    } catch {
      /* storage unavailable */
    }
  }
  /** custom order only: swap with the neighbour, then renumber the book as ST's drag does */
  function moveEntry(uid: number, delta: -1 | 1) {
    if (!book) return;
    const uids = sortWorldEntries(Object.values(book.entries), WI_SORT_CUSTOM).map((e) =>
      Number(e['uid']),
    );
    const from = uids.indexOf(uid);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= uids.length) return;
    [uids[from], uids[to]] = [uids[to]!, uids[from]!];
    reorderWorldEntries(book, uids);
    touch();
  }
  const canMove = $derived(sortOrder === WI_SORT_CUSTOM && !query.trim());

  const entries = $derived.by<WIEntryData[]>(() => {
    void version;
    if (!book) return [];
    // shallow copies: core mutates entries in place, and a keyed {#each} skips items whose
    // object identity did not change, so the list would keep showing the old title
    const all = sortWorldEntries(Object.values(book.entries), sortOrder).map((e) => ({ ...e }));
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((e) =>
      [entryTitle(e), joinKeywords(e['key']), String(e['content'] ?? '')].some((t) =>
        t.toLowerCase().includes(q),
      ),
    );
  });
  const total = $derived.by(() => {
    void version;
    return book ? Object.keys(book.entries).length : 0;
  });
  const editing = $derived.by<WIEntryData | null>(() => {
    void version;
    return book && editingUid !== null ? (book.entries[editingUid] ?? null) : null;
  });
  const isGlobal = $derived(globalSelect.includes(current));

  // ---- load ----
  onMount(async () => {
    if (!isTauri()) return;
    await store.init();
    const settings = store.settings ? $state.snapshot(store.settings) : {};
    globalSelect = globalSelectOf(settings);
    wi = {
      ...DEFAULT_WORLD_INFO_SETTINGS,
      ...((settings['world_info_settings'] as Record<string, unknown> | undefined) ?? {}),
    };
    await refreshNames();
    const first = globalSelect.find((n) => names.includes(n)) ?? names[0];
    if (first) await openBook(first);
  });
  onDestroy(() => {
    void flushBook();
    void flushSettings();
  });

  async function refreshNames() {
    if (!store.root) return;
    try {
      names = await listWorldNames(store.root);
    } catch (e) {
      error = msg(e);
    }
  }

  async function openBook(name: string) {
    if (!store.root || !name) return;
    await flushBook();
    busy = '读取中…';
    error = null;
    try {
      book = await readWorld(store.root, name);
      current = name;
      editingUid = null;
      version++;
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }

  // ---- saving (ST saveWorldDebounced) ----
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  function touch() {
    version++;
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushBook(), 500);
  }
  async function flushBook() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty || !book || !current || !store.root) return;
    dirty = false;
    try {
      await writeWorld(store.root, current, book);
    } catch (e) {
      dirty = true;
      error = msg(e);
    }
  }

  // ---- books ----
  async function doCreate() {
    newOpen = false;
    if (!store.root) return;
    try {
      await flushBook();
      const name = await createWorld(store.root, newName);
      await refreshNames();
      await openBook(name);
      notice = `已新建「${name}」`;
    } catch (e) {
      error = msg(e);
    }
  }
  /** the name the picker returned, also for iOS `file://` URLs */
  const pickedName = (path: string) => decodeURIComponent(path.split(/[\\/]/).pop() ?? path);
  /** an embedded book is far smaller; the cap only stops a huge picture from being read whole */
  const WORLD_PNG_MAX_BYTES = 50 * 1024 * 1024;
  /** ST importWorldInfo: a `.png` carries the book as base64 JSON in its `naidata` text chunk */
  async function readWorldFile(path: string): Promise<unknown> {
    if (!/\.png$/i.test(pickedName(path))) return readPickedJson(path);
    const text = await pngTextRead(path, 'naidata', WORLD_PNG_MAX_BYTES);
    if (text === null) throw new Error('文件无效：图片里没有内嵌的世界书');
    return JSON.parse(text);
  }
  /** ST `#world_import_button`: each file becomes a book named after it (DEV_NOTES §9.35) */
  async function doImport() {
    if (!store.root) return;
    const files = await pickFiles({
      extensions: ['json', 'png'],
      multiple: true,
      title: '世界书',
    });
    if (files.length === 0) return;
    busy = '导入世界书…';
    error = null;
    const done: string[] = [];
    const failed: string[] = [];
    try {
      await flushBook();
      for (const f of files) {
        try {
          done.push(await importWorldBook(store.root, pickedName(f), await readWorldFile(f)));
        } catch (e) {
          failed.push(`${pickedName(f)}：${msg(e)}`);
        }
      }
      await refreshNames();
      const last = done.at(-1);
      if (last) await openBook(last);
      notice = done.length ? `已导入 ${done.map((n) => `「${n}」`).join('')}` : null;
      if (failed.length) error = `没能导入：${failed.join('；')}`;
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
  /** ST `#world_popup_export`: the open book as `<name>.json` */
  async function doExport() {
    moreOpen = false;
    if (!current) return;
    try {
      await flushBook();
      const data = book ?? (await readWorld(store.root ?? '', current));
      const target = await exportText(`${current}.json`, JSON.stringify(data, null, 4));
      if (target) notice = await describeExport(target);
    } catch (e) {
      error = msg(e);
    }
  }
  /** world_info_settings = scan settings (`wi`) + `world_info.globalSelect`, written as one patch */
  function persistWi() {
    const settings = store.settings ? $state.snapshot(store.settings) : {};
    const cur = (settings['world_info_settings'] as Record<string, unknown> | undefined) ?? {};
    const inner = (cur['world_info'] as Record<string, unknown> | undefined) ?? {};
    persistSettings({
      world_info_settings: {
        ...cur,
        ...wi,
        world_info: { ...inner, globalSelect: [...globalSelect] },
      },
    });
  }
  function saveGlobal(next: string[]) {
    globalSelect = next;
    persistWi();
  }
  function toggleGlobal(on: boolean) {
    const next = globalSelect.filter((n) => n !== current);
    if (on) next.push(current);
    saveGlobal(next);
  }
  async function doRename() {
    renameOpen = false;
    if (!store.root || !book || !current) return;
    busy = '重命名…';
    try {
      await flushBook();
      await flushSettings();
      const r = await renameWorld(
        store.root,
        current,
        renameTo,
        book,
        store.settings ? $state.snapshot(store.settings) : null,
        store.characters.map((c) => c.avatar),
      );
      if (r.settings) {
        await store.saveSettings(r.settings);
        globalSelect = globalSelectOf(r.settings);
      }
      await refreshNames();
      current = r.name;
      notice = `已重命名为「${r.name}」`;
      if (r.linkedAvatars.length) relink = { name: r.name, avatars: r.linkedAvatars };
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
  async function doRelink() {
    const r = relink;
    relink = null;
    if (!r || !store.root) return;
    try {
      const n = await relinkCharacters(store.root, r.avatars, r.name);
      await store.refreshCharacters();
      if (store.character && r.avatars.includes(store.character.avatar))
        await store.reloadCharacter();
      notice = `已更新 ${n} 个角色的世界书链接`;
    } catch (e) {
      error = msg(e);
    }
  }
  async function doDelete() {
    deleteOpen = false;
    if (!store.root || !current) return;
    busy = '删除中…';
    try {
      dirty = false;
      if (saveTimer) clearTimeout(saveTimer);
      await flushSettings();
      const next = await deleteWorld(
        store.root,
        current,
        store.settings ? $state.snapshot(store.settings) : null,
      );
      if (next) {
        await store.saveSettings(next);
        globalSelect = globalSelectOf(next);
      }
      const gone = current;
      book = null;
      current = '';
      await refreshNames();
      if (names[0]) await openBook(names[0]);
      notice = `已删除「${gone}」`;
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }

  // ---- entries ----
  function openEntry(uid: number) {
    if (!book) return;
    const e = book.entries[uid];
    if (!e) return;
    editingUid = uid;
    keysText = joinKeywords(e['key']);
    secondaryText = joinKeywords(e['keysecondary']);
    advancedOpen = false;
  }
  function addEntry() {
    if (!book) return;
    const e = createWorldInfoEntry(book);
    if (!e) return;
    touch();
    openEntry(Number(e['uid']));
  }
  function set(field: string, value: unknown) {
    if (!book || editingUid === null) return;
    setWorldInfoEntryField(book, editingUid, field, value);
    touch();
  }
  function setOn(uid: number, field: string, value: unknown) {
    if (!book) return;
    setWorldInfoEntryField(book, uid, field, value);
    touch();
  }
  function setNum(field: string, raw: string, nullable = false) {
    const t = raw.trim();
    if (nullable && t === '') return set(field, null);
    const v = Number(t);
    if (Number.isFinite(v)) set(field, v);
  }
  function setTri(field: string, raw: string) {
    set(field, raw === '' ? null : raw === 'true');
  }
  function commitKeys(field: 'key' | 'keysecondary', text: string) {
    // select2 tags never hold the same keyword twice
    set(field, [...new Set(splitKeywordsAndRegexes(text))]);
    if (field === 'key') keysText = joinKeywords(editing?.['key']);
    else secondaryText = joinKeywords(editing?.['keysecondary']);
  }
  function duplicateEntry() {
    if (!book || editingUid === null) return;
    const e = duplicateWorldInfoEntry(book, editingUid);
    if (!e) return;
    touch();
    openEntry(Number(e['uid']));
    notice = '已复制条目';
  }
  function removeEntry() {
    if (!book || editingUid === null) return;
    deleteWorldInfoEntry(book, editingUid);
    editingUid = null;
    touch();
  }
  function toggleTrigger(t: string, on: boolean) {
    const list = Array.isArray(editing?.['triggers']) ? [...(editing['triggers'] as string[])] : [];
    const next = on ? [...new Set([...list, t])] : list.filter((x) => x !== t);
    set('triggers', next);
  }

  // ---- global scan settings ----
  function setWi(key: string, value: unknown) {
    wi = { ...wi, [key]: value };
    persistWi();
  }
  const wiNum = (k: string) => Number(wi[k] ?? 0);

  type Pair = readonly [string, string];
  type Triple = readonly [string, string, string];
  const SCAN_SLIDERS: ReadonlyArray<readonly [string, string, number, number, number, string]> = [
    ['world_info_depth', '扫描深度', 0, 1000, 1, '向前看多少条消息'],
    ['world_info_budget', '上下文占比 %', 1, 100, 1, '世界书最多占上下文的比例'],
    ['world_info_budget_cap', '预算上限（token）', 0, 65536, 1, '0 = 不限'],
    ['world_info_min_activations', '最少激活数', 0, 100, 1, '不够就继续往前扫'],
    ['world_info_min_activations_depth_max', '最少激活的最大深度', 0, 100, 1, '0 = 不限'],
    ['world_info_max_recursion_steps', '最大递归步数', 0, 10, 1, '0 = 不限'],
  ];
  const SCAN_TOGGLES: readonly Triple[] = [
    ['world_info_recursive', '递归扫描', '激活的条目内容也参与匹配'],
    ['world_info_case_sensitive', '区分大小写', ''],
    ['world_info_match_whole_words', '整词匹配', '对中文无效'],
    ['world_info_include_names', '匹配时带上名字', ''],
    ['world_info_use_group_scoring', '组内评分', ''],
    ['world_info_overflow_alert', '超预算提醒', ''],
  ];
  const TRISTATE_FIELDS: readonly Pair[] = [
    ['caseSensitive', '区分大小写'],
    ['matchWholeWords', '整词匹配'],
    ['useGroupScoring', '组内评分'],
  ];
  const TIMED_FIELDS: readonly Pair[] = [
    ['sticky', '粘滞'],
    ['cooldown', '冷却'],
    ['delay', '延迟'],
  ];
  const RECURSION_FIELDS: readonly Pair[] = [
    ['excludeRecursion', '不被递归激活'],
    ['preventRecursion', '不触发递归'],
    ['ignoreBudget', '不计入预算'],
  ];
  const MATCH_FIELDS: readonly Pair[] = [
    ['matchPersonaDescription', '用户设定'],
    ['matchCharacterDescription', '角色描述'],
    ['matchCharacterPersonality', '角色性格'],
    ['matchCharacterDepthPrompt', '角色备注'],
    ['matchScenario', '场景'],
    ['matchCreatorNotes', '创作者备注'],
  ];

  const strategyLabel: Record<WIEntryStrategy, string> = {
    constant: '常驻',
    normal: '关键词',
    vectorized: '向量',
  };
  const positionLabel = (e: WIEntryData) =>
    WI_POSITION_OPTIONS.find((o) => o.id === positionOptionId(e))?.label ?? '';
</script>

{#if !isTauri()}
  <section class="tm-form"><p class="tm-form__hint">世界书需要在 app 里运行。</p></section>
{:else}
  <section class="tm-form drawer-content" id="WorldInfo">
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
      <div class="tm-form__row">
        <label class="tm-form__field">
          <span class="tm-form__label">世界书 <small>worlds/ · {names.length} 本</small></span>
          <select
            id="world_editor_select"
            class="text_pole tm-form__select"
            value={current}
            disabled={!!busy}
            onchange={(e) => openBook(e.currentTarget.value)}
          >
            {#if !current}<option value="">（还没有世界书）</option>{/if}
            {#each names as n (n)}<option value={n}
                >{n}{globalSelect.includes(n) ? ' ●' : ''}</option
              >{/each}
          </select>
        </label>
        <button
          class="tm-form__icon"
          aria-label="更多"
          disabled={!current}
          onclick={() => (moreOpen = true)}><Icon name="ellipsis" /></button
        >
      </div>
      <div class="tm-form__actions">
        <Button
          variant="outline"
          size="sm"
          disabled={!!busy}
          onclick={() => {
            newName = '';
            newOpen = true;
          }}><Icon name="plus" size="sm" />新建世界书</Button
        >
        <Button
          id="world_import_button"
          variant="outline"
          size="sm"
          disabled={!!busy}
          onclick={() => void doImport()}>导入</Button
        >
        {#if current}
          <label class="checkbox_label tm-form__check">
            <input
              type="checkbox"
              checked={isGlobal}
              onchange={(e) => toggleGlobal(e.currentTarget.checked)}
            />
            <span>全局启用 <small>对所有聊天生效</small></span>
          </label>
        {/if}
      </div>
      <p class="tm-form__hint">角色专属的世界书在「角色设定 → 高级定义 → 角色世界书」里绑定。</p>
    </div>

    {#if book}
      <div class="tm-form__section">
        <h2 class="tm-form__heading">
          <span>条目 · {total}</span>
          <button class="menu_button tm-form__chip" onclick={addEntry}
            ><Icon name="plus" size="sm" />新条目</button
          >
        </h2>
        {#if total > 0}
          <input
            aria-label="搜索条目"
            class="text_pole tm-form__input"
            type="search"
            placeholder="搜索标题 / 关键词 / 内容"
            autocapitalize="off"
            bind:value={query}
          />
          <label class="tm-form__field">
            <span class="tm-form__label">排序</span>
            <select
              id="world_info_sort_order"
              class="text_pole tm-form__select"
              value={String(sortOrder)}
              onchange={(e) => setSortOrder(Number(e.currentTarget.value))}
            >
              {#each WI_SORT_OPTIONS as o (o.value)}<option value={String(o.value)}
                  >{o.label}</option
                >{/each}
            </select>
          </label>
          {#if sortOrder === WI_SORT_CUSTOM}
            <p class="tm-form__hint">
              {canMove ? '用条目右侧的箭头调整顺序。' : '清空搜索后才能调整顺序。'}
            </p>
          {/if}
        {/if}
        <div class="tm-form__list" id="world_popup_entries_list">
          {#each entries as e, i (e['uid'])}
            {@const uid = Number(e['uid'])}
            <div class="tm-form__item world_entry" class:is-off={!!e['disable']} data-uid={uid}>
              <input
                type="checkbox"
                aria-label="启用"
                checked={!e['disable']}
                onchange={(ev) => setOn(uid, 'disable', !ev.currentTarget.checked)}
              />
              <button class="tm-wi__open" onclick={() => openEntry(uid)}>
                <span class="tm-form__item-name">{entryTitle(e)}</span>
                <span class="tm-form__item-meta">
                  {strategyLabel[entryStrategy(e)]} · {positionLabel(e)}{Number(e['position']) === 4
                    ? ` ${e['depth'] ?? 4}`
                    : ''} · 次序 {e['order'] ?? 100}{e['useProbability'] &&
                  Number(e['probability'] ?? 100) < 100
                    ? ` · ${e['probability']}%`
                    : ''}
                </span>
              </button>
              {#if canMove}
                <span class="tm-form__item-actions">
                  <button
                    class="tm-form__icon"
                    aria-label="上移"
                    disabled={i === 0}
                    onclick={() => moveEntry(uid, -1)}><Icon name="chevron-up" size="sm" /></button
                  >
                  <button
                    class="tm-form__icon"
                    aria-label="下移"
                    disabled={i === entries.length - 1}
                    onclick={() => moveEntry(uid, 1)}><Icon name="chevron-down" size="sm" /></button
                  >
                </span>
              {:else}
                <span class="tm-wi__uid">#{uid}</span>
              {/if}
            </div>
          {:else}
            <p class="tm-form__hint">{total ? '没有匹配的条目。' : '这本世界书还是空的。'}</p>
          {/each}
        </div>
      </div>
    {:else if !busy && names.length === 0}
      <p class="tm-form__hint">
        还没有世界书。点「新建世界书」，或者整包导入 ST 备份时会一起带过来。
      </p>
    {/if}

    <button
      class="tm-form__heading tm-wi__toggle inline-drawer-header"
      aria-expanded={settingsOpen}
      onclick={() => (settingsOpen = !settingsOpen)}
    >
      <span>扫描设置（全局）</span><Icon name={settingsOpen ? 'chevron-up' : 'chevron-down'} />
    </button>
    {#if settingsOpen}
      <div class="tm-form__section" id="wiActivationSettings">
        {#each SCAN_SLIDERS as [key, label, min, max, step, hint] (key)}
          <label class="tm-form__field">
            <span class="tm-form__label"
              >{label} <small>{hint}</small><span class="tm-form__value">{wiNum(key)}</span></span
            >
            <input
              class="neo-range-slider tm-form__range"
              type="range"
              {min}
              {max}
              {step}
              value={wiNum(key)}
              oninput={(e) => setWi(key, Number(e.currentTarget.value))}
            />
          </label>
        {/each}
        {#each SCAN_TOGGLES as [key, label, hint] (key)}
          <label class="checkbox_label tm-form__check">
            <input
              type="checkbox"
              checked={!!wi[key]}
              onchange={(e) => setWi(key, e.currentTarget.checked)}
            />
            <span
              >{label}{#if hint}
                <small>{hint}</small>{/if}</span
            >
          </label>
        {/each}
        <label class="tm-form__field">
          <span class="tm-form__label">插入顺序 <small>角色与全局世界书谁先</small></span>
          <select
            class="text_pole tm-form__select"
            value={String(wiNum('world_info_character_strategy'))}
            onchange={(e) => setWi('world_info_character_strategy', Number(e.currentTarget.value))}
          >
            <option value={String(WORLD_INFO_INSERTION_STRATEGY.evenly)}>均匀排序</option>
            <option value={String(WORLD_INFO_INSERTION_STRATEGY.character_first)}>角色优先</option>
            <option value={String(WORLD_INFO_INSERTION_STRATEGY.global_first)}>全局优先</option>
          </select>
        </label>
      </div>
    {/if}
  </section>

  <!-- entry editor -->
  <BottomSheet
    open={!!editing}
    title={editing ? `条目 #${editing['uid']}` : ''}
    onClose={() => (editingUid = null)}
  >
    {#if editing}
      <div class="tm-wi__editor">
        <label class="tm-form__field">
          <span class="tm-form__label">标题 / 备注</span>
          <input
            class="text_pole tm-form__input"
            type="text"
            value={String(editing['comment'] ?? '')}
            oninput={(e) => set('comment', e.currentTarget.value)}
          />
        </label>
        <div class="tm-form__field">
          <span class="tm-form__label">触发方式</span>
          <Segmented
            label="触发方式"
            value={entryStrategy(editing)}
            options={[
              { value: 'normal', label: '关键词' },
              { value: 'constant', label: '常驻' },
              { value: 'vectorized', label: '向量' },
            ]}
            onchange={(v) => {
              if (book && editingUid !== null) {
                setEntryStrategy(book, editingUid, v);
                touch();
              }
            }}
          />
        </div>
        <label class="tm-form__field">
          <span class="tm-form__label">主关键词 <small>逗号分隔，/正则/ 可用</small></span>
          <input
            class="text_pole tm-form__input tm-form__input--mono"
            type="text"
            autocapitalize="off"
            autocorrect="off"
            bind:value={keysText}
            onchange={() => commitKeys('key', keysText)}
          />
        </label>
        <div class="tm-form__row tm-form__row--wrap">
          <label class="tm-form__field">
            <span class="tm-form__label">次关键词逻辑</span>
            <select
              class="text_pole tm-form__select"
              value={String(editing['selectiveLogic'] ?? 0)}
              onchange={(e) => set('selectiveLogic', Number(e.currentTarget.value))}
            >
              {#each WI_LOGIC_OPTIONS as o (o.value)}<option value={String(o.value)}
                  >{o.label}</option
                >{/each}
            </select>
          </label>
          <label class="tm-form__field">
            <span class="tm-form__label">次关键词 <small>可选</small></span>
            <input
              class="text_pole tm-form__input tm-form__input--mono"
              type="text"
              autocapitalize="off"
              autocorrect="off"
              bind:value={secondaryText}
              onchange={() => commitKeys('keysecondary', secondaryText)}
            />
          </label>
        </div>
        <label class="tm-form__field">
          <span class="tm-form__label">内容</span>
          <textarea
            class="text_pole tm-form__textarea"
            rows="6"
            value={String(editing['content'] ?? '')}
            oninput={(e) => set('content', e.currentTarget.value)}></textarea>
        </label>
        <h3 class="tm-form__subhead">插入</h3>
        <div class="tm-form__row tm-form__row--wrap">
          <label class="tm-form__field">
            <span class="tm-form__label">插入位置</span>
            <select
              class="text_pole tm-form__select"
              value={positionOptionId(editing)}
              onchange={(e) => {
                if (book && editingUid !== null) {
                  setEntryPosition(book, editingUid, e.currentTarget.value);
                  touch();
                }
              }}
            >
              {#each WI_POSITION_OPTIONS as o (o.id)}<option value={o.id}>{o.label}</option>{/each}
            </select>
          </label>
          {#if Number(editing['position']) === 4}
            <label class="tm-form__field tm-form__field--narrow">
              <span class="tm-form__label">深度</span>
              <input
                class="text_pole tm-form__input tm-form__input--mono"
                type="number"
                min="0"
                value={Number(editing['depth'] ?? 4)}
                onchange={(e) => setNum('depth', e.currentTarget.value)}
              />
            </label>
          {/if}
          <label class="tm-form__field tm-form__field--narrow">
            <span class="tm-form__label">次序</span>
            <input
              class="text_pole tm-form__input tm-form__input--mono"
              type="number"
              value={Number(editing['order'] ?? 100)}
              onchange={(e) => setNum('order', e.currentTarget.value)}
            />
          </label>
        </div>
        {#if Number(editing['position']) === 7}
          <label class="tm-form__field">
            <span class="tm-form__label">Outlet 名 <small>{'{{outlet::名字}}'} 取用</small></span>
            <input
              class="text_pole tm-form__input"
              type="text"
              autocapitalize="off"
              value={String(editing['outletName'] ?? '')}
              oninput={(e) => set('outletName', e.currentTarget.value)}
            />
          </label>
        {/if}
        <h3 class="tm-form__subhead">触发</h3>
        <div class="tm-form__row tm-form__row--wrap">
          <label class="checkbox_label tm-form__check">
            <input
              type="checkbox"
              checked={!!editing['useProbability']}
              onchange={(e) => set('useProbability', e.currentTarget.checked)}
            />
            <span>按概率触发</span>
          </label>
          {#if editing['useProbability']}
            <label class="tm-form__field tm-form__field--narrow">
              <span class="tm-form__label">概率 %</span>
              <input
                class="text_pole tm-form__input tm-form__input--mono"
                type="number"
                min="0"
                max="100"
                value={Number(editing['probability'] ?? 100)}
                onchange={(e) => setNum('probability', e.currentTarget.value)}
              />
            </label>
          {/if}
        </div>

        <button
          class="tm-form__heading tm-wi__toggle inline-drawer-header"
          aria-expanded={advancedOpen}
          onclick={() => (advancedOpen = !advancedOpen)}
        >
          <span>更多选项</span><Icon name={advancedOpen ? 'chevron-up' : 'chevron-down'} />
        </button>
        {#if advancedOpen}
          <div class="tm-form__row tm-form__row--wrap">
            <label class="tm-form__field">
              <span class="tm-form__label">扫描深度 <small>留空 = 全局</small></span>
              <input
                class="text_pole tm-form__input tm-form__input--mono"
                type="number"
                min="0"
                value={editing['scanDepth'] ?? ''}
                onchange={(e) => setNum('scanDepth', e.currentTarget.value, true)}
              />
            </label>
            {#each TRISTATE_FIELDS as [key, label] (key)}
              <label class="tm-form__field">
                <span class="tm-form__label">{label}</span>
                <select
                  class="text_pole tm-form__select"
                  value={editing[key] === null || editing[key] === undefined
                    ? ''
                    : String(editing[key])}
                  onchange={(e) => setTri(key, e.currentTarget.value)}
                >
                  <option value="">跟随全局</option>
                  <option value="true">是</option>
                  <option value="false">否</option>
                </select>
              </label>
            {/each}
          </div>
          <div class="tm-form__row tm-form__row--wrap">
            <label class="tm-form__field">
              <span class="tm-form__label">包含组 <small>逗号分隔</small></span>
              <input
                class="text_pole tm-form__input"
                type="text"
                autocapitalize="off"
                value={String(editing['group'] ?? '')}
                oninput={(e) => set('group', e.currentTarget.value)}
              />
            </label>
            <label class="tm-form__field tm-form__field--narrow">
              <span class="tm-form__label">组权重</span>
              <input
                class="text_pole tm-form__input tm-form__input--mono"
                type="number"
                min="1"
                value={Number(editing['groupWeight'] ?? 100)}
                onchange={(e) => setNum('groupWeight', e.currentTarget.value)}
              />
            </label>
          </div>
          <label class="checkbox_label tm-form__check">
            <input
              type="checkbox"
              checked={!!editing['groupOverride']}
              onchange={(e) => set('groupOverride', e.currentTarget.checked)}
            />
            <span>组内优先 <small>按次序选，不按权重随机</small></span>
          </label>
          <div class="tm-form__row">
            {#each TIMED_FIELDS as [key, label] (key)}
              <label class="tm-form__field">
                <span class="tm-form__label">{label} <small>条消息</small></span>
                <input
                  class="text_pole tm-form__input tm-form__input--mono"
                  type="number"
                  min="0"
                  value={editing[key] ?? ''}
                  onchange={(e) => setNum(key, e.currentTarget.value, true)}
                />
              </label>
            {/each}
          </div>
          {#each RECURSION_FIELDS as [key, label] (key)}
            <label class="checkbox_label tm-form__check">
              <input
                type="checkbox"
                checked={!!editing[key]}
                onchange={(e) => set(key, e.currentTarget.checked)}
              />
              <span>{label} <small>{key}</small></span>
            </label>
          {/each}
          <label class="tm-form__field">
            <span class="tm-form__label"
              >延迟到递归 <small>0 = 否；数字 = 第几层递归才激活</small></span
            >
            <input
              class="text_pole tm-form__input tm-form__input--mono"
              type="number"
              min="0"
              value={Number(editing['delayUntilRecursion'] ?? 0)}
              onchange={(e) => setNum('delayUntilRecursion', e.currentTarget.value)}
            />
          </label>
          <div class="tm-form__field">
            <span class="tm-form__label">额外匹配来源</span>
            {#each MATCH_FIELDS as [key, label] (key)}
              <label class="checkbox_label tm-form__check">
                <input
                  type="checkbox"
                  checked={!!editing[key]}
                  onchange={(e) => set(key, e.currentTarget.checked)}
                />
                <span>{label}</span>
              </label>
            {/each}
          </div>
          <div class="tm-form__field">
            <span class="tm-form__label">只在这些生成类型触发 <small>都不选 = 全部</small></span>
            <div class="tm-form__actions">
              {#each WI_TRIGGER_OPTIONS as t (t)}
                <label class="checkbox_label tm-form__check">
                  <input
                    type="checkbox"
                    checked={Array.isArray(editing['triggers']) &&
                      (editing['triggers'] as string[]).includes(t)}
                    onchange={(e) => toggleTrigger(t, e.currentTarget.checked)}
                  />
                  <span>{t}</span>
                </label>
              {/each}
            </div>
          </div>
          <label class="tm-form__field">
            <span class="tm-form__label">Automation ID</span>
            <input
              class="text_pole tm-form__input tm-form__input--mono"
              type="text"
              autocapitalize="off"
              value={String(editing['automationId'] ?? '')}
              oninput={(e) => set('automationId', e.currentTarget.value)}
            />
          </label>
        {/if}

        <div class="tm-form__sheet-footer">
          <span class="tm-form__sheet-footer-group">
            <button class="menu_button tm-form__chip tm-form__chip--danger" onclick={removeEntry}
              ><Icon name="trash" size="sm" />删除</button
            >
            <button class="menu_button tm-form__chip" onclick={duplicateEntry}
              ><Icon name="copy" size="sm" />复制</button
            >
          </span>
          <button
            class="menu_button tm-form__chip tm-form__chip--primary"
            onclick={() => (editingUid = null)}><Icon name="check" size="sm" />完成</button
          >
        </div>
      </div>
    {/if}
  </BottomSheet>

  <BottomSheet open={moreOpen} title={current} onClose={() => (moreOpen = false)}>
    <button
      class="tm-opt"
      onclick={() => {
        moreOpen = false;
        renameTo = current;
        renameOpen = true;
      }}><Icon name="pencil" /><span>重命名</span></button
    >
    <button id="world_popup_export" class="tm-opt" onclick={() => void doExport()}
      ><Icon name="file-export" /><span>导出为 JSON</span></button
    >
    <button
      class="tm-opt tm-opt--danger"
      onclick={() => {
        moreOpen = false;
        deleteOpen = true;
      }}><Icon name="trash" /><span>删除世界书</span></button
    >
  </BottomSheet>

  <BottomSheet open={newOpen} title="新建世界书" onClose={() => (newOpen = false)}>
    <input
      aria-label="世界书名字"
      class="text_pole tm-form__input"
      type="text"
      placeholder="名字（留空自动起名）"
      autocapitalize="off"
      bind:value={newName}
    />
    <div class="tm-form__sheet-actions">
      <Button variant="outline" onclick={() => (newOpen = false)}>取消</Button>
      <Button variant="primary" onclick={doCreate}>新建</Button>
    </div>
  </BottomSheet>

  <BottomSheet open={renameOpen} title="重命名世界书" onClose={() => (renameOpen = false)}>
    <input
      aria-label="新名字"
      class="text_pole tm-form__input"
      type="text"
      autocapitalize="off"
      bind:value={renameTo}
    />
    <div class="tm-form__sheet-actions">
      <Button variant="outline" onclick={() => (renameOpen = false)}>取消</Button>
      <Button
        variant="primary"
        disabled={!renameTo.trim() || renameTo.trim() === current}
        onclick={doRename}>重命名</Button
      >
    </div>
  </BottomSheet>

  <BottomSheet open={!!relink} title="更新角色链接" onClose={() => (relink = null)}>
    <p class="tm-form__sheet-text">
      有 {relink?.avatars.length ?? 0} 个角色把旧名字设为自己的世界书。要一起改成「{relink?.name}」吗？
    </p>
    <div class="tm-form__sheet-actions">
      <Button variant="outline" onclick={() => (relink = null)}>不用</Button>
      <Button variant="primary" onclick={doRelink}>更新</Button>
    </div>
  </BottomSheet>

  <BottomSheet open={deleteOpen} title="删除世界书" onClose={() => (deleteOpen = false)}>
    <p class="tm-form__sheet-text">删除「{current}」？文件会被移除，无法撤销。</p>
    <div class="tm-form__sheet-actions">
      <Button variant="outline" onclick={() => (deleteOpen = false)}>取消</Button>
      <Button variant="primary" onclick={doDelete}>删除</Button>
    </div>
  </BottomSheet>
{/if}

<style>
  .tm-wi__open {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--tm-space-1);
    min-width: 0;
    text-align: left;
    color: var(--tm-color-text);
  }
  .tm-wi__uid {
    font-family: var(--tm-font-mono);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }
  .tm-wi__toggle {
    width: 100%;
  }
  .tm-wi__editor {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-4);
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
  .tm-opt:hover {
    background: var(--tm-color-surface-sunken);
  }
  .tm-opt--danger {
    color: var(--tm-color-danger);
  }
</style>
