<script lang="ts">
  /** Full-screen editor for a long text field (ST `editor_maximize`, DEV_NOTES §9.41). */
  interface Props {
    open: boolean;
    title: string;
    value: string;
    onInput: (value: string) => void;
    onClose: () => void;
  }
  let { open, title, value, onInput, onClose }: Props = $props();

  let field = $state<HTMLTextAreaElement>();
  let opener: Element | null = null;
  $effect(() => {
    if (open) {
      opener = document.activeElement;
      field?.focus();
    } else if (opener instanceof HTMLElement) {
      opener.focus();
      opener = null;
    }
  });
</script>

{#if open}
  <div
    class="tm-fulled"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    onkeydown={(e) => {
      if (e.key === 'Escape') onClose();
    }}
  >
    <header class="tm-fulled__bar">
      <h2 class="tm-fulled__title">{title}</h2>
      <button type="button" class="tm-fulled__done" onclick={onClose}>完成</button>
    </header>
    <textarea
      bind:this={field}
      class="tm-fulled__text"
      aria-label={title}
      {value}
      oninput={(e) => onInput(e.currentTarget.value)}></textarea>
  </div>
{/if}

<style>
  .tm-fulled {
    position: fixed;
    inset: 0;
    z-index: var(--tm-z-modal);
    display: flex;
    flex-direction: column;
    /* --tm-safe-bottom already includes the keyboard */
    padding: var(--tm-safe-top) 0 var(--tm-safe-bottom);
    background: var(--tm-color-bg);
  }
  .tm-fulled__bar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--tm-space-3);
    min-height: var(--tm-topbar-height);
    padding: 0 var(--tm-gutter);
    border-bottom: var(--tm-border-width) solid var(--tm-color-border);
    font-family: var(--tm-font-ui);
  }
  .tm-fulled__title {
    font-size: var(--tm-text-md);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tm-fulled__done {
    flex: none;
    min-height: var(--tm-touch-target);
    padding: 0 var(--tm-space-3);
    border-radius: var(--tm-radius-md);
    color: var(--tm-color-accent);
    font-size: var(--tm-text-md);
    font-weight: 600;
  }
  .tm-fulled__text {
    flex: 1;
    min-height: 0;
    width: 100%;
    padding: var(--tm-space-4) var(--tm-gutter);
    background: var(--tm-color-bg);
    color: var(--tm-color-text);
    font-family: var(--tm-font-body);
    font-size: var(--tm-text-md);
    line-height: var(--tm-leading-relaxed);
    resize: none;
  }
  .tm-fulled__text:focus-visible {
    outline: none;
  }
</style>
