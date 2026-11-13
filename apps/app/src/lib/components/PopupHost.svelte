<script lang="ts">
  /** Draws the dialog at the head of the popup queue (lib/popup.svelte.ts); mounted once. */
  import Button from '@tm/ui/components/Button.svelte';
  import BottomSheet from './BottomSheet.svelte';
  import { popups, type PopupResult } from '../popup.svelte';

  /**
   * A dialog takes no answer this long after it appears: the queue shows the next one where the
   * last one was, and a second tap meant for the old dialog must not answer the new one (a script
   * could otherwise time a harmless popup right before the `custom_api` question).
   */
  const ARM_DELAY = 400;

  const request = $derived(popups.current);
  let draft = $state('');
  let shownAt = 0;
  $effect(() => {
    draft = request?.kind === 'input' ? (request.value ?? '') : '';
    shownAt = performance.now();
  });

  function answer(result: PopupResult) {
    if (performance.now() - shownAt >= ARM_DELAY) popups.answer(result);
  }

  /** scrim, as ST's popup: a confirm is declined, an input or a button list has no answer */
  function dismiss() {
    answer(request?.kind === 'confirm' ? false : null);
  }

  /** an address or an id is typed as it is: iOS would capitalise and "correct" it */
  const LITERAL: Record<string, string> = {
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
  };
</script>

{#if request}
  <BottomSheet open system title={request.title} onClose={dismiss}>
    <p class="tm-popup__text">{request.text}</p>
    {#if request.kind === 'buttons'}
      {#each request.labels as label (label)}
        <Button variant="outline" onclick={() => answer(label)}>{label}</Button>
      {/each}
    {:else}
      {#if request.kind === 'input'}
        <textarea
          class="tm-popup__input text_pole"
          rows={request.rows ?? 1}
          aria-label={request.text}
          {...request.literal ? LITERAL : {}}
          bind:value={draft}></textarea>
      {/if}
      <div class="tm-popup__actions">
        <Button variant="outline" onclick={dismiss}>{request.cancelButton || '取消'}</Button>
        <Button variant="primary" onclick={() => answer(request.kind === 'input' ? draft : true)}>
          {request.okButton || '确定'}
        </Button>
      </div>
    {/if}
  </BottomSheet>
{/if}

<style>
  .tm-popup__text {
    margin: 0 0 var(--tm-space-3);
    font-size: var(--tm-text-sm);
    line-height: var(--tm-leading-normal);
    color: var(--tm-color-text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .tm-popup__input {
    width: 100%;
    margin-bottom: var(--tm-space-3);
    padding: var(--tm-space-2) var(--tm-space-3);
    border: var(--tm-border-width) solid var(--tm-color-border);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-sunken);
    color: var(--tm-color-text);
    font: inherit;
    font-size: var(--tm-text-md);
    resize: vertical;
  }
  .tm-popup__actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--tm-space-2);
  }
</style>
