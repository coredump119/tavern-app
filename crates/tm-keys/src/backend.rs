use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{KeysError, Result};

/// name → value 的最小存取接口
pub trait SecretBackend: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>>;
    fn set(&self, name: &str, value: &str) -> Result<()>;
    fn delete(&self, name: &str) -> Result<()>;
    /// 存储种类（UI 用来提示"密钥存在哪"）
    fn kind(&self) -> &'static str;
}

/// keyring-core 默认凭据库（需先 `init_platform_store`）
pub struct KeyringBackend {
    service: String,
}

impl KeyringBackend {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, name: &str) -> Result<keyring_core::Entry> {
        Ok(keyring_core::Entry::new(&self.service, name)?)
    }
}

impl SecretBackend for KeyringBackend {
    fn get(&self, name: &str) -> Result<Option<String>> {
        match self.entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn set(&self, name: &str, value: &str) -> Result<()> {
        Ok(self.entry(name)?.set_password(value)?)
    }

    fn delete(&self, name: &str) -> Result<()> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    fn kind(&self) -> &'static str {
        "keyring"
    }
}

/// 内存后端：测试与"平台钥匙串不可用"时的会话内回退（不落盘）
#[derive(Default)]
pub struct MemoryBackend {
    map: Mutex<HashMap<String, String>>,
}

impl MemoryBackend {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretBackend for MemoryBackend {
    fn get(&self, name: &str) -> Result<Option<String>> {
        Ok(self
            .map
            .lock()
            .map_err(|e| KeysError::Keyring(e.to_string()))?
            .get(name)
            .cloned())
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        self.map
            .lock()
            .map_err(|e| KeysError::Keyring(e.to_string()))?
            .insert(name.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<()> {
        self.map
            .lock()
            .map_err(|e| KeysError::Keyring(e.to_string()))?
            .remove(name);
        Ok(())
    }
    fn kind(&self) -> &'static str {
        "memory"
    }
}

/// 让 `SecretVault<Box<dyn SecretBackend>>` 可用（宿主按平台在运行时选后端）
impl SecretBackend for Box<dyn SecretBackend> {
    fn get(&self, name: &str) -> Result<Option<String>> {
        (**self).get(name)
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        (**self).set(name, value)
    }
    fn delete(&self, name: &str) -> Result<()> {
        (**self).delete(name)
    }
    fn kind(&self) -> &'static str {
        (**self).kind()
    }
}
