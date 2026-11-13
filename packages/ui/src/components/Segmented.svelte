<script lang="ts" generics="T extends string">
  interface Option {
    value: T;
    label: string;
  }
  interface Props {
    options: readonly Option[];
    value: T;
    onchange?: (v: T) => void;
    label?: string;
  }
  let { options, value = $bindable(), onchange, label }: Props = $props();
  function pick(v: T) {
    value = v;
    onchange?.(v);
  }
</script>

<div class="tm-seg" role="radiogroup" aria-label={label}>
  {#each options as o (o.value)}
    <button
      type="button"
      role="radio"
      class="tm-seg__item"
      class:is-active={o.value === value}
      aria-checked={o.value === value}
      onclick={() => pick(o.value)}
    >
      {o.label}
    </button>
  {/each}
</div>

<style>
  .tm-seg {
    display: inline-flex;
    padding: var(--tm-space-1);
    gap: var(--tm-space-1);
    background: var(--tm-color-surface-sunken);
    border-radius: var(--tm-radius-md);
  }
  .tm-seg__item {
    min-height: calc(var(--tm-touch-target) * 0.7);
    padding: 0 var(--tm-space-4);
    border-radius: calc(var(--tm-radius-md) - var(--tm-space-1));
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-xs);
    font-weight: 500;
    color: var(--tm-color-text-secondary);
    transition:
      background-color var(--tm-duration-fast) var(--tm-ease),
      color var(--tm-duration-fast) var(--tm-ease);
  }
  .tm-seg__item.is-active {
    background: var(--tm-color-surface-raised);
    color: var(--tm-color-text);
    box-shadow: var(--tm-shadow-1);
  }
</style>
