//! Tavern data layer (DEV_NOTES §5). Files are the truth; everything here is plain Rust so the
//! same code serves the Tauri app, the `tm-data` CLI and the st-oracle round-trip test.

pub mod archive;
pub mod card;
pub mod chat;
pub mod content;
pub mod crashlog;
pub mod extensions;
pub mod index;
pub mod layout;
pub mod media;
pub mod seal;
pub mod settings;
pub mod user_avatar;
