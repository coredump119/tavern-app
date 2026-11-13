//! tiktoken 编码族与 OpenAI model → encoding 映射（数据来自 tiktoken npm 1.0.22 的 model_to_encoding.json）。
use std::collections::HashMap;
use std::sync::OnceLock;
use tiktoken_rs::CoreBPE;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Encoding {
    /// gpt2 / r50k_base（词表相同）
    Gpt2,
    P50k,
    P50kEdit,
    Cl100k,
    O200k,
    O200kHarmony,
}

pub type EncodingName = &'static str;

impl Encoding {
    pub fn name(self) -> EncodingName {
        match self {
            Encoding::Gpt2 => "gpt2",
            Encoding::P50k => "p50k_base",
            Encoding::P50kEdit => "p50k_edit",
            Encoding::Cl100k => "cl100k_base",
            Encoding::O200k => "o200k_base",
            Encoding::O200kHarmony => "o200k_harmony",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "gpt2" | "r50k_base" => Encoding::Gpt2,
            "p50k_base" => Encoding::P50k,
            "p50k_edit" => Encoding::P50kEdit,
            "cl100k_base" => Encoding::Cl100k,
            "o200k_base" => Encoding::O200k,
            "o200k_harmony" => Encoding::O200kHarmony,
            _ => return None,
        })
    }

    pub fn bpe(self) -> &'static CoreBPE {
        match self {
            Encoding::Gpt2 => tiktoken_rs::r50k_base_singleton(),
            Encoding::P50k => tiktoken_rs::p50k_base_singleton(),
            Encoding::P50kEdit => tiktoken_rs::p50k_edit_singleton(),
            Encoding::Cl100k => tiktoken_rs::cl100k_base_singleton(),
            Encoding::O200k => tiktoken_rs::o200k_base_singleton(),
            Encoding::O200kHarmony => tiktoken_rs::o200k_harmony_singleton(),
        }
    }

    /// tiktoken `encoding_for_model`：精确匹配 model_to_encoding.json；未知模型返回 None（npm 版会抛错）
    pub fn for_openai_model(model: &str) -> Option<Self> {
        static MAP: OnceLock<HashMap<String, Encoding>> = OnceLock::new();
        let map = MAP.get_or_init(|| {
            let raw: HashMap<String, String> =
                serde_json::from_str(include_str!("../data/model_to_encoding.json"))
                    .expect("model_to_encoding.json");
            raw.into_iter()
                .filter_map(|(k, v)| Encoding::from_name(&v).map(|e| (k, e)))
                .collect()
        });
        map.get(model).copied()
    }
}
