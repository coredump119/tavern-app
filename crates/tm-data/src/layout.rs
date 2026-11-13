//! ST `data/<user>/` directory layout (DEV_NOTES §5.1). Names are ST's, spaces included.

use std::path::{Path, PathBuf};

pub const CHARACTERS: &str = "characters";
pub const CHATS: &str = "chats";
pub const GROUP_CHATS: &str = "group chats";
pub const GROUPS: &str = "groups";
pub const WORLDS: &str = "worlds";
pub const OPENAI_SETTINGS: &str = "OpenAI Settings";
pub const TEXTGEN_SETTINGS: &str = "TextGen Settings";
pub const KOBOLD_SETTINGS: &str = "KoboldAI Settings";
pub const NOVEL_SETTINGS: &str = "NovelAI Settings";
pub const CONTEXT: &str = "context";
pub const INSTRUCT: &str = "instruct";
pub const SYSPROMPT: &str = "sysprompt";
pub const REASONING: &str = "reasoning";
pub const QUICK_REPLIES: &str = "QuickReplies";
pub const USER_AVATARS: &str = "User Avatars";
pub const BACKGROUNDS: &str = "backgrounds";
pub const THEMES: &str = "themes";
pub const MOVING_UI: &str = "movingUI";
pub const USER_IMAGES: &str = "user/images";
pub const EXTENSIONS: &str = "extensions";
pub const SETTINGS_FILE: &str = "settings.json";
pub const APP_SETTINGS_FILE: &str = "app_settings.json";
pub const SECRETS_FILE: &str = "secrets.json";
pub const INDEX_FILE: &str = "index.sqlite";

/// Every directory we create on first run.
pub const DIRS: &[&str] = &[
    CHARACTERS,
    CHATS,
    GROUP_CHATS,
    GROUPS,
    WORLDS,
    OPENAI_SETTINGS,
    TEXTGEN_SETTINGS,
    KOBOLD_SETTINGS,
    NOVEL_SETTINGS,
    CONTEXT,
    INSTRUCT,
    SYSPROMPT,
    REASONING,
    QUICK_REPLIES,
    USER_AVATARS,
    BACKGROUNDS,
    THEMES,
    MOVING_UI,
    USER_IMAGES,
    EXTENSIONS,
];

/// Paths that never leave the device and never enter an export (index, keys, caches, temp).
pub fn is_private_path(rel: &Path) -> bool {
    let Some(first) = rel.components().next() else {
        return false;
    };
    let first = first.as_os_str().to_string_lossy();
    if first == SECRETS_FILE || first.starts_with(INDEX_FILE) {
        return true;
    }
    if matches!(first.as_ref(), "backups" | "thumbnails" | ".git") {
        return true;
    }
    let name = rel
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    name.ends_with(".tmp") || name == ".DS_Store"
}

pub fn ensure_layout(root: &Path) -> std::io::Result<()> {
    for d in DIRS {
        std::fs::create_dir_all(root.join(d))?;
    }
    Ok(())
}

pub fn chat_dir(root: &Path, avatar_png: &str) -> PathBuf {
    root.join(CHATS).join(avatar_png.trim_end_matches(".png"))
}
