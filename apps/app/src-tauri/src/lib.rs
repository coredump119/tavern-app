//! Tauri entry: thin command wrappers over `tm_data` (files, index, archive, extensions),
//! `tm_net`, `tm_keys` and `tm_tokenizers` (DEV_NOTES §2).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::Manager;
use tm_data::{archive, card, chat, content, crashlog, extensions, index, layout, seal, settings};
use tm_keys::{SecretBackend, SecretMeta, SecretRef, SecretVault};
use tm_net::{CancellationToken, FetchRequest, FetchResponse, GenEvent, GenerateRequest};
use tm_tokenizers::{EncodeResult, TokenizerService, LOCAL_TOKENIZER_NAMES};
mod background;
mod ext_host;
mod helper_realm;
#[cfg(target_os = "ios")]
mod ios_layout;

use serde::Serialize;

#[derive(Serialize)]
pub struct PingResponse {
    app: &'static str,
    version: &'static str,
    platform: &'static str,
}

#[tauri::command]
fn ping() -> PingResponse {
    PingResponse {
        app: "tavern-mobile",
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    }
}

/// Read the character JSON (ccv3 preferred) from a card PNG.
#[tauri::command]
fn card_read(path: String) -> Result<String, String> {
    card::read_card_file(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

/// Create a new chat jsonl (header + first messages). Rust `chat::create_chat`.
#[tauri::command]
fn chat_create(path: String, lines: Vec<String>) -> Result<(), String> {
    chat::create_chat(std::path::Path::new(&path), &lines).map_err(|e| e.to_string())
}

/// A path from the dialog plugin: on iOS it can arrive as a `file://` URL (percent-encoded);
/// desktop gives a plain path. Returns something `std::fs` can open.
fn picked_path(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("file://") {
        let rest = rest.strip_prefix("localhost").unwrap_or(rest);
        return PathBuf::from(percent_decode(rest));
    }
    PathBuf::from(raw)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Folder under the system temp dir for our own copies of picked files (DEV_NOTES §9.37).
const PICKED_STAGE_DIR: &str = "tm-picked";

fn picked_stage_dir() -> PathBuf {
    std::env::temp_dir().join(PICKED_STAGE_DIR)
}

/// Copy `src` to `<dir>/<stamp>/<file name>`. The name is kept: importers read it.
fn stage_picked(dir: &Path, src: &Path, stamp: u64) -> std::io::Result<PathBuf> {
    let name = src
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    let slot = dir.join(stamp.to_string());
    std::fs::create_dir_all(&slot)?;
    let dest = slot.join(name);
    std::fs::copy(src, &dest)?;
    Ok(dest)
}

/// Remove a staged copy together with its slot folder. Anything that is not
/// `<dir>/<digits>/<name>` is left alone.
fn unstage_picked(dir: &Path, staged: &Path) -> std::io::Result<()> {
    let Some(slot) = staged.parent() else {
        return Ok(());
    };
    let is_slot = slot.parent() == Some(dir)
        && slot
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    if is_slot {
        std::fs::remove_dir_all(slot)
    } else {
        Ok(())
    }
}

/// Keep a picked file readable while the user is asked something: the iOS document picker deletes
/// its copy about a minute after the pick (DEV_NOTES §9.37). Returns the path of our copy.
#[tauri::command]
async fn picked_stage(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stage_picked(&picked_stage_dir(), &picked_path(&path), now_millis())
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove a copy made by `picked_stage`.
#[tauri::command]
fn picked_unstage(path: String) -> Result<(), String> {
    unstage_picked(&picked_stage_dir(), Path::new(&path)).map_err(|e| e.to_string())
}

/// Read a picked file as UTF-8 text (chat import, text attachments). Refuses files over
/// `max_bytes` and anything that is not valid UTF-8 (ST treats those as binary).
#[tauri::command]
fn file_read_text(path: String, max_bytes: u64) -> Result<String, String> {
    let p = picked_path(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("{e} ({})", p.display()))?;
    if meta.len() > max_bytes {
        return Err(format!("file too large: {} bytes", meta.len()));
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "not a UTF-8 text file".to_string())
}

/// Import a character card (PNG with embedded JSON, or a bare JSON card) into `<root>/characters/`.
/// Returns the avatar file name. JSON cards get the bundled default avatar. Never overwrites.
#[tauri::command]
fn card_import(root: String, path: String) -> Result<String, String> {
    const DEFAULT_AVATAR: &[u8] = include_bytes!("../assets/default-avatar.png");
    card::import_card(
        std::path::Path::new(&root),
        &picked_path(&path),
        DEFAULT_AVATAR,
    )
    .map_err(|e| e.to_string())
}

/// Write character JSON into an existing card PNG (atomic replace).
#[tauri::command]
fn card_write(path: String, json: String) -> Result<(), String> {
    card::write_card_file(std::path::Path::new(&path), &json).map_err(|e| e.to_string())
}

/// Delete a character PNG and, with `delete_chats`, its `chats/<stem>/` folder (ST /api/characters/delete).
#[tauri::command]
fn card_delete(root: String, avatar: String, delete_chats: bool) -> Result<(), String> {
    card::delete_card(Path::new(&root), &avatar, delete_chats).map_err(|e| e.to_string())
}

/// Rename a character (name + data.name, new PNG file, chats folder moved). Returns the new avatar.
#[tauri::command]
fn card_rename(root: String, avatar: String, new_name: String) -> Result<String, String> {
    card::rename_card(Path::new(&root), &avatar, &new_name).map_err(|e| e.to_string())
}

/// Copy a card to `<base>_<n>.png` (ST /api/characters/duplicate). Returns the new avatar.
#[tauri::command]
fn card_duplicate(root: String, avatar: String) -> Result<String, String> {
    card::duplicate_card(Path::new(&root), &avatar).map_err(|e| e.to_string())
}

/// Replace the card image (optionally cover-cropped to 512×768) keeping the embedded JSON.
#[tauri::command]
fn card_avatar_replace(
    root: String,
    avatar: String,
    image_path: String,
    resize: bool,
    keep_original: bool,
    crop: Option<card::avatar::Crop>,
) -> Result<(), String> {
    card::replace_avatar(
        Path::new(&root),
        &avatar,
        &picked_path(&image_path),
        resize,
        keep_original,
        crop.as_ref(),
    )
    .map_err(|e| e.to_string())
}

/// What the crop popup shows for a picked image: source size + a shrunk JPEG data URL
/// (DEV_NOTES §9.37). Decoding a large photo takes a while, so off the main thread.
#[tauri::command]
async fn image_preview(image_path: String, max_edge: u32) -> Result<card::avatar::Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(picked_path(&image_path)).map_err(|e| e.to_string())?;
        card::avatar::preview(&bytes, max_edge.clamp(64, 2048)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ST `uploadGroupAvatar`: cropped 200×300 JPEG thumbnail under `user/images/<group id>/`;
/// returns the path for the group's `avatar_url`.
#[tauri::command]
fn group_avatar_upload(
    root: String,
    group_id: String,
    file_name: String,
    image_path: String,
    crop: Option<card::avatar::Crop>,
) -> Result<String, String> {
    tm_data::media::save_group_avatar(
        Path::new(&root),
        &group_id,
        &file_name,
        &picked_path(&image_path),
        crop.as_ref(),
    )
    .map_err(|e| e.to_string())
}

/// ST `extractDataFromPng(buffer, keyword)` for a picked file: the base64-decoded text of the
/// first `tEXt` chunk under `keyword` (a NovelAI lorebook image carries `naidata`), or null.
#[tauri::command]
fn png_text_read(path: String, keyword: String, max_bytes: u64) -> Result<Option<String>, String> {
    let p = picked_path(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("{e} ({})", p.display()))?;
    if meta.len() > max_bytes {
        return Err(format!("file too large: {} bytes", meta.len()));
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    card::read_png_text(&bytes, &keyword).map_err(|e| e.to_string())
}

/// ST `/api/avatars/upload`: user (persona) avatar into `User Avatars/`; returns the file name.
#[tauri::command]
fn user_avatar_upload(
    root: String,
    image_path: String,
    resize: bool,
    overwrite_name: Option<String>,
    crop: Option<card::avatar::Crop>,
) -> Result<String, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    tm_data::user_avatar::upload_user_avatar(
        Path::new(&root),
        &picked_path(&image_path),
        resize,
        overwrite_name.as_deref(),
        now,
        crop.as_ref(),
    )
    .map_err(|e| e.to_string())
}

/// ST `/api/images/upload`: copy a picked media file into `user/images/<character>/`;
/// returns the data-root relative path the message stores (DEV_NOTES §9.30).
#[tauri::command]
fn media_upload(
    root: String,
    ch_name: String,
    src_path: String,
    file_name: String,
) -> Result<String, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let src = picked_path(&src_path);
    tm_data::media::save_media(Path::new(&root), &ch_name, &src, &file_name, now)
        .map_err(|e| format!("{e} ({})", src.display()))
}

/// ST `/api/backgrounds/upload`: copy a picked image into `backgrounds/`; returns the stored
/// file name (DEV_NOTES §9.42).
#[tauri::command]
fn background_upload(root: String, src_path: String, file_name: String) -> Result<String, String> {
    let src = picked_path(&src_path);
    tm_data::media::save_background(Path::new(&root), &src, &file_name)
        .map_err(|e| format!("{e} ({})", src.display()))
}

/// ST `/api/images/upload` as an extension calls it: base64 body, caller-chosen name
/// (DEV_NOTES §9.34 第 4 轮). The error text is ST's.
#[tauri::command]
async fn media_upload_base64(
    root: String,
    ch_name: Option<String>,
    file_name: Option<String>,
    format: String,
    image: String,
) -> Result<String, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || {
        tm_data::media::save_media_base64(
            Path::new(&root),
            ch_name.as_deref(),
            file_name.as_deref(),
            &format,
            &image,
            now,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ST `/api/images/list`: the files of one `user/images/<folder>/` with their modification times
/// (DEV_NOTES §9.34 第 12 轮).
#[tauri::command]
fn media_list(root: String, folder: String) -> Vec<tm_data::media::MediaEntry> {
    tm_data::media::list_media(Path::new(&root), &folder)
}

/// ST `/api/images/folders`: the folders inside `user/images/`.
#[tauri::command]
fn media_folders(root: String) -> Vec<String> {
    tm_data::media::list_media_folders(Path::new(&root))
}

/// ST `/api/images/delete`: delete one file under `user/images/`; says what happened
/// (`removed` / `missing` / `invalid`).
#[tauri::command]
fn media_delete(root: String, rel: String) -> Result<&'static str, String> {
    use tm_data::media::Removal;
    tm_data::media::delete_media(Path::new(&root), &rel)
        .map(|done| match done {
            Removal::Removed => "removed",
            Removal::Missing => "missing",
            Removal::Invalid => "invalid",
        })
        .map_err(|e| e.to_string())
}

/// ST duplicatePersona re-uploads the same image under the new id.
#[tauri::command]
fn user_avatar_copy(root: String, from: String, to: String) -> Result<(), String> {
    tm_data::user_avatar::copy_user_avatar(Path::new(&root), &from, &to).map_err(|e| e.to_string())
}

/// First run: seed ST's `user-default.png` when `User Avatars/` has no PNG yet.
#[tauri::command]
fn user_avatar_seed_default(root: String) -> Result<bool, String> {
    const USER_DEFAULT: &[u8] = include_bytes!("../assets/user-default.png");
    tm_data::user_avatar::seed_default_user_avatar(Path::new(&root), USER_DEFAULT)
        .map_err(|e| e.to_string())
}

/// ST renamePastChats: rewrite the character `name` in every chat of `avatar`. Returns files touched.
#[tauri::command]
fn chat_rename_character(root: String, avatar: String, new_name: String) -> Result<usize, String> {
    chat::rename_character(Path::new(&root), &avatar, &new_name).map_err(|e| e.to_string())
}

/// A path relative to the data root that stays inside it and away from private files.
fn guarded_rel(root: &str, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        })
        || layout::is_private_path(rel_path)
    {
        return Err(format!("refused path: {rel}"));
    }
    Ok(Path::new(root).join(rel_path))
}

/// Write a UTF-8 text file inside the data root (presets, worlds…), creating the parent directory.
/// Atomic (temp + rename). Same path guard as `data_read_text`.
#[tauri::command]
fn data_write_text(root: String, rel: String, text: String) -> Result<(), String> {
    let path = guarded_rel(&root, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    std::fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Delete one file inside the data root. Directories and private files are refused.
#[tauri::command]
fn data_delete(root: String, rel: String) -> Result<(), String> {
    let path = guarded_rel(&root, &rel)?;
    if !path.is_file() {
        return Err(format!("not a file: {rel}"));
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Rename / move a file inside the data root (chat files; `/api/chats/rename`). Refuses to overwrite.
#[tauri::command]
fn data_rename(root: String, from: String, to: String) -> Result<(), String> {
    let src = guarded_rel(&root, &from)?;
    let dst = guarded_rel(&root, &to)?;
    if !src.is_file() {
        return Err(format!("not a file: {from}"));
    }
    if dst.exists() {
        return Err(format!("already exists: {to}"));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())
}

/// Where exports land when there is no save dialog (iOS / Android): Downloads, else the app's
/// Documents folder (iOS: visible in Files once UIFileSharingEnabled is set), else `<data>/../exports`.
#[tauri::command]
fn export_dir(app: tauri::AppHandle) -> Result<String, String> {
    let p = app.path();
    let dir = if cfg!(target_os = "ios") {
        p.document_dir().map_err(|e| e.to_string())?
    } else {
        p.download_dir()
            .or_else(|_| p.document_dir())
            .or_else(|_| p.app_data_dir().map(|d| d.join("exports")))
            .map_err(|e| e.to_string())?
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// A destination chosen by the user (dialog or export_dir) must not point back into the data root.
fn guard_export_dest(app: &tauri::AppHandle, dest: &str) -> Result<PathBuf, String> {
    let dest = PathBuf::from(dest);
    if !dest.is_absolute() {
        return Err("export path must be absolute".into());
    }
    if let Ok(data) = app.path().app_data_dir() {
        if dest.starts_with(&data) {
            return Err("refused: export path inside the app data directory".into());
        }
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(dest)
}

/// Does an export destination already exist? (mobile picks `name (2).ext` instead of overwriting)
#[tauri::command]
fn export_exists(dest: String) -> bool {
    Path::new(&dest).exists()
}

#[tauri::command]
fn export_write_text(app: tauri::AppHandle, dest: String, text: String) -> Result<(), String> {
    let dest = guard_export_dest(&app, &dest)?;
    std::fs::write(&dest, text).map_err(|e| e.to_string())
}

/// Copy a file from inside the data root (chat jsonl, backup zip, …) to an export destination.
#[tauri::command]
fn export_copy(app: tauri::AppHandle, src: String, dest: String) -> Result<(), String> {
    let dest = guard_export_dest(&app, &dest)?;
    std::fs::copy(Path::new(&src), &dest)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// `/api/characters/export` png: card copy with private fields unset.
#[tauri::command]
fn card_export_png(
    app: tauri::AppHandle,
    root: String,
    avatar: String,
    dest: String,
) -> Result<(), String> {
    let dest = guard_export_dest(&app, &dest)?;
    card::export_card_png(Path::new(&root), &avatar, &dest).map_err(|e| e.to_string())
}

/// File names in a data-root subdirectory (`worlds`, `OpenAI Settings`, …), optionally filtered by
/// extension (without the dot), sorted case-insensitively. Missing directory ⇒ empty list.
#[tauri::command]
fn data_list(root: String, rel: String, ext: Option<String>) -> Result<Vec<String>, String> {
    let dir = guarded_rel(&root, &rel)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let want = ext.map(|e| e.trim_start_matches('.').to_ascii_lowercase());
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.') && !n.ends_with(".tmp"))
        .filter(|n| match &want {
            Some(w) => Path::new(n)
                .extension()
                .map(|x| x.to_string_lossy().to_ascii_lowercase() == *w)
                .unwrap_or(false),
            None => true,
        })
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    Ok(names)
}

/// First-run default content (ST default/content templates and TC presets, content.log semantics).
/// Returns the data-root paths written.
#[tauri::command]
fn content_seed(root: String) -> Result<Vec<String>, String> {
    const BUNDLE: &str = include_str!("../assets/st-default-content.json");
    content::seed(Path::new(&root), BUNDLE).map_err(|e| e.to_string())
}

/// Write / overwrite a chat jsonl from its lines (legacy group chats get their header this way).
#[tauri::command]
fn chat_write(path: String, lines: Vec<String>) -> Result<(), String> {
    chat::write_chat(Path::new(&path), &lines).map_err(|e| e.to_string())
}

/// ST renameGroupMember on the listed group chats. Returns files touched.
#[tauri::command]
fn chat_rename_group_member(
    root: String,
    chat_ids: Vec<String>,
    old_avatar: String,
    new_avatar: String,
    new_name: String,
) -> Result<usize, String> {
    chat::rename_group_member(
        Path::new(&root),
        &chat_ids,
        &old_avatar,
        &new_avatar,
        &new_name,
    )
    .map_err(|e| e.to_string())
}

/// Read a UTF-8 text file inside the data root (worlds/*.json, presets, …). Refuses paths that
/// escape the root or touch private files (secrets, index).
#[tauri::command]
fn data_read_text(root: String, rel: String) -> Result<String, String> {
    std::fs::read_to_string(guarded_rel(&root, &rel)?).map_err(|e| e.to_string())
}

/// Last `n` messages of a chat jsonl plus header and total count (DEV_NOTES §5.2).
#[tauri::command]
fn chat_read_tail(path: String, n: usize) -> Result<chat::ChatTail, String> {
    chat::read_tail(std::path::Path::new(&path), n).map_err(|e| e.to_string())
}

/// Append one serialized message line.
#[tauri::command]
fn chat_append(path: String, line: String) -> Result<(), String> {
    chat::append_message(std::path::Path::new(&path), &line).map_err(|e| e.to_string())
}

/// Replace the header line only (chat metadata); messages are untouched. Atomic.
#[tauri::command]
fn chat_write_header(path: String, header: String) -> Result<(), String> {
    chat::rewrite_header(std::path::Path::new(&path), &header).map_err(|e| e.to_string())
}

/// Replace messages from `index` (0-based, header excluded) to the end. Atomic.
#[tauri::command]
fn chat_rewrite_from(path: String, index: usize, lines: Vec<String>) -> Result<(), String> {
    chat::rewrite_from(std::path::Path::new(&path), index, &lines).map_err(|e| e.to_string())
}

/// The ST-compatible data root (DEV_NOTES §5.1), created on first call.
#[tauri::command]
fn data_root(app: tauri::AppHandle) -> Result<String, String> {
    let root: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("data");
    layout::ensure_layout(&root).map_err(|e| e.to_string())?;
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
fn settings_read(root: String) -> Result<Option<serde_json::Value>, String> {
    settings::read_settings(Path::new(&root)).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_write(root: String, mut value: serde_json::Value) -> Result<(), String> {
    // DEV_NOTES §7: secret fields never reach settings.json; the keyring is the only store
    settings::scrub_secrets(&mut value);
    settings::write_settings(Path::new(&root), &value).map_err(|e| e.to_string())
}

#[tauri::command]
fn app_settings_read(root: String) -> Result<Option<serde_json::Value>, String> {
    settings::read_app_settings(Path::new(&root)).map_err(|e| e.to_string())
}

#[tauri::command]
fn app_settings_write(root: String, value: serde_json::Value) -> Result<(), String> {
    settings::write_app_settings(Path::new(&root), &value).map_err(|e| e.to_string())
}

#[tauri::command]
fn index_scan(root: String, rebuild: bool) -> Result<index::ScanReport, String> {
    let mut ix = index::Index::open(Path::new(&root)).map_err(|e| e.to_string())?;
    if rebuild { ix.rebuild() } else { ix.scan() }.map_err(|e| e.to_string())
}

#[tauri::command]
fn index_characters(root: String) -> Result<Vec<index::CharacterRow>, String> {
    index::Index::open(Path::new(&root))
        .and_then(|ix| ix.characters())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn index_chats(root: String, char_avatar: String) -> Result<Vec<index::ChatRow>, String> {
    index::Index::open(Path::new(&root))
        .and_then(|ix| ix.chats(&char_avatar))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn index_search(
    root: String,
    query: String,
    limit: usize,
) -> Result<Vec<index::SearchHit>, String> {
    index::Index::open(Path::new(&root))
        .and_then(|ix| ix.search(&query, limit))
        .map_err(|e| e.to_string())
}

/// A scratch zip next to the staged picks; the folder is wiped at startup.
fn scratch_zip() -> std::io::Result<PathBuf> {
    let dir = picked_stage_dir();
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("backup-{}.zip", now_millis())))
}

/// Export the data root as a zip, or with `password` as a sealed `.tmbackup` (DEV_NOTES §9.38):
/// the plain zip then only ever exists in the scratch folder and is removed right after.
fn export_backup(
    root: &Path,
    dest: &Path,
    include_secrets: bool,
    password: Option<&str>,
) -> Result<archive::ExportReport, String> {
    let Some(password) = password else {
        return archive::export(root, dest, include_secrets).map_err(|e| e.to_string());
    };
    let zip = scratch_zip().map_err(|e| e.to_string())?;
    let report = archive::export(root, &zip, include_secrets)
        .map_err(|e| e.to_string())
        .and_then(|r| {
            seal::seal(&zip, dest, password)
                .map(|()| r)
                .map_err(seal_message)
        });
    let _ = std::fs::remove_file(&zip);
    report
}

/// Import a backup zip; a sealed one needs `password` and is opened into the scratch folder first.
fn import_backup(
    src: &Path,
    root: &Path,
    password: Option<&str>,
) -> Result<archive::ImportReport, String> {
    if !seal::is_sealed(src) {
        return archive::import(src, root).map_err(|e| e.to_string());
    }
    let password = password.ok_or("这个备份加了密，需要密码")?;
    let zip = scratch_zip().map_err(|e| e.to_string())?;
    let report = seal::unseal(src, &zip, password)
        .map_err(seal_message)
        .and_then(|()| archive::import(&zip, root).map_err(|e| e.to_string()));
    let _ = std::fs::remove_file(&zip);
    report
}

fn seal_message(e: seal::SealError) -> String {
    match e {
        seal::SealError::WrongPassword => "密码不对".into(),
        seal::SealError::Corrupt | seal::SealError::NotSealed => "加密备份已损坏".into(),
        other => other.to_string(),
    }
}

#[tauri::command(async)]
fn data_export(
    root: String,
    zip_path: String,
    include_secrets: bool,
    password: Option<String>,
) -> Result<archive::ExportReport, String> {
    export_backup(
        Path::new(&root),
        Path::new(&zip_path),
        include_secrets,
        password.as_deref(),
    )
}

/// Is the picked file a sealed backup (so the UI asks for its password before importing)?
#[tauri::command]
fn data_backup_sealed(path: String) -> bool {
    seal::is_sealed(&picked_path(&path))
}

/// Imports an ST data zip. Secrets found in the archive are returned, never written (→ keyring, Phase 3).
#[tauri::command(async)]
fn data_import(
    zip_path: String,
    root: String,
    password: Option<String>,
) -> Result<archive::ImportReport, String> {
    import_backup(
        &picked_path(&zip_path),
        Path::new(&root),
        password.as_deref(),
    )
}

// ---- crash log (DEV_NOTES §9.38): local file only, redacted on write ----

static CRASH_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Record Rust panics in the crash log, then hand over to the previous hook.
fn install_panic_log(dir: PathBuf) {
    if CRASH_DIR.set(dir).is_err() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(dir) = CRASH_DIR.get() {
            let payload = info.payload();
            let message = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic".into());
            let source = info
                .location()
                .map(|l| format!("{}:{}", l.file(), l.line()))
                .unwrap_or_default();
            let _ = crashlog::append(
                dir,
                crashlog::Entry {
                    t: now_millis(),
                    kind: "rust".into(),
                    message,
                    source,
                    stack: String::new(),
                },
            );
        }
        previous(info);
    }));
}

fn crash_dir() -> Result<&'static PathBuf, String> {
    CRASH_DIR.get().ok_or_else(|| "crash log not ready".into())
}

/// An uncaught page error. `kind` is `js` or `promise`; anything else is stored as `js`.
#[tauri::command]
fn crash_log_append(
    kind: String,
    message: String,
    source: String,
    stack: String,
) -> Result<(), String> {
    let kind = if kind == "promise" { "promise" } else { "js" };
    crashlog::append(
        crash_dir()?,
        crashlog::Entry {
            t: now_millis(),
            kind: kind.into(),
            message,
            source,
            stack,
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn crash_log_read() -> Result<Vec<crashlog::Entry>, String> {
    crashlog::read(crash_dir()?).map_err(|e| e.to_string())
}

#[tauri::command]
fn crash_log_clear() -> Result<(), String> {
    crashlog::clear(crash_dir()?).map_err(|e| e.to_string())
}

// ---- extensions (DEV_NOTES §9.6, §9.34) ----

/// Installed extensions with their manifests and the host modules they import.
#[tauri::command]
fn extension_list(root: String) -> Result<Vec<extensions::ExtensionInfo>, String> {
    extensions::list(Path::new(&root)).map_err(|e| e.to_string())
}

/// Unpacks a picked extension zip into `extensions/<name>/`.
#[tauri::command]
fn extension_install_zip(
    root: String,
    zip_path: String,
) -> Result<extensions::ExtensionInfo, String> {
    let zip = picked_path(&zip_path);
    let fallback = zip
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    extensions::install_zip(Path::new(&root), &zip, &fallback).map_err(|e| e.to_string())
}

/// Largest repository archive `extension_install_github` downloads.
const MAX_EXTENSION_ARCHIVE: usize = 50 * 1024 * 1024;

/// Downloads a GitHub repository's archive and installs it as `extensions/<repo>/` (DEV_NOTES §9.6).
#[tauri::command]
async fn extension_install_github(
    root: String,
    url: String,
) -> Result<extensions::ExtensionInfo, String> {
    let source = extensions::github_source(&url)
        .ok_or("只认 https://github.com/<作者>/<仓库> 这样的地址")?;
    let mut response = tm_net::client()
        .get(&source.zip_url)
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败：HTTP {}", response.status().as_u16()));
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("下载失败：{e}"))?
    {
        if bytes.len() + chunk.len() > MAX_EXTENSION_ARCHIVE {
            return Err("扩展包超过 50 MB，没有安装".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    tauri::async_runtime::spawn_blocking(move || {
        extensions::install_github_zip(Path::new(&root), bytes, &source).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn extension_remove(root: String, name: String) -> Result<(), String> {
    extensions::remove(Path::new(&root), &name).map_err(|e| e.to_string())
}

/// Which names each stand-in host module exports; call before loading any extension.
#[tauri::command]
fn ext_shims_set(
    shims: tauri::State<'_, ext_host::Shims>,
    table: HashMap<String, BTreeSet<String>>,
) {
    shims.set(table);
}

// ---- tokenizers (crate tm-tokenizers) ----

/// `/api/tokenizers/<name>/encode` 等价：ids + count。`model` 仅 openai 需要。
#[tauri::command]
fn tokenizer_encode(
    svc: tauri::State<'_, TokenizerService>,
    name: String,
    model: Option<String>,
    text: String,
) -> Result<EncodeResult, String> {
    svc.encode(&name, model.as_deref(), &text)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn tokenizer_decode(
    svc: tauri::State<'_, TokenizerService>,
    name: String,
    model: Option<String>,
    ids: Vec<u32>,
) -> Result<String, String> {
    svc.decode(&name, model.as_deref(), &ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn tokenizer_count(
    svc: tauri::State<'_, TokenizerService>,
    name: String,
    model: Option<String>,
    text: String,
) -> Result<usize, String> {
    svc.count(&name, model.as_deref(), &text)
        .map_err(|e| e.to_string())
}

/// `/api/tokenizers/openai/count?model=` 等价（服务端口径，不含前端的 -1/-2 调整）。
#[tauri::command]
fn tokenizer_count_openai(
    svc: tauri::State<'_, TokenizerService>,
    model: String,
    messages: Vec<serde_json::Value>,
) -> Result<usize, String> {
    svc.count_openai_messages(&model, &messages)
        .map_err(|e| e.to_string())
}

/// 登记一个 HF tokenizer.json（懒加载）。name ∈ ST 本地分词器名。
#[tauri::command]
fn tokenizer_register(
    svc: tauri::State<'_, TokenizerService>,
    name: String,
    path: String,
) -> Result<(), String> {
    if !LOCAL_TOKENIZER_NAMES.contains(&name.as_str()) {
        return Err(format!("unknown tokenizer: {name}"));
    }
    svc.register_hf(&name, PathBuf::from(path));
    Ok(())
}

/// 扫描 `<root>/tokenizers/<name>.json` 并登记全部命中的本地分词器；返回登记后的名字列表。
#[tauri::command]
fn tokenizer_autoload(
    svc: tauri::State<'_, TokenizerService>,
    root: String,
) -> Result<Vec<String>, String> {
    let dir = Path::new(&root).join("tokenizers");
    for name in LOCAL_TOKENIZER_NAMES {
        let file = dir.join(format!("{name}.json"));
        if file.is_file() {
            svc.register_hf(name, file);
        }
    }
    Ok(svc.hf().registered())
}

/// 已登记（有真实词表）的本地分词器名。
#[tauri::command]
fn tokenizer_list(svc: tauri::State<'_, TokenizerService>) -> Vec<String> {
    svc.hf().registered()
}

// ---- 钥匙串（crate tm-keys）----

/// 平台钥匙串不可用时回退到会话内内存（UI 据 `secret_backend_info` 提示用户）
struct KeysState {
    vault: SecretVault<Box<dyn SecretBackend>>,
    platform: Result<&'static str, String>,
}

impl KeysState {
    fn open() -> Self {
        match tm_keys::init_platform_store() {
            Ok(kind) => KeysState {
                vault: SecretVault::new(Box::new(tm_keys::KeyringBackend::new(tm_keys::SERVICE))),
                platform: Ok(kind),
            },
            Err(e) => {
                eprintln!(
                    "[keys] platform credential store unavailable, using in-memory fallback: {e}"
                );
                KeysState {
                    vault: SecretVault::new(Box::new(tm_keys::MemoryBackend::new())),
                    platform: Err(e.to_string()),
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct SecretBackendInfo {
    /// "keyring" 或 "memory"
    backend: &'static str,
    /// 平台存储种类（macos-keychain / ios-keychain / android-keystore / …），不可用时为 null
    platform: Option<&'static str>,
    error: Option<String>,
}

#[tauri::command]
fn secret_backend_info(keys: tauri::State<'_, KeysState>) -> SecretBackendInfo {
    SecretBackendInfo {
        backend: keys.vault.backend_kind(),
        platform: keys.platform.as_ref().ok().copied(),
        error: keys.platform.as_ref().err().cloned(),
    }
}

/// 写入一把密钥（成为 active），返回 id。值只在此命令里经过 IPC 一次。
#[tauri::command]
fn secret_write(
    keys: tauri::State<'_, KeysState>,
    key: String,
    value: String,
    label: Option<String>,
) -> Result<String, String> {
    keys.vault
        .write(&key, &value, label.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_delete(keys: tauri::State<'_, KeysState>, key: String, id: String) -> Result<(), String> {
    keys.vault.delete(&key, &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_rotate(keys: tauri::State<'_, KeysState>, key: String, id: String) -> Result<(), String> {
    keys.vault.rotate(&key, &id).map_err(|e| e.to_string())
}

/// 改名（ST /api/secrets/rename）
#[tauri::command]
fn secret_rename(
    keys: tauri::State<'_, KeysState>,
    key: String,
    id: String,
    label: String,
) -> Result<(), String> {
    keys.vault
        .rename(&key, &id, &label)
        .map_err(|e| e.to_string())
}

/// 元数据 + 遮掩值（ST /api/secrets/find）
#[tauri::command]
fn secret_find(keys: tauri::State<'_, KeysState>, key: String) -> Result<Vec<SecretMeta>, String> {
    keys.vault.find(&key).map_err(|e| e.to_string())
}

/// 每个 key 是否有密钥（ST /api/secrets/read 的 secret_state）
#[tauri::command]
fn secret_state(keys: tauri::State<'_, KeysState>) -> Result<HashMap<String, bool>, String> {
    keys.vault.state().map_err(|e| e.to_string())
}

#[tauri::command]
fn proxy_password_set(
    keys: tauri::State<'_, KeysState>,
    preset: String,
    value: String,
) -> Result<String, String> {
    keys.vault
        .set_proxy_password(&preset, &value)
        .map_err(|e| e.to_string())
}

/// 把密钥引用解析成 url `{{key}}` 占位（Google）或 api_key（头）；IPC 自带 api_key 一律拒绝
fn apply_secret(
    url: &mut String,
    api_key: &mut Option<String>,
    keys: &KeysState,
    secret: Option<&SecretRef>,
) -> Result<(), String> {
    if api_key.is_some() {
        return Err("api_key must not cross IPC; pass a `secret` reference instead".into());
    }
    let value = match secret {
        Some(s) => keys.vault.resolve(s).map_err(|e| e.to_string())?,
        None => None,
    };
    if url.contains("{{key}}") {
        let Some(v) = value.as_deref() else {
            return Err("this endpoint needs a secret in the url".into());
        };
        *url = url.replace("{{key}}", v);
        return Ok(());
    }
    *api_key = value;
    Ok(())
}

fn resolve_secret_into(
    req: &mut GenerateRequest,
    keys: &KeysState,
    secret: Option<&SecretRef>,
) -> Result<(), String> {
    apply_secret(&mut req.url, &mut req.api_key, keys, secret)
}

/// 通用非流式 HTTP（模型列表 / 连接检测 / 探测）；密钥同样由 SecretRef 解析
#[tauri::command]
async fn net_fetch(
    keys: tauri::State<'_, KeysState>,
    mut request: FetchRequest,
    secret: Option<SecretRef>,
) -> Result<FetchResponse, String> {
    apply_secret(
        &mut request.url,
        &mut request.api_key,
        &keys,
        secret.as_ref(),
    )?;
    tm_net::fetch(&request, &CancellationToken::new())
        .await
        .map_err(|e| e.to_string())
}

// ---- 生成（crate tm-net）----

/// 一次生成的实时快照：切后台再回来时 UI 用它补齐已生成内容
#[derive(Debug, Clone, Serialize)]
struct GenSnapshot {
    text: String,
    reasoning: String,
    swipes: Vec<String>,
    /// running | done | aborted | error
    state: &'static str,
    done: bool,
    aborted: bool,
    error: Option<String>,
    /// ms since epoch
    started_at: u64,
    updated_at: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Default for GenSnapshot {
    fn default() -> Self {
        let t = now_ms();
        GenSnapshot {
            text: String::new(),
            reasoning: String::new(),
            swipes: Vec::new(),
            state: "running",
            done: false,
            aborted: false,
            error: None,
            started_at: t,
            updated_at: t,
        }
    }
}

struct GenEntry {
    cancel: CancellationToken,
    snapshot: Mutex<GenSnapshot>,
    keepalive: background::Keepalive,
}

#[derive(Default)]
struct GenRegistry(Mutex<HashMap<String, Arc<GenEntry>>>);

fn apply_event(snapshot: &mut GenSnapshot, ev: &GenEvent) {
    snapshot.updated_at = now_ms();
    match ev {
        GenEvent::Started { .. } => {}
        GenEvent::Delta {
            text,
            reasoning,
            swipes,
            ..
        } => {
            snapshot.text = text.clone();
            snapshot.reasoning = reasoning.clone();
            snapshot.swipes = swipes.clone();
        }
        GenEvent::Done {
            text,
            reasoning,
            swipes,
            ..
        } => {
            snapshot.text = text.clone();
            snapshot.reasoning = reasoning.clone();
            snapshot.swipes = swipes.clone();
            snapshot.done = true;
            snapshot.state = "done";
        }
        GenEvent::Error { message, .. } => {
            snapshot.error = Some(message.clone());
            snapshot.done = true;
            snapshot.state = "error";
        }
    }
}

/// 发起生成：事件经 Channel 推给前端；返回生成 id（用于中断 / 快照 / 清理）。
#[tauri::command]
async fn generate_start(
    app: tauri::AppHandle,
    reg: tauri::State<'_, GenRegistry>,
    keys: tauri::State<'_, KeysState>,
    mut request: GenerateRequest,
    secret: Option<SecretRef>,
    on_event: Channel<GenEvent>,
) -> Result<String, String> {
    resolve_secret_into(&mut request, &keys, secret.as_ref())?;
    let id = format!(
        "gen-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let entry = Arc::new(GenEntry {
        cancel: CancellationToken::new(),
        snapshot: Mutex::new(GenSnapshot::default()),
        keepalive: background::Keepalive::default(),
    });
    if let Err(e) = entry.keepalive.begin(&app) {
        eprintln!("[background] keepalive begin failed: {e}");
    }
    reg.0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), entry.clone());
    let task_entry = entry.clone();
    tauri::async_runtime::spawn(async move {
        let cancel = task_entry.cancel.clone();
        let result = tm_net::generate(request, cancel, |ev| {
            if let Ok(mut snap) = task_entry.snapshot.lock() {
                apply_event(&mut snap, &ev);
            }
            let _ = on_event.send(ev);
        })
        .await;
        if matches!(result, Err(tm_net::NetError::Aborted)) {
            if let Ok(mut snap) = task_entry.snapshot.lock() {
                snap.aborted = true;
                snap.done = true;
                snap.state = "aborted";
                snap.updated_at = now_ms();
            }
        }
        task_entry.keepalive.end(&app);
    });
    Ok(id)
}

/// 中断生成；返回是否找到该 id
#[tauri::command]
fn generate_abort(reg: tauri::State<'_, GenRegistry>, id: String) -> Result<bool, String> {
    let map = reg.0.lock().map_err(|e| e.to_string())?;
    Ok(match map.get(&id) {
        Some(e) => {
            e.cancel.cancel();
            true
        }
        None => false,
    })
}

/// 当前快照（页面恢复时拉取已生成文本）
#[tauri::command]
fn generate_snapshot(
    reg: tauri::State<'_, GenRegistry>,
    id: String,
) -> Result<Option<GenSnapshot>, String> {
    let map = reg.0.lock().map_err(|e| e.to_string())?;
    Ok(map
        .get(&id)
        .and_then(|e| e.snapshot.lock().ok().map(|s| s.clone())))
}

#[derive(Debug, Clone, Serialize)]
struct GenListItem {
    id: String,
    state: &'static str,
    updated_at: u64,
}

/// 当前注册表里的生成（页面恢复时用来找回进行中的那一次）
#[tauri::command]
fn generate_list(reg: tauri::State<'_, GenRegistry>) -> Result<Vec<GenListItem>, String> {
    let map = reg.0.lock().map_err(|e| e.to_string())?;
    let mut out: Vec<GenListItem> = map
        .iter()
        .filter_map(|(id, e)| {
            e.snapshot.lock().ok().map(|s| GenListItem {
                id: id.clone(),
                state: s.state,
                updated_at: s.updated_at,
            })
        })
        .collect();
    out.sort_by_key(|x| x.updated_at);
    Ok(out)
}

/// 释放一次生成的记录（UI 已消费完）
#[tauri::command]
fn generate_forget(reg: tauri::State<'_, GenRegistry>, id: String) -> Result<(), String> {
    reg.0.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
struct UrlPolicy {
    ok: bool,
    /// http 到非本地主机：需要用户确认后以 allow_insecure_http 重发
    needs_confirm: bool,
    error: Option<String>,
}

/// URL 策略预检（UI 在连接前调用，决定是否弹"http 不安全"确认）
#[tauri::command]
fn net_url_policy(url: String) -> UrlPolicy {
    match tm_net::check_url(&url, false) {
        Ok(_) => UrlPolicy {
            ok: true,
            needs_confirm: false,
            error: None,
        },
        Err(tm_net::NetError::InsecureHttp(_)) => UrlPolicy {
            ok: false,
            needs_confirm: true,
            error: None,
        },
        Err(e) => UrlPolicy {
            ok: false,
            needs_confirm: false,
            error: Some(e.to_string()),
        },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // copies left behind by a run that ended mid-dialog
    let _ = std::fs::remove_dir_all(picked_stage_dir());
    let builder = tauri::Builder::default()
        .invoke_system(helper_realm::invoke_system_script())
        .register_asynchronous_uri_scheme_protocol(helper_realm::SCHEME, helper_realm::handle)
        .register_asynchronous_uri_scheme_protocol(ext_host::SCHEME, ext_host::handle)
        .plugin(tauri_plugin_dialog::init())
        .manage(TokenizerService::new())
        .manage(GenRegistry::default())
        .manage(KeysState::open())
        .manage(ext_host::Shims::default())
        .invoke_handler(tauri::generate_handler![
            ping,
            card_read,
            card_write,
            card_import,
            card_delete,
            card_rename,
            card_duplicate,
            card_avatar_replace,
            image_preview,
            picked_stage,
            picked_unstage,
            group_avatar_upload,
            png_text_read,
            user_avatar_upload,
            user_avatar_copy,
            media_upload,
            background_upload,
            media_upload_base64,
            media_list,
            media_folders,
            media_delete,
            file_read_text,
            user_avatar_seed_default,
            chat_rename_character,
            chat_write,
            chat_rename_group_member,
            data_read_text,
            data_rename,
            export_dir,
            export_exists,
            export_write_text,
            export_copy,
            card_export_png,
            data_list,
            data_write_text,
            content_seed,
            data_delete,
            chat_read_tail,
            chat_create,
            chat_append,
            chat_rewrite_from,
            chat_write_header,
            data_root,
            extension_list,
            extension_install_zip,
            extension_install_github,
            extension_remove,
            ext_shims_set,
            settings_read,
            settings_write,
            app_settings_read,
            app_settings_write,
            index_scan,
            index_characters,
            index_chats,
            index_search,
            data_export,
            data_import,
            tokenizer_encode,
            tokenizer_decode,
            tokenizer_count,
            tokenizer_count_openai,
            tokenizer_register,
            tokenizer_autoload,
            tokenizer_list,
            generate_start,
            generate_abort,
            generate_snapshot,
            generate_forget,
            generate_list,
            net_url_policy,
            net_fetch,
            secret_backend_info,
            secret_write,
            secret_delete,
            secret_rotate,
            secret_rename,
            secret_find,
            secret_state,
            proxy_password_set,
            data_backup_sealed,
            crash_log_append,
            crash_log_read,
            crash_log_clear
        ])
        .setup(|app| {
            install_panic_log(app.path().app_data_dir()?.join("logs"));
            #[cfg(target_os = "ios")]
            ios_layout::on_setup(app);
            Ok(())
        });
    #[cfg(target_os = "ios")]
    let builder = builder.on_page_load(ios_layout::on_page_load);
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_backup_round_trips_and_plain_zip_still_imports() {
        let dir = std::env::temp_dir().join(format!("tm-seal-test-{}", now_millis()));
        let (root, back) = (dir.join("data"), dir.join("back"));
        std::fs::create_dir_all(root.join("worlds")).unwrap();
        std::fs::write(root.join("worlds/Atlas.json"), r#"{"entries":{}}"#).unwrap();
        let sealed = dir.join("a.tmbackup");
        export_backup(&root, &sealed, false, Some("a long password")).unwrap();
        assert!(seal::is_sealed(&sealed));
        assert_eq!(
            import_backup(&sealed, &back, None).unwrap_err(),
            "这个备份加了密，需要密码"
        );
        assert_eq!(
            import_backup(&sealed, &back, Some("nope")).unwrap_err(),
            "密码不对"
        );
        assert!(!back.join("worlds/Atlas.json").exists());
        import_backup(&sealed, &back, Some("a long password")).unwrap();
        assert!(back.join("worlds/Atlas.json").exists());

        let plain = dir.join("a.zip");
        export_backup(&root, &plain, false, None).unwrap();
        let again = dir.join("again");
        import_backup(&plain, &again, None).unwrap();
        assert!(again.join("worlds/Atlas.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn picked_path_accepts_file_urls_from_the_ios_picker() {
        assert_eq!(
            picked_path("file:///private/var/tmp/x%20y/%E5%9B%BE.png"),
            PathBuf::from("/private/var/tmp/x y/图.png")
        );
        assert_eq!(
            picked_path("/Users/a/b.png"),
            PathBuf::from("/Users/a/b.png")
        );
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    #[test]
    fn staged_pick_keeps_its_name_and_unstage_removes_only_slots() {
        let dir = std::env::temp_dir().join(format!("tm-stage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("my ext.zip");
        std::fs::write(&src, b"zip").unwrap();
        let stage = dir.join("stage");

        let staged = stage_picked(&stage, &src, 1700).unwrap();
        assert_eq!(staged, stage.join("1700").join("my ext.zip"));
        assert_eq!(std::fs::read(&staged).unwrap(), b"zip");
        assert!(stage_picked(&stage, &dir.join("missing.png"), 1701).is_err());

        // not a slot: the source itself, a `..` hop, a non-numeric folder
        unstage_picked(&stage, &src).unwrap();
        unstage_picked(&stage, &stage.join("..").join("my ext.zip")).unwrap();
        std::fs::create_dir_all(stage.join("keep")).unwrap();
        unstage_picked(&stage, &stage.join("keep").join("x")).unwrap();
        assert!(src.exists() && stage.join("keep").exists() && staged.exists());

        unstage_picked(&stage, &staged).unwrap();
        assert!(!stage.join("1700").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ping_reports_version() {
        let p = ping();
        assert_eq!(p.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(p.app, "tavern-mobile");
    }
}
