//! Tavern Mobile 的分词层：
//! - tiktoken 编码族（gpt2/r50k、p50k、p50k_edit、cl100k、o200k）与 ST 服务端相同的 model → encoding 映射
//! - HuggingFace tokenizer.json（claude / llama3 / qwen2 / command-r / nemo / deepseek…）按名字注册、懒加载
//! - ST 的字节估算 `guesstimate`（UTF-8 字节数 / 3.35 向上取整）
//! - ST `/api/tokenizers/openai/count` 端点的逐段移植（tiktoken 每条消息开销、Claude 文本转换、sentencepiece 数组拼接）

pub mod claude;
pub mod encoding;
pub mod hf;
pub mod model;

use std::collections::HashMap;

pub use encoding::{Encoding, EncodingName};
pub use hf::HfRegistry;
pub use model::{openai_tokenizer_model, resolve_tokenizer_model, TokenizerModel};

/// ST BYTES_PER_TOKEN
pub const BYTES_PER_TOKEN: f64 = 3.35;

#[derive(Debug, thiserror::Error)]
pub enum TokenizerError {
    #[error("unknown tokenizer: {0}")]
    Unknown(String),
    #[error("tokenizer {0} is not loaded")]
    NotLoaded(String),
    #[error("hf tokenizer error: {0}")]
    Hf(String),
    #[error("tiktoken error: {0}")]
    Tiktoken(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, TokenizerError>;

/// ST utils.guesstimate：⌈UTF-8 字节数 / 3.35⌉
pub fn guesstimate(text: &str) -> usize {
    (text.len() as f64 / BYTES_PER_TOKEN).ceil() as usize
}

/// ST 前端 TOKENIZER_URLS 里的本地分词器名字（即 /api/tokenizers/<name>/encode）
pub const LOCAL_TOKENIZER_NAMES: &[&str] = &[
    "gpt2",
    "openai",
    "llama",
    "nerdstash",
    "nerdstash_v2",
    "mistral",
    "yi",
    "claude",
    "llama3",
    "gemma",
    "jamba",
    "qwen2",
    "command-r",
    "command-a",
    "nemo",
    "deepseek",
];

/// 分词服务：持有 HF 注册表；tiktoken 编码由 tiktoken-rs 全局单例提供。
#[derive(Default)]
pub struct TokenizerService {
    hf: HfRegistry,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct EncodeResult {
    pub ids: Vec<u32>,
    pub count: usize,
}

impl TokenizerService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn hf(&self) -> &HfRegistry {
        &self.hf
    }

    /// 注册一个 HF tokenizer.json 文件路径（懒加载）。name 用 ST 的本地分词器名，如 "claude"、"llama3"。
    pub fn register_hf(&self, name: &str, path: impl Into<std::path::PathBuf>) {
        self.hf.register(name, path);
    }

    /// 对应 `/api/tokenizers/<name>/encode`：返回 ids 与 count。
    /// `openai` 名字需要再给 model（走 tiktoken）；sentencepiece 名字在没有注册 HF 文件时回退估算（ids 为空）。
    pub fn encode(&self, name: &str, model: Option<&str>, text: &str) -> Result<EncodeResult> {
        match name {
            "gpt2" => Ok(tiktoken_result(Encoding::Gpt2.bpe(), text)),
            "openai" => {
                let model = model.unwrap_or("gpt-3.5-turbo");
                let enc = Encoding::for_openai_model(&model::openai_tokenizer_model(model))
                    .ok_or_else(|| TokenizerError::Unknown(model.to_string()))?;
                Ok(tiktoken_result(enc.bpe(), text))
            }
            other if LOCAL_TOKENIZER_NAMES.contains(&other) => match self.hf.get(other)? {
                Some(tok) => {
                    let ids = hf::encode(&tok, text)?;
                    Ok(EncodeResult {
                        count: ids.len(),
                        ids,
                    })
                }
                None => Ok(EncodeResult {
                    ids: vec![],
                    count: guesstimate(text),
                }),
            },
            other => Err(TokenizerError::Unknown(other.to_string())),
        }
    }

    /// 对应 `/api/tokenizers/<name>/decode`
    pub fn decode(&self, name: &str, model: Option<&str>, ids: &[u32]) -> Result<String> {
        match name {
            "gpt2" => Encoding::Gpt2
                .bpe()
                .decode(ids)
                .map_err(|e| TokenizerError::Tiktoken(e.to_string())),
            "openai" => {
                let model = model.unwrap_or("gpt-3.5-turbo");
                let enc = Encoding::for_openai_model(&model::openai_tokenizer_model(model))
                    .ok_or_else(|| TokenizerError::Unknown(model.to_string()))?;
                enc.bpe()
                    .decode(ids)
                    .map_err(|e| TokenizerError::Tiktoken(e.to_string()))
            }
            other if LOCAL_TOKENIZER_NAMES.contains(&other) => match self.hf.get(other)? {
                Some(tok) => hf::decode(&tok, ids),
                None => Err(TokenizerError::NotLoaded(other.to_string())),
            },
            other => Err(TokenizerError::Unknown(other.to_string())),
        }
    }

    /// 只要 count（前端 `countTokensFromServer` 读 data.count）
    pub fn count(&self, name: &str, model: Option<&str>, text: &str) -> Result<usize> {
        Ok(self.encode(name, model, text)?.count)
    }

    /// ST `/api/tokenizers/openai/count?model=` 逐段移植。messages 为 JSON 对象数组。
    /// 返回值与服务端一致（前端 countTokensOpenAIAsync 再做 -1 起始累加与 -2 的处理）。
    pub fn count_openai_messages(
        &self,
        request_model: &str,
        messages: &[serde_json::Value],
    ) -> Result<usize> {
        let model = model::openai_tokenizer_model(request_model);
        match model.as_str() {
            "claude" | "llama3" | "qwen2" | "command-r" | "command-a" | "nemo" | "deepseek" => {
                // WebTokenizer 路径：先按 Claude 旧文本格式拼成一段，再数
                let prompt = claude::convert_claude_prompt(messages);
                match self.hf.get(model.as_str())? {
                    Some(tok) => Ok(hf::encode(&tok, &prompt)?.len()),
                    None => Ok(guesstimate(&prompt)),
                }
            }
            "llama" | "mistral" | "yi" | "gemma" | "jamba" => {
                // sentencepiece 路径：所有字段值用 \n\n 拼接
                let joined = messages
                    .iter()
                    .flat_map(|m| {
                        m.as_object()
                            .map(|o| o.values().cloned().collect::<Vec<_>>())
                            .unwrap_or_default()
                    })
                    .map(|v| json_value_to_text(&v))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                match self.hf.get(model.as_str())? {
                    Some(tok) => Ok(hf::encode(&tok, &joined)?.len()),
                    None => Ok(guesstimate(&joined)),
                }
            }
            _ => Ok(count_tiktoken_messages(&model, messages)),
        }
    }
}

fn tiktoken_result(bpe: &tiktoken_rs::CoreBPE, text: &str) -> EncodeResult {
    let ids = bpe.encode_ordinary(text);
    EncodeResult {
        count: ids.len(),
        ids,
    }
}

/// 服务端 tiktoken 分支：每条 +tokensPerMessage，每个字段 encode 长度，name 字段 +tokensPerName，整次 +3；
/// gpt-3.5-turbo-0301 每条再 +9。字段值非字符串时按 JSON 文本编码（服务端会抛错跳过该条，这里取更宽松的处理）。
pub fn count_tiktoken_messages(query_model: &str, messages: &[serde_json::Value]) -> usize {
    let legacy = query_model.contains("gpt-3.5-turbo-0301");
    let tokens_per_name: i64 = if legacy { -1 } else { 1 };
    let tokens_per_message: i64 = if legacy { 4 } else { 3 };
    let enc = Encoding::for_openai_model(query_model).unwrap_or(Encoding::Cl100k);
    let bpe = enc.bpe();
    let mut num: i64 = 0;
    for msg in messages {
        num += tokens_per_message;
        if let Some(obj) = msg.as_object() {
            for (key, value) in obj {
                num += bpe.encode_ordinary(&json_value_to_text(value)).len() as i64;
                if key == "name" {
                    num += tokens_per_name;
                }
            }
        }
    }
    num += 3;
    if legacy {
        num += 9;
    }
    num.max(0) as usize
}

pub(crate) fn json_value_to_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 便捷：按名字批量注册（name → path）
pub fn register_all(service: &TokenizerService, paths: &HashMap<String, std::path::PathBuf>) {
    for (name, path) in paths {
        service.register_hf(name, path.clone());
    }
}
