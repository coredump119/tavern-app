//! ST secrets.json 语义（src/endpoints/secrets.js SecretManager）搬进钥匙串。
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::backend::SecretBackend;
use crate::error::{KeysError, Result};

/// ST SECRET_KEYS（不含 _migrated）
pub const SECRET_KEYS: &[&str] = &[
    "api_key_horde",
    "api_key_mancer",
    "api_key_vllm",
    "api_key_aphrodite",
    "api_key_tabby",
    "api_key_openai",
    "api_key_novel",
    "api_key_claude",
    "deepl",
    "libre",
    "libre_url",
    "lingva_url",
    "api_key_openrouter",
    "api_key_ai21",
    "oneringtranslator_url",
    "deeplx_url",
    "api_key_makersuite",
    "api_key_vertexai",
    "api_key_serpapi",
    "api_key_togetherai",
    "api_key_mistralai",
    "api_key_custom",
    "api_key_ooba",
    "api_key_infermaticai",
    "api_key_dreamgen",
    "api_key_nomicai",
    "api_key_koboldcpp",
    "api_key_llamacpp",
    "api_key_cohere",
    "api_key_perplexity",
    "api_key_groq",
    "api_key_azure_tts",
    "api_key_featherless",
    "api_key_huggingface",
    "api_key_stability",
    "api_key_custom_openai_tts",
    "api_key_tavily",
    "api_key_chutes",
    "api_key_electronhub",
    "api_key_nanogpt",
    "api_key_bfl",
    "api_key_comfy_runpod",
    "api_key_falai",
    "api_key_generic",
    "api_key_deepseek",
    "api_key_serper",
    "api_key_aimlapi",
    "api_key_xai",
    "api_key_fireworks",
    "vertexai_service_account_json",
    "api_key_minimax",
    "minimax_group_id",
    "api_key_moonshot",
    "api_key_cometapi",
    "api_key_azure_openai",
    "api_key_zai",
    "api_key_siliconflow",
    "api_key_elevenlabs",
    "api_key_pollinations",
    // 反向代理预设密码（label = 预设名），ST 原本明文放 settings.json
    "proxy_password",
];

/// 不需要遮掩的 key（ST EXPORTABLE_KEYS：它们是 URL 不是密钥）
const EXPORTABLE_KEYS: &[&str] = &[
    "libre_url",
    "lingva_url",
    "oneringtranslator_url",
    "deeplx_url",
];

/// 一把密钥的元数据（不含值）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretMeta {
    pub id: String,
    pub label: String,
    pub active: bool,
    /// ST getMaskedValue：≤10 字符全遮，否则 7 个 * + 末 3 位
    #[serde(default)]
    pub masked: String,
}

/// 请求时引用密钥的方式（密钥值本身不过 IPC）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SecretRef {
    /// 按 ST key 取 active（或指定 id）
    Keyring {
        key: String,
        #[serde(default)]
        id: Option<String>,
    },
    /// 反向代理预设密码
    ProxyPassword {
        preset: String,
    },
    None,
}

/// ST getMaskedValue
pub fn mask_secret(value: &str, key: &str) -> String {
    if EXPORTABLE_KEYS.contains(&key) {
        return value.to_string();
    }
    let threshold = 10usize;
    let exposed = 3usize;
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= threshold {
        return "*".repeat(threshold);
    }
    let tail: String = chars[chars.len() - exposed..].iter().collect();
    format!("{}{}", "*".repeat(threshold - exposed), tail)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct MetaList(Vec<SecretMeta>);

pub struct SecretVault<B: SecretBackend> {
    backend: B,
}

impl<B: SecretBackend> SecretVault<B> {
    pub fn new(backend: B) -> Self {
        Self { backend }
    }

    pub fn backend_kind(&self) -> &'static str {
        self.backend.kind()
    }

    fn check_key(key: &str) -> Result<()> {
        if SECRET_KEYS.contains(&key) {
            Ok(())
        } else {
            Err(KeysError::UnknownKey(key.to_string()))
        }
    }

    fn meta_name(key: &str) -> String {
        key.to_string()
    }
    fn value_name(key: &str, id: &str) -> String {
        format!("{key}/{id}")
    }

    fn load_meta(&self, key: &str) -> Result<Vec<SecretMeta>> {
        match self.backend.get(&Self::meta_name(key))? {
            Some(json) => Ok(serde_json::from_str::<MetaList>(&json)?.0),
            None => Ok(Vec::new()),
        }
    }

    fn save_meta(&self, key: &str, list: &[SecretMeta]) -> Result<()> {
        if list.is_empty() {
            self.backend.delete(&Self::meta_name(key))
        } else {
            let stripped: Vec<SecretMeta> = list
                .iter()
                .map(|m| SecretMeta {
                    masked: String::new(),
                    ..m.clone()
                })
                .collect();
            self.backend.set(
                &Self::meta_name(key),
                &serde_json::to_string(&MetaList(stripped))?,
            )
        }
    }

    /// ST writeSecret：新密钥成为唯一 active；返回 id
    pub fn write(&self, key: &str, value: &str, label: Option<&str>) -> Result<String> {
        Self::check_key(key)?;
        let mut list = self.load_meta(key)?;
        for m in &mut list {
            m.active = false;
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.backend.set(&Self::value_name(key, &id), value)?;
        list.push(SecretMeta {
            id: id.clone(),
            label: label.unwrap_or("Unlabeled").to_string(),
            active: true,
            masked: String::new(),
        });
        self.save_meta(key, &list)?;
        Ok(id)
    }

    /// ST deleteSecret：删掉指定 id；若删的是 active，剩下的最后一把变 active
    pub fn delete(&self, key: &str, id: &str) -> Result<()> {
        Self::check_key(key)?;
        let mut list = self.load_meta(key)?;
        let Some(pos) = list.iter().position(|m| m.id == id) else {
            return Err(KeysError::NotFound(format!("{key}/{id}")));
        };
        let was_active = list[pos].active;
        list.remove(pos);
        self.backend.delete(&Self::value_name(key, id))?;
        if was_active {
            if let Some(last) = list.last_mut() {
                last.active = true;
            }
        }
        self.save_meta(key, &list)
    }

    /// ST readSecret(key, id?)：指定 id 或 active 的值
    pub fn read(&self, key: &str, id: Option<&str>) -> Result<Option<String>> {
        Self::check_key(key)?;
        let list = self.load_meta(key)?;
        let target = match id {
            Some(id) => list.iter().find(|m| m.id == id),
            None => list.iter().find(|m| m.active),
        };
        match target {
            Some(m) => self.backend.get(&Self::value_name(key, &m.id)),
            None => Ok(None),
        }
    }

    /// ST rotateSecret：把指定 id 设为 active
    pub fn rotate(&self, key: &str, id: &str) -> Result<()> {
        Self::check_key(key)?;
        let mut list = self.load_meta(key)?;
        if !list.iter().any(|m| m.id == id) {
            return Err(KeysError::NotFound(format!("{key}/{id}")));
        }
        for m in &mut list {
            m.active = m.id == id;
        }
        self.save_meta(key, &list)
    }

    /// ST renameSecret：只改 label
    pub fn rename(&self, key: &str, id: &str, label: &str) -> Result<()> {
        Self::check_key(key)?;
        let mut list = self.load_meta(key)?;
        let Some(meta) = list.iter_mut().find(|m| m.id == id) else {
            return Err(KeysError::NotFound(format!("{key}/{id}")));
        };
        meta.label = label.to_string();
        self.save_meta(key, &list)
    }

    /// ST findSecret：元数据 + 遮掩值
    pub fn find(&self, key: &str) -> Result<Vec<SecretMeta>> {
        Self::check_key(key)?;
        let list = self.load_meta(key)?;
        let mut out = Vec::with_capacity(list.len());
        for m in list {
            let value = self
                .backend
                .get(&Self::value_name(key, &m.id))?
                .unwrap_or_default();
            out.push(SecretMeta {
                masked: mask_secret(&value, key),
                ..m
            });
        }
        Ok(out)
    }

    /// ST readSecretState：每个 key 是否至少有一把密钥
    pub fn state(&self) -> Result<HashMap<String, bool>> {
        let mut out = HashMap::new();
        for key in SECRET_KEYS {
            out.insert(key.to_string(), !self.load_meta(key)?.is_empty());
        }
        Ok(out)
    }

    /// 反向代理预设密码：label = 预设名
    pub fn set_proxy_password(&self, preset: &str, value: &str) -> Result<String> {
        let list = self.load_meta("proxy_password")?;
        for m in list.iter().filter(|m| m.label == preset) {
            self.delete("proxy_password", &m.id)?;
        }
        self.write("proxy_password", value, Some(preset))
    }

    pub fn proxy_password(&self, preset: &str) -> Result<Option<String>> {
        let list = self.load_meta("proxy_password")?;
        match list.iter().find(|m| m.label == preset) {
            Some(m) => self.backend.get(&Self::value_name("proxy_password", &m.id)),
            None => Ok(None),
        }
    }

    /// 解析请求里的密钥引用
    pub fn resolve(&self, secret: &SecretRef) -> Result<Option<String>> {
        match secret {
            SecretRef::Keyring { key, id } => self.read(key, id.as_deref()),
            SecretRef::ProxyPassword { preset } => self.proxy_password(preset),
            SecretRef::None => Ok(None),
        }
    }
}
