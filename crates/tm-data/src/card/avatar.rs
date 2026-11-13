//! Avatar images for character cards: decode whatever the picker handed us (png / jpeg / webp /
//! gif / bmp), optionally cover-crop to ST's 512×768 (Jimp `cover` semantics: scale up to cover,
//! crop centred), and re-encode as PNG so the card chunks can be embedded.

use image::{imageops::FilterType, DynamicImage, ImageFormat};

/// ST `src/constants.js`
pub const AVATAR_WIDTH: u32 = 512;
pub const AVATAR_HEIGHT: u32 = 768;

/// Decode `bytes`, optionally cover-resize to `(w, h)`, encode PNG.
pub fn to_png(bytes: &[u8], cover: Option<(u32, u32)>) -> Result<Vec<u8>, image::ImageError> {
    let img = image::load_from_memory(bytes)?;
    let img = match cover {
        Some((w, h)) => cover_resize(&img, w, h),
        None => img,
    };
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png)?;
    Ok(out.into_inner())
}

/// The crop popup's rectangle in source-image pixels (ST `Crop`; fractions are allowed).
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Jimp `crop`, with the rectangle rounded and kept inside the image.
fn crop_image(img: &DynamicImage, crop: &Crop) -> DynamicImage {
    let (iw, ih) = (img.width(), img.height());
    let x = (crop.x.round().max(0.0) as u32).min(iw.saturating_sub(1));
    let y = (crop.y.round().max(0.0) as u32).min(ih.saturating_sub(1));
    let w = (crop.width.round().max(1.0) as u32).min(iw - x).max(1);
    let h = (crop.height.round().max(1.0) as u32).min(ih - y).max(1);
    img.crop_imm(x, y, w, h)
}

fn encode_png(img: &DynamicImage) -> Result<Vec<u8>, image::ImageError> {
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png)?;
    Ok(out.into_inner())
}

/// ST `applyAvatarCropResize`: crop, then cover to 512×768 when `want_resize`, else keep the
/// cropped size. Encodes PNG.
pub fn crop_resize(
    bytes: &[u8],
    crop: &Crop,
    want_resize: bool,
) -> Result<Vec<u8>, image::ImageError> {
    let img = crop_image(&image::load_from_memory(bytes)?, crop);
    let img = if want_resize {
        cover_resize(&img, AVATAR_WIDTH, AVATAR_HEIGHT)
    } else {
        img
    };
    encode_png(&img)
}

/// JPEG has no alpha: paint over white first (ST `createThumbnail` fills the canvas white).
fn flatten_white(img: &DynamicImage) -> image::RgbImage {
    let rgba = img.to_rgba8();
    image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let a = u32::from(a);
        let mix = |c: u8| ((u32::from(c) * a + 255 * (255 - a) + 127) / 255) as u8;
        image::Rgb([mix(r), mix(g), mix(b)])
    })
}

fn encode_jpeg(img: &DynamicImage) -> Result<Vec<u8>, image::ImageError> {
    let mut out = std::io::Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(flatten_white(img)).write_to(&mut out, ImageFormat::Jpeg)?;
    Ok(out.into_inner())
}

/// ST `calculateThumbnailSize`: never enlarges; a landscape image is fitted by width, anything
/// else by height.
pub fn thumbnail_size(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w <= max_w && h <= max_h {
        return (w, h);
    }
    let aspect = f64::from(w) / f64::from(h);
    if w > h {
        (max_w, ((f64::from(max_w) / aspect).round() as u32).max(1))
    } else {
        (((f64::from(max_h) * aspect).round() as u32).max(1), max_h)
    }
}

/// ST group avatar: `uploadGroupAvatar` crops, then `createThumbnail(_, 200, 300)` → JPEG.
pub const GROUP_THUMB_WIDTH: u32 = 200;
pub const GROUP_THUMB_HEIGHT: u32 = 300;

pub fn group_thumbnail(bytes: &[u8], crop: Option<&Crop>) -> Result<Vec<u8>, image::ImageError> {
    let img = image::load_from_memory(bytes)?;
    let img = match crop {
        Some(c) => crop_image(&img, c),
        None => img,
    };
    let (w, h) = thumbnail_size(
        img.width(),
        img.height(),
        GROUP_THUMB_WIDTH,
        GROUP_THUMB_HEIGHT,
    );
    let img = if (w, h) == (img.width(), img.height()) {
        img
    } else {
        img.resize_exact(w, h, FilterType::Lanczos3)
    };
    encode_jpeg(&img)
}

/// What the crop popup shows: the source size plus a shrunk JPEG as a data URL (a picked file is
/// not readable from the webview, DEV_NOTES §9.37).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub width: u32,
    pub height: u32,
    pub data_url: String,
}

pub fn preview(bytes: &[u8], max_edge: u32) -> Result<Preview, image::ImageError> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let img = image::load_from_memory(bytes)?;
    let (width, height) = (img.width(), img.height());
    let small = if width.max(height) > max_edge {
        img.resize(max_edge, max_edge, FilterType::Triangle)
    } else {
        img
    };
    let jpeg = encode_jpeg(&small)?;
    Ok(Preview {
        width,
        height,
        data_url: format!("data:image/jpeg;base64,{}", STANDARD.encode(jpeg)),
    })
}

/// Decode `bytes` and encode PNG, shrinking (never enlarging) so the longest edge is ≤ `max_edge`.
pub fn to_png_bounded(bytes: &[u8], max_edge: u32) -> Result<Vec<u8>, image::ImageError> {
    let img = image::load_from_memory(bytes)?;
    let img = if img.width().max(img.height()) > max_edge {
        img.resize(max_edge, max_edge, FilterType::Lanczos3)
    } else {
        img
    };
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png)?;
    Ok(out.into_inner())
}

/// Jimp `cover({w, h})`: scale so the image covers the box, then crop the centre.
pub fn cover_resize(img: &DynamicImage, w: u32, h: u32) -> DynamicImage {
    if img.width() == w && img.height() == h {
        return img.clone();
    }
    let (iw, ih) = (img.width() as f64, img.height() as f64);
    let scale = (w as f64 / iw).max(h as f64 / ih);
    let rw = ((iw * scale).round() as u32).max(w);
    let rh = ((ih * scale).round() as u32).max(h);
    let resized = img.resize_exact(rw, rh, FilterType::Lanczos3);
    resized.crop_imm((rw - w) / 2, (rh - h) / 2, w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_fn(w, h, |x, y| {
            image::Rgba([(x * 20) as u8, (y * 10) as u8, 128, 255])
        });
        let mut out = std::io::Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(img)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn crop_then_resize_follows_st() {
        let src = tiny_png(40, 30);
        let crop = Crop {
            x: 10.4,
            y: 0.0,
            width: 20.0,
            height: 30.0,
        };
        let kept = image::load_from_memory(&crop_resize(&src, &crop, false).unwrap()).unwrap();
        assert_eq!((kept.width(), kept.height()), (20, 30));
        // x = 10 → the first kept pixel's red channel is 10 * 20
        assert_eq!(kept.to_rgba8().get_pixel(0, 0).0[0], 200);
        let sized = image::load_from_memory(&crop_resize(&src, &crop, true).unwrap()).unwrap();
        assert_eq!(
            (sized.width(), sized.height()),
            (AVATAR_WIDTH, AVATAR_HEIGHT)
        );
        // a rectangle hanging over the edge is pulled back inside
        let over = Crop {
            x: 35.0,
            y: 25.0,
            width: 50.0,
            height: 50.0,
        };
        let edge = image::load_from_memory(&crop_resize(&src, &over, false).unwrap()).unwrap();
        assert_eq!((edge.width(), edge.height()), (5, 5));
    }

    #[test]
    fn thumbnails_follow_st_sizes() {
        assert_eq!(thumbnail_size(100, 150, 200, 300), (100, 150));
        assert_eq!(thumbnail_size(400, 600, 200, 300), (200, 300));
        assert_eq!(thumbnail_size(600, 300, 200, 300), (200, 100));
        assert_eq!(thumbnail_size(300, 300, 200, 300), (300, 300));
        let jpeg = group_thumbnail(&tiny_png(400, 600), None).unwrap();
        assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
        let img = image::load_from_memory(&jpeg).unwrap();
        assert_eq!((img.width(), img.height()), (200, 300));
    }

    #[test]
    fn preview_reports_source_size() {
        let p = preview(&tiny_png(64, 32), 16).unwrap();
        assert_eq!((p.width, p.height), (64, 32));
        assert!(p.data_url.starts_with("data:image/jpeg;base64,/9j/"));
    }

    #[test]
    fn cover_resizes_to_avatar_box() {
        let src = tiny_png(10, 20);
        let out = to_png(&src, Some((AVATAR_WIDTH, AVATAR_HEIGHT))).unwrap();
        let img = image::load_from_memory(&out).unwrap();
        assert_eq!((img.width(), img.height()), (512, 768));
        // wide source: scaled by height then cropped horizontally
        let wide = tiny_png(100, 10);
        let img = image::load_from_memory(&to_png(&wide, Some((512, 768))).unwrap()).unwrap();
        assert_eq!((img.width(), img.height()), (512, 768));
        // no cover: dimensions untouched
        let img = image::load_from_memory(&to_png(&src, None).unwrap()).unwrap();
        assert_eq!((img.width(), img.height()), (10, 20));
        assert!(to_png(b"not an image", None).is_err());
        // bounded copy only shrinks
        let img =
            image::load_from_memory(&to_png_bounded(&tiny_png(300, 100), 150).unwrap()).unwrap();
        assert_eq!((img.width(), img.height()), (150, 50));
        let img = image::load_from_memory(&to_png_bounded(&src, 150).unwrap()).unwrap();
        assert_eq!((img.width(), img.height()), (10, 20));
    }
}
