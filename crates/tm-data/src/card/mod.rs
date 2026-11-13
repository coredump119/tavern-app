//! Character card PNG I/O: read/write the `chara` (V2) and `ccv3` (V3) tEXt chunks exactly
//! the way SillyTavern's character-card-parser.js does. No image decoding — chunks are copied.

pub mod avatar;
mod png;

pub use avatar::{AVATAR_HEIGHT, AVATAR_WIDTH};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum CardError {
    #[error("png: {0}")]
    Png(#[from] png::PngError),
    #[error("no character data (chara/ccv3) in PNG")]
    NoCharacterData,
    #[error("character data is not valid base64/UTF-8: {0}")]
    Decode(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("image: {0}")]
    Image(String),
    #[error("name is empty after sanitizing")]
    InvalidName,
    #[error("invalid avatar file name: {0}")]
    InvalidAvatar(String),
}

#[derive(Debug, Serialize)]
pub struct CardText {
    /// Keyword as found (lower-cased).
    pub keyword: String,
    /// Decoded JSON text.
    pub json: String,
}

fn decode_b64_utf8(raw: &[u8]) -> Result<String, CardError> {
    let bytes = B64
        .decode(raw)
        .map_err(|e| CardError::Decode(e.to_string()))?;
    String::from_utf8(bytes).map_err(|e| CardError::Decode(e.to_string()))
}

/// Every `chara` / `ccv3` text chunk, decoded.
pub fn read_card_texts(png_bytes: &[u8]) -> Result<Vec<CardText>, CardError> {
    let mut out = Vec::new();
    for chunk in png::read_chunks(png_bytes)? {
        if chunk.kind != *b"tEXt" {
            continue;
        }
        let Some((keyword, text)) = png::split_text(&chunk.data) else {
            continue;
        };
        let keyword = keyword.to_ascii_lowercase();
        if keyword == "chara" || keyword == "ccv3" {
            out.push(CardText {
                json: decode_b64_utf8(text)?,
                keyword,
            });
        }
    }
    Ok(out)
}

/// ST `extractDataFromPng(data, identifier)`: the first `tEXt` chunk under `keyword`, base64-decoded.
/// `None` when the image carries no such chunk.
pub fn read_png_text(png_bytes: &[u8], keyword: &str) -> Result<Option<String>, CardError> {
    for chunk in png::read_chunks(png_bytes)? {
        if chunk.kind != *b"tEXt" {
            continue;
        }
        if let Some((found, text)) = png::split_text(&chunk.data) {
            if found == keyword {
                return decode_b64_utf8(text).map(Some);
            }
        }
    }
    Ok(None)
}

/// Character JSON: prefers `ccv3`, falls back to `chara` (same precedence as ST).
pub fn read_card_json(png_bytes: &[u8]) -> Result<String, CardError> {
    let texts = read_card_texts(png_bytes)?;
    texts
        .iter()
        .find(|t| t.keyword == "ccv3")
        .or_else(|| texts.iter().find(|t| t.keyword == "chara"))
        .map(|t| t.json.clone())
        .ok_or(CardError::NoCharacterData)
}

/// Replace character data: strips existing chara/ccv3, inserts `chara` = json and `ccv3` = json
/// with spec forced to chara_card_v3 / 3.0, both right before IEND. Image chunks are untouched.
pub fn write_card_json(png_bytes: &[u8], json: &str) -> Result<Vec<u8>, CardError> {
    let mut chunks: Vec<png::Chunk> = png::read_chunks(png_bytes)?
        .into_iter()
        .filter(|c| {
            if c.kind != *b"tEXt" {
                return true;
            }
            match png::split_text(&c.data) {
                Some((k, _)) => {
                    let k = k.to_ascii_lowercase();
                    k != "chara" && k != "ccv3"
                }
                None => true,
            }
        })
        .collect();
    let at = chunks
        .iter()
        .position(|c| c.kind == *b"IEND")
        .unwrap_or(chunks.len());

    let mut inserts = vec![png::text_chunk("chara", &B64.encode(json.as_bytes()))];
    if let Ok(mut v3) = serde_json::from_str::<serde_json::Value>(json) {
        if let Some(obj) = v3.as_object_mut() {
            obj.insert("spec".into(), "chara_card_v3".into());
            obj.insert("spec_version".into(), "3.0".into());
            let text = serde_json::to_string(&v3).expect("serialize card");
            inserts.push(png::text_chunk("ccv3", &B64.encode(text.as_bytes())));
        }
    }
    chunks.splice(at..at, inserts);
    Ok(png::write_chunks(&chunks))
}

pub fn read_card_file(path: &Path) -> Result<String, CardError> {
    read_card_json(&std::fs::read(path)?)
}

/// Write atomically: temp file beside the target, then rename.
pub fn write_card_file(path: &Path, json: &str) -> Result<(), CardError> {
    let bytes = write_card_json(&std::fs::read(path)?, json)?;
    let tmp = path.with_extension("png.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Import a card into `<root>/characters/`. Accepts a PNG with embedded character data or a bare
/// JSON card (V2/V3 object, or ST's flattened export); JSON cards are written into `default_avatar`.
/// The file is named after the character (sanitized) and never overwrites an existing card.
/// Returns the avatar file name (e.g. `Seraphina.png`).
pub fn import_card(root: &Path, src: &Path, default_avatar: &[u8]) -> Result<String, CardError> {
    let bytes = std::fs::read(src)?;
    let is_png = bytes.starts_with(&[0x89, b'P', b'N', b'G']);
    let (png_bytes, json) = if is_png {
        let json = read_card_json(&bytes)?;
        (bytes, json)
    } else {
        let text = String::from_utf8(bytes).map_err(|e| CardError::Decode(e.to_string()))?;
        // must at least be a JSON object
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| CardError::Decode(e.to_string()))?;
        if !value.is_object() {
            return Err(CardError::Decode("card JSON is not an object".into()));
        }
        (write_card_json(default_avatar, &text)?, text)
    };
    let name = serde_json::from_str::<serde_json::Value>(&json)
        .ok()
        .and_then(|v| {
            v.get("data")
                .and_then(|d| d.get("name"))
                .or_else(|| v.get("name"))
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
        })
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "character".to_string());
    let dir = root.join(crate::layout::CHARACTERS);
    std::fs::create_dir_all(&dir)?;
    let mut stem = sanitize_filename(&name);
    if stem.is_empty() {
        stem = "character".to_string();
    }
    let file = format!("{}.png", png_name(&dir, &stem));
    let tmp = dir.join(format!("{file}.tmp"));
    std::fs::write(&tmp, &png_bytes)?;
    std::fs::rename(&tmp, dir.join(&file))?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_png_and_json() {
        let root = std::env::temp_dir().join(format!("tm-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("src.png");
        std::fs::write(&src, FIXTURE).unwrap();
        let a = import_card(&root, &src, FIXTURE).unwrap();
        assert_eq!(a, "Seraphina.png");
        let b = import_card(&root, &src, FIXTURE).unwrap();
        assert_eq!(b, "Seraphina1.png");
        let json_src = root.join("card.json");
        std::fs::write(&json_src, r#"{"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"A/B:C","first_mes":"hi"}}"#).unwrap();
        let c = import_card(&root, &json_src, FIXTURE).unwrap();
        assert_eq!(c, "ABC.png");
        let back = read_card_file(&root.join("characters").join(&c)).unwrap();
        assert!(back.contains("\"first_mes\":\"hi\""));
        assert!(import_card(&root, &root.join("missing.png"), FIXTURE).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    const FIXTURE: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/formats/tests/fixtures/default_Seraphina.png"
    ));

    #[test]
    fn reads_both_chunks_and_prefers_ccv3() {
        let texts = read_card_texts(FIXTURE).unwrap();
        let mut kws: Vec<_> = texts.iter().map(|t| t.keyword.as_str()).collect();
        kws.sort();
        assert_eq!(kws, ["ccv3", "chara"]);
        let v: serde_json::Value = serde_json::from_str(&read_card_json(FIXTURE).unwrap()).unwrap();
        assert_eq!(v["spec"], "chara_card_v3");
        assert_eq!(v["data"]["name"], "Seraphina");
    }

    #[test]
    fn write_round_trip_keeps_image_and_json() {
        let json = read_card_json(FIXTURE).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        v["spec"] = "chara_card_v2".into();
        v["spec_version"] = "2.0".into();
        let out = write_card_json(FIXTURE, &serde_json::to_string(&v).unwrap()).unwrap();

        let before: Vec<_> = png::read_chunks(FIXTURE)
            .unwrap()
            .into_iter()
            .filter(|c| c.kind != *b"tEXt")
            .collect();
        let after: Vec<_> = png::read_chunks(&out)
            .unwrap()
            .into_iter()
            .filter(|c| c.kind != *b"tEXt")
            .collect();
        assert_eq!(before.len(), after.len());
        for (a, b) in before.iter().zip(after.iter()) {
            assert_eq!(a.kind, b.kind);
            assert_eq!(a.data, b.data);
        }
        let back: serde_json::Value = serde_json::from_str(&read_card_json(&out).unwrap()).unwrap();
        let orig: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(back, orig, "ccv3 chunk must equal the ST-shipped V3 JSON");
        // crc must validate: re-read fully
        assert!(png::read_chunks(&out).is_ok());
    }

    #[test]
    fn rejects_non_png_and_missing_data() {
        assert!(matches!(read_card_json(b"nope"), Err(CardError::Png(_))));
        // a PNG with only header + IEND
        let bare = png::write_chunks(&[
            png::Chunk {
                kind: *b"IHDR",
                data: vec![0; 13],
            },
            png::Chunk {
                kind: *b"IEND",
                data: vec![],
            },
        ]);
        assert!(matches!(
            read_card_json(&bare),
            Err(CardError::NoCharacterData)
        ));
    }
}

// ---- editing: ST /api/characters/{edit,delete,rename,duplicate} (DEV_NOTES §9.17) ----

fn truncate_utf8(s: &mut String, max_bytes: usize) {
    if s.len() > max_bytes {
        let mut end = max_bytes;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
}

/// npm `sanitize-filename` with an empty replacement — what ST's `sanitize()` does to names:
/// drops `/ ? < > \ : * | "`, C0 / C1 control characters, all-dot names, Windows reserved
/// device names, trailing dots and spaces; truncates to 255 UTF-8 bytes.
pub fn sanitize_filename(input: &str) -> String {
    let mut s: String = input
        .chars()
        .filter(|&c| {
            let code = c as u32;
            let illegal = matches!(c, '/' | '?' | '<' | '>' | '\\' | ':' | '*' | '|' | '"');
            let control = code <= 0x1f || (0x80..=0x9f).contains(&code);
            !(illegal || control)
        })
        .collect();
    if !s.is_empty() && s.chars().all(|c| c == '.') {
        s.clear();
    }
    {
        let lower = s.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or("");
        let reserved = matches!(stem, "con" | "prn" | "aux" | "nul")
            || (stem.len() == 4
                && (stem.starts_with("com") || stem.starts_with("lpt"))
                && stem.as_bytes()[3].is_ascii_digit());
        if reserved {
            s.clear();
        }
    }
    let keep = s.trim_end_matches(['.', ' ']).len();
    s.truncate(keep);
    truncate_utf8(&mut s, 255);
    s
}

/// ST `getPngName`: sanitized `base`, then `base1`, `base2`, … until no `<name>.png` exists in `dir`.
pub fn png_name(dir: &Path, name: &str) -> String {
    let base = sanitize_filename(name);
    for i in 0..10_000u32 {
        let candidate = if i == 0 {
            base.clone()
        } else {
            format!("{base}{i}")
        };
        if !dir.join(format!("{candidate}.png")).exists() {
            return candidate;
        }
    }
    base
}

fn check_avatar(avatar: &str) -> Result<(), CardError> {
    let ok = !avatar.is_empty()
        && avatar.to_ascii_lowercase().ends_with(".png")
        && !avatar.contains('/')
        && !avatar.contains('\\')
        && avatar != "."
        && avatar != "..";
    if ok {
        Ok(())
    } else {
        Err(CardError::InvalidAvatar(avatar.to_string()))
    }
}

fn not_found(what: &str) -> CardError {
    CardError::Io(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("{what} not found"),
    ))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), CardError> {
    let tmp = path.with_extension("png.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// `/api/characters/delete`: remove the PNG and, with `delete_chats`, the whole `chats/<stem>/`.
/// `/api/characters/export` with `format: 'png'`: the card PNG with ST's `unsetPrivateFields`
/// applied to the embedded JSON (`fav` / `data.extensions.fav` → false, `chat` removed).
pub fn export_card_png(root: &Path, avatar: &str, dest: &Path) -> Result<(), CardError> {
    check_avatar(avatar)?;
    let path = root.join(crate::layout::CHARACTERS).join(avatar);
    let bytes = std::fs::read(&path).map_err(|_| not_found(avatar))?;
    let json = read_card_json(&bytes)?;
    let mut v: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| CardError::Decode(e.to_string()))?;
    unset_private_fields(&mut v);
    let out = write_card_json(&bytes, &serde_json::to_string(&v).expect("serialize card"))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_atomic(dest, &out)
}

/// ST `unsetPrivateFields`
pub fn unset_private_fields(v: &mut serde_json::Value) {
    if let Some(obj) = v.as_object_mut() {
        obj.insert("fav".into(), serde_json::Value::Bool(false));
        obj.remove("chat");
        if let Some(data) = obj.get_mut("data").and_then(|d| d.as_object_mut()) {
            let ext = data
                .entry("extensions")
                .or_insert_with(|| serde_json::json!({}));
            if let Some(ext) = ext.as_object_mut() {
                ext.insert("fav".into(), serde_json::Value::Bool(false));
            }
        }
    }
}

/// Large copy of the avatar kept for the app's "avatar as chat background" option (not an ST
/// concept, but ST lists it as an ordinary background): `backgrounds/character-<stem>.png`.
pub fn background_copy_path(root: &Path, avatar: &str) -> std::path::PathBuf {
    let stem = avatar.rsplit_once('.').map(|(s, _)| s).unwrap_or(avatar);
    root.join(crate::layout::BACKGROUNDS)
        .join(format!("character-{stem}.png"))
}

/// Longest edge of the background copy (keeps phone memory and disk sane).
pub const BACKGROUND_MAX_EDGE: u32 = 2048;

pub fn delete_card(root: &Path, avatar: &str, delete_chats: bool) -> Result<(), CardError> {
    check_avatar(avatar)?;
    let path = root.join(crate::layout::CHARACTERS).join(avatar);
    if !path.exists() {
        return Err(not_found(avatar));
    }
    std::fs::remove_file(&path)?;
    let bg = background_copy_path(root, avatar);
    if bg.exists() {
        let _ = std::fs::remove_file(bg);
    }
    if delete_chats {
        let dir = crate::layout::chat_dir(root, avatar);
        if dir.exists() {
            std::fs::remove_dir_all(dir)?;
        }
    }
    Ok(())
}

/// `/api/characters/rename`: `name` + `data.name` → `new_name`, written to `png_name(new_name).png`
/// (image chunks untouched), `chats/<old>` moved to `chats/<new>` when the target is free, old PNG
/// removed. Returns the new avatar file name.
pub fn rename_card(root: &Path, avatar: &str, new_name: &str) -> Result<String, CardError> {
    check_avatar(avatar)?;
    if sanitize_filename(new_name).is_empty() {
        return Err(CardError::InvalidName);
    }
    let dir = root.join(crate::layout::CHARACTERS);
    let old_path = dir.join(avatar);
    let bytes = std::fs::read(&old_path).map_err(|_| not_found(avatar))?;
    let json = read_card_json(&bytes)?;
    let mut v: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| CardError::Decode(e.to_string()))?;
    let Some(obj) = v.as_object_mut() else {
        return Err(CardError::Decode("card JSON is not an object".into()));
    };
    obj.insert("name".into(), new_name.into());
    let data = obj.entry("data").or_insert_with(|| serde_json::json!({}));
    if !data.is_object() {
        *data = serde_json::json!({});
    }
    data.as_object_mut()
        .expect("object")
        .insert("name".into(), new_name.into());
    let new_internal = png_name(&dir, new_name);
    let new_avatar = format!("{new_internal}.png");
    let out = write_card_json(&bytes, &serde_json::to_string(&v).expect("serialize card"))?;
    write_atomic(&dir.join(&new_avatar), &out)?;
    let old_chats = crate::layout::chat_dir(root, avatar);
    let new_chats = crate::layout::chat_dir(root, &new_avatar);
    if old_chats.exists() && !new_chats.exists() {
        std::fs::rename(&old_chats, &new_chats)?;
    }
    let old_bg = background_copy_path(root, avatar);
    let new_bg = background_copy_path(root, &new_avatar);
    if old_bg.exists() && !new_bg.exists() {
        let _ = std::fs::rename(&old_bg, &new_bg);
    }
    std::fs::remove_file(&old_path)?;
    Ok(new_avatar)
}

/// `/api/characters/duplicate`: copy to `<base>_<n>.png` (a trailing `_<number>` is incremented,
/// otherwise `_1`), bumping `n` while the name is taken. Returns the new avatar file name.
pub fn duplicate_card(root: &Path, avatar: &str) -> Result<String, CardError> {
    check_avatar(avatar)?;
    let dir = root.join(crate::layout::CHARACTERS);
    let src = dir.join(avatar);
    if !src.exists() {
        return Err(not_found(avatar));
    }
    let ext_at = avatar.rfind('.').unwrap_or(avatar.len());
    let (stem, ext) = avatar.split_at(ext_at);
    let parts: Vec<&str> = stem.split('_').collect();
    let last = parts[parts.len() - 1].trim();
    let (base, mut suffix) = match last.parse::<i64>() {
        Ok(n) if parts.len() > 1 => (parts[..parts.len() - 1].join("_"), n + 1),
        _ => (parts.join("_"), 1),
    };
    let mut new_name = format!("{base}_{suffix}{ext}");
    while dir.join(&new_name).exists() {
        new_name = format!("{base}_{suffix}{ext}");
        suffix += 1;
    }
    std::fs::copy(&src, dir.join(&new_name))?;
    let bg = background_copy_path(root, avatar);
    if bg.exists() {
        let _ = std::fs::copy(&bg, background_copy_path(root, &new_name));
    }
    Ok(new_name)
}

/// `/api/characters/edit` with an avatar file: decode `image_path`, apply the crop popup's
/// rectangle when there is one (`avatar::crop_resize`), else cover-crop to 512×768 when `resize`
/// (`want_resize`, i.e. `!power_user.never_resize_avatars`), re-encode as PNG and embed the card's
/// current JSON. Atomic replace. The large copy keeps the uncropped picture.
pub fn replace_avatar(
    root: &Path,
    avatar: &str,
    image_path: &Path,
    resize: bool,
    keep_original: bool,
    crop: Option<&avatar::Crop>,
) -> Result<(), CardError> {
    check_avatar(avatar)?;
    let path = root.join(crate::layout::CHARACTERS).join(avatar);
    let json = read_card_file(&path)?;
    let image = std::fs::read(image_path)?;
    let png = match crop {
        Some(c) => avatar::crop_resize(&image, c, resize),
        None => avatar::to_png(&image, resize.then_some((AVATAR_WIDTH, AVATAR_HEIGHT))),
    }
    .map_err(|e| CardError::Image(e.to_string()))?;
    let out = write_card_json(&png, &json)?;
    write_atomic(&path, &out)?;
    if keep_original {
        let large = avatar::to_png_bounded(&image, BACKGROUND_MAX_EDGE)
            .map_err(|e| CardError::Image(e.to_string()))?;
        let bg = background_copy_path(root, avatar);
        if let Some(dir) = bg.parent() {
            std::fs::create_dir_all(dir)?;
        }
        write_atomic(&bg, &large)?;
    }
    Ok(())
}

#[cfg(test)]
mod edit_tests {
    use super::*;

    const FIXTURE: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/formats/tests/fixtures/default_Seraphina.png"
    ));

    #[test]
    fn reads_a_named_png_text_chunk() {
        use base64::Engine as _;
        let png = avatar::to_png_bounded(
            &{
                let mut out = std::io::Cursor::new(Vec::new());
                image::RgbaImage::new(2, 2)
                    .write_to(&mut out, image::ImageFormat::Png)
                    .unwrap();
                out.into_inner()
            },
            8,
        )
        .unwrap();
        let mut chunks = png::read_chunks(&png).unwrap();
        let end = chunks.pop().unwrap();
        chunks.push(png::text_chunk("other", &B64.encode("no")));
        chunks.push(png::text_chunk("naidata", &B64.encode(r#"{"entries":[]}"#)));
        chunks.push(end);
        let bytes = png::write_chunks(&chunks);
        assert_eq!(
            read_png_text(&bytes, "naidata").unwrap().as_deref(),
            Some(r#"{"entries":[]}"#)
        );
        assert_eq!(read_png_text(&bytes, "missing").unwrap(), None);
        assert!(read_png_text(b"not a png", "naidata").is_err());
    }

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("tm-edit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("characters")).unwrap();
        std::fs::write(root.join("characters/Seraphina.png"), FIXTURE).unwrap();
        root
    }

    #[test]
    fn sanitize_matches_npm_sanitize_filename() {
        assert_eq!(sanitize_filename("A/B:C"), "ABC");
        assert_eq!(sanitize_filename("a?b<c>d|e\"f*g"), "abcdefg");
        assert_eq!(sanitize_filename("con"), "");
        assert_eq!(sanitize_filename("CON.txt"), "");
        assert_eq!(sanitize_filename("com1"), "");
        assert_eq!(sanitize_filename("console"), "console");
        assert_eq!(sanitize_filename("..."), "");
        assert_eq!(sanitize_filename("name. . "), "name");
        assert_eq!(sanitize_filename("tab\there\u{85}x"), "tabherex");
        assert_eq!(sanitize_filename("  spaced  "), "  spaced");
        let long = "字".repeat(100); // 300 bytes
        let out = sanitize_filename(&long);
        assert_eq!(out.len(), 255);
        assert_eq!(out.chars().count(), 85);
    }

    #[test]
    fn png_name_increments_like_st() {
        let root = temp_root("pngname");
        let dir = root.join("characters");
        assert_eq!(png_name(&dir, "Seraphina"), "Seraphina1");
        assert_eq!(png_name(&dir, "Other"), "Other");
        std::fs::write(dir.join("Seraphina1.png"), b"x").unwrap();
        assert_eq!(png_name(&dir, "Sera/phina"), "Seraphina2");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_removes_png_and_optionally_chats() {
        let root = temp_root("delete");
        std::fs::create_dir_all(root.join("chats/Seraphina")).unwrap();
        std::fs::write(root.join("chats/Seraphina/a.jsonl"), b"{}\n").unwrap();
        assert!(delete_card(&root, "../x.png", true).is_err());
        assert!(delete_card(&root, "Missing.png", true).is_err());
        delete_card(&root, "Seraphina.png", false).unwrap();
        assert!(!root.join("characters/Seraphina.png").exists());
        assert!(root.join("chats/Seraphina/a.jsonl").exists());
        std::fs::write(root.join("characters/Seraphina.png"), FIXTURE).unwrap();
        delete_card(&root, "Seraphina.png", true).unwrap();
        assert!(!root.join("chats/Seraphina").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_rewrites_name_moves_chats_and_avoids_collisions() {
        let root = temp_root("rename");
        std::fs::create_dir_all(root.join("chats/Seraphina")).unwrap();
        std::fs::write(root.join("chats/Seraphina/a.jsonl"), b"{}\n").unwrap();
        std::fs::write(root.join("characters/Sera.png"), FIXTURE).unwrap();
        assert!(matches!(
            rename_card(&root, "Seraphina.png", "???"),
            Err(CardError::InvalidName)
        ));
        let new_avatar = rename_card(&root, "Seraphina.png", "Sera").unwrap();
        assert_eq!(new_avatar, "Sera1.png");
        assert!(!root.join("characters/Seraphina.png").exists());
        assert!(root.join("chats/Sera1/a.jsonl").exists());
        assert!(!root.join("chats/Seraphina").exists());
        let json: serde_json::Value =
            serde_json::from_str(&read_card_file(&root.join("characters/Sera1.png")).unwrap())
                .unwrap();
        assert_eq!(json["name"], "Sera");
        assert_eq!(json["data"]["name"], "Sera");
        assert!(json["data"]["description"].as_str().is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn duplicate_uses_underscore_suffixes() {
        let root = temp_root("dupe");
        assert_eq!(
            duplicate_card(&root, "Seraphina.png").unwrap(),
            "Seraphina_1.png"
        );
        assert_eq!(
            duplicate_card(&root, "Seraphina.png").unwrap(),
            "Seraphina_2.png"
        );
        assert_eq!(
            duplicate_card(&root, "Seraphina_2.png").unwrap(),
            "Seraphina_3.png"
        );
        assert_eq!(
            duplicate_card(&root, "Seraphina_3.png").unwrap(),
            "Seraphina_4.png"
        );
        assert!(duplicate_card(&root, "Nope.png").is_err());
        assert_eq!(
            read_card_file(&root.join("characters/Seraphina_4.png")).unwrap(),
            read_card_file(&root.join("characters/Seraphina.png")).unwrap()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn replace_avatar_keeps_json_and_resizes() {
        let root = temp_root("avatar");
        let img = image::RgbaImage::from_fn(30, 10, |x, _| image::Rgba([x as u8, 0, 0, 255]));
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut buf, image::ImageFormat::Jpeg)
            .unwrap();
        let src = root.join("new.jpg");
        std::fs::write(&src, buf.into_inner()).unwrap();
        let before = read_card_file(&root.join("characters/Seraphina.png")).unwrap();
        replace_avatar(&root, "Seraphina.png", &src, true, true, None).unwrap();
        let bg = background_copy_path(&root, "Seraphina.png");
        assert!(bg.exists(), "large copy written next to ST backgrounds");
        let big = image::load_from_memory(&std::fs::read(&bg).unwrap()).unwrap();
        assert_eq!(
            (big.width(), big.height()),
            (30, 10),
            "original size, not the 512×768 crop"
        );
        // rename / duplicate / delete carry the copy along
        let renamed = rename_card(&root, "Seraphina.png", "Sera").unwrap();
        assert!(!bg.exists());
        assert!(background_copy_path(&root, &renamed).exists());
        let dup = duplicate_card(&root, &renamed).unwrap();
        assert!(background_copy_path(&root, &dup).exists());
        delete_card(&root, &dup, false).unwrap();
        assert!(!background_copy_path(&root, &dup).exists());
        let back = rename_card(&root, &renamed, "Seraphina").unwrap();
        assert_eq!(back, "Seraphina.png");
        // export: same image, private fields stripped
        let dest = root.join("out/Seraphina.png");
        export_card_png(&root, "Seraphina.png", &dest).unwrap();
        let exported: serde_json::Value =
            serde_json::from_str(&read_card_file(&dest).unwrap()).unwrap();
        assert_eq!(exported["fav"], serde_json::Value::Bool(false));
        assert!(exported.get("chat").is_none());
        assert_eq!(
            exported["data"]["extensions"]["fav"],
            serde_json::Value::Bool(false)
        );
        assert_eq!(exported["data"]["name"], "Seraphina");
        let png = std::fs::read(root.join("characters/Seraphina.png")).unwrap();
        let dims = image::load_from_memory(&png).unwrap();
        assert_eq!((dims.width(), dims.height()), (512, 768));
        assert_eq!(read_card_json(&png).unwrap(), before);
        replace_avatar(&root, "Seraphina.png", &src, false, false, None).unwrap();
        let png = std::fs::read(root.join("characters/Seraphina.png")).unwrap();
        let dims = image::load_from_memory(&png).unwrap();
        assert_eq!((dims.width(), dims.height()), (30, 10));
        assert!(replace_avatar(
            &root,
            "Seraphina.png",
            &root.join("missing.jpg"),
            true,
            false,
            None
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
