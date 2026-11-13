<script lang="ts">
  /**
   * Regex scripts = ST's regex extension panel (DEV_NOTES §9.25): three lists (global / current
   * preset / current character) with enable toggles, ordering, move between lists, import / export,
   * and an editor sheet with live test. Prompt-time behaviour is core `RegexEngine` (§9.11).
   */
  import { onMount } from 'svelte';
  import {
    MacroEngine,
    REGEX_PLACEMENT_OPTIONS,
    REGEX_SUBSTITUTE_OPTIONS,
    RegexEngine,
    importRegexScripts,
    isPresetRegexAllowed,
    isScopedRegexAllowed,
    migrateRegexScripts,
    newRegexScript,
    normalizeRegexScript,
    regexExportFileName,
    regexSaveWarnings,
    setPresetRegexAllowed,
    setScopedRegexAllowed,
    testRegexScript,
    toFullScript,
    type RegexScript,
    type RegexScriptFull,
  } from '@tm/core';
  import Button from '@tm/ui/components/Button.svelte';
  import Segmented from '@tm/ui/components/Segmented.svelte';
  import BottomSheet from '../lib/components/BottomSheet.svelte';
  import RegexDebugger from '../lib/components/RegexDebugger.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import { chatStore } from '../lib/chat/store.svelte';
  import { isTauri } from '../lib/ipc';
  import { pickFiles, readPickedJson } from '../lib/files';
  import { downloadText } from '../lib/download';
  import {
    extOf,
    globalRegexScripts,
    presetRegexScripts,
    regexPresetContext,
    scopedRegexScripts,
    setGlobalRegexScripts,
    setPresetRegexScripts,
    setScopedRegexScripts,
    type RegexScope,
  } from '../lib/regex';
  import {
    REGEX_SCOPES,
    allRegexBulkKeys,
    applyRegexBulk,
    pickedRegexScripts,
    regexBulkExportFileName,
    regexBulkKey,
    type RegexBulkOp,
    type RegexLists,
  } from '../lib/regex-bulk';

  const store = chatStore;
  const SCOPE_LABEL: Record<RegexScope, string> = {
    global: '全局',
    preset: '预设',
    scoped: '角色',
  };

  let scoped = $state<RegexScript[]>([]);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);

  const settingsPlain = $derived(store.settings ? $state.snapshot(store.settings) : null);
  const ext = $derived(
    (settingsPlain?.['extension_settings'] as Record<string, unknown> | undefined) ?? {},
  );
  const global = $derived(settingsPlain ? globalRegexScripts(structuredClone(settingsPlain)) : []);
  const preset = $derived(settingsPlain ? presetRegexScripts(structuredClone(settingsPlain)) : []);
  const presetCtx = $derived(settingsPlain ? regexPresetContext(settingsPlain) : null);
  const avatar = $derived(store.character?.avatar ?? null);
  const presetAllowed = $derived(
    !!presetCtx && isPresetRegexAllowed(ext, presetCtx.api, presetCtx.presetName),
  );
  const scopedAllowed = $derived(isScopedRegexAllowed(ext, avatar));
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  async function loadScoped() {
    if (!store.root || !avatar) {
      scoped = [];
      return;
    }
    try {
      scoped = await scopedRegexScripts(store.root, avatar);
    } catch (e) {
      error = msg(e);
    }
  }
  onMount(async () => {
    await store.init();
    // ST migrateSettings on load (global list only)
    if (store.settings) {
      const next = structuredClone($state.snapshot(store.settings)) as Record<string, unknown>;
      const list = globalRegexScripts(next);
      if (migrateRegexScripts(list)) {
        setGlobalRegexScripts(next, list);
        await store.saveSettings(next);
      }
    }
  });
  $effect(() => {
    void avatar;
    void loadScoped();
  });

  const listOf = (scope: RegexScope): RegexScript[] =>
    scope === 'global' ? global : scope === 'preset' ? preset : scoped;

  /** Persist one list (settings snapshot + preset file / card as needed). */
  async function saveList(scope: RegexScope, scripts: RegexScript[]) {
    if (!store.root || !store.settings) return;
    const next = structuredClone($state.snapshot(store.settings)) as Record<string, unknown>;
    busy = '保存…';
    error = null;
    try {
      if (scope === 'global') setGlobalRegexScripts(next, scripts);
      else if (scope === 'preset') await setPresetRegexScripts(store.root, next, scripts);
      else if (avatar) {
        await setScopedRegexScripts(store.root, next, avatar, scripts);
        await store.reloadCharacter();
        scoped = scripts;
      }
      await store.saveSettings(next);
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }

  const toggleEnabled = (scope: RegexScope, id: string) =>
    saveList(
      scope,
      listOf(scope).map((s) => (s.id === id ? { ...s, disabled: !s.disabled } : s)),
    );
  const move = (scope: RegexScope, i: number, dir: -1 | 1) => {
    const list = listOf(scope).slice();
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    void saveList(scope, list);
  };
  const remove = (scope: RegexScope, id: string) =>
    saveList(
      scope,
      listOf(scope).filter((s) => s.id !== id),
    );
  /** ST moveRegexScript: delete from one list, append to another */
  async function moveTo(from: RegexScope, to: RegexScope, script: RegexScript) {
    if (from === to) return;
    if (to === 'scoped' && !avatar) {
      error = '先在聊天里打开一个角色，才能把脚本移到角色卡上';
      return;
    }
    await saveList(
      from,
      listOf(from).filter((s) => s.id !== script.id),
    );
    await saveList(to, [...listOf(to), script]);
    moreTarget = null;
  }
  async function setAllowed(scope: 'preset' | 'scoped', allowed: boolean) {
    if (!store.settings) return;
    const next = structuredClone($state.snapshot(store.settings)) as Record<string, unknown>;
    if (scope === 'preset' && presetCtx)
      setPresetRegexAllowed(extOf(next), presetCtx.api, presetCtx.presetName, allowed);
    if (scope === 'scoped' && avatar) setScopedRegexAllowed(extOf(next), avatar, allowed);
    try {
      await store.saveSettings(next);
    } catch (e) {
      error = msg(e);
    }
  }

  async function importScripts(scope: RegexScope) {
    if (!store.root) return;
    const [file] = await pickFiles({ extensions: ['json'], title: '正则脚本 JSON' });
    if (!file) return;
    try {
      const raw = await readPickedJson(file);
      const scripts = importRegexScripts(raw);
      await saveList(scope, [...listOf(scope), ...scripts]);
      notice = `已导入 ${scripts.length} 个脚本`;
    } catch (e) {
      error = `导入失败：${msg(e)}`;
    }
  }
  const exportScript = (script: RegexScript) =>
    downloadText(regexExportFileName(script), JSON.stringify(script, null, 4));

  // ---- bulk selection (ST #bulk_*) ----
  let selecting = $state(false);
  let picked = $state<string[]>([]);
  let bulkMoveOpen = $state(false);
  let bulkDeleteOpen = $state(false);
  let debugOpen = $state(false);
  const lists = (): RegexLists => ({ global, preset, scoped });
  const allPicked = $derived.by(() => {
    const all = allRegexBulkKeys(lists());
    return all.length > 0 && all.every((k) => picked.includes(k));
  });
  function setSelecting(on: boolean) {
    selecting = on;
    picked = [];
  }
  function togglePicked(scope: RegexScope, id: string) {
    const key = regexBulkKey(scope, id);
    picked = picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key];
  }
  async function bulk(op: RegexBulkOp) {
    if (op.kind === 'move' && op.to === 'scoped' && !avatar) {
      error = '先在聊天里打开一个角色，才能把脚本移到角色卡上';
      return;
    }
    const changed = applyRegexBulk(lists(), new Set(picked), op);
    for (const scope of REGEX_SCOPES) {
      const next = changed[scope];
      if (next) await saveList(scope, next);
    }
    bulkMoveOpen = false;
    bulkDeleteOpen = false;
    // moved / deleted scripts no longer exist under their old keys
    if (op.kind === 'move' || op.kind === 'delete') picked = [];
  }
  function bulkExport() {
    const scripts = pickedRegexScripts(lists(), new Set(picked));
    if (!scripts.length) return;
    downloadText(regexBulkExportFileName(new Date()), JSON.stringify(scripts, null, 4));
  }

  // ---- editor ----
  let editorScope = $state<RegexScope>('global');
  let editing = $state<RegexScriptFull | null>(null);
  let editingIsNew = $state(false);
  let trimText = $state('');
  let testOpen = $state(false);
  let testInput = $state('');
  let moreTarget = $state<{ scope: RegexScope; script: RegexScript } | null>(null);
  const macro = new MacroEngine();
  const testEngine = new RegexEngine({ substitute: (t) => t, sources: () => ({}) });
  void macro;
  const testOutput = $derived(
    editing && testOpen
      ? testRegexScript(testEngine, { ...editing, trimStrings: trimText.split('\n') }, testInput)
      : '',
  );
  const warnings = $derived(editing ? regexSaveWarnings(editing) : null);

  function openEditor(scope: RegexScope, script: RegexScript | null) {
    editorScope = scope;
    editingIsNew = !script;
    editing = script ? toFullScript(script) : newRegexScript();
    trimText = editing.trimStrings.join('\n');
    testOpen = false;
  }
  function togglePlacement(value: number, on: boolean) {
    if (!editing) return;
    editing.placement = on
      ? [...editing.placement.filter((p) => p !== value), value]
      : editing.placement.filter((p) => p !== value);
  }
  async function saveEditor() {
    if (!editing) return;
    const script = normalizeRegexScript({ ...editing, trimStrings: trimText.split('\n') });
    if (!script.scriptName.trim()) {
      error = '脚本名不能为空';
      return;
    }
    const w = regexSaveWarnings(script);
    const list = listOf(editorScope);
    const i = list.findIndex((s) => s.id === script.id);
    const stored: RegexScript = { ...script };
    const next: RegexScript[] =
      i === -1 ? [...list, stored] : list.map((s, k) => (k === i ? stored : s));
    await saveList(editorScope, next);
    if (w.findMissing) notice = '已保存，但没有查找正则，这个脚本不会生效';
    else if (w.placementMissing) notice = '已保存，但没有勾选作用范围，这个脚本不会生效';
    editing = null;
  }

  const placementLabels = (s: RegexScript) =>
    REGEX_PLACEMENT_OPTIONS.filter((o) => s.placement?.includes(o.value))
      .map((o) => o.label)
      .join(' · ');
  const flagLabels = (s: RegexScript) =>
    [s.markdownOnly && '仅显示', s.promptOnly && '仅提示词', s.runOnEdit && '编辑时']
      .filter(Boolean)
      .join(' · ');
</script>

{#snippet scriptList(scope: RegexScope, scripts: RegexScript[])}
  {#if scripts.length === 0}
    <p class="tm-form__hint">还没有脚本。</p>
  {:else}
    <div class="tm-form__list">
      {#each scripts as s, i (s.id ?? i)}
        <div class="tm-form__item regex-script-label" class:is-off={!!s.disabled} id={s.id}>
          {#if selecting}
            <input
              type="checkbox"
              class="regex_bulk_checkbox"
              aria-label="选择"
              checked={!!s.id && picked.includes(regexBulkKey(scope, s.id))}
              onchange={() => s.id && togglePicked(scope, s.id)}
            />
          {:else}
            <input
              type="checkbox"
              class="regex_enabled"
              aria-label="启用"
              checked={!s.disabled}
              disabled={!!busy}
              onchange={() => s.id && toggleEnabled(scope, s.id)}
            />
          {/if}
          <button
            class="tm-rx__open"
            onclick={() => (selecting ? s.id && togglePicked(scope, s.id) : openEditor(scope, s))}
          >
            <span class="tm-form__item-name">{s.scriptName || '（未命名）'}</span>
            <span class="tm-form__item-meta"
              >{placementLabels(s) || '无作用范围'}{flagLabels(s)
                ? ` · ${flagLabels(s)}`
                : ''}</span
            >
          </button>
          <span class="tm-form__item-actions" class:tm-rx__hidden={selecting}>
            <button
              class="tm-form__icon"
              aria-label="上移"
              disabled={i === 0 || !!busy}
              onclick={() => move(scope, i, -1)}><Icon name="chevron-up" size="sm" /></button
            >
            <button
              class="tm-form__icon"
              aria-label="下移"
              disabled={i === scripts.length - 1 || !!busy}
              onclick={() => move(scope, i, 1)}><Icon name="chevron-down" size="sm" /></button
            >
            <button
              class="tm-form__icon"
              aria-label="更多"
              onclick={() => (moreTarget = { scope, script: s })}
              ><Icon name="ellipsis" size="sm" /></button
            >
          </span>
        </div>
      {/each}
    </div>
  {/if}
  <div class="tm-form__actions">
    <button
      class="menu_button tm-form__chip"
      disabled={!!busy}
      onclick={() => openEditor(scope, null)}><Icon name="plus" size="sm" />新建</button
    >
    <button class="menu_button tm-form__chip" disabled={!!busy} onclick={() => importScripts(scope)}
      >导入 JSON</button
    >
  </div>
{/snippet}

{#if !isTauri()}
  <section class="tm-form"><p class="tm-form__hint">正则脚本需要在 app 里运行。</p></section>
{:else}
  <section class="tm-form drawer-content" id="regex_container">
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
    <p class="tm-form__hint">
      生效顺序：全局 → 预设 → 角色。预设和角色卡里的脚本要先在这里允许才会跑（和酒馆一样）。
    </p>
    <div class="tm-form__actions">
      <button
        class="menu_button tm-form__chip"
        aria-pressed={selecting}
        onclick={() => setSelecting(!selecting)}
        ><Icon name={selecting ? 'xmark' : 'check'} size="sm" />{selecting
          ? '退出选择'
          : '选择'}</button
      >
      <button
        id="open_regex_debugger"
        class="menu_button tm-form__chip"
        onclick={() => (debugOpen = true)}>调试</button
      >
    </div>
    {#if selecting}
      <div class="tm-rx__bulk" role="toolbar" aria-label="批量操作">
        <span class="tm-rx__bulk-count">已选 {picked.length}</span>
        <button
          id="bulk_select_all_toggle"
          class="menu_button tm-form__chip"
          onclick={() => (picked = allPicked ? [] : allRegexBulkKeys(lists()))}
          >{allPicked ? '全不选' : '全选'}</button
        >
        <button
          id="bulk_enable_regex"
          class="menu_button tm-form__chip"
          disabled={!picked.length || !!busy}
          onclick={() => bulk({ kind: 'enable' })}>启用</button
        >
        <button
          id="bulk_disable_regex"
          class="menu_button tm-form__chip"
          disabled={!picked.length || !!busy}
          onclick={() => bulk({ kind: 'disable' })}>停用</button
        >
        <button
          class="menu_button tm-form__chip"
          disabled={!picked.length || !!busy}
          onclick={() => (bulkMoveOpen = true)}>移到…</button
        >
        <button
          id="bulk_export_regex"
          class="menu_button tm-form__chip"
          disabled={!picked.length}
          onclick={bulkExport}>导出</button
        >
        <button
          id="bulk_delete_regex"
          class="menu_button tm-form__chip"
          disabled={!picked.length || !!busy}
          onclick={() => (bulkDeleteOpen = true)}>删除</button
        >
      </div>
    {/if}

    <div class="tm-form__section">
      <h2 class="tm-form__heading"><span>全局</span><small>{global.length}</small></h2>
      {@render scriptList('global', global)}
    </div>

    <div class="tm-form__section">
      <h2 class="tm-form__heading">
        <span>预设 <small>{presetCtx?.presetName || '（未命名预设）'}</small></span>
        <small>{preset.length}</small>
      </h2>
      {#if preset.length}
        <label class="checkbox_label tm-form__check">
          <input
            type="checkbox"
            checked={presetAllowed}
            onchange={(e) => setAllowed('preset', e.currentTarget.checked)}
          />
          <span>允许这个预设的正则 <small>preset_allowed_regex</small></span>
        </label>
      {/if}
      {@render scriptList('preset', preset)}
    </div>

    <div class="tm-form__section">
      <h2 class="tm-form__heading">
        <span
          >角色 <small
            >{store.character?.name ?? (store.group ? '群聊：按成员各自的卡' : '未打开角色')}</small
          ></span
        >
        <small>{scoped.length}</small>
      </h2>
      {#if !avatar}
        <p class="tm-form__hint">在聊天里打开一个角色后，这里显示并编辑它卡片里的正则。</p>
      {:else}
        {#if scoped.length}
          <label class="checkbox_label tm-form__check">
            <input
              type="checkbox"
              checked={scopedAllowed}
              onchange={(e) => setAllowed('scoped', e.currentTarget.checked)}
            />
            <span>允许这张卡的正则 <small>character_allowed_regex</small></span>
          </label>
        {/if}
        {@render scriptList('scoped', scoped)}
      {/if}
    </div>
  </section>

  <RegexDebugger open={debugOpen} lists={lists()} onClose={() => (debugOpen = false)} />

  <BottomSheet open={bulkMoveOpen} title="移动选中的脚本" onClose={() => (bulkMoveOpen = false)}>
    {#each REGEX_SCOPES as scope (scope)}
      <button
        id="bulk_regex_move_to_{scope}"
        class="tm-opt"
        disabled={!!busy}
        onclick={() => bulk({ kind: 'move', to: scope })}
        ><Icon name="arrow-right" /><span>移到{SCOPE_LABEL[scope]}</span></button
      >
    {/each}
  </BottomSheet>

  <BottomSheet
    open={bulkDeleteOpen}
    title="删除选中的脚本"
    onClose={() => (bulkDeleteOpen = false)}
  >
    <p class="tm-form__hint">要删除选中的 {picked.length} 个正则脚本吗？删了找不回来。</p>
    <div class="tm-form__sheet-actions">
      <Button variant="outline" onclick={() => (bulkDeleteOpen = false)}>取消</Button>
      <Button variant="primary" onclick={() => bulk({ kind: 'delete' })}>删除</Button>
    </div>
  </BottomSheet>

  <BottomSheet
    open={!!moreTarget}
    title={moreTarget?.script.scriptName || '脚本'}
    onClose={() => (moreTarget = null)}
  >
    {#if moreTarget}
      {@const t = moreTarget}
      {#each ['global', 'preset', 'scoped'] as const as scope (scope)}
        {#if scope !== t.scope}
          <button class="tm-opt" disabled={!!busy} onclick={() => moveTo(t.scope, scope, t.script)}
            ><Icon name="arrow-right" /><span>移到{SCOPE_LABEL[scope]}</span></button
          >
        {/if}
      {/each}
      <button
        class="tm-opt"
        onclick={() => {
          exportScript(t.script);
          moreTarget = null;
        }}><Icon name="copy" /><span>导出 JSON</span></button
      >
      <button
        class="tm-opt tm-opt--danger"
        disabled={!!busy}
        onclick={() => {
          if (t.script.id) void remove(t.scope, t.script.id);
          moreTarget = null;
        }}><Icon name="trash" /><span>删除</span></button
      >
    {/if}
  </BottomSheet>

  <BottomSheet
    id="regex_editor"
    open={!!editing}
    title={editingIsNew ? `新建${SCOPE_LABEL[editorScope]}脚本` : editing?.scriptName || '编辑脚本'}
    onClose={() => (editing = null)}
  >
    {#if editing}
      <div class="tm-rx__editor">
        <label class="tm-form__field">
          <span class="tm-form__label">脚本名</span>
          <input
            class="text_pole tm-form__input regex_script_name"
            type="text"
            bind:value={editing.scriptName}
            autocapitalize="off"
            autocorrect="off"
          />
        </label>
        <label class="tm-form__field">
          <span class="tm-form__label">查找正则 <small>/pattern/flags 或裸表达式</small></span>
          <textarea
            class="text_pole tm-form__textarea tm-form__input--mono find_regex"
            rows="2"
            bind:value={editing.findRegex}
            autocapitalize="off"
            spellcheck="false"></textarea>
        </label>
        <label class="tm-form__field">
          <span class="tm-form__label"
            >替换为 <small>{'{{match}}'} $1 $&lt;name&gt; 可用</small></span
          >
          <textarea
            class="text_pole tm-form__textarea tm-form__input--mono regex_replace_string"
            rows="2"
            bind:value={editing.replaceString}
            autocapitalize="off"
            spellcheck="false"></textarea>
        </label>
        <label class="tm-form__field">
          <span class="tm-form__label">修剪 <small>每行一个，从匹配结果里删掉</small></span>
          <textarea
            class="text_pole tm-form__textarea tm-form__input--mono regex_trim_strings"
            rows="2"
            bind:value={trimText}
            autocapitalize="off"
            spellcheck="false"></textarea>
        </label>

        <h3 class="tm-form__subhead">作用范围</h3>
        <div class="tm-form__row tm-form__row--wrap">
          {#each REGEX_PLACEMENT_OPTIONS as o (o.value)}
            <label class="checkbox_label tm-form__check">
              <input
                type="checkbox"
                name="replace_position"
                value={o.value}
                checked={editing.placement.includes(o.value)}
                onchange={(e) => togglePlacement(o.value, e.currentTarget.checked)}
              />
              <span>{o.label}</span>
            </label>
          {/each}
        </div>

        <h3 class="tm-form__subhead">选项</h3>
        <label class="checkbox_label tm-form__check">
          <input type="checkbox" bind:checked={editing.markdownOnly} />
          <span>只改显示 <small>不进提示词、不改存档</small></span>
        </label>
        <label class="checkbox_label tm-form__check">
          <input type="checkbox" bind:checked={editing.promptOnly} />
          <span>只改提示词 <small>显示和存档不变</small></span>
        </label>
        <label class="checkbox_label tm-form__check">
          <input type="checkbox" bind:checked={editing.runOnEdit} />
          <span>编辑消息时也运行</span>
        </label>
        <label class="checkbox_label tm-form__check">
          <input type="checkbox" bind:checked={editing.disabled} />
          <span>禁用</span>
        </label>
        <div class="tm-form__field">
          <span class="tm-form__label">查找正则里的宏</span>
          <Segmented
            label="查找正则里的宏"
            value={String(editing.substituteRegex)}
            options={REGEX_SUBSTITUTE_OPTIONS.map((o) => ({
              value: String(o.value),
              label: o.label,
            }))}
            onchange={(v) => editing && (editing.substituteRegex = Number(v))}
          />
        </div>
        <div class="tm-form__row tm-form__row--wrap">
          <label class="tm-form__field">
            <span class="tm-form__label">最小深度 <small>留空 = 不限</small></span>
            <input
              class="text_pole tm-form__input tm-form__input--mono"
              type="number"
              min="-1"
              value={editing.minDepth ?? ''}
              onchange={(e) =>
                editing &&
                (editing.minDepth =
                  e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
            />
          </label>
          <label class="tm-form__field">
            <span class="tm-form__label">最大深度 <small>留空 = 不限</small></span>
            <input
              class="text_pole tm-form__input tm-form__input--mono"
              type="number"
              min="0"
              value={editing.maxDepth ?? ''}
              onchange={(e) =>
                editing &&
                (editing.maxDepth =
                  e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
            />
          </label>
        </div>

        <button
          class="tm-form__heading tm-rx__toggle inline-drawer-header"
          aria-expanded={testOpen}
          onclick={() => (testOpen = !testOpen)}
        >
          <span>测试</span><Icon name={testOpen ? 'chevron-up' : 'chevron-down'} />
        </button>
        {#if testOpen}
          <label class="tm-form__field">
            <span class="tm-form__label">输入</span>
            <textarea
              id="regex_test_input"
              class="text_pole tm-form__textarea"
              rows="3"
              bind:value={testInput}></textarea>
          </label>
          <div class="tm-form__field">
            <span class="tm-form__label">输出</span>
            <pre id="regex_test_output" class="tm-rx__output">{testOutput}</pre>
          </div>
        {/if}

        {#if warnings?.nameMissing}<p class="tm-form__hint">脚本名不能为空。</p>{/if}
        <div class="tm-form__sheet-footer">
          <span class="tm-form__sheet-footer-group">
            <button class="menu_button tm-form__chip" onclick={() => (editing = null)}>取消</button>
          </span>
          <button
            class="menu_button tm-form__chip tm-form__chip--primary"
            disabled={!!busy || !!warnings?.nameMissing}
            onclick={saveEditor}><Icon name="check" size="sm" />保存</button
          >
        </div>
      </div>
    {/if}
  </BottomSheet>
{/if}

<style>
  .tm-rx__open {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--tm-space-1);
    min-width: 0;
    text-align: left;
    color: var(--tm-color-text);
  }
  .tm-rx__hidden {
    visibility: hidden;
  }
  /* stays in view while the lists scroll under it */
  .tm-rx__bulk {
    position: sticky;
    top: 0;
    z-index: var(--tm-z-sticky);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--tm-space-2);
    padding: var(--tm-space-3);
    border: var(--tm-border-width) solid var(--tm-color-border);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface);
  }
  .tm-rx__bulk-count {
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-secondary);
    margin-inline-end: auto;
  }
  .tm-rx__editor {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-4);
  }
  .tm-rx__toggle {
    width: 100%;
  }
  .tm-rx__output {
    min-height: calc(var(--tm-touch-target) * 1.5);
    padding: var(--tm-space-3) var(--tm-space-4);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-sunken);
    font-family: var(--tm-font-body);
    font-size: var(--tm-text-sm);
    white-space: pre-wrap;
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
  .tm-opt:hover {
    background: var(--tm-color-surface-sunken);
  }
  .tm-opt--danger {
    color: var(--tm-color-danger);
  }
</style>
