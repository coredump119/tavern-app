//! 按平台把 keyring-core 默认凭据库指向原生安全存储。只做一次；失败时返回错误由调用方决定回退。
use std::sync::OnceLock;

use crate::error::{KeysError, Result};

static INIT: OnceLock<std::result::Result<&'static str, String>> = OnceLock::new();

fn init_once() -> std::result::Result<&'static str, String> {
    #[cfg(target_os = "macos")]
    {
        let store =
            apple_native_keyring_store::keychain::Store::new().map_err(|e| e.to_string())?;
        keyring_core::set_default_store(store);
        return Ok("macos-keychain");
    }
    #[cfg(target_os = "ios")]
    {
        let store =
            apple_native_keyring_store::protected::Store::new().map_err(|e| e.to_string())?;
        keyring_core::set_default_store(store);
        return Ok("ios-keychain");
    }
    #[cfg(target_os = "android")]
    {
        let store = android_native_keyring_store::Store::new().map_err(|e| e.to_string())?;
        keyring_core::set_default_store(store);
        return Ok("android-keystore");
    }
    #[cfg(target_os = "windows")]
    {
        let store = windows_native_keyring_store::Store::new().map_err(|e| e.to_string())?;
        keyring_core::set_default_store(store);
        return Ok("windows-credential-manager");
    }
    #[cfg(target_os = "linux")]
    {
        let store = zbus_secret_service_keyring_store::Store::new().map_err(|e| e.to_string())?;
        keyring_core::set_default_store(store);
        return Ok("linux-secret-service");
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".to_string())
}

/// 初始化平台凭据库，返回种类名；重复调用返回首次结果。
pub fn init_platform_store() -> Result<&'static str> {
    INIT.get_or_init(init_once)
        .clone()
        .map_err(KeysError::StoreUnavailable)
}
