<script lang="ts">
  import type { Snippet } from 'svelte';
  interface Props {
    title: string;
    subtitle?: string | undefined;
    onMenu?: (() => void) | undefined;
    onInspector?: (() => void) | undefined;
    actions?: Snippet;
    /** chat page: float over the content, no title, no hairline; just the two icon buttons */
    immersive?: boolean;
  }
  let { title, subtitle, onMenu, onInspector, actions, immersive = false }: Props = $props();
</script>

<!-- safe-area padding on the outer header (no ST name); #top-bar is the row themes style -->
<header class="tm-topbar__safe" class:tm-topbar--immersive={immersive}>
  <div id="top-bar" class="tm-topbar">
    <button
      class="tm-topbar__icon tm-topbar__menu drawer-toggle"
      aria-label="菜单"
      onclick={onMenu}
    >
      <svg
        class="drawer-icon fa-solid fa-bars"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"><path d="M4 7h16M4 12h16M4 17h16" /></svg
      >
    </button>
    <div class="tm-topbar__titles">
      {#if immersive}
        <h1 class="tm-topbar__title tm-visually-hidden">{title}</h1>
      {:else}
        <h1 class="tm-topbar__title">{title}</h1>
        {#if subtitle}<p class="tm-topbar__subtitle">{subtitle}</p>{/if}
      {/if}
    </div>
    <div class="tm-topbar__actions">
      {#if actions}{@render actions()}{/if}
      {#if onInspector}
        <button
          id="user-settings-button"
          class="tm-topbar__icon tm-topbar__inspector drawer-toggle"
          aria-label="主题面板"
          onclick={onInspector}
        >
          <svg
            class="drawer-icon fa-solid fa-user-cog"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            ><circle cx="12" cy="12" r="8" /><path
              d="M12 4a8 8 0 0 1 0 16"
              fill="currentColor"
              stroke="none"
            /></svg
          >
        </button>
      {/if}
    </div>
  </div>
</header>

<style>
  .tm-topbar__safe {
    padding-top: var(--tm-safe-top);
  }
  .tm-topbar {
    display: flex;
    align-items: center;
    gap: var(--tm-space-3);
    min-height: var(--tm-topbar-height);
    padding: 0 var(--tm-gutter);
    border-bottom: var(--tm-border-width) solid var(--tm-color-border);
    font-family: var(--tm-font-ui);
  }
  .tm-topbar__titles {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .tm-topbar__title {
    font-size: var(--tm-text-md);
    font-weight: 600;
    letter-spacing: var(--tm-tracking-tight);
    line-height: var(--tm-leading-tight);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tm-topbar__subtitle {
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-secondary);
    line-height: var(--tm-leading-tight);
  }
  .tm-topbar__actions {
    display: flex;
    gap: var(--tm-space-2);
  }
  .tm-topbar__icon {
    width: var(--tm-touch-target);
    height: var(--tm-touch-target);
    display: inline-grid;
    place-items: center;
    border-radius: var(--tm-radius-md);
    color: var(--tm-color-text-secondary);
    margin-inline: calc(var(--tm-space-3) * -1);
  }
  .tm-topbar__icon:hover {
    color: var(--tm-color-text);
    background: var(--tm-color-surface-sunken);
  }
  .tm-topbar__icon svg {
    width: var(--tm-icon-md);
    height: var(--tm-icon-md);
  }
  /* immersive: floats over the chat; buttons sit on a translucent disc so they read over any background */
  .tm-topbar--immersive {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: var(--tm-z-sticky);
    background: none;
    pointer-events: none;
  }
  .tm-topbar--immersive .tm-topbar {
    border-bottom: 0;
    background: none;
  }
  /* soft fade behind the status bar so the clock stays readable while messages scroll under it */
  .tm-topbar--immersive::before {
    content: '';
    position: absolute;
    inset: 0 0 calc(var(--tm-space-4) * -1);
    background: linear-gradient(
      to bottom,
      var(--tm-color-bg) 0%,
      color-mix(in srgb, var(--tm-color-bg) 70%, transparent) 55%,
      transparent 100%
    );
    pointer-events: none;
  }
  .tm-topbar--immersive .tm-topbar__icon {
    position: relative;
    pointer-events: auto;
    border-radius: var(--tm-radius-full);
    color: var(--tm-color-text-secondary);
    background: color-mix(in srgb, var(--tm-color-bg) 72%, transparent);
    backdrop-filter: blur(var(--tm-space-2));
    -webkit-backdrop-filter: blur(var(--tm-space-2));
  }
  .tm-visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  @media (min-width: 600px) {
    .tm-topbar__menu {
      display: none;
    }
  }
  @media (min-width: 1024px) {
    .tm-topbar__inspector {
      display: none;
    }
  }
</style>
