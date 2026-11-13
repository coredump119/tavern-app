<script lang="ts">
  /**
   * Script editor (DEV_NOTES §9.5, round 3): a full-height layer over the library sheet with the
   * name, the code, the description and the script's buttons. A plain monospace textarea, no
   * highlighting.
   *
   * The code is not bound to state: a script can be a minified bundle of several hundred KB, and
   * copying that through a signal on every keystroke stalls typing. The textarea owns the text and
   * is read when saving, exporting or leaving.
   */
  import { onMount, tick, untrack } from 'svelte';
  import {
    applyScriptEdit,
    findScript,
    newScript,
    normalizeButtons,
    scriptExport,
    scriptExportFileName,
    type Script,
    type ScriptEdit,
    type ScriptScope,
  } from '@tm/tavern-helper';
  import { downloadText } from '../download';
  import { describeExport, exportText } from '../export';
  import { scriptLibrary } from '../helper/scripts.svelte';
  import { isTauri } from '../ipc';
  import Icon from './Icon.svelte';

  interface Props {
    scope: ScriptScope;
    /** null = write a new script */
    script: Script | null;
    /** `notice` is set after a save */
    onClose: (notice?: string) => void;
  }
  let { scope, script, onClose }: Props = $props();

  const SCOPE_LABEL: Record<ScriptScope, string> = {
    global: '全局',
    character: '角色',
    preset: '预设',
  };
  const INDENT = '  ';

  // one instance per opened script (the library keys it), so the starting values are read once
  const isNew = untrack(() => script === null);
  const original = untrack(() => script ?? newScript(crypto.randomUUID()));
  const startName = isNew ? '' : original.name;
  const title = isNew ? `新建${untrack(() => SCOPE_LABEL[scope])}脚本` : '编辑脚本';

  let tab = $state<'code' | 'info'>('code');
  let name = $state(startName);
  let info = $state(original.info);
  let buttonsOn = $state(original.button.enabled);
  let nextKey = 0;
  let buttons = $state(original.button.buttons.map((b) => ({ ...b, key: nextKey++ })));
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let confirmingDiscard = $state(false);
  let askData = $state(false);
  let codeEl = $state<HTMLTextAreaElement>();
  let nameEl = $state<HTMLInputElement>();

  onMount(() => {
    if (codeEl) {
      // Safari's attribute; Svelte's typings only know it on <input>
      codeEl.setAttribute('autocorrect', 'off');
      codeEl.value = original.content;
    }
    if (isNew) nameEl?.focus();
  });

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  /** a hidden textarea forgets where it was scrolled to */
  let codeScroll = { top: 0, left: 0 };
  async function show(next: 'code' | 'info') {
    if (next === tab) return;
    if (tab === 'code' && codeEl) codeScroll = { top: codeEl.scrollTop, left: codeEl.scrollLeft };
    tab = next;
    if (next !== 'code') return;
    await tick();
    codeEl?.scrollTo(codeScroll);
  }

  function draft(): ScriptEdit {
    return {
      name: name.trim(),
      info,
      content: codeEl?.value ?? original.content,
      button: {
        enabled: buttonsOn,
        buttons: normalizeButtons(
          buttons.map((b) => ({ name: b.name.trim(), visible: b.visible })),
        ),
      },
    };
  }

  function isDirty(): boolean {
    const now = draft();
    return (
      now.name !== startName ||
      now.info !== original.info ||
      now.content !== original.content ||
      buttonsOn !== original.button.enabled ||
      JSON.stringify(now.button?.buttons) !== JSON.stringify(original.button.buttons)
    );
  }

  function cancel() {
    if (!confirmingDiscard && isDirty()) {
      confirmingDiscard = true;
      return;
    }
    onClose();
  }

  function save() {
    const edit = draft();
    if (!edit.name) {
      error = '脚本名称不能为空';
      nameEl?.focus();
      return;
    }
    try {
      if (isNew) {
        scriptLibrary.addScript(scope, applyScriptEdit(original, edit));
        onClose(`已新建「${edit.name}」，默认关闭，打开开关后运行`);
      } else if (scriptLibrary.updateScript(scope, original.id, edit)) {
        onClose(`已保存「${edit.name}」`);
      } else {
        // a running script rewrote the library meanwhile: what was typed here is not thrown away
        scriptLibrary.addScript(scope, applyScriptEdit({ ...original, enabled: false }, edit));
        onClose(`原来的脚本已经不在库里，「${edit.name}」作为新脚本保存，默认关闭`);
      }
    } catch (e) {
      error = `保存失败：${msg(e)}`;
    }
  }

  function addButton() {
    buttons.push({ name: '', visible: true, key: nextKey++ });
  }

  /** What the editor shows now, saved or not; `data` is the stored one (the script may have written it) */
  function current(): Script {
    const stored = isNew ? undefined : findScript(scriptLibrary.trees[scope], original.id);
    return applyScriptEdit({ ...original, data: stored?.data ?? original.data }, draft());
  }

  function startExport() {
    error = null;
    notice = null;
    if (Object.keys(current().data).length > 0) askData = true;
    else void exportScript(true);
  }

  async function exportScript(withData: boolean) {
    askData = false;
    const out = scriptExport(current(), withData);
    const fileName = scriptExportFileName(out);
    const json = JSON.stringify(out, null, 4);
    try {
      if (!isTauri()) {
        downloadText(fileName, json);
        return;
      }
      const target = await exportText(fileName, json);
      if (target) notice = await describeExport(target);
    } catch (e) {
      error = `导出失败：${msg(e)}`;
    }
  }

  function onCodeKeydown(e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    // Shift+Tab stays native, so a hardware keyboard can still leave the field
    if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing)
      return;
    e.preventDefault();
    const el = e.currentTarget;
    // execCommand keeps the insertion on the undo stack; setRangeText is the fallback
    if (!document.execCommand('insertText', false, INDENT))
      el.setRangeText(INDENT, el.selectionStart, el.selectionEnd, 'end');
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- No ST class names here: a theme's `.popup` sizing would break the full-height layout. -->
<div class="tm-sed" role="dialog" aria-modal="true" aria-label={title}>
  <div id="tm_script_editor" class="tm-sed__panel">
    <header class="tm-sed__bar">
      <button id="tm_script_editor_cancel" class="tm-sed__btn" onclick={cancel}>取消</button>
      <div class="tm-sed__tabs" role="tablist" aria-label="编辑内容">
        <button
          class="tm-sed__tab"
          class:is-active={tab === 'code'}
          role="tab"
          aria-selected={tab === 'code'}
          aria-controls="tm_script_editor_code_pane"
          onclick={() => show('code')}>代码</button
        >
        <button
          class="tm-sed__tab"
          class:is-active={tab === 'info'}
          role="tab"
          aria-selected={tab === 'info'}
          aria-controls="tm_script_editor_info_pane"
          onclick={() => show('info')}>说明与按钮</button
        >
      </div>
      <button id="tm_script_editor_save" class="tm-sed__btn tm-sed__btn--primary" onclick={save}
        >保存</button
      >
    </header>

    {#if confirmingDiscard}
      <div class="tm-sed__confirm" role="alert">
        <span>放弃修改？</span>
        <span class="tm-sed__confirm-actions">
          <button class="tm-sed__btn" onclick={() => (confirmingDiscard = false)}>继续编辑</button>
          <button class="tm-sed__btn tm-sed__btn--danger" onclick={() => onClose()}>放弃</button>
        </span>
      </div>
    {/if}
    {#if error}
      <p class="tm-form__error tm-sed__status" role="alert">
        <span>{error}</span><button class="tm-form__link" onclick={() => (error = null)}
          >关闭</button
        >
      </p>
    {/if}
    {#if notice}
      <p class="tm-form__notice tm-sed__status" role="status">
        <span>{notice}</span><button class="tm-form__link" onclick={() => (notice = null)}
          >关闭</button
        >
      </p>
    {/if}

    <div class="tm-sed__body">
      <label class="tm-form__field tm-sed__name">
        <span class="tm-form__label">名称</span>
        <input
          id="tm_script_editor_name"
          class="text_pole tm-form__input"
          type="text"
          placeholder={isNew ? `${SCOPE_LABEL[scope]}脚本的名称` : ''}
          bind:this={nameEl}
          bind:value={name}
          autocapitalize="off"
          autocorrect="off"
          autocomplete="off"
        />
      </label>

      <div
        id="tm_script_editor_code_pane"
        class="tm-sed__pane"
        role="tabpanel"
        aria-label="代码"
        hidden={tab !== 'code'}
      >
        <textarea
          id="tm_script_editor_code"
          class="text_pole tm-form__textarea tm-form__input--mono tm-sed__code"
          aria-label="脚本代码"
          placeholder="// 在这里写脚本"
          wrap="off"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          bind:this={codeEl}
          onkeydown={onCodeKeydown}></textarea>
      </div>

      <div
        id="tm_script_editor_info_pane"
        class="tm-sed__pane tm-sed__pane--info"
        role="tabpanel"
        aria-label="说明与按钮"
        hidden={tab !== 'info'}
      >
        <label class="tm-form__field">
          <span class="tm-form__label">说明 <small>可以不填</small></span>
          <textarea
            id="tm_script_editor_info"
            class="text_pole tm-form__textarea"
            rows="4"
            bind:value={info}></textarea>
        </label>

        <h3 class="tm-form__subhead">脚本按钮</h3>
        <label class="checkbox_label tm-form__check">
          <input type="checkbox" bind:checked={buttonsOn} />
          <span>显示这个脚本的按钮 <small>脚本运行时出现在输入框上方</small></span>
        </label>
        {#each buttons as button, i (button.key)}
          <div class="tm-sed__button">
            <label class="tm-sed__visible">
              <input
                type="checkbox"
                aria-label={`显示按钮 ${button.name}`}
                bind:checked={button.visible}
              />
            </label>
            <input
              class="text_pole tm-form__input"
              type="text"
              aria-label="按钮名称"
              placeholder="按钮名称"
              bind:value={button.name}
              autocapitalize="off"
              autocorrect="off"
              autocomplete="off"
            />
            <button
              class="tm-sed__icon"
              aria-label={`删除按钮 ${button.name}`}
              onclick={() => buttons.splice(i, 1)}><Icon name="trash" size="sm" /></button
            >
          </div>
        {/each}
        <div class="tm-form__actions">
          <button class="menu_button tm-form__chip tm-sed__chip" onclick={addButton}
            ><Icon name="plus" size="sm" />添加按钮</button
          >
        </div>

        <h3 class="tm-form__subhead">导出</h3>
        {#if askData}
          <p class="tm-form__hint">
            这个脚本存了自己的变量，里面可能有你填过的密钥之类的内容。要一起导出吗？
          </p>
          <div class="tm-form__actions">
            <button
              class="menu_button tm-form__chip tm-sed__chip"
              onclick={() => exportScript(false)}>不带变量</button
            >
            <button
              class="menu_button tm-form__chip tm-sed__chip"
              onclick={() => exportScript(true)}>连同变量</button
            >
            <button class="menu_button tm-form__chip tm-sed__chip" onclick={() => (askData = false)}
              >取消</button
            >
          </div>
        {:else}
          <div class="tm-form__actions">
            <button
              id="tm_script_editor_export"
              class="menu_button tm-form__chip tm-sed__chip"
              onclick={startExport}><Icon name="file-export" size="sm" />导出 JSON</button
            >
          </div>
        {/if}

        <p class="tm-sed__id">
          <span class="tm-form__label">脚本 ID</span>
          <code id="tm_script_editor_id">{original.id}</code>
        </p>
      </div>
    </div>
  </div>
</div>

<style>
  .tm-sed {
    position: fixed;
    inset: 0;
    z-index: var(--tm-z-modal);
    display: flex;
    flex-direction: column;
    /* --tm-safe-bottom grows by the keyboard height, which keeps the code above the keyboard */
    padding: var(--tm-safe-top) var(--tm-safe-right) var(--tm-safe-bottom) var(--tm-safe-left);
    background: var(--tm-color-surface);
    color: var(--tm-color-text);
    font-family: var(--tm-font-ui);
  }
  .tm-sed__panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .tm-sed__bar {
    flex: none;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--tm-space-3);
    padding: var(--tm-space-2) var(--tm-gutter);
    border-bottom: var(--tm-border-width) solid var(--tm-color-border);
  }
  .tm-sed__btn {
    flex: none;
    min-width: var(--tm-touch-target);
    min-height: var(--tm-touch-target);
    padding-inline: var(--tm-space-2);
    border-radius: var(--tm-radius-md);
    color: var(--tm-color-text-link);
    font-size: var(--tm-text-sm);
    white-space: nowrap;
  }
  .tm-sed__btn--primary {
    padding-inline: var(--tm-space-5);
    border-radius: var(--tm-radius-full);
    background: var(--tm-color-accent);
    color: var(--tm-color-on-accent);
    font-weight: 500;
  }
  .tm-sed__btn--danger {
    color: var(--tm-color-danger);
  }
  .tm-sed__tabs {
    display: flex;
    gap: var(--tm-space-1);
    min-width: 0;
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-sunken);
  }
  .tm-sed__tab {
    flex: 1;
    min-width: 0;
    min-height: var(--tm-touch-target);
    padding-inline: var(--tm-space-2);
    border-radius: var(--tm-radius-md);
    color: var(--tm-color-text-secondary);
    font-size: var(--tm-text-sm);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tm-sed__tab.is-active {
    background: var(--tm-color-surface-raised);
    color: var(--tm-color-text);
    box-shadow: var(--tm-shadow-1);
  }
  .tm-sed__confirm {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--tm-space-3);
    padding: 0 var(--tm-gutter);
    background: var(--tm-color-surface-sunken);
    font-size: var(--tm-text-sm);
  }
  .tm-sed__confirm-actions {
    display: flex;
    gap: var(--tm-space-2);
  }
  .tm-sed__status {
    flex: none;
    margin: 0;
    padding: var(--tm-space-2) var(--tm-gutter) 0;
    align-items: center;
  }
  .tm-sed__body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-3);
    padding: var(--tm-space-3) var(--tm-gutter);
  }
  .tm-sed__name {
    flex: none;
    flex-direction: row;
    align-items: center;
    gap: var(--tm-space-3);
  }
  .tm-sed__name .tm-form__label {
    flex: none;
  }
  .tm-sed__name .tm-form__input,
  .tm-sed__button .tm-form__input {
    flex: 1;
    min-width: 0;
  }
  .tm-sed__pane {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* both panes stay mounted: the code textarea holds the only copy of what was typed */
  .tm-sed__pane[hidden] {
    display: none;
  }
  .tm-sed__pane--info {
    gap: var(--tm-space-4);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .tm-sed__pane--info > :global(*) {
    flex: none;
  }
  .tm-sed__code {
    flex: 1;
    min-height: 0;
    resize: none;
    /* long lines scroll sideways instead of wrapping */
    white-space: pre;
    overflow: auto;
    overflow-wrap: normal;
    overscroll-behavior: contain;
    line-height: var(--tm-leading-tight);
    tab-size: 2;
  }
  .tm-sed__button {
    display: flex;
    align-items: center;
    gap: var(--tm-space-2);
  }
  .tm-sed__visible,
  .tm-sed__icon {
    flex: none;
    min-width: var(--tm-touch-target);
    min-height: var(--tm-touch-target);
    display: inline-grid;
    place-items: center;
    border-radius: var(--tm-radius-md);
    color: var(--tm-color-text-muted);
  }
  .tm-sed__visible input {
    accent-color: var(--tm-color-accent);
    width: var(--tm-icon-sm);
    height: var(--tm-icon-sm);
  }
  .tm-sed__chip {
    min-height: var(--tm-touch-target);
  }
  .tm-sed__id {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-1);
  }
  .tm-sed__id code {
    font-family: var(--tm-font-mono);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
  }
</style>
