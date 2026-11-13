<script lang="ts">
  /**
   * Script library sheet (DEV_NOTES §9.5): the three scope switches, a switch per script, and
   * import / new / delete. Tapping a script's name opens it in `ScriptEditor`, layered over the
   * sheet (code, description, buttons, export).
   */
  import type { Script, ScriptScope, ScriptTree } from '@tm/tavern-helper';
  import { chatStore } from '../chat/store.svelte';
  import { pickFiles, readPickedJson } from '../files';
  import { scriptLibrary } from '../helper/scripts.svelte';
  import BottomSheet from './BottomSheet.svelte';
  import Icon from './Icon.svelte';
  import ScriptEditor from './ScriptEditor.svelte';

  interface Props {
    open: boolean;
    onClose: () => void;
  }
  let { open, onClose }: Props = $props();

  let message = $state<string | null>(null);
  /** id of the row whose delete button was tapped once */
  let confirming = $state<string | null>(null);
  /** the script in the editor (null = a new one); raw, so the script object stays a plain one */
  let editing = $state.raw<{ scope: ScriptScope; script: Script | null; key: number } | null>(null);
  let editorKey = 0;

  const sections = $derived<{ scope: ScriptScope; title: string; hint: string }[]>([
    { scope: 'global', title: '全局脚本', hint: '每个聊天都运行' },
    ...(scriptLibrary.avatar
      ? [
          {
            scope: 'character' as const,
            title: `角色脚本 · ${chatStore.character?.name ?? ''}`,
            hint: '随这张角色卡带来，打开后才运行',
          },
        ]
      : []),
    ...(scriptLibrary.presetName
      ? [
          {
            scope: 'preset' as const,
            title: `预设脚本 · ${scriptLibrary.presetName}`,
            hint: '随这个预设带来，打开后才运行',
          },
        ]
      : []),
  ]);

  async function importScripts() {
    message = null;
    const [file] = await pickFiles({ extensions: ['json'], title: '导入脚本' });
    if (!file) return;
    try {
      const count = scriptLibrary.importGlobal(await readPickedJson(file));
      message = count ? `已导入 ${count} 项，默认关闭，看过内容后再打开` : '文件里没有脚本';
    } catch (e) {
      message = `导入失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function edit(scope: ScriptScope, script: Script | null) {
    message = null;
    confirming = null;
    editing = { scope, script, key: ++editorKey };
  }

  function closeEditor(notice?: string) {
    editing = null;
    if (notice) message = notice;
  }

  // the editor does not outlive the sheet it sits on
  $effect(() => {
    if (!open) editing = null;
  });

  function remove(scope: ScriptScope, id: string) {
    if (confirming !== id) {
      confirming = id;
      return;
    }
    confirming = null;
    scriptLibrary.remove(scope, id);
  }
</script>

{#snippet row(scope: ScriptScope, tree: ScriptTree, nested: boolean)}
  <div class="tm-scripts__row" class:tm-scripts__row--nested={nested}>
    {#if tree.type === 'folder'}
      <label class="checkbox_label tm-scripts__check">
        <input
          type="checkbox"
          checked={tree.enabled}
          onchange={(e) => scriptLibrary.setEnabled(scope, tree.id, e.currentTarget.checked)}
        />
        <span class="tm-scripts__name">{tree.name}（文件夹）</span>
      </label>
    {:else}
      <label class="checkbox_label tm-scripts__switch">
        <input
          type="checkbox"
          aria-label={`运行 ${tree.name}`}
          checked={tree.enabled}
          onchange={(e) => scriptLibrary.setEnabled(scope, tree.id, e.currentTarget.checked)}
        />
      </label>
      <button
        class="tm-scripts__open"
        aria-label={`编辑 ${tree.name}`}
        onclick={() => edit(scope, tree)}
      >
        <span class="tm-scripts__name">{tree.name}</span>
        <Icon name="pencil" size="sm" />
      </button>
    {/if}
    <button
      class="tm-scripts__delete"
      class:tm-scripts__delete--confirm={confirming === tree.id}
      aria-label={`删除 ${tree.name}`}
      onclick={() => remove(scope, tree.id)}
    >
      {#if confirming === tree.id}确认删除{:else}<Icon name="trash" size="sm" />{/if}
    </button>
  </div>
{/snippet}

<BottomSheet id="tm_script_library" {open} title="脚本库" {onClose}>
  <div class="tm-scripts">
    {#each sections as section (section.scope)}
      {@const trees = scriptLibrary.trees[section.scope]}
      <section class="tm-scripts__section" data-scope={section.scope}>
        <label class="checkbox_label tm-scripts__check tm-scripts__scope">
          <input
            type="checkbox"
            checked={scriptLibrary.scopes[section.scope]}
            onchange={(e) => scriptLibrary.setScopeEnabled(section.scope, e.currentTarget.checked)}
          />
          <span class="tm-scripts__name">{section.title}</span>
        </label>
        <p class="tm-scripts__hint">{section.hint}</p>
        {#each trees as tree (tree.id)}
          {@render row(section.scope, tree, false)}
          {#if tree.type === 'folder'}
            {#each tree.scripts as script (script.id)}
              {@render row(section.scope, script, true)}
            {/each}
          {/if}
        {:else}
          <p class="tm-scripts__hint tm-scripts__empty">没有脚本</p>
        {/each}
        <div class="tm-scripts__actions">
          <button
            class="tm-scripts__action"
            data-action="new"
            onclick={() => edit(section.scope, null)}
          >
            <Icon name="plus" size="sm" /><span>新建脚本</span>
          </button>
          {#if section.scope === 'global'}
            <button id="tm_script_import" class="tm-scripts__action" onclick={importScripts}>
              <Icon name="file-lines" size="sm" /><span>导入脚本（JSON）</span>
            </button>
          {/if}
        </div>
      </section>
    {/each}
    {#if message}<p class="tm-scripts__hint" role="status">{message}</p>{/if}
    {#if !chatStore.helperRender}
      <p class="tm-scripts__hint">「前端卡片渲染」关着，脚本不会运行。</p>
    {/if}
  </div>
</BottomSheet>

{#if open && editing}
  {#key editing.key}
    <ScriptEditor scope={editing.scope} script={editing.script} onClose={closeEditor} />
  {/key}
{/if}

<style>
  .tm-scripts {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-5);
    font-family: var(--tm-font-ui);
  }
  .tm-scripts__section {
    display: flex;
    flex-direction: column;
  }
  .tm-scripts__row {
    display: flex;
    align-items: center;
    gap: var(--tm-space-2);
  }
  .tm-scripts__row--nested {
    padding-left: var(--tm-space-6);
  }
  .tm-scripts__check {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--tm-space-3);
    min-height: var(--tm-touch-target);
    font-size: var(--tm-text-sm);
  }
  .tm-scripts__switch {
    flex: none;
    min-width: var(--tm-touch-target);
    min-height: var(--tm-touch-target);
    display: inline-flex;
    align-items: center;
  }
  .tm-scripts__open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--tm-space-2);
    min-height: var(--tm-touch-target);
    text-align: left;
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text);
  }
  .tm-scripts__open :global(.tm-icon) {
    flex: none;
    color: var(--tm-color-text-muted);
  }
  .tm-scripts__check input,
  .tm-scripts__switch input {
    flex: none;
    accent-color: var(--tm-color-accent);
    width: var(--tm-icon-sm);
    height: var(--tm-icon-sm);
  }
  .tm-scripts__scope {
    font-size: var(--tm-text-md);
    font-weight: 600;
  }
  .tm-scripts__name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tm-scripts__hint {
    margin: 0;
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
    line-height: var(--tm-leading-normal);
  }
  .tm-scripts__empty {
    padding-block: var(--tm-space-2);
  }
  .tm-scripts__delete {
    flex: none;
    min-width: var(--tm-touch-target);
    min-height: var(--tm-touch-target);
    display: inline-grid;
    place-items: center;
    border-radius: var(--tm-radius-md);
    color: var(--tm-color-text-muted);
    font-size: var(--tm-text-xs);
  }
  .tm-scripts__delete--confirm {
    padding-inline: var(--tm-space-3);
    color: var(--tm-color-danger);
  }
  .tm-scripts__actions {
    display: flex;
    flex-wrap: wrap;
    column-gap: var(--tm-space-5);
  }
  .tm-scripts__action {
    display: flex;
    align-items: center;
    gap: var(--tm-space-3);
    min-height: var(--tm-touch-target);
    color: var(--tm-color-text-link);
    font-size: var(--tm-text-sm);
  }
</style>
