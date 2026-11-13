<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  interface Props extends HTMLButtonAttributes {
    variant?: 'primary' | 'ghost' | 'outline';
    size?: 'sm' | 'md';
    children: Snippet;
  }
  let { variant = 'ghost', size = 'md', children, class: cls = '', ...rest }: Props = $props();
</script>

<button class="menu_button tm-btn tm-btn--{variant} tm-btn--{size} {cls}" {...rest}>
  {@render children()}
</button>

<style>
  .tm-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--tm-space-2);
    min-height: var(--tm-touch-target);
    padding: 0 var(--tm-space-5);
    border-radius: var(--tm-radius-md);
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-sm);
    font-weight: 500;
    letter-spacing: var(--tm-tracking-normal);
    line-height: 1;
    color: var(--tm-color-text);
    transition:
      background-color var(--tm-duration-fast) var(--tm-ease),
      color var(--tm-duration-fast) var(--tm-ease),
      border-color var(--tm-duration-fast) var(--tm-ease);
  }
  .tm-btn--sm {
    min-height: calc(var(--tm-touch-target) * 0.75);
    padding: 0 var(--tm-space-4);
    font-size: var(--tm-text-xs);
  }
  .tm-btn--primary {
    background: var(--tm-color-accent);
    color: var(--tm-color-on-accent);
  }
  .tm-btn--primary:hover {
    filter: brightness(1.08);
  }
  .tm-btn--ghost:hover {
    background: var(--tm-color-surface-sunken);
  }
  .tm-btn--outline {
    border: var(--tm-border-width) solid var(--tm-color-border);
  }
  .tm-btn--outline:hover {
    border-color: var(--tm-color-border-strong);
  }
  .tm-btn:disabled {
    color: var(--tm-color-text-muted);
    cursor: default;
    filter: none;
    background: none;
  }
</style>
