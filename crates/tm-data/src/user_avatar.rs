//! User (persona) avatars in `User Avatars/` — ST `src/endpoints/avatars.js` (DEV_NOTES §9.24).

use std::path::{Path, PathBuf};

use crate::card::{avatar, sanitize_filename, CardError, AVATAR_HEIGHT, AVATAR_WIDTH};
use crate::layout::USER_AVATARS;

/// ST default/content `user-default.png` file name
pub const DEFAULT_USER_AVATAR: &str = "user-default.png";

fn dir(root: &Path) -> PathBuf {
    root.join(USER_AVATARS)
}

/// `/api/avatars/upload`: decode any image, apply the crop popup's rectangle when there is one,
/// else cover-crop to 512×768 when `resize` (`want_resize`, i.e. `!never_resize_avatars`), save as
/// `overwrite_name` or `<now_ms>.png`.
/// Returns the file name.
pub fn upload_user_avatar(
    root: &Path,
    image_path: &Path,
    resize: bool,
    overwrite_name: Option<&str>,
    now_ms: u128,
    crop: Option<&avatar::Crop>,
) -> Result<String, CardError> {
    let bytes = std::fs::read(image_path)?;
    let png = match crop {
        Some(c) => avatar::crop_resize(&bytes, c, resize),
        None => avatar::to_png(&bytes, resize.then_some((AVATAR_WIDTH, AVATAR_HEIGHT))),
    }
    .map_err(|e| CardError::Image(e.to_string()))?;
    let name = match overwrite_name.map(sanitize_filename) {
        Some(n) if !n.is_empty() => n,
        _ => format!("{now_ms}.png"),
    };
    let d = dir(root);
    std::fs::create_dir_all(&d)?;
    write_atomic(&d.join(&name), &png)?;
    Ok(name)
}

/// Copy an existing user avatar to a new file name (ST `duplicatePersona` re-uploads the image).
pub fn copy_user_avatar(root: &Path, from: &str, to: &str) -> Result<(), CardError> {
    let d = dir(root);
    let to = sanitize_filename(to);
    if to.is_empty() {
        return Err(CardError::InvalidName);
    }
    std::fs::copy(d.join(sanitize_filename(from)), d.join(to))?;
    Ok(())
}

/// First run: ST's content.log seeds `user-default.png`; we do the same when the folder has no PNG.
/// Returns true when the file was written.
pub fn seed_default_user_avatar(root: &Path, png: &[u8]) -> Result<bool, CardError> {
    let d = dir(root);
    std::fs::create_dir_all(&d)?;
    let has_png = std::fs::read_dir(&d)?.filter_map(|e| e.ok()).any(|e| {
        e.path()
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("png"))
    });
    if has_png {
        return Ok(false);
    }
    write_atomic(&d.join(DEFAULT_USER_AVATAR), png)?;
    Ok(true)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), CardError> {
    let tmp = path.with_extension("png.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_fn(w, h, |x, y| image::Rgba([x as u8, y as u8, 9, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn upload_copy_seed() {
        let root = std::env::temp_dir().join(format!("tm-ua-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("in.png");
        std::fs::write(&src, png(30, 10)).unwrap();

        assert!(seed_default_user_avatar(&root, &png(4, 4)).unwrap());
        assert!(root.join("User Avatars/user-default.png").exists());
        assert!(
            !seed_default_user_avatar(&root, &png(4, 4)).unwrap(),
            "folder already has a png"
        );

        let name = upload_user_avatar(&root, &src, true, None, 1700, None).unwrap();
        assert_eq!(name, "1700.png");
        let img = image::open(root.join("User Avatars").join(&name)).unwrap();
        assert_eq!((img.width(), img.height()), (512, 768));

        // sanitize-filename semantics: path separators dropped, the dots stay, file lands in the folder
        let name = upload_user_avatar(&root, &src, false, Some("../evil.png"), 1, None).unwrap();
        assert_eq!(name, "..evil.png");
        assert!(root.join("User Avatars").join(&name).exists());
        let img = image::open(root.join("User Avatars").join(&name)).unwrap();
        assert_eq!((img.width(), img.height()), (30, 10));

        copy_user_avatar(&root, "..evil.png", "copy.png").unwrap();
        assert!(root.join("User Avatars/copy.png").exists());
        assert!(upload_user_avatar(&root, &root.join("missing.jpg"), true, None, 2, None).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
