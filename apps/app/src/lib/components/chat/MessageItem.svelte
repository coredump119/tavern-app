<script lang="ts">
  /**
   * One chat message, laid out the way ST does it: name + timestamp on the left of the header,
   * `…`(extra actions) + pencil on the right; editing swaps the header buttons for ST's
   * .mes_edit_buttons toolbar (✓ copy 🗑 ↑ ↓ ✕); swipe chevrons sit beside the last reply.
   * DOM follows the ST contract (DEV_NOTES §9.3): .mes[mesid][is_user][ch_name], .mes_block,
   * .mes_text, .mes_buttons, .extraMesButtons, .mes_edit_buttons, .swipe_left/.swipe_right.
   */
  import { untrack } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import { isFrontend } from '@tm/tavern-helper';
  import { helperBridge } from '../../helper/bridge.svelte';
  import Icon from '../Icon.svelte';

  /** one attachment, display-ready (DEV_NOTES §9.30) */
  export interface MediaView {
    index: number;
    url: string;
    kind: 'image' | 'video' | 'audio';
    title: string;
  }

  interface Props {
    index: number;
    name: string;
    isUser: boolean;
    isSystem?: boolean;
    time: string;
    html: string;
    reasoningHtml?: string | undefined;
    avatarUrl?: string | undefined;
    grouped?: boolean;
    streaming?: boolean;
    isLast?: boolean;
    swipe?: { id: number; count: number } | undefined;
    /** Raw message text for the editor (mes, not display_text) */
    rawText?: string;
    /** ST "delete messages" mode: tapping a message selects it and everything after it */
    selectMode?: boolean;
    selected?: boolean;
    onSelect?: (() => void) | undefined;
    onEdit?: ((text: string) => void) | undefined;
    onDelete?: (() => void) | undefined;
    /** ST deleteSwipe: only the last reply with more than one swipe offers it */
    onDeleteSwipe?: (() => void) | undefined;
    onMoveUp?: (() => void) | undefined;
    onMoveDown?: (() => void) | undefined;
    onToggleHidden?: (() => void) | undefined;
    onSwipe?: ((dir: -1 | 1) => void) | undefined;
    /** ST bookmarks (DEV_NOTES §9.29): flag when this message has a checkpoint; create actions */
    bookmarkLink?: string | null | undefined;
    onOpenBookmark?: (() => void) | undefined;
    onCheckpoint?: (() => void) | undefined;
    onBranch?: (() => void) | undefined;
    /** ST media (DEV_NOTES §9.30) */
    media?: MediaView[] | undefined;
    mediaDisplay?: 'list' | 'gallery' | undefined;
    mediaIndex?: number | undefined;
    /** `extra.inline_image === false`: the picture replaces the text */
    hideText?: boolean | undefined;
    fileNames?: string[] | undefined;
    onMediaOpen?: ((index: number) => void) | undefined;
    onMediaDelete?: ((index: number) => void) | undefined;
    onMediaIndex?: ((index: number) => void) | undefined;
    /** from the virtual list: measures this row; `parked` = kept mounted outside the window */
    attach?: Attachment<HTMLElement> | undefined;
    parked?: boolean;
  }
  let {
    index,
    name,
    isUser,
    isSystem = false,
    time,
    html,
    reasoningHtml,
    avatarUrl,
    grouped = false,
    streaming = false,
    isLast = false,
    swipe,
    rawText = '',
    selectMode = false,
    selected = false,
    onSelect,
    onEdit,
    onDelete,
    onDeleteSwipe,
    onMoveUp,
    onMoveDown,
    onToggleHidden,
    onSwipe,
    bookmarkLink = null,
    onOpenBookmark,
    onCheckpoint,
    onBranch,
    media,
    mediaDisplay = 'list',
    mediaIndex = 0,
    hideText = false,
    fileNames,
    onMediaOpen,
    onMediaDelete,
    onMediaIndex,
    attach,
    parked = false,
  }: Props = $props();

  // gallery shows one attachment with ‹ › controls; list shows them all (ST appendMediaToMessage)
  const shownMedia = $derived.by<MediaView[]>(() => {
    if (!media || media.length === 0) return [];
    if (mediaDisplay !== 'gallery') return media;
    const i = Math.min(Math.max(mediaIndex, 0), media.length - 1);
    return [media[i]!];
  });

  let avatarFailed = $state(false);
  $effect(() => {
    void avatarUrl;
    avatarFailed = false;
  });

  let editing = $state(false);
  let draft = $state('');
  let extrasOpen = $state(false);
  let copied = $state(false);
  const canAct = $derived(!!onEdit && !streaming && !selectMode);

  function startEdit() {
    draft = rawText;
    editing = true;
    extrasOpen = false;
  }
  function saveEdit() {
    editing = false;
    if (draft !== rawText) onEdit?.(draft);
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }
  // ST addCopyToCodeBlocks (DEV_NOTES §9.33): a copy button on every `pre code`, re-added after each render
  let textEl = $state<HTMLDivElement | null>(null);
  const COPY_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 9h10v11H9zM5 15V4h10"/></svg>';
  $effect(() => {
    void html;
    const el = textEl;
    if (!el) return;
    for (const code of el.querySelectorAll('pre code')) {
      const pre = code.parentElement;
      if (!pre || pre.querySelector(':scope > .code-copy')) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy interactable fa-solid fa-copy';
      btn.title = '复制代码';
      btn.setAttribute('aria-label', '复制代码');
      btn.innerHTML = COPY_SVG;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        void copy(code.textContent ?? '');
      });
      pre.appendChild(btn);
    }
  });
  // TavernHelper (DEV_NOTES §9.5): a code block holding a front-end page is shown as a sandboxed
  // iframe. Not while streaming: the page is incomplete and would be rebuilt every frame.
  $effect(() => {
    void html;
    const el = textEl;
    if (!el || streaming || !helperBridge.active) return;
    const cleanups: (() => void)[] = [];
    for (const code of el.querySelectorAll('pre code')) {
      const pre = code.parentElement;
      const source = code.textContent ?? '';
      if (!pre || !isFrontend(source)) continue;
      const block = cleanups.length;
      // untracked: what the slot reads from the stores must not re-run this effect
      cleanups.push(untrack(() => helperBridge.mountSlot(pre, index, block, source)));
    }
    if (cleanups.length === 0) return;
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  });
  const showSwipes = $derived(
    isLast && !isUser && !isSystem && !streaming && !editing && !selectMode && !!onSwipe,
  );
</script>

<article
  class="mes tm-mes"
  class:tm-mes--user={isUser}
  class:tm-mes--system={isSystem}
  class:tm-mes--grouped={grouped}
  class:tm-mes--streaming={streaming}
  class:tm-mes--editing={editing}
  class:tm-mes--selectable={selectMode}
  class:tm-mes--selected={selected}
  class:last_mes={isLast}
  class:tm-vlist__row--parked={parked}
  aria-busy={streaming || undefined}
  {@attach attach}
  mesid={index}
  is_user={isUser}
  ch_name={name}
>
  {#if selectMode}
    <button
      class="tm-mes__select"
      aria-pressed={selected}
      aria-label="从这条开始删除"
      onclick={onSelect}
    >
      <span class="del_checkbox tm-mes__checkbox" aria-hidden="true"
        >{#if selected}<Icon name="check" size="sm" />{/if}</span
      >
    </button>
  {/if}
  <div class="mesAvatarWrapper tm-mes__avatar-col">
    {#if !grouped}
      {#if avatarUrl && !avatarFailed}
        <img
          class="avatar tm-avatar"
          src={avatarUrl}
          alt=""
          loading="lazy"
          onerror={() => (avatarFailed = true)}
        />
      {:else}
        <span class="avatar tm-avatar" aria-hidden="true">{name.slice(0, 1)}</span>
      {/if}
    {/if}
    {#if showSwipes && swipe && swipe.id > 0}
      <button
        class="swipe_left tm-mes__swipe tm-mes__swipe--left"
        aria-label="上一个回复"
        onclick={() => onSwipe?.(-1)}
      >
        <Icon name="chevron-left" />
      </button>
    {/if}
  </div>
  <div class="mes_block tm-mes__block">
    <header class="ch_name tm-mes__head" class:tm-mes__head--grouped={grouped}>
      <div class="tm-mes__who">
        {#if !grouped}
          <span class="name_text tm-mes__name">{name}</span>
          {#if isSystem}<span class="mes_ghost tm-mes__ghost" title="这条消息对 AI 不可见"
              ><Icon name="ghost" size="sm" /></span
            >{/if}
          <time class="timestamp tm-mes__time">{time}</time>
          {#if bookmarkLink}
            <button
              class="mes_bookmark mes_button tm-mes__flag"
              title={`检查点：${bookmarkLink}`}
              aria-label="打开检查点聊天"
              onclick={onOpenBookmark}><Icon name="flag" size="sm" /></button
            >
          {/if}
        {/if}
      </div>
      {#if editing}
        <div class="mes_edit_buttons tm-mes__tools tm-mes__tools--edit">
          <button
            class="mes_edit_done tm-mes__tool"
            title="确认"
            aria-label="确认"
            onclick={saveEdit}><Icon name="check" size="sm" /></button
          >
          <button
            class="mes_edit_copy tm-mes__tool"
            title="复制这条消息"
            aria-label="复制"
            onclick={() => copy(draft)}><Icon name="copy" size="sm" /></button
          >
          {#if onDeleteSwipe}
            <button
              class="mes_edit_delete_swipe tm-mes__tool tm-mes__tool--danger"
              title="删除这个回复（仅当前滑动）"
              aria-label="删除当前滑动"
              onclick={() => {
                editing = false;
                onDeleteSwipe?.();
              }}><Icon name="xmark" size="sm" /></button
            >
          {/if}
          {#if onDelete}
            <button
              class="mes_edit_delete tm-mes__tool tm-mes__tool--danger"
              title="删除这条消息"
              aria-label="删除"
              onclick={() => {
                editing = false;
                onDelete?.();
              }}><Icon name="trash" size="sm" /></button
            >
          {/if}
          <button
            class="mes_edit_up tm-mes__tool"
            title="将消息上移"
            aria-label="上移"
            disabled={!onMoveUp}
            onclick={() => {
              editing = false;
              onMoveUp?.();
            }}><Icon name="chevron-up" size="sm" /></button
          >
          <button
            class="mes_edit_down tm-mes__tool"
            title="将消息下移"
            aria-label="下移"
            disabled={!onMoveDown}
            onclick={() => {
              editing = false;
              onMoveDown?.();
            }}><Icon name="chevron-down" size="sm" /></button
          >
          <button
            class="mes_edit_cancel tm-mes__tool"
            title="取消"
            aria-label="取消"
            onclick={() => (editing = false)}><Icon name="xmark" size="sm" /></button
          >
        </div>
      {:else if canAct}
        <div class="mes_buttons tm-mes__tools" aria-label="消息操作">
          {#if extrasOpen}
            <div class="extraMesButtons tm-mes__extras">
              <button
                class="mes_copy mes_button tm-mes__tool"
                title="复制"
                aria-label="复制"
                onclick={() => copy(rawText)}><Icon name="copy" size="sm" /></button
              >
              {#if onToggleHidden}
                {#if isSystem}
                  <button
                    class="mes_unhide mes_button tm-mes__tool"
                    title="包含在提示词中"
                    aria-label="取消隐藏"
                    onclick={() => {
                      extrasOpen = false;
                      onToggleHidden?.();
                    }}><Icon name="eye-slash" size="sm" /></button
                  >
                {:else}
                  <button
                    class="mes_hide mes_button tm-mes__tool"
                    title="从提示词中排除"
                    aria-label="隐藏"
                    onclick={() => {
                      extrasOpen = false;
                      onToggleHidden?.();
                    }}><Icon name="eye" size="sm" /></button
                  >
                {/if}
              {/if}
              {#if onCheckpoint}
                <button
                  class="mes_create_bookmark mes_button tm-mes__tool"
                  title="创建检查点"
                  aria-label="创建检查点"
                  onclick={() => {
                    extrasOpen = false;
                    onCheckpoint?.();
                  }}><Icon name="flag-checkered" size="sm" /></button
                >
              {/if}
              {#if onBranch}
                <button
                  class="mes_create_branch mes_button tm-mes__tool"
                  title="创建分支"
                  aria-label="创建分支"
                  onclick={() => {
                    extrasOpen = false;
                    onBranch?.();
                  }}><Icon name="code-branch" size="sm" /></button
                >
              {/if}
            </div>
          {/if}
          <button
            class="extraMesButtonsHint mes_button tm-mes__tool"
            title="消息操作"
            aria-label="更多"
            aria-expanded={extrasOpen}
            onclick={() => (extrasOpen = !extrasOpen)}><Icon name="ellipsis" size="sm" /></button
          >
          <button
            class="mes_edit mes_button tm-mes__tool"
            title="编辑"
            aria-label="编辑"
            onclick={startEdit}><Icon name="pencil" size="sm" /></button
          >
        </div>
      {/if}
    </header>
    {#if copied}<span class="tm-mes__toast">已复制</span>{/if}
    {#if reasoningHtml && !editing}
      <details class="mes_reasoning_details tm-mes__reasoning">
        <summary class="tm-mes__reasoning-title">思考过程</summary>
        <div class="mes_reasoning tm-mes__reasoning-body">{@html reasoningHtml}</div>
      </details>
    {/if}
    {#if shownMedia.length > 0 && !editing}
      <div class="mes_media_wrapper tm-mes__media" data-media-display={mediaDisplay}>
        {#each shownMedia as m (m.index)}
          <div
            class="mes_media_container tm-mes__media-item"
            class:mes_img_container={m.kind === 'image'}
            class:mes_video_container={m.kind === 'video'}
            class:mes_audio_container={m.kind === 'audio'}
            data-index={m.index}
          >
            {#if m.kind === 'image'}
              <button
                class="tm-mes__media-open"
                title={m.title}
                aria-label="查看大图"
                onclick={() => onMediaOpen?.(m.index)}
              >
                <img class="mes_img tm-mes__img" src={m.url} alt={m.title} loading="lazy" />
              </button>
            {:else if m.kind === 'video'}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video
                class="mes_video tm-mes__video"
                src={m.url}
                controls
                preload="metadata"
                title={m.title}
              ></video>
            {:else}
              <audio
                class="mes_audio tm-mes__audio"
                src={m.url}
                controls
                preload="metadata"
                title={m.title}
              ></audio>
            {/if}
            {#if onMediaDelete && canAct}
              <div class="mes_img_controls tm-mes__media-controls">
                <button
                  class="mes_media_delete tm-mes__media-btn"
                  title="移除附件"
                  aria-label="移除附件"
                  onclick={() => onMediaDelete?.(m.index)}><Icon name="xmark" size="sm" /></button
                >
              </div>
            {/if}
          </div>
        {/each}
        {#if mediaDisplay === 'gallery' && media && media.length > 1}
          <div class="mes_img_swipes tm-mes__media-swipes">
            <button
              class="mes_img_swipe_left tm-mes__media-btn"
              aria-label="上一张"
              disabled={mediaIndex <= 0}
              onclick={() => onMediaIndex?.(mediaIndex - 1)}
              ><Icon name="chevron-left" size="sm" /></button
            >
            <span class="mes_img_swipe_counter tm-mes__media-counter"
              >{mediaIndex + 1}/{media.length}</span
            >
            <button
              class="mes_img_swipe_right tm-mes__media-btn"
              aria-label="下一张"
              disabled={mediaIndex >= media.length - 1}
              onclick={() => onMediaIndex?.(mediaIndex + 1)}
              ><Icon name="chevron-right" size="sm" /></button
            >
          </div>
        {/if}
      </div>
    {/if}
    {#if fileNames && fileNames.length > 0 && !editing}
      <div class="mes_file_wrapper tm-mes__files">
        {#each fileNames as f (f)}
          <span class="mes_file_container tm-mes__file"
            ><Icon name="file-lines" size="sm" />{f}</span
          >
        {/each}
      </div>
    {/if}
    {#if editing}
      <textarea
        aria-label="编辑消息"
        class="edit_textarea tm-mes__edit-textarea"
        bind:value={draft}
        rows="4"></textarea>
    {:else}
      <div class="mes_text tm-mes__text" class:inline_media={hideText} bind:this={textEl}>
        {@html html}{#if streaming}<span class="tm-mes__cursor" aria-hidden="true"></span>{/if}
      </div>
    {/if}
    {#if showSwipes && swipe}
      <div class="tm-mes__swipe-right-wrap">
        <button
          class="swipe_right tm-mes__swipe tm-mes__swipe--right"
          aria-label="下一个回复 / 换一个"
          onclick={() => onSwipe?.(1)}
        >
          <Icon name="chevron-right" />
        </button>
        {#if swipe.count > 1}<span class="swipes-counter tm-mes__counter"
            >{swipe.id + 1}/{swipe.count}</span
          >{/if}
      </div>
    {/if}
  </div>
</article>

<style>
  .tm-mes {
    position: relative;
    display: grid;
    grid-template-columns: var(--tm-avatar-size) minmax(0, 1fr);
    grid-template-areas: 'avatar block';
    gap: var(--tm-space-4);
    padding-bottom: var(--tm-space-7);
  }
  .tm-mes--grouped {
    margin-top: calc(var(--tm-space-7) * -1 + var(--tm-space-3));
  }
  :root[data-tm-user-side='right'] .tm-mes--user {
    grid-template-columns: minmax(0, 1fr) var(--tm-avatar-size);
    grid-template-areas: 'block avatar';
  }
  :root[data-tm-user-side='right'] .tm-mes--user .tm-mes__block {
    align-items: flex-end;
  }
  :root[data-tm-user-side='right'] .tm-mes--user .tm-mes__head {
    flex-direction: row-reverse;
  }
  :root[data-tm-user-side='right'] .tm-mes--user .tm-mes__tools {
    margin-left: 0;
    margin-right: auto;
  }
  :root[data-tm-user-side='right'] .tm-mes--user .tm-mes__who {
    flex-direction: row-reverse;
  }
  .tm-mes__avatar-col {
    grid-area: avatar;
    position: relative;
  }
  :root[data-tm-avatars='false'] .tm-mes {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'block';
  }
  :root[data-tm-avatars='false'] .tm-mes__avatar-col {
    display: none;
  }
  .tm-avatar {
    display: grid;
    place-items: center;
    width: var(--tm-avatar-size);
    height: var(--tm-avatar-height);
    border-radius: var(--tm-radius-avatar);
    object-fit: cover;
    background: var(--tm-color-surface-sunken);
    color: var(--tm-color-text-secondary);
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-sm);
    font-weight: 600;
    object-fit: cover;
  }
  .tm-mes__block {
    grid-area: block;
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-2);
    min-width: 0;
    position: relative;
  }
  .tm-mes__head {
    display: flex;
    flex-wrap: wrap; /* expanded tools drop to their own row instead of leaving the screen */
    align-items: center;
    justify-content: space-between;
    gap: var(--tm-space-3);
    min-height: calc(var(--tm-touch-target) * 0.6);
    font-family: var(--tm-font-ui);
  }
  .tm-mes__head--grouped {
    min-height: 0;
    margin-bottom: calc(var(--tm-space-2) * -1);
  }
  .tm-mes__who {
    display: flex;
    align-items: baseline;
    gap: var(--tm-space-3);
    min-width: 0;
  }
  .tm-mes__name {
    font-size: var(--tm-text-sm);
    font-weight: 600;
    letter-spacing: var(--tm-tracking-wide);
  }
  .tm-mes__ghost {
    color: var(--tm-color-text-muted);
    align-self: center;
  }
  .tm-mes__time {
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
    font-variant-numeric: tabular-nums;
  }
  :root[data-tm-timestamps='false'] .tm-mes__time {
    display: none;
  }

  /* header tools: ST shows them on hover; touch devices always */
  .tm-mes__tools {
    display: flex;
    align-items: center;
    gap: var(--tm-space-1);
    flex: none;
    margin-left: auto;
    opacity: 0;
    transition: opacity var(--tm-duration-fast) var(--tm-ease);
  }
  .tm-mes:hover .tm-mes__tools,
  .tm-mes:focus-within .tm-mes__tools,
  .tm-mes__tools--edit,
  .tm-mes__tools:has([aria-expanded='true']) {
    opacity: 1;
  }
  @media (hover: none) {
    .tm-mes__tools {
      opacity: 0.7;
    }
  }
  .tm-mes__extras {
    display: flex;
    align-items: center;
    gap: var(--tm-space-1);
    padding-right: var(--tm-space-1);
    border-right: var(--tm-border-width) solid var(--tm-color-border);
  }
  .tm-mes__tool {
    display: grid;
    place-items: center;
    width: calc(var(--tm-touch-target) * 0.7);
    height: calc(var(--tm-touch-target) * 0.7);
    border-radius: var(--tm-radius-sm);
    color: var(--tm-color-text-muted);
  }
  .tm-mes__tool:hover {
    color: var(--tm-color-text);
    background: var(--tm-color-surface-sunken);
  }
  .tm-mes__tool:disabled {
    opacity: 0.35;
  }
  .tm-mes__tool--danger:hover {
    color: var(--tm-color-danger);
  }
  .tm-mes__toast {
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }

  .tm-mes__text {
    font-family: var(--tm-font-body);
    font-size: var(--tm-text-md);
    line-height: var(--tm-leading-body);
    overflow-wrap: anywhere;
  }
  .tm-mes--system .tm-mes__text {
    opacity: 0.6;
  }
  .tm-mes__text :global(p) {
    margin: 0 0 var(--tm-space-4);
  }
  .tm-mes__text :global(p:last-child) {
    margin-bottom: 0;
  }
  .tm-mes__text :global(em) {
    color: var(--tm-color-text-em);
  }
  .tm-mes__text :global(q) {
    color: var(--tm-color-text-quote);
    quotes: none;
  }
  .tm-mes__text :global(a) {
    color: var(--tm-color-text-link);
  }
  .tm-mes__text :global(pre),
  .tm-mes__text :global(code) {
    font-family: var(--tm-font-mono);
    font-size: var(--tm-text-sm);
  }
  .tm-mes__text :global(pre) {
    padding: var(--tm-space-3) var(--tm-space-4);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-sunken);
    overflow-x: auto;
  }
  .tm-mes__text :global(blockquote) {
    margin: 0;
    padding-left: var(--tm-space-4);
    border-left: 2px solid var(--tm-color-border-strong);
    color: var(--tm-color-text-secondary);
  }
  .tm-mes__text :global(table) {
    border-collapse: collapse;
  }
  .tm-mes__text :global(td),
  .tm-mes__text :global(th) {
    padding: var(--tm-space-1) var(--tm-space-3);
    border: var(--tm-border-width) solid var(--tm-color-border);
  }
  .tm-mes__text :global(img) {
    max-width: 100%;
    border-radius: var(--tm-radius-md);
  }
  .tm-mes__cursor {
    display: inline-block;
    width: 0.5em;
    height: 1em;
    vertical-align: text-bottom;
    margin-left: var(--tm-space-1);
    background: var(--tm-color-text-muted);
    animation: tm-blink calc(var(--tm-duration-slow) * 3) steps(2) infinite;
  }
  /* reduced motion zeroes the duration tokens; a 0ms loop would park the caret invisible */
  :global(:root[data-tm-reduced-motion='true']) .tm-mes__cursor {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .tm-mes__cursor {
      animation: none;
    }
  }
  @keyframes tm-blink {
    to {
      opacity: 0;
    }
  }
  .tm-mes__reasoning {
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-secondary);
    border-left: 2px solid var(--tm-color-border);
    padding-left: var(--tm-space-3);
  }
  .tm-mes__reasoning-title {
    cursor: pointer;
    font-size: var(--tm-text-xs);
    letter-spacing: var(--tm-tracking-wide);
    color: var(--tm-color-text-muted);
  }
  .tm-mes__reasoning-body {
    margin-top: var(--tm-space-2);
    font-family: var(--tm-font-body);
  }
  .tm-mes__edit-textarea {
    width: 100%;
    min-height: calc(var(--tm-composer-min-h) * 2);
    padding: var(--tm-space-3) var(--tm-space-4);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-sunken);
    font-family: var(--tm-font-body);
    font-size: var(--tm-text-md);
    line-height: var(--tm-leading-body);
    resize: vertical;
    field-sizing: content;
  }
  .tm-mes__edit-textarea:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--tm-color-border-strong);
  }

  /* swipes (ST: chevrons at the sides of the last reply, counter under the right one) */
  .tm-mes__swipe {
    display: grid;
    place-items: center;
    width: var(--tm-touch-target);
    height: var(--tm-touch-target);
    border-radius: var(--tm-radius-full);
    color: var(--tm-color-text-muted);
  }
  .tm-mes__swipe:hover {
    color: var(--tm-color-text);
    background: var(--tm-color-surface-sunken);
  }
  .tm-mes__swipe--left {
    position: absolute;
    left: calc((var(--tm-touch-target) - var(--tm-avatar-size)) / -2);
    bottom: 0;
  }
  .tm-mes__swipe-right-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    align-self: flex-end;
    margin-top: calc(var(--tm-space-2) * -1);
  }
  .tm-mes__counter {
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* delete-messages mode */
  .tm-mes--selectable {
    cursor: pointer;
  }
  .tm-mes__select {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    padding: var(--tm-space-2);
    border-radius: var(--tm-radius-md);
  }
  .tm-mes--selected .tm-mes__select {
    background: color-mix(in srgb, var(--tm-color-danger) 10%, transparent);
  }
  .tm-mes__checkbox {
    display: grid;
    place-items: center;
    width: var(--tm-icon-lg);
    height: var(--tm-icon-lg);
    border-radius: var(--tm-radius-sm);
    border: var(--tm-border-width) solid var(--tm-color-border-strong);
    background: var(--tm-color-surface);
    color: var(--tm-color-on-accent);
  }
  .tm-mes--selected .tm-mes__checkbox {
    background: var(--tm-color-danger);
    border-color: var(--tm-color-danger);
  }

  /* bubbles variant */
  :root[data-tm-chat-style='bubbles'] .tm-mes__block {
    padding: var(--tm-space-4) var(--tm-space-5);
    border-radius: var(--tm-radius-bubble);
    background: var(--tm-color-bubble-bot);
    border: var(--tm-border-width) solid var(--tm-color-border);
    box-shadow: var(--tm-shadow-1);
  }
  :root[data-tm-chat-style='bubbles'] .tm-mes--user .tm-mes__block {
    background: var(--tm-color-bubble-user);
  }

  /* document variant (ST documentstyle): prose only — no avatars, names or timestamps; tools stay on the last message */
  :root[data-tm-chat-style='document'] .tm-mes {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'block';
    padding-bottom: var(--tm-space-4);
  }
  :root[data-tm-chat-style='document'] .tm-mes__avatar-col,
  :root[data-tm-chat-style='document'] .tm-mes__name,
  :root[data-tm-chat-style='document'] .tm-mes__time {
    display: none;
  }
  :root[data-tm-chat-style='document'] .tm-mes--grouped {
    margin-top: 0;
  }
  :root[data-tm-chat-style='document'] .tm-mes__head {
    min-height: 0;
  }

  /* checkpoint flag beside the timestamp (ST .mes_bookmark) */
  .tm-mes__flag {
    display: inline-grid;
    place-items: center;
    width: var(--tm-icon-md);
    height: var(--tm-icon-md);
    align-self: center;
    border-radius: var(--tm-radius-sm);
    color: var(--tm-color-accent);
  }
  .tm-mes__flag:hover {
    background: var(--tm-color-surface-sunken);
  }

  /* media attachments (ST .mes_img_container etc.) */
  .tm-mes__media {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-2);
    max-width: 100%;
  }
  .tm-mes__media-item {
    position: relative;
    max-width: 100%;
    align-self: flex-start;
  }
  :root[data-tm-user-side='right'] .tm-mes--user .tm-mes__media-item {
    align-self: flex-end;
  }
  .tm-mes__media-open {
    display: block;
    max-width: 100%;
    border-radius: var(--tm-radius-md);
    overflow: hidden;
    background: var(--tm-color-surface-sunken);
  }
  .tm-mes__img {
    display: block;
    max-width: min(100%, var(--tm-media-max-width));
    max-height: var(--tm-media-max-height);
    object-fit: contain;
  }
  .tm-mes__video {
    display: block;
    max-width: min(100%, var(--tm-media-max-width));
    max-height: var(--tm-media-max-height);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-sunken);
  }
  /* audio: the player needs real width, and its remove button sits beside it, not on top */
  .tm-mes__media-item.mes_audio_container {
    display: flex;
    align-items: center;
    gap: var(--tm-space-2);
    width: min(100%, var(--tm-media-max-width));
  }
  .tm-mes__audio {
    display: block;
    flex: 1;
    min-width: 0;
    width: 100%;
  }
  .mes_audio_container .tm-mes__media-controls {
    position: static;
    opacity: 0.85;
  }
  .mes_audio_container .tm-mes__media-btn {
    background: var(--tm-color-surface-sunken);
    color: var(--tm-color-text-secondary);
  }
  .tm-mes__media-controls {
    position: absolute;
    top: var(--tm-space-2);
    right: var(--tm-space-2);
    display: flex;
    gap: var(--tm-space-1);
    opacity: 0;
    transition: opacity var(--tm-duration-fast) var(--tm-ease);
  }
  .tm-mes__media-item:hover .tm-mes__media-controls,
  .tm-mes__media-item:focus-within .tm-mes__media-controls {
    opacity: 1;
  }
  @media (hover: none) {
    .tm-mes__media-controls {
      opacity: 0.85;
    }
  }
  .tm-mes__media-btn {
    display: inline-grid;
    place-items: center;
    width: var(--tm-icon-lg);
    height: var(--tm-icon-lg);
    border-radius: var(--tm-radius-full);
    background: var(--tm-color-scrim);
    color: var(--tm-color-on-accent);
  }
  .tm-mes__media-btn:disabled {
    opacity: 0.35;
  }
  .tm-mes__media-swipes {
    display: flex;
    align-items: center;
    gap: var(--tm-space-2);
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }
  .tm-mes__media-swipes .tm-mes__media-btn {
    background: var(--tm-color-surface-sunken);
    color: var(--tm-color-text-secondary);
  }
  .tm-mes__files {
    display: flex;
    flex-wrap: wrap;
    gap: var(--tm-space-2);
  }
  .tm-mes__file {
    display: inline-flex;
    align-items: center;
    gap: var(--tm-space-1);
    padding: var(--tm-space-1) var(--tm-space-3);
    border-radius: var(--tm-radius-full);
    background: var(--tm-color-surface-sunken);
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-secondary);
  }
  .tm-mes__text.inline_media {
    display: none;
  }

  /* ST .code-copy: top-right of each code block */
  .tm-mes__text :global(pre) {
    position: relative;
  }
  .tm-mes__text :global(.code-copy) {
    position: absolute;
    top: 0;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--tm-icon-lg);
    height: var(--tm-icon-lg);
    margin: var(--tm-space-1);
    border-radius: var(--tm-radius-sm);
    color: var(--tm-color-text-secondary);
    opacity: 0.5;
    cursor: pointer;
  }
  .tm-mes__text :global(.code-copy:hover) {
    opacity: 0.9;
    background: var(--tm-color-surface-sunken);
  }
  .tm-mes__text :global(.code-copy svg) {
    width: var(--tm-icon-sm);
    height: var(--tm-icon-sm);
  }
  @media (hover: none) {
    .tm-mes__text :global(.code-copy) {
      opacity: 0.8;
    }
  }

  /* TavernHelper slot (DEV_NOTES §9.5): the iframe stands in for the code block it was read from */
  .tm-mes__text :global(pre.tm-th-source) {
    display: none;
  }
  .tm-mes__text :global(.tm-th-slot) {
    display: block;
    width: 100%;
    border: 0;
    /* the card document is light-scheme; a matching scheme keeps the iframe canvas transparent */
    color-scheme: light;
  }
</style>
