<script lang="ts">
  /**
   * Draws the avatar crop dialog (lib/crop.svelte.ts); mounted once. A fixed 2:3 box over the
   * picture: drag it to move, the slider sets its size (DEV_NOTES §9.37).
   */
  import Button from '@tm/ui/components/Button.svelte';
  import BottomSheet from './BottomSheet.svelte';
  import { cropDialog } from '../crop.svelte';
  import { cropFraction, initialCrop, MIN_CROP_FRACTION, moveCrop, scaleCrop } from '../crop';
  import type { ImageCrop } from '../ipc';

  const request = $derived(cropDialog.current);
  let crop = $state.raw<ImageCrop | null>(null);
  let stage = $state<HTMLElement | null>(null);
  /** last pointer position while dragging the box */
  let drag: { id: number; x: number; y: number } | null = null;

  $effect(() => {
    crop = request ? initialCrop(request.preview.width, request.preview.height) : null;
  });

  const percent = (part: number, whole: number) => `${(part / whole) * 100}%`;

  function onPointerDown(e: PointerEvent) {
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!request || !crop || !stage || drag?.id !== e.pointerId) return;
    const { width, height } = request.preview;
    // screen pixels → source pixels
    const scale = width / stage.clientWidth;
    crop = moveCrop(
      crop,
      width,
      height,
      (e.clientX - drag.x) * scale,
      (e.clientY - drag.y) * scale,
    );
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }

  function onPointerUp(e: PointerEvent) {
    if (drag?.id === e.pointerId) drag = null;
  }

  function setSize(value: string) {
    if (!request || !crop) return;
    const { width, height } = request.preview;
    crop = scaleCrop(crop, width, height, Number(value));
  }
</script>

{#if request && crop}
  {@const { width, height, dataUrl } = request.preview}
  <BottomSheet open system title="裁剪头像" onClose={() => cropDialog.answer(null)}>
    <div class="tm-crop">
      <div class="tm-crop__stage" bind:this={stage}>
        <img class="tm-crop__image" src={dataUrl} alt="" draggable="false" />
        <div
          class="tm-crop__box"
          role="presentation"
          style:left={percent(crop.x, width)}
          style:top={percent(crop.y, height)}
          style:width={percent(crop.width, width)}
          style:height={percent(crop.height, height)}
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointercancel={onPointerUp}
        ></div>
      </div>
      <label class="tm-crop__size">
        <span>选框大小</span>
        <input
          class="neo-range-slider tm-crop__range"
          type="range"
          min={MIN_CROP_FRACTION}
          max="1"
          step="0.01"
          value={cropFraction(crop, width, height)}
          oninput={(e) => setSize(e.currentTarget.value)}
        />
      </label>
      <p class="tm-crop__hint">拖动选框选择要保留的部分</p>
      <div class="tm-crop__actions">
        <Button variant="outline" onclick={() => cropDialog.answer(null)}>取消</Button>
        <Button variant="primary" onclick={() => cropDialog.answer(crop)}>确定</Button>
      </div>
    </div>
  </BottomSheet>
{/if}

<style>
  .tm-crop {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-3);
  }
  .tm-crop__stage {
    position: relative;
    align-self: center;
    overflow: hidden;
    border-radius: var(--tm-radius-sm);
    line-height: 0;
  }
  .tm-crop__image {
    display: block;
    max-width: 100%;
    max-height: 50dvh;
    user-select: none;
    -webkit-user-select: none;
    pointer-events: none;
  }
  /* everything outside the box is dimmed by the box's own spread shadow (the stage clips it) */
  .tm-crop__box {
    position: absolute;
    box-sizing: border-box;
    border: var(--tm-border-width) solid var(--tm-color-accent);
    box-shadow: 0 0 0 100vmax color-mix(in srgb, var(--tm-color-bg) 65%, transparent);
    touch-action: none;
    cursor: move;
  }
  .tm-crop__size {
    display: flex;
    align-items: center;
    gap: var(--tm-space-3);
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-secondary);
    white-space: nowrap;
  }
  .tm-crop__range {
    flex: 1;
    min-width: 0;
  }
  .tm-crop__hint {
    margin: 0;
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-secondary);
  }
  .tm-crop__actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--tm-space-2);
  }
</style>
