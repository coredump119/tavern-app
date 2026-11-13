//! 钥匙串层（无 Tauri 依赖）：
//! - `platform::init_platform_store`：按平台把 keyring-core 的默认凭据库指向原生安全存储
//!   （macOS 钥匙串、iOS protected data、Android Keystore + SharedPreferences、Windows 凭据管理器、Linux Secret Service）
//! - `SecretBackend`：name → value 的最小抽象；`KeyringBackend`（keyring-core Entry）与 `MemoryBackend`（测试 / 回退）
//! - `SecretVault`：ST secrets.json 的语义（每个 key 多把密钥，id / label / active；write 自动激活新密钥）
//!   搬到钥匙串里：元数据（不含值）存在 `<key>`，值存在 `<key>/<id>`
//!
//! 硬规则（DEV_NOTES §7）：settings.json 的密钥字段永远为空；密钥值只在这里与请求头之间流动。

pub mod backend;
pub mod error;
pub mod platform;
pub mod vault;

pub use backend::{KeyringBackend, MemoryBackend, SecretBackend};
pub use error::KeysError;
pub use platform::init_platform_store;
pub use vault::{mask_secret, SecretMeta, SecretRef, SecretVault, SECRET_KEYS};

/// 钥匙串条目的 service 名（Keychain 里显示为此名字）
pub const SERVICE: &str = "dev.coredump119.tavern";
