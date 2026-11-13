<script lang="ts">
  import type { Snippet } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { PHONE_QUERY } from '../breakpoints';
  interface Props {
    sidebar: Snippet;
    main: Snippet;
    inspector?: Snippet;
    sidebarOpen?: boolean;
    inspectorOpen?: boolean;
  }
  let {
    sidebar,
    main,
    inspector,
    sidebarOpen = $bindable(false),
    inspectorOpen = $bindable(false),
  }: Props = $props();

  /** phone layout: an open panel is a modal drawer over the page (wider, it docks or floats beside it) */
  const narrow = new MediaQuery(PHONE_QUERY);
  const covered = $derived(narrow.current && (sidebarOpen || inspectorOpen));
</script>

<div class="tm-shell" class:has-inspector={!!inspector}>
  <aside class="tm-shell__sidebar" class:is-open={sidebarOpen} aria-label="导航">
    {@render sidebar()}
  </aside>
  <main class="tm-shell__main" inert={covered}>
    {@render main()}
  </main>
  {#if inspector}
    <aside class="tm-shell__inspector" class:is-open={inspectorOpen} aria-label="检视器">
      {@render inspector()}
    </aside>
  {/if}
  {#if sidebarOpen || inspectorOpen}
    <button
      class="tm-shell__scrim"
      aria-label="关闭面板"
      onclick={() => {
        sidebarOpen = false;
        inspectorOpen = false;
      }}
    ></button>
  {/if}
</div>

<style>
  .tm-shell {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    background: var(--tm-color-bg);
  }
  .tm-shell__sidebar,
  .tm-shell__inspector {
    background: var(--tm-color-surface);
    overflow-y: auto;
    padding-top: var(--tm-safe-top);
    padding-bottom: var(--tm-safe-bottom);
  }
  .tm-shell__sidebar {
    border-right: var(--tm-border-width) solid var(--tm-color-border);
  }
  .tm-shell__inspector {
    border-left: var(--tm-border-width) solid var(--tm-color-border);
  }
  .tm-shell__main {
    position: relative; /* the immersive top bar floats inside it */
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* sm: panels are drawers */
  .tm-shell__sidebar,
  .tm-shell__inspector {
    position: fixed;
    top: 0;
    bottom: 0;
    width: min(var(--tm-sidebar-width), 85vw);
    z-index: var(--tm-z-drawer);
    /* a closed drawer is off screen but still there for a screen reader, unless it is hidden */
    visibility: hidden;
    transition:
      transform var(--tm-duration-normal) var(--tm-ease),
      visibility 0s linear var(--tm-duration-normal);
  }
  .tm-shell__sidebar {
    left: 0;
    transform: translateX(-100%);
  }
  .tm-shell__inspector {
    right: 0;
    width: min(var(--tm-inspector-width), 85vw);
    transform: translateX(100%);
  }
  .tm-shell__sidebar.is-open,
  .tm-shell__inspector.is-open {
    transform: none;
    box-shadow: var(--tm-shadow-3);
    visibility: visible;
    transition: transform var(--tm-duration-normal) var(--tm-ease);
  }
  .tm-shell__scrim {
    position: fixed;
    inset: 0;
    z-index: calc(var(--tm-z-drawer) - 1);
    background: var(--tm-color-scrim);
  }

  /* md: sidebar docked */
  @media (min-width: 600px) {
    .tm-shell {
      grid-template-columns: var(--tm-sidebar-width) minmax(0, 1fr);
    }
    .tm-shell__sidebar {
      position: static;
      transform: none;
      width: auto;
      box-shadow: none;
      visibility: visible;
    }
    .tm-shell__scrim {
      display: none;
    }
    .tm-shell__inspector {
      z-index: var(--tm-z-drawer);
    }
  }

  /* lg: inspector docked */
  @media (min-width: 1024px) {
    .tm-shell.has-inspector {
      grid-template-columns: var(--tm-sidebar-width) minmax(0, 1fr) var(--tm-inspector-width);
    }
    .tm-shell__inspector {
      position: static;
      transform: none;
      width: auto;
      box-shadow: none;
      visibility: visible;
    }
  }
</style>
