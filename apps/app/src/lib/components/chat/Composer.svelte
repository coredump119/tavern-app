<script lang="ts">
  /**
   * Bottom composer: #options_button (≡) on the left, optional quick #mes_continue /
   * #mes_impersonate and #send_but / #mes_stop on the right. Attaching and the wand menu are rows
   * of the options list, so the text field keeps its width on a phone; #extensionsMenuButton stays
   * in #leftSendForm unseen for extensions that click it (DEV_NOTES §9.34).
   * IDs follow the ST contract: #send_form, #send_textarea, #send_but.
   */
  import Icon from '../Icon.svelte';
  import { hostSendForm } from '../../ext/anchors';
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
    placeholder = '写点什么…',
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
      <div id="nonQRFormItems" class="tm-composer__inner">
        <div id="leftSendForm" class="tm-composer__side">
          <button
            type="button"
            id="options_button"
            class="tm-composer__icon"
            aria-label="选项"
            title="选项"
            onclick={onOptions}
          >
            <Icon name="bars" />
          </button>
          <button
            type="button"
            id="extensionsMenuButton"
            class="tm-composer__unseen"
            tabindex="-1"
            aria-hidden="true"
            disabled={!onExtensions}
            onclick={onExtensions}
          ></button>
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
        <div id="rightSendForm" class="tm-composer__side">
          {#if busy}
            <button
              type="button"
              id="mes_stop"
              class="tm-composer__send tm-composer__send--stop"
              aria-label="中止请求"
              title="中止请求"
              onclick={onAbort}
            >
              <Icon name="stop" />
            </button>
          {:else}
            {#if quickImpersonate}
              <button
                type="button"
                id="mes_impersonate"
                class="tm-composer__icon"
                aria-label="AI 帮答"
                title="让 AI 为您撰写消息"
                {disabled}
                onclick={onImpersonate}
              >
                <Icon name="mask" />
              </button>
            {/if}
            {#if quickContinue}
              <button
                type="button"
                id="mes_continue"
                class="tm-composer__icon"
                aria-label="续写"
                title="续写上一条消息"
                {disabled}
                onclick={onContinue}
              >
                <Icon name="arrow-right" />
              </button>
            {/if}
            <button
              type="submit"
              id="send_but"
              class="tm-composer__send"
              aria-label="发送消息"
              title="发送消息"
              {disabled}
            >
              <Icon name="arrow-right" />
            </button>
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
  }
  .tm-composer__safe {
    padding-bottom: var(--tm-safe-bottom);
    background: var(--tm-color-bg);
  }
  .tm-composer__form {
    display: contents;
  }
  /* the session-long #send_form box: not rendered by this component, hence global */
  :global(.tm-composer) {
    border-top: var(--tm-border-width) solid var(--tm-color-border);
    padding: var(--tm-space-3) var(--tm-gutter);
    background: var(--tm-color-bg);
  }
  .tm-composer__inner {
    display: flex;
    align-items: flex-end;
    gap: var(--tm-space-2);
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
  /* theme CSS written for ST may give this id a display of its own */
  .tm-composer__unseen {
    display: none !important;
  }
  .tm-composer__side {
    display: flex;
    align-items: center;
    gap: var(--tm-space-1);
    flex: none;
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
  .tm-composer__icon:hover:not(:disabled) {
    background: var(--tm-color-surface-sunken);
    color: var(--tm-color-text);
  }
  .tm-composer__icon:disabled {
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
  .tm-composer__send:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .tm-composer__input {
    flex: 1;
    min-width: 0;
    min-height: var(--tm-composer-min-h);
    max-height: calc(var(--tm-composer-min-h) * 4);
    padding: var(--tm-space-3) var(--tm-space-4);
    border-radius: var(--tm-radius-lg);
    background: var(--tm-color-surface-sunken);
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
    box-shadow: inset 0 0 0 1px var(--tm-color-border-strong);
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
