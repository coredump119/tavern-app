/**
 * The avatar crop dialog (DEV_NOTES §9.37): one request at a time, drawn by `AvatarCropper.svelte`
 * (mounted once in App.svelte).
 */
import { withStagedPick } from './files';
import { imagePreview, type ImageCrop, type ImagePreview } from './ipc';

/** long edge of the picture shown in the dialog */
const PREVIEW_EDGE = 1024;

interface CropRequest {
  preview: ImagePreview;
  resolve(crop: ImageCrop | null): void;
}

class CropDialog {
  current = $state.raw<CropRequest | null>(null);

  /** Show the dialog for a picked image. Null when cancelled. Throws when the image cannot be read. */
  async ask(imagePath: string): Promise<ImageCrop | null> {
    const preview = await imagePreview(imagePath, PREVIEW_EDGE);
    this.current?.resolve(null);
    return new Promise((resolve) => {
      this.current = { preview, resolve };
    });
  }

  answer(crop: ImageCrop | null): void {
    const request = this.current;
    this.current = null;
    request?.resolve(crop);
  }
}

export const cropDialog = new CropDialog();

/**
 * Crop a picked image, then hand it to `use`; null when the dialog was dismissed. `use` reads a
 * staged copy: the dialog can stay open longer than the picker keeps its file.
 */
export function cropPicked<T>(
  imagePath: string,
  use: (image: string, crop: ImageCrop) => Promise<T>,
): Promise<T | null> {
  return withStagedPick(imagePath, async (image) => {
    const crop = await cropDialog.ask(image);
    return crop ? use(image, crop) : null;
  });
}

/**
 * ST character / persona avatars: no crop popup when `power_user.never_resize_avatars` (the
 * picture is stored as picked, `use` gets no crop). Null when the dialog was dismissed.
 */
export function cropForAvatar<T>(
  imagePath: string,
  settings: Record<string, unknown> | null,
  use: (image: string, crop: ImageCrop | undefined) => Promise<T>,
): Promise<T | null> {
  const pu = (settings?.['power_user'] as Record<string, unknown> | undefined) ?? {};
  return pu['never_resize_avatars'] ? use(imagePath, undefined) : cropPicked(imagePath, use);
}
