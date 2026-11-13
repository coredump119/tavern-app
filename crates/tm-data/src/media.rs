//! Message media attachments in `user/images/<character>/` — ST `src/endpoints/images.js`
//! `/upload` (DEV_NOTES §9.30). Files are copied verbatim; the message stores the data-root
//! relative path with ST's leading slash (`/user/images/Sera/1731000000000_abc.png`).

use std::path::{Path, PathBuf};

use crate::card::{sanitize_filename, CardError};
use crate::layout::USER_IMAGES;

/// ST `MEDIA_EXTENSIONS` (constants.js) — what `/api/images/upload` accepts.
pub const MEDIA_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic", "heif", // images
    "mp4", "webm", "mov", "m4v", "mkv", "avi", // video
    "mp3", "ogg", "wav", "m4a", "aac", "flac", "opus", "weba", // audio
];

/// ST `getStringHash` (cyrb53) — the upload file name is `<now>_<hash(original name)>`.
pub fn string_hash(s: &str, seed: u32) -> u64 {
    let mut h1: u32 = 0xdead_beef ^ seed;
    let mut h2: u32 = 0x41c6_ce57 ^ seed;
    for ch in s.encode_utf16() {
        let ch = ch as u32;
        h1 = (h1 ^ ch).wrapping_mul(2_654_435_761);
        h2 = (h2 ^ ch).wrapping_mul(1_597_334_677);
    }
    h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2_246_822_507)
        ^ (h2 ^ (h2 >> 13)).wrapping_mul(3_266_489_909);
    h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2_246_822_507)
        ^ (h1 ^ (h1 >> 13)).wrapping_mul(3_266_489_909);
    (u64::from(h2 & 0x001f_ffff) << 32) | u64::from(h1)
}

fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
}

/// Copy `src` into `user/images/<sanitize(ch_name)>/<now_ms>_<hash(file_name)>.<ext>` and return the
/// data-root relative path with forward slashes. `file_name` is the original name (for the hash
/// and the extension when `src` has none).
pub fn save_media(
    root: &Path,
    ch_name: &str,
    src: &Path,
    file_name: &str,
    now_ms: u128,
) -> Result<String, CardError> {
    let ext = extension_of(src)
        .or_else(|| extension_of(Path::new(file_name)))
        .ok_or_else(|| CardError::Image("file has no extension".into()))?;
    if !MEDIA_EXTENSIONS.contains(&ext.as_str()) {
        return Err(CardError::Image(format!("unsupported media type: .{ext}")));
    }
    let folder = sanitize_filename(ch_name);
    let folder = if folder.is_empty() {
        "misc".to_string()
    } else {
        folder
    };
    let name = format!("{now_ms}_{}.{ext}", string_hash(file_name, 0));
    let dir: PathBuf = root.join(USER_IMAGES).join(&folder);
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(&name);
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::copy(src, &tmp)?;
    std::fs::rename(&tmp, &dest)?;
    // ST clientRelativePath: root-relative with a leading slash
    Ok(format!("/{USER_IMAGES}/{folder}/{name}"))
}

/// What `save_media_base64` refuses, with ST's reply text for each.
#[derive(Debug, thiserror::Error)]
pub enum UploadError {
    #[error("No image data provided")]
    NoData,
    #[error("Invalid image format")]
    Format,
    #[error("Failed to save the image")]
    Io(#[from] std::io::Error),
}

/// ST `/api/images/upload` as an extension calls it: a base64 body under a name the caller picks.
/// Lands in `user/images/[<ch_name>/]<file_name without extension | now_ms>.<format>`; returns the
/// data-root relative path with a leading slash.
pub fn save_media_base64(
    root: &Path,
    ch_name: Option<&str>,
    file_name: Option<&str>,
    format: &str,
    image: &str,
    now_ms: u128,
) -> Result<String, UploadError> {
    use base64::engine::{general_purpose, DecodePaddingMode, GeneralPurpose};
    use base64::{alphabet, Engine as _};
    // Node's `Buffer.from(_, 'base64')` takes padded and unpadded input alike
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &alphabet::STANDARD,
        general_purpose::PAD.with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );

    if !MEDIA_EXTENSIONS.contains(&format) {
        return Err(UploadError::Format);
    }
    let compact: String = image.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = LENIENT.decode(compact).map_err(|_| UploadError::NoData)?;
    if bytes.is_empty() {
        return Err(UploadError::NoData);
    }

    // ST `removeFileExtension`: drop the last `.xyz`
    let stem = file_name
        .map(|name| name.rfind('.').map_or(name, |dot| &name[..dot]))
        .map(sanitize_filename)
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| now_ms.to_string());
    let name = format!("{stem}.{format}");
    let folder = ch_name.map(sanitize_filename).filter(|f| !f.is_empty());

    Ok(write_named(root, folder.as_deref(), &name, &bytes)?)
}

/// Write `bytes` as `user/images/[<folder>/]<name>` (both already sanitized); returns the
/// data-root relative path with a leading slash.
fn write_named(
    root: &Path,
    folder: Option<&str>,
    name: &str,
    bytes: &[u8],
) -> std::io::Result<String> {
    let mut dir: PathBuf = root.join(USER_IMAGES);
    if let Some(folder) = folder {
        dir.push(folder);
    }
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, dir.join(name))?;
    Ok(match folder {
        Some(folder) => format!("/{USER_IMAGES}/{folder}/{name}"),
        None => format!("/{USER_IMAGES}/{name}"),
    })
}

/// One file of a `user/images/<folder>/` listing.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
    pub name: String,
    /// modification time, ms since the epoch (ST sorts a listing by `mtimeMs`)
    pub mtime_ms: u64,
}

/// ST `/api/images/list`: the files directly inside `user/images/<sanitize(folder)>/`, in no
/// particular order. A folder that is not there lists as empty.
pub fn list_media(root: &Path, folder: &str) -> Vec<MediaEntry> {
    let folder = sanitize_filename(folder);
    if folder.is_empty() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(root.join(USER_IMAGES).join(folder)) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            // `.tmp` is a write in progress (`write_named`)
            if !meta.is_file() || name.ends_with(".tmp") {
                return None;
            }
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            Some(MediaEntry { name, mtime_ms })
        })
        .collect()
}

/// ST `/api/images/folders`: the folders directly inside `user/images/`, sorted.
pub fn list_media_folders(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root.join(USER_IMAGES)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// What `delete_media` did; the three answers ST's `/api/images/delete` gives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Removal {
    /// the path does not point inside `user/images/`
    Invalid,
    Missing,
    Removed,
}

/// ST `/api/images/delete`: `rel` is data-root relative (leading slash optional) and has to stay
/// inside `user/images/`.
pub fn delete_media(root: &Path, rel: &str) -> std::io::Result<Removal> {
    let inside = rel
        .trim_start_matches('/')
        .strip_prefix(USER_IMAGES)
        .and_then(|rest| rest.strip_prefix('/'));
    let Some(inside) = inside else {
        return Ok(Removal::Invalid);
    };
    let stays_inside = !inside.contains('\\')
        && inside
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if !stays_inside {
        return Ok(Removal::Invalid);
    }
    let path = root.join(USER_IMAGES).join(inside);
    if !path.is_file() {
        return Ok(Removal::Missing);
    }
    std::fs::remove_file(path)?;
    Ok(Removal::Removed)
}

/// ST `uploadGroupAvatar`: crop, shrink to the 200×300 thumbnail, save as JPEG under
/// `user/images/<group id>/<file_name>.jpg` (dots in the name become `_`, as `saveBase64AsFile`
/// does). Returns the path stored in the group's `avatar_url`.
pub fn save_group_avatar(
    root: &Path,
    group_id: &str,
    file_name: &str,
    image_path: &Path,
    crop: Option<&crate::card::avatar::Crop>,
) -> Result<String, CardError> {
    let folder = sanitize_filename(group_id);
    let stem = sanitize_filename(&file_name.replace('.', "_"));
    if folder.is_empty() || stem.is_empty() {
        return Err(CardError::InvalidName);
    }
    let jpeg = crate::card::avatar::group_thumbnail(&std::fs::read(image_path)?, crop)
        .map_err(|e| CardError::Image(e.to_string()))?;
    Ok(write_named(
        root,
        Some(&folder),
        &format!("{stem}.jpg"),
        &jpeg,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_avatar_is_a_jpeg_thumbnail_in_the_group_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let src = root.join("pick.png");
        let img = image::RgbaImage::from_pixel(400, 600, image::Rgba([10, 20, 30, 255]));
        img.save(&src).unwrap();
        let crop = crate::card::avatar::Crop {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 300.0,
        };
        let path = save_group_avatar(
            root,
            "1700000000000",
            "1700000000000_2026-11-12@10h.20m",
            &src,
            Some(&crop),
        )
        .unwrap();
        assert_eq!(
            path,
            format!("/{USER_IMAGES}/1700000000000/1700000000000_2026-11-12@10h_20m.jpg")
        );
        let saved = image::open(root.join(path.trim_start_matches('/'))).unwrap();
        assert_eq!((saved.width(), saved.height()), (200, 300));
        assert!(save_group_avatar(root, "..", "x", &src, None).is_err());
    }

    #[test]
    fn base64_upload_follows_st_naming() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // "hi" with and without padding
        let named = save_media_base64(root, Some("Sera"), Some("shot.jpeg"), "png", "aGk=", 7);
        assert_eq!(named.unwrap(), format!("/{USER_IMAGES}/Sera/shot.png"));
        assert_eq!(
            std::fs::read(root.join(USER_IMAGES).join("Sera/shot.png")).unwrap(),
            b"hi"
        );
        let bare = save_media_base64(root, None, None, "webp", "aGk", 7).unwrap();
        assert_eq!(bare, format!("/{USER_IMAGES}/7.webp"));

        let format = save_media_base64(root, None, None, "exe", "aGk=", 7);
        assert!(matches!(format, Err(UploadError::Format)));
        let empty = save_media_base64(root, None, None, "png", "", 7);
        assert!(matches!(empty, Err(UploadError::NoData)));
        let junk = save_media_base64(root, None, None, "png", "data:image/png;base64,aGk=", 7);
        assert!(matches!(junk, Err(UploadError::NoData)));
    }

    #[test]
    fn hash_matches_st_cyrb53() {
        // reference values from ST utils.js getStringHash (cyrb53, seed 0)
        assert_eq!(string_hash("hello", 0), 4_625_896_200_565_286);
        assert_eq!(string_hash("", 0), 3_338_908_027_751_811);
        assert_eq!(string_hash("pic.PNG", 0), 6_779_839_543_807_858);
    }

    #[test]
    fn saves_under_character_folder_with_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("pic.PNG");
        std::fs::write(&src, b"\x89PNG").unwrap();
        let rel = save_media(dir.path(), "Sera/Phina", &src, "pic.PNG", 42).unwrap();
        assert_eq!(
            rel,
            format!(
                "/user/images/SeraPhina/42_{}.png",
                string_hash("pic.PNG", 0)
            )
        );
        let on_disk = dir.path().join(rel.trim_start_matches('/'));
        assert_eq!(std::fs::read(on_disk).unwrap(), b"\x89PNG");
        let bad = dir.path().join("x.exe");
        std::fs::write(&bad, b"MZ").unwrap();
        assert!(save_media(dir.path(), "S", &bad, "x.exe", 1).is_err());
    }

    #[test]
    fn listing_and_deleting_stay_inside_user_images() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_named(root, Some("box"), "a.png", b"1").unwrap();
        write_named(root, Some("box"), "b.mp4", b"2").unwrap();
        std::fs::write(root.join(USER_IMAGES).join("box").join("c.png.tmp"), b"3").unwrap();
        std::fs::create_dir_all(root.join(USER_IMAGES).join("box").join("nested")).unwrap();
        std::fs::write(root.join("settings.json"), b"{}").unwrap();

        let mut names: Vec<String> = list_media(root, "box")
            .into_iter()
            .map(|e| e.name)
            .collect();
        names.sort();
        assert_eq!(names, ["a.png", "b.mp4"]);
        assert!(list_media(root, "box").iter().all(|e| e.mtime_ms > 0));
        assert!(list_media(root, "nowhere").is_empty());
        assert!(list_media(root, "../..").is_empty());
        assert_eq!(list_media_folders(root), ["box"]);

        for bad in [
            "settings.json",
            "user/images",
            "user/images/",
            "user/images/../../settings.json",
            "user/images/box/../../../settings.json",
            "user/images/box\\..\\a.png",
            "user/imagesX/a.png",
        ] {
            assert_eq!(delete_media(root, bad).unwrap(), Removal::Invalid, "{bad}");
        }
        assert!(root.join("settings.json").is_file());
        assert_eq!(
            delete_media(root, "user/images/box/zzz.png").unwrap(),
            Removal::Missing
        );
        assert_eq!(
            delete_media(root, "user/images/box/nested").unwrap(),
            Removal::Missing
        );
        assert_eq!(
            delete_media(root, "/user/images/box/a.png").unwrap(),
            Removal::Removed
        );
        assert_eq!(
            delete_media(root, "user/images/box/b.mp4").unwrap(),
            Removal::Removed
        );
        assert!(list_media(root, "box").is_empty());
    }
}
