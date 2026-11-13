<script lang="ts">
  /** Bottom sheet for menus (ST's #options popup, chat file list). Scrim closes it. */
  import type { Snippet } from 'svelte';
  interface Props {
    open: boolean;
    title?: string | undefined;
    id?: string | undefined;
    onClose: () => void;
    /** draw above everything, extension panels included (popups the user must answer) */
    system?: boolean;
    children: Snippet;
  }
  let { open, title, id, onClose, system = false, children }: Props = $props();

  let sheet = $state<HTMLElement>();
  const isTextField = (el: Element) =>
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  // Focus goes into the sheet (a screen reader starts reading there, Escape reaches it) and back to
  // the control that opened it. A text field is left alone: focusing it would bring the keyboard up.
  $effect(() => {
    const el = sheet;
    if (!open || !el) return;
    const active = document.activeElement;
    // content that focused a field of its own while mounting keeps it
    const inside = !!active && el.contains(active);
    const opener = !inside && active instanceof HTMLElement ? active : null;
    if (!inside) el.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      const free = !now || now === document.body || el.contains(now);
      if (free && opener?.isConnected && !isTextField(opener))
        opener.focus({ preventScroll: true });
    };
  });
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  }
</script>

{#if open}
  <div class="tm-sheet__root" class:tm-sheet__root--system={system}>
    <button class="tm-sheet__scrim" aria-label="关闭" onclick={onClose}></button>
    <div
      bind:this={sheet}
      {id}
      class="tm-sheet popup"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      onkeydown={onKeydown}
    >
      <div class="tm-sheet__grip" aria-hidden="true"></div>
      {#if title}<h2 class="tm-sheet__title popup-title">{title}</h2>{/if}
      <div class="tm-sheet__body popup-body popup-content">{@render children()}</div>
    </div>
  </div>
{/if}

<style>
  .tm-sheet__root {
    position: fixed;
    inset: 0;
    z-index: var(--tm-z-modal);
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }
  .tm-sheet__root--system {
    z-index: var(--tm-z-system);
  }
  .tm-sheet__scrim {
    position: absolute;
    inset: 0;
    background: var(--tm-color-scrim);
  }
  .tm-sheet {
    position: relative;
    max-height: 80vh;
    overflow-y: auto;
    background: var(--tm-color-surface);
    border-radius: var(--tm-radius-lg) var(--tm-radius-lg) 0 0;
    padding: var(--tm-space-2) var(--tm-gutter) calc(var(--tm-space-5) + var(--tm-safe-bottom));
    box-shadow: var(--tm-shadow-3);
    font-family: var(--tm-font-ui);
  }
  .tm-sheet:focus {
    outline: none;
  }
  @media (min-width: 600px) {
    .tm-sheet {
      width: min(100%, calc(var(--tm-chat-measure) * 0.8));
      margin: 0 auto var(--tm-space-6);
      border-radius: var(--tm-radius-lg);
      padding-bottom: var(--tm-space-5);
    }
  }
  .tm-sheet__grip {
    width: calc(var(--tm-space-8) * 1.25);
    height: var(--tm-space-1);
    margin: 0 auto var(--tm-space-3);
    border-radius: var(--tm-radius-full);
    background: var(--tm-color-border-strong);
  }
  .tm-sheet__title {
    margin: 0 0 var(--tm-space-3);
    font-size: var(--tm-text-xs);
    font-weight: 600;
    letter-spacing: var(--tm-tracking-wide);
    color: var(--tm-color-text-secondary);
  }
  .tm-sheet__body {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-1);
  }
</style>
