/**
 * Geometry of the avatar crop box (DEV_NOTES §9.37). Everything is in source-image pixels; the
 * component only converts pointer distances. No DOM here.
 */
import type { ImageCrop } from './ipc';

/** ST `POPUP_TYPE.CROP` default: `cropAspect ?? 2 / 3` */
export const AVATAR_ASPECT = 2 / 3;
/** smallest box, as a fraction of the largest one that fits */
export const MIN_CROP_FRACTION = 0.2;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The largest box of `aspect` (width / height) that fits a `width` × `height` image. */
export function maxCropSize(
  width: number,
  height: number,
  aspect = AVATAR_ASPECT,
): { width: number; height: number } {
  return width / height > aspect
    ? { width: height * aspect, height }
    : { width, height: width / aspect };
}

/** ST opens the cropper with `autoCropArea: 1`: the largest box, centred. */
export function initialCrop(width: number, height: number, aspect = AVATAR_ASPECT): ImageCrop {
  const size = maxCropSize(width, height, aspect);
  return { x: (width - size.width) / 2, y: (height - size.height) / 2, ...size };
}

/** Shift the box by (`dx`, `dy`), stopping at the image edges. */
export function moveCrop(
  crop: ImageCrop,
  width: number,
  height: number,
  dx: number,
  dy: number,
): ImageCrop {
  return {
    ...crop,
    x: clamp(crop.x + dx, 0, width - crop.width),
    y: clamp(crop.y + dy, 0, height - crop.height),
  };
}

/** Resize the box to `fraction` of the largest one, around its centre, kept inside the image. */
export function scaleCrop(
  crop: ImageCrop,
  width: number,
  height: number,
  fraction: number,
  aspect = AVATAR_ASPECT,
): ImageCrop {
  const max = maxCropSize(width, height, aspect);
  const f = clamp(fraction, MIN_CROP_FRACTION, 1);
  const size = { width: max.width * f, height: max.height * f };
  return {
    x: clamp(crop.x + crop.width / 2 - size.width / 2, 0, width - size.width),
    y: clamp(crop.y + crop.height / 2 - size.height / 2, 0, height - size.height),
    ...size,
  };
}

/** The box's size as a fraction of the largest one (what the size slider shows). */
export function cropFraction(
  crop: ImageCrop,
  width: number,
  height: number,
  aspect = AVATAR_ASPECT,
): number {
  return crop.width / maxCropSize(width, height, aspect).width;
}
