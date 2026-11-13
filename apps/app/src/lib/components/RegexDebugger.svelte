<script lang="ts">
  /**
   * Regex debugger (ST extensions/regex `#regex_debugger`, DEV_NOTES §9.37): pick rules, type a
   * sample, run them in order (全局 → 预设 → 角色) and see what each one captured, added and removed.
   */
  import { untrack } from 'svelte';
  import { debugRegexChain, type RegexDebugRun } from '@tm/core';
  import Button from '@tm/ui/components/Button.svelte';
  import BottomSheet from './BottomSheet.svelte';
  import type { RegexScope } from '../regex';
  import { REGEX_SCOPES, type RegexLists } from '../regex-bulk';

  interface Props {
    open: boolean;
    lists: RegexLists;
    onClose: () => void;
  }
  let { open, lists, onClose }: Props = $props();

  const SCOPE_LABEL: Record<RegexScope, string> = {
    global: '全局',
    preset: '预设',
    scoped: '角色',
  };

  const rules = $derived(
    REGEX_SCOPES.flatMap((scope) =>
      lists[scope].map((script, i) => ({ scope, script, key: `${scope}:${i}` })),
    ),
  );
  let checked = $state<string[]>([]);
  let input = $state('');
  let mode = $state<'replace' | 'highlight'>('replace');
  let run = $state.raw<RegexDebugRun | null>(null);

  // ST: every rule starts checked unless it is disabled
  $effect(() => {
    if (!open) return;
    untrack(() => {
      checked = rules.filter((r) => !r.script.disabled).map((r) => r.key);
      run = null;
    });
  });

  function toggle(key: string) {
    checked = checked.includes(key) ? checked.filter((k) => k !== key) : [...checked, key];
  }

  function start() {
    run = debugRegexChain(
      rules.filter((r) => checked.includes(r.key)).map((r) => r.script),
      input,
    );
  }
</script>

<BottomSheet {open} title="正则调试器" {onClose}>
  <div id="regex_debugger" class="tm-rxd">
    <p class="tm-form__hint">
      这里只看「查找 → 替换」本身，按勾选顺序一条条套上去；作用范围、深度、宏这些运行时条件不参与。
    </p>
    <ul id="regex_debugger_rules" class="tm-rxd__rules">
      {#each rules as r (r.key)}
        <li>
          <label class="tm-rxd__rule">
            <input
              type="checkbox"
              checked={checked.includes(r.key)}
              onchange={() => toggle(r.key)}
            />
            <span class="tm-rxd__rule-name">{r.script.scriptName || '（未命名）'}</span>
            <small class="tm-rxd__scope">{SCOPE_LABEL[r.scope]}</small>
          </label>
        </li>
      {:else}
        <li class="tm-form__hint">还没有正则脚本。</li>
      {/each}
    </ul>
    <label class="tm-form__field">
      <span class="tm-form__label">输入</span>
      <textarea
        id="regex_debugger_raw_input"
        class="text_pole tm-form__textarea"
        rows="3"
        bind:value={input}></textarea>
    </label>
    <div class="tm-rxd__bar">
      <div class="tm-rxd__modes" role="group" aria-label="显示方式">
        <button
          class="menu_button tm-form__chip"
          aria-pressed={mode === 'replace'}
          onclick={() => (mode = 'replace')}>替换</button
        >
        <button
          class="menu_button tm-form__chip"
          aria-pressed={mode === 'highlight'}
          onclick={() => (mode = 'highlight')}>高亮</button
        >
      </div>
      <Button variant="primary" size="sm" disabled={!checked.length} onclick={start}>运行</Button>
    </div>

    {#if run}
      <ol id="regex_debugger_steps" class="tm-rxd__steps">
        {#each run.steps as step, i (i)}
          <li class="tm-rxd__step">
            <p class="tm-rxd__step-head">
              <strong>之后：{step.scriptName || '（未命名）'}</strong>
              <small
                >捕获 {step.charsCaptured}，新增 +{step.charsAdded}，删除 -{step.charsRemoved}</small
              >
            </p>
            {#if step.error}<p class="tm-rxd__error" role="alert">{step.error}</p>{/if}
            <pre
              class="tm-rxd__text">{#if mode === 'highlight'}{#each step.segments as seg, j (j)}{#if seg.kind === 'text'}{seg.text}{:else}<mark
                      class="tm-rxd__hl tm-rxd__hl--{seg.kind}">{seg.text}</mark
                    >{/if}{/each}{:else}{step.output}{/if}</pre>
          </li>
        {/each}
      </ol>
      <div class="tm-form__field">
        <span class="tm-form__label"
          >最终结果 <small
            >捕获 {run.charsCaptured}，新增 +{run.charsAdded}，删除 -{run.charsRemoved}</small
          ></span
        >
        <pre id="regex_debugger_final_output" class="tm-rxd__text">{run.output}</pre>
      </div>
      {#if mode === 'highlight'}
        <p class="tm-form__hint">
          <mark class="tm-rxd__hl tm-rxd__hl--removed">被匹配的原文</mark>
          <mark class="tm-rxd__hl tm-rxd__hl--added">规则加的字</mark>
          <mark class="tm-rxd__hl tm-rxd__hl--kept">保留下来的捕获</mark>
        </p>
      {/if}
    {/if}
  </div>
</BottomSheet>

<style>
  .tm-rxd {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-3);
  }
  .tm-rxd__rules,
  .tm-rxd__steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-2);
  }
  .tm-rxd__rules {
    max-height: 30dvh;
    overflow-y: auto;
  }
  .tm-rxd__rule {
    display: flex;
    align-items: center;
    gap: var(--tm-space-2);
    min-height: var(--tm-touch-target);
    font-size: var(--tm-text-sm);
  }
  .tm-rxd__rule-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tm-rxd__scope {
    color: var(--tm-color-text-muted);
  }
  .tm-rxd__bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--tm-space-2);
  }
  .tm-rxd__modes {
    display: flex;
    gap: var(--tm-space-2);
  }
  .tm-rxd__modes [aria-pressed='true'] {
    border-color: var(--tm-color-accent);
    color: var(--tm-color-accent);
  }
  .tm-rxd__step-head {
    margin: 0 0 var(--tm-space-1);
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--tm-space-2);
    font-size: var(--tm-text-sm);
  }
  .tm-rxd__step-head small {
    color: var(--tm-color-text-secondary);
  }
  .tm-rxd__error {
    margin: 0 0 var(--tm-space-1);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-danger);
  }
  .tm-rxd__text {
    margin: 0;
    padding: var(--tm-space-2) var(--tm-space-3);
    border: var(--tm-border-width) solid var(--tm-color-border);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-sunken);
    font-family: var(--tm-font-mono);
    font-size: var(--tm-text-xs);
    line-height: var(--tm-leading-normal);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
  }
  .tm-rxd__hl {
    color: inherit;
    border-radius: var(--tm-radius-sm);
  }
  .tm-rxd__hl--removed {
    background: color-mix(in srgb, var(--tm-color-danger) 30%, transparent);
    text-decoration: line-through;
  }
  .tm-rxd__hl--added {
    background: color-mix(in srgb, var(--tm-color-success) 30%, transparent);
  }
  .tm-rxd__hl--kept {
    background: color-mix(in srgb, var(--tm-color-warning) 35%, transparent);
  }
</style>
