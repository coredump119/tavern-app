<script lang="ts">
  /**
   * ST's wand menu. `#extensionsMenu` belongs to the extensions (they append their own entries),
   * so it stays in the page and only its sheet is shown or hidden (DEV_NOTES §9.34).
   */
  import { extensionHost as host } from '../ext/host.svelte';
  import Icon from './Icon.svelte';

  let menu = $state<HTMLElement>();
  /** counted when the sheet opens; entries only ever change while it is closed or by a click in it */
  const empty = $derived(host.menuOpen && menu?.childElementCount === 0);

  // ST fades `#extensionsMenu` itself in and out, so extensions `.hide()` it after a pick: undo that on open
  $effect(() => {
    if (!host.menuOpen || !menu) return;
    menu.style.removeProperty('display');
    menu.style.removeProperty('opacity');
  });

  /** an entry was chosen: the sheet has done its job */
  function onPick(event: MouseEvent) {
    if (event.target !== menu) host.menuOpen = false;
  }
</script>

<div class="tm-extmenu" class:is-open={host.menuOpen}>
  <button class="tm-extmenu__scrim" aria-label="关闭" onclick={() => (host.menuOpen = false)}
  ></button>
  <div class="tm-extmenu__sheet" role="dialog" aria-modal="true" aria-label="扩展">
    <div class="tm-extmenu__grip" aria-hidden="true"></div>
    <h2 class="tm-extmenu__title">扩展</h2>
    {#if host.attachFile}
      <button
        class="tm-extmenu__builtin"
        onclick={() => {
          host.menuOpen = false;
          host.attachFile?.();
        }}><Icon name="paperclip" /><span>附加文件</span></button
      >
    {/if}
    {#if empty}<p class="tm-extmenu__hint">
        {host.status === 'running'
          ? '已加载的扩展没有往这里加东西。'
          : '扩展加的入口会出现在这里。'}装卸和开关在侧栏「扩展」。
      </p>{/if}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div id="extensionsMenu" class="options-content" bind:this={menu} onclick={onPick}></div>
  </div>
</div>

<style>
  .tm-extmenu__builtin {
    display: grid;
    grid-template-columns: var(--tm-icon-md) minmax(0, 1fr);
    column-gap: var(--tm-space-4);
    align-items: center;
    text-align: left;
    width: 100%;
    min-height: var(--tm-touch-target);
    padding: var(--tm-space-2) var(--tm-space-3);
    border-radius: var(--tm-radius-md);
    color: var(--tm-color-text);
    font-size: var(--tm-text-md);
  }
  .tm-extmenu {
    position: fixed;
    inset: 0;
    z-index: var(--tm-z-modal);
    display: none;
    flex-direction: column;
    justify-content: flex-end;
  }
  .tm-extmenu.is-open {
    display: flex;
  }
  .tm-extmenu__scrim {
    position: absolute;
    inset: 0;
    background: var(--tm-color-scrim);
  }
  .tm-extmenu__sheet {
    position: relative;
    max-height: 80vh;
    overflow-y: auto;
    background: var(--tm-color-surface);
    border-radius: var(--tm-radius-lg) var(--tm-radius-lg) 0 0;
    padding: var(--tm-space-2) var(--tm-gutter) calc(var(--tm-space-5) + var(--tm-safe-bottom));
    box-shadow: var(--tm-shadow-3);
    font-family: var(--tm-font-ui);
  }
  @media (min-width: 600px) {
    .tm-extmenu__sheet {
      width: min(100%, calc(var(--tm-chat-measure) * 0.8));
      margin: 0 auto var(--tm-space-6);
      border-radius: var(--tm-radius-lg);
      padding-bottom: var(--tm-space-5);
    }
  }
  .tm-extmenu__grip {
    width: calc(var(--tm-space-8) * 1.25);
    height: var(--tm-space-1);
    margin: 0 auto var(--tm-space-3);
    border-radius: var(--tm-radius-full);
    background: var(--tm-color-border-strong);
  }
  .tm-extmenu__title {
    margin: 0 0 var(--tm-space-3);
    font-size: var(--tm-text-xs);
    font-weight: 600;
    letter-spacing: var(--tm-tracking-wide);
    color: var(--tm-color-text-secondary);
  }
  .tm-extmenu__hint {
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-muted);
  }
</style>
