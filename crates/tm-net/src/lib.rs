//! Tavern Mobile 网络层（无 Tauri 依赖）：
//! - 单例 reqwest 客户端（rustls + 平台根证书、HTTP/2、连接池）
//! - SSE / JSON 行解析（与 ST sse-stream.js 的切分规则一致）
//! - `generate`：发出 Chat / Text Completion 请求，流式提取各后端的 delta（移植 ST getStreamingReply /
//!   generateTextGenWithStreaming / parseOllamaStream），通过回调推送累计文本；支持取消
//! - URL 策略：http 仅允许本地 / 局域网，除非显式放行

pub mod client;
pub mod error;
pub mod fetch;
pub mod generate;
pub mod policy;
pub mod reply;
pub mod sse;
pub mod tools;
pub mod types;

pub use client::client;
pub use error::NetError;
pub use fetch::{fetch, FetchRequest, FetchResponse, HttpMethod};
pub use generate::{generate, GenOutcome};
pub use policy::{check_url, is_local_or_private_host};
pub use reply::{detect_error, extract_full_reply, extract_stream_delta, Delta};
pub use sse::{JsonChunker, SseEvent, SseParser};
pub use tokio_util::sync::CancellationToken;
pub use types::{GenEvent, GenerateRequest, ReplyFormat, StreamFormat};
