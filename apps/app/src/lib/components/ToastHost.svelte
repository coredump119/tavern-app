<script lang="ts">
  /** Draws the notices of lib/toast.svelte.ts; mounted once. */
  import { toasts } from '../toast.svelte';
</script>

<!-- the live region stays in the page: one that arrives together with its text is not read out -->
<div class="tm-toasts__live" aria-live="polite">
  {#if toasts.list.length > 0}
    <div id="toast-container" class="tm-toasts">
      {#each toasts.list as toast (toast.id)}
        <button
          class="tm-toast toast toast-{toast.kind}"
          data-kind={toast.kind}
          onclick={() => toasts.dismiss(toast.id)}
        >
          {#if toast.title}<span class="tm-toast__title toast-title">{toast.title}</span>{/if}
          <span class="tm-toast__text toast-message">{toast.text}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .tm-toasts__live {
    display: contents;
  }
  .tm-toasts {
    position: fixed;
    top: calc(var(--tm-safe-top) + var(--tm-space-2));
    left: var(--tm-gutter);
    right: var(--tm-gutter);
    z-index: var(--tm-z-toast);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--tm-space-2);
    pointer-events: none;
  }
  .tm-toast {
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-1);
    max-width: 100%;
    padding: var(--tm-space-2) var(--tm-space-4);
    border: var(--tm-border-width) solid var(--tm-color-border);
    border-inline-start: var(--tm-space-1) solid var(--tm-color-text-secondary);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-raised);
    color: var(--tm-color-text);
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-sm);
    line-height: var(--tm-leading-normal);
    text-align: start;
    box-shadow: var(--tm-shadow-2);
  }
  .tm-toast[data-kind='success'] {
    border-inline-start-color: var(--tm-color-success);
  }
  .tm-toast[data-kind='warning'] {
    border-inline-start-color: var(--tm-color-warning);
  }
  .tm-toast[data-kind='error'] {
    border-inline-start-color: var(--tm-color-danger);
  }
  .tm-toast__title {
    font-weight: 600;
  }
  .tm-toast__text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
