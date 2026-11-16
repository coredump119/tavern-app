<script lang="ts">
  /**
   * Bottom composer, built like ST's #send_form so theme CSS written for ST lands on the same boxes
   * (DEV_NOTES §9.41): #leftSendForm holds #options_button (≡) and #extensionsMenuButton (wand),
   * #rightSendForm the optional quick #mes_continue / #mes_impersonate and #send_but / #mes_stop.
   * The buttons are `div`s with ST's classes, as in ST (themes select `#leftSendForm > div`).
   * Attaching stays a row of the options list.
   */
  import { tick } from 'svelte';
  import Icon from '../Icon.svelte';
  import { hostSendForm } from '../../ext/anchors';
  import { themeStore } from '../../theme.svelte';
  import type { PendingMedia } from '../../chat/media';
  interface Props {
    disabled?: boolean;
    busy?: boolean;
    placeholder?: string;
    draft?: string;
    quickContinue?: boolean;
    quickImpersonate?: boolean;
    onSend: (text: string) => void;
    onAbort?: (() => void) | undefined;
    onOptions?: (() => void) | undefined;
    onContinue?: (() => void) | undefined;
    onImpersonate?: (() => void) | undefined;
    /** DEV_NOTES §9.30: picked files waiting to go out with the next message */
    attachments?: PendingMedia[];
    onRemoveAttachment?: ((index: number) => void) | undefined;
    /** opens the wand menu; absent while no extension is loaded */
    onExtensions?: (() => void) | undefined;
  }
  let {
    disabled = false,
    busy = false,
    placeholder = '输入想发送的消息…',
    draft = $bindable(''),
    quickContinue = false,
    quickImpersonate = false,
    onSend,
    onAbort,
    onOptions,
    onContinue,
    onImpersonate,
    attachments = [],
    onRemoveAttachment,
    onExtensions,
  }: Props = $props();
  // ST send_on_enter AUTO: Enter sends on pointer devices, newline on touch
  const enterSends = typeof matchMedia !== 'undefined' && matchMedia('(hover: hover)').matches;

  function submit() {
    if (disabled || busy) return;
    const text = draft;
    draft = '';
    onSend(text);
  }
  /** Enter / Space on a `div` button */
  const press = (run: (() => void) | undefined) => (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    run?.();
  };

  /**
   * ST draws these icons as the element's `::before`; themes swap them there (a glyph, or a mask
   * with `content: ""`). When a theme gives a button a `::before` box of its own, our own icon
   * steps aside so the two do not stack.
   */
  let inner = $state<HTMLElement | null>(null);
  function markThemedIcons() {
    if (!inner) return;
    for (const el of inner.querySelectorAll<HTMLElement>('.tm-composer__st')) {
      const before = getComputedStyle(el, '::before');
      const drawn =
        before.content !== 'none' &&
        before.content !== 'normal' &&
        before.display !== 'none' &&
        parseFloat(before.width) > 0 &&
        parseFloat(before.height) > 0;
      el.toggleAttribute('data-tm-themed-icon', drawn);
    }
  }
  $effect(() => {
    // re-check when the theme's CSS or the set of buttons changes
    const t = themeStore.current;
    void [
      t.customCss,
      t.customCssEnabled,
      t.customCssLayout,
      busy,
      quickContinue,
      quickImpersonate,
    ];
    void tick().then(() => requestAnimationFrame(markThemedIcons));
  });
  // …and whenever a stylesheet arrives or changes after that: the theme's own, an extension's, a
  // web font finishing. At mount the form may not be laid out yet, so one look is not enough.
  $effect(() => {
    let queued = 0;
    const recheck = () => {
      cancelAnimationFrame(queued);
      queued = requestAnimationFrame(markThemedIcons);
    };
    const styles = new MutationObserver(recheck);
    styles.observe(document.head, { childList: true, subtree: true, characterData: true });
    const timers = [300, 1500].map((ms) => setTimeout(recheck, ms));
    void document.fonts?.ready.then(recheck);
    return () => {
      styles.disconnect();
      cancelAnimationFrame(queued);
      for (const timer of timers) clearTimeout(timer);
    };
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && enterSends && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  }
</script>

<!-- safe-area padding lives on a wrapper with no ST name, so theme CSS cannot remove it -->
<div class="tm-composer__safe">
  <div id="form_sheld" class="tm-composer__sheld">
    <!-- #send_form itself is one element for the whole session (lib/ext/anchors): it lands in this form -->
    <form
      class="tm-composer__form"
      use:hostSendForm
      onsubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {#if attachments.length > 0}
        <!-- ST #file_form: what goes out with the next message -->
        <div id="file_form" class="tm-composer__files">
          {#each attachments as a, i (a.url)}
            <div class="tm-composer__file" title={a.name}>
              {#if a.type === 'image'}
                <img class="tm-composer__thumb" src={a.previewUrl} alt="" />
              {:else}
                <span class="tm-composer__thumb tm-composer__thumb--icon"
                  ><Icon
                    name={a.type === 'file'
                      ? 'file-lines'
                      : a.type === 'audio'
                        ? 'paperclip'
                        : 'image'}
                  /></span
                >
              {/if}
              <span class="tm-composer__file-name">{a.name}</span>
              <button
                type="button"
                class="tm-composer__file-remove"
                aria-label="移除附件"
                onclick={() => onRemoveAttachment?.(i)}><Icon name="xmark" size="sm" /></button
              >
            </div>
          {/each}
        </div>
      {/if}
      <div id="nonQRFormItems" class="tm-composer__inner" bind:this={inner}>
        <div id="leftSendForm" class="alignContentCenter tm-composer__side">
          <div
            id="options_button"
            class="fa-solid fa-bars interactable tm-composer__st tm-composer__icon"
            role="button"
            tabindex="0"
            aria-label="选项"
            title="选项"
            onclick={onOptions}
            onkeydown={press(onOptions)}
          >
            <Icon name="bars" />
          </div>
          <div
            id="extensionsMenuButton"
            class="fa-solid fa-magic-wand-sparkles interactable tm-composer__st tm-composer__icon"
            class:tm-composer__unseen={!onExtensions}
            role="button"
            tabindex={onExtensions ? 0 : -1}
            aria-label="扩展"
            title="扩展"
            aria-hidden={onExtensions ? undefined : true}
            onclick={onExtensions}
            onkeydown={press(onExtensions)}
          >
            <Icon name="wand" />
          </div>
        </div>
        <textarea
          aria-label="输入消息"
          id="send_textarea"
          class="tm-composer__input"
          rows="1"
          {placeholder}
          {disabled}
          bind:value={draft}
          onkeydown={onKeydown}></textarea>
        <div id="rightSendForm" class="alignContentCenter tm-composer__side">
          {#if busy}
            <div
              id="mes_stop"
              class="mes_stop interactable tm-composer__st tm-composer__send tm-composer__send--stop"
              role="button"
              tabindex="0"
              aria-label="中止请求"
              title="中止请求"
              onclick={onAbort}
              onkeydown={press(onAbort)}
            >
              <Icon name="stop" />
            </div>
          {:else}
            {#if quickImpersonate}
              <div
                id="mes_impersonate"
                class="fa-solid fa-user-secret interactable tm-composer__st tm-composer__icon"
                class:is-disabled={disabled}
                role="button"
                tabindex="0"
                aria-label="AI 帮答"
                aria-disabled={disabled}
                title="让 AI 为您撰写消息"
                onclick={() => !disabled && onImpersonate?.()}
                onkeydown={press(() => !disabled && onImpersonate?.())}
              >
                <Icon name="mask" />
              </div>
            {/if}
            {#if quickContinue}
              <div
                id="mes_continue"
                class="fa-fw fa-solid fa-arrow-right interactable tm-composer__st tm-composer__icon"
                class:is-disabled={disabled}
                role="button"
                tabindex="0"
                aria-label="续写"
                aria-disabled={disabled}
                title="续写上一条消息"
                onclick={() => !disabled && onContinue?.()}
                onkeydown={press(() => !disabled && onContinue?.())}
              >
                <Icon name="arrow-right" />
              </div>
            {/if}
            <div
              id="send_but"
              class="fa-solid fa-paper-plane interactable tm-composer__st tm-composer__send"
              class:is-disabled={disabled}
              role="button"
              tabindex="0"
              aria-label="发送消息"
              aria-disabled={disabled}
              title="发送消息"
              onclick={submit}
              onkeydown={press(submit)}
            >
              <Icon name="arrow-right" />
            </div>
          {/if}
        </div>
      </div>
    </form>
  </div>
</div>

<style>
  /* ST #form_sheld: a real box so themes can pad / tint it (beautification themes often float the input as a pill) */
  .tm-composer__sheld {
    display: block;
    padding: var(--tm-space-2) var(--tm-gutter);
  }
  .tm-composer__safe {
    padding-bottom: var(--tm-safe-bottom);
    background: var(--tm-color-bg);
  }
  .tm-composer__form {
    display: contents;
  }
  /* the session-long #send_form box: not rendered by this component, hence global */
  /* a card with the text field across the top and the buttons in a row under it (DEV_NOTES §9.44):
     the field keeps the full width on a phone however many buttons there are */
  :global(.tm-composer) {
    border: var(--tm-border-width) solid var(--tm-color-border);
    border-radius: var(--tm-radius-lg);
    padding: var(--tm-space-2) var(--tm-space-3);
    background: var(--tm-color-surface);
  }
  .tm-composer__inner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--tm-space-1) var(--tm-space-2);
    width: 100%;
    max-width: var(--tm-chat-measure);
    margin: 0 auto;
  }
  @media (min-width: 1024px) {
    .tm-composer__inner {
      width: var(--tm-chat-width);
      max-width: var(--tm-chat-desktop-max);
    }
  }
  /* no extension loaded: nothing for the wand to open; theme CSS may give this id a display of its own */
  .tm-composer__unseen {
    display: none !important;
  }
  .tm-composer__side {
    display: flex;
    align-items: center;
    gap: var(--tm-space-1);
    flex: none;
  }
  #rightSendForm {
    margin-left: auto;
  }
  .tm-composer__icon,
  .tm-composer__send {
    flex: none;
    width: var(--tm-touch-target);
    height: var(--tm-touch-target);
    display: grid;
    place-items: center;
    border-radius: var(--tm-radius-full);
    color: var(--tm-color-text-secondary);
  }
  .tm-composer__st {
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
  }
  /* the theme draws this button's icon itself (see markThemedIcons) */
  .tm-composer__st:global([data-tm-themed-icon]) > :global(.tm-icon) {
    display: none;
  }
  .tm-composer__icon:hover:not(.is-disabled) {
    background: var(--tm-color-surface-sunken);
    color: var(--tm-color-text);
  }
  .tm-composer__icon.is-disabled {
    opacity: 0.35;
  }
  .tm-composer__send {
    background: var(--tm-color-accent);
    color: var(--tm-color-on-accent);
    transition: opacity var(--tm-duration-fast) var(--tm-ease);
  }
  .tm-composer__send--stop {
    background: var(--tm-color-surface-sunken);
    color: var(--tm-color-danger);
  }
  .tm-composer__send.is-disabled {
    opacity: 0.35;
    cursor: default;
  }
  .tm-composer__input {
    order: -1;
    flex: 1 0 100%;
    min-width: 0;
    min-height: var(--tm-composer-min-h);
    max-height: calc(var(--tm-composer-min-h) * 4);
    padding: var(--tm-space-3) var(--tm-space-2);
    border-radius: var(--tm-radius-md);
    background: none;
    font-family: var(--tm-font-body);
    font-size: var(--tm-text-md);
    line-height: var(--tm-leading-normal);
    resize: none;
    field-sizing: content;
  }
  .tm-composer__input::placeholder {
    color: var(--tm-color-text-muted);
  }
  .tm-composer__input:focus-visible {
    outline: none;
  }
  :global(.tm-composer):focus-within {
    border-color: var(--tm-color-border-strong);
  }

  /* pending attachments strip (ST #file_form) */
  .tm-composer__files {
    display: flex;
    gap: var(--tm-space-2);
    overflow-x: auto;
    width: 100%;
    max-width: var(--tm-chat-measure);
    margin: 0 auto var(--tm-space-2);
    padding-bottom: var(--tm-space-1);
  }
  .tm-composer__file {
    position: relative;
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--tm-space-1);
    width: calc(var(--tm-media-thumb) + var(--tm-space-3));
  }
  .tm-composer__thumb {
    width: var(--tm-media-thumb);
    height: var(--tm-media-thumb);
    border-radius: var(--tm-radius-md);
    object-fit: cover;
    background: var(--tm-color-surface-sunken);
  }
  .tm-composer__thumb--icon {
    display: grid;
    place-items: center;
    color: var(--tm-color-text-secondary);
  }
  .tm-composer__file-name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }
  .tm-composer__file-remove {
    position: absolute;
    top: calc(var(--tm-space-1) * -1);
    right: 0;
    display: grid;
    place-items: center;
    width: var(--tm-icon-lg);
    height: var(--tm-icon-lg);
    border-radius: var(--tm-radius-full);
    background: var(--tm-color-scrim);
    color: var(--tm-color-on-accent);
  }
</style>
