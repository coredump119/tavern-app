use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// 流式数据的外层格式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StreamFormat {
    #[default]
    Sse,
    /// Ollama /api/generate：每块一个 JSON
    JsonLines,
}

/// 回复 delta 的提取方式（移植 ST 前端各源分支）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ReplyFormat {
    /// OpenAI 兼容 chat completions；`source` = chat_completion_source
    ChatCompletion { source: String },
    /// text completions；`api_type` = textgen 类型（ooba / llamacpp / ollama / …）
    TextCompletion { api_type: String },
}

/// 一次生成请求。`body` 是 core 已经算好的上游请求体（字节级与 ST 一致），这里只负责发送与解析。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateRequest {
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// 有值且 headers 没有 authorization 时加 `Authorization: Bearer`
    #[serde(default)]
    pub api_key: Option<String>,
    /// 密钥放哪个头（如 Claude 的 `x-api-key`，原样放值）；None 则 `Authorization: Bearer`
    #[serde(default)]
    pub auth_header: Option<String>,
    pub body: serde_json::Value,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub stream_format: StreamFormat,
    pub format: ReplyFormat,
    /// 允许对非本地主机走 http（用户已确认）
    #[serde(default)]
    pub allow_insecure_http: bool,
    /// 非流式请求的总超时；None 则不限
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// 推给 UI 的事件。`text` / `reasoning` 为累计值（与 ST 流式生成器的 yield 一致）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum GenEvent {
    Started {
        status: u16,
    },
    Delta {
        text: String,
        chunk: String,
        reasoning: String,
        swipes: Vec<String>,
    },
    Done {
        text: String,
        reasoning: String,
        swipes: Vec<String>,
        raw: Option<serde_json::Value>,
        /// 模型请求的工具调用（OpenAI 形）；没有就不出现在事件里
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<serde_json::Value>,
    },
    Error {
        status: Option<u16>,
        message: String,
    },
}
