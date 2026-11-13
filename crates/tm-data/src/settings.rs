//! `settings.json` (ST field names, untouched) and our own `app_settings.json`.
//! Secrets never live in settings.json on disk here (DEV_NOTES §7): `scrub_secrets` blanks them
//! and returns what it removed so the caller can move them to the keyring.

use crate::layout::{APP_SETTINGS_FILE, SETTINGS_FILE};
use serde_json::Value;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("settings.json is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
}

/// Keys whose values are credentials wherever they appear in settings.json.
pub const SECRET_KEYS: &[&str] = &["proxy_password", "password", "api_key", "apiKey"];

fn read_json(path: &Path) -> Result<Option<Value>, SettingsError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Pretty JSON (ST writes `JSON.stringify(x, null, 4)`), temp file + rename.
pub fn write_json_atomic(path: &Path, value: &Value) -> Result<(), SettingsError> {
    let mut text = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(
        &mut text,
        serde_json::ser::PrettyFormatter::with_indent(b"    "),
    );
    serde::Serialize::serialize(value, &mut ser)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &text)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn read_settings(root: &Path) -> Result<Option<Value>, SettingsError> {
    read_json(&root.join(SETTINGS_FILE))
}

pub fn write_settings(root: &Path, settings: &Value) -> Result<(), SettingsError> {
    write_json_atomic(&root.join(SETTINGS_FILE), settings)
}

pub fn read_app_settings(root: &Path) -> Result<Option<Value>, SettingsError> {
    read_json(&root.join(APP_SETTINGS_FILE))
}

pub fn write_app_settings(root: &Path, settings: &Value) -> Result<(), SettingsError> {
    write_json_atomic(&root.join(APP_SETTINGS_FILE), settings)
}

/// Blank every non-empty secret string in place. Returns `(json path, value)` for each one removed.
pub fn scrub_secrets(value: &mut Value) -> Vec<(String, String)> {
    let mut removed = Vec::new();
    walk(value, String::new(), &mut removed);
    removed
}

fn walk(value: &mut Value, path: String, removed: &mut Vec<(String, String)>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                let p = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                if SECRET_KEYS.contains(&k.as_str()) {
                    if let Value::String(s) = v {
                        if !s.is_empty() {
                            removed.push((p, std::mem::take(s)));
                        }
                    }
                } else {
                    walk(v, p, removed);
                }
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter_mut().enumerate() {
                walk(v, format!("{path}[{i}]"), removed);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scrub_blanks_nested_secrets_and_reports_paths() {
        let mut v = json!({
            "oai_settings": { "proxy_password": "p1", "reverse_proxy": "http://x" },
            "proxies": [{ "name": "a", "password": "p2" }, { "name": "b", "password": "" }],
            "extension_settings": { "apiKey": "k", "caption": { "api_key": "c" } },
            "username": "me"
        });
        let removed = scrub_secrets(&mut v);
        let paths: Vec<_> = removed.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            paths,
            [
                "oai_settings.proxy_password",
                "proxies[0].password",
                "extension_settings.apiKey",
                "extension_settings.caption.api_key"
            ]
        );
        assert_eq!(v["oai_settings"]["proxy_password"], "");
        assert_eq!(v["oai_settings"]["reverse_proxy"], "http://x");
        assert_eq!(v["proxies"][0]["password"], "");
        assert_eq!(v["username"], "me");
    }

    #[test]
    fn write_is_pretty_and_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let v = json!({"b": 1, "a": {"c": [1, 2]}});
        write_settings(dir.path(), &v).unwrap();
        let text = std::fs::read_to_string(dir.path().join(SETTINGS_FILE)).unwrap();
        assert!(
            text.starts_with("{\n    \"b\": 1,"),
            "key order preserved + 4-space indent: {text}"
        );
        assert_eq!(read_settings(dir.path()).unwrap().unwrap(), v);
        assert!(!dir.path().join("settings.json.tmp").exists());
        assert!(read_app_settings(dir.path()).unwrap().is_none());
    }
}
