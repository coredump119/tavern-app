<script lang="ts">
  /**
   * ST getGroupAvatar: the group's own picture when it has one (`custom` = its `avatar_url`), else
   * up to four member avatars in a 2×2 collage (one or two fill the box).
   */
  import { groupCustomAvatar } from '@tm/core';
  import { fileUrl } from '../ipc';
  interface Props {
    avatars: readonly string[];
    root: string;
    custom?: string | null | undefined;
  }
  let { avatars, root, custom }: Props = $props();
  const own = $derived(groupCustomAvatar(custom));
</script>

{#if own}
  <span class="tm-collage tm-collage--1" aria-hidden="true">
    <img
      class="tm-collage__img"
      src={own.startsWith('data:') ? own : fileUrl(`${root}/${own}`)}
      alt=""
      loading="lazy"
    />
  </span>
{:else}
  <span class="tm-collage tm-collage--{Math.min(avatars.length, 4)}" aria-hidden="true">
    {#each avatars.slice(0, 4) as a (a)}
      <img class="tm-collage__img" src={fileUrl(`${root}/characters/${a}`)} alt="" loading="lazy" />
    {:else}
      <span class="tm-collage__empty">群</span>
    {/each}
  </span>
{/if}

<style>
  .tm-collage {
    display: grid;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--tm-color-surface-sunken);
    gap: 1px;
  }
  .tm-collage--0,
  .tm-collage--1 {
    grid-template-columns: 1fr;
  }
  .tm-collage--2 {
    grid-template-columns: 1fr 1fr;
  }
  .tm-collage--3,
  .tm-collage--4 {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
  }
  .tm-collage--3 .tm-collage__img:first-child {
    grid-row: 1 / span 2;
  }
  .tm-collage__img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .tm-collage__empty {
    display: grid;
    place-items: center;
    font-family: var(--tm-font-serif);
    color: var(--tm-color-text-muted);
  }
</style>
