use futures_util::StreamExt;
use reqwest::header::HeaderMap;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::client::client;
use crate::error::NetError;
use crate::policy::check_url;
use crate::reply::{detect_error, extract_full_reply, extract_stream_delta, ollama_to_choices};
use crate::sse::{JsonChunker, SseParser};
use crate::tools::{full_reply_tool_calls, wants_tool_calls, ToolCallAccumulator};
use crate::types::{GenEvent, GenerateRequest, ReplyFormat, StreamFormat};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct GenOutcome {
    pub text: String,
    pub reasoning: String,
    pub swipes: Vec<String>,
    /// 非流式时的完整响应
    pub raw: Option<Value>,
    /// 模型请求的工具调用；只在请求体带了 `tools` 时收集
    pub tool_calls: Vec<Value>,
}

/// 逐块 UTF-8 解码，跨块的多字节序列留到下一块
#[derive(Default)]
struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(s) => {
                let out = s.to_string();
                self.pending.clear();
                out
            }
            Err(e) => {
                let valid = e.valid_up_to();
                if e.error_len().is_some() {
                    // 真正的非法字节：有损替换，继续
                    let out = String::from_utf8_lossy(&self.pending).into_owned();
                    self.pending.clear();
                    return out;
                }
                let out = String::from_utf8_lossy(&self.pending[..valid]).into_owned();
                self.pending.drain(..valid);
                out
            }
        }
    }
}

fn build_headers(req: &GenerateRequest) -> Result<HeaderMap, NetError> {
    crate::fetch::build_headers(
        &req.headers,
        req.api_key.as_deref(),
        req.auth_header.as_deref(),
        true,
    )
}

fn push_delta(outcome: &mut GenOutcome, format: &ReplyFormat, json: &Value) -> Option<String> {
    let delta = extract_stream_delta(format, json);
    if let Some((i, text)) = delta.swipe {
        if outcome.swipes.len() <= i {
            outcome.swipes.resize(i + 1, String::new());
        }
        outcome.swipes[i].push_str(&text);
        return None;
    }
    outcome.text.push_str(&delta.text);
    outcome.reasoning.push_str(&delta.reasoning);
    Some(delta.text)
}

/// 发送请求；流式时每个 delta 回调一次 `GenEvent::Delta`（累计值），结束回调 `Done`；
/// 出错回调 `Error` 并返回 Err。`cancel` 触发后尽快返回 `NetError::Aborted`。
pub async fn generate(
    req: GenerateRequest,
    cancel: CancellationToken,
    mut on_event: impl FnMut(GenEvent),
) -> Result<GenOutcome, NetError> {
    let result = generate_inner(&req, &cancel, &mut on_event).await;
    match &result {
        Ok(outcome) => on_event(GenEvent::Done {
            text: outcome.text.clone(),
            reasoning: outcome.reasoning.clone(),
            swipes: outcome.swipes.clone(),
            raw: outcome.raw.clone(),
            tool_calls: outcome.tool_calls.clone(),
        }),
        Err(NetError::Aborted) => {}
        Err(e) => {
            let status = if let NetError::Http { status, .. } = e {
                Some(*status)
            } else {
                None
            };
            on_event(GenEvent::Error {
                status,
                message: e.to_string(),
            });
        }
    }
    result
}

async fn generate_inner(
    req: &GenerateRequest,
    cancel: &CancellationToken,
    on_event: &mut impl FnMut(GenEvent),
) -> Result<GenOutcome, NetError> {
    let url = check_url(&req.url, req.allow_insecure_http)?;
    let headers = build_headers(req)?;
    let mut builder = client().post(url).headers(headers).json(&req.body);
    if let (false, Some(ms)) = (req.stream, req.timeout_ms) {
        builder = builder.timeout(std::time::Duration::from_millis(ms));
    }

    let response = tokio::select! {
        r = builder.send() => r?,
        _ = cancel.cancelled() => return Err(NetError::Aborted),
    };
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|j| detect_error(&j))
            .unwrap_or_else(|| {
                if text.is_empty() {
                    status.to_string()
                } else {
                    text.clone()
                }
            });
        return Err(NetError::Http {
            status: status.as_u16(),
            message,
        });
    }
    on_event(GenEvent::Started {
        status: status.as_u16(),
    });

    let mut outcome = GenOutcome::default();
    let mut tools = wants_tool_calls(req).then(ToolCallAccumulator::default);

    if !req.stream {
        let text = tokio::select! {
            t = response.text() => t?,
            _ = cancel.cancelled() => return Err(NetError::Aborted),
        };
        let json: Value = serde_json::from_str(&text)?;
        if let Some(msg) = detect_error(&json) {
            return Err(NetError::Upstream(msg));
        }
        let (t, r) = extract_full_reply(&req.format, &json);
        outcome.text = t;
        outcome.reasoning = r;
        if tools.is_some() {
            outcome.tool_calls = full_reply_tool_calls(&req.format, &json);
        }
        outcome.raw = Some(json);
        return Ok(outcome);
    }

    let mut body = response.bytes_stream();
    let mut decoder = Utf8Decoder::default();
    let mut sse = SseParser::new();
    let mut lines = JsonChunker::new();

    loop {
        let next = tokio::select! {
            n = body.next() => n,
            _ = cancel.cancelled() => return Err(NetError::Aborted),
        };
        let Some(chunk) = next else { break };
        let chunk = chunk?;
        let text = decoder.push(&chunk);
        if text.is_empty() {
            continue;
        }
        let mut done = false;
        let jsons: Vec<Value> = match req.stream_format {
            StreamFormat::Sse => {
                let mut out = Vec::new();
                for ev in sse.push(&text) {
                    if ev.data == "[DONE]" {
                        // 同一块里 [DONE] 之前的事件仍要处理
                        done = true;
                        break;
                    }
                    match serde_json::from_str::<Value>(&ev.data) {
                        Ok(j) => out.push(j),
                        Err(_) => continue, // ST 对非 JSON 的 data 会抛错；这里跳过（如心跳注释）
                    }
                }
                out
            }
            StreamFormat::JsonLines => lines
                .push(&text)
                .into_iter()
                .map(|j| ollama_to_choices(&j))
                .collect(),
        };
        for json in jsons {
            if let Some(msg) = detect_error(&json) {
                return Err(NetError::Upstream(msg));
            }
            if let Some(acc) = tools.as_mut() {
                acc.push(&req.format, &json);
            }
            if let Some(chunk_text) = push_delta(&mut outcome, &req.format, &json) {
                on_event(GenEvent::Delta {
                    text: outcome.text.clone(),
                    chunk: chunk_text,
                    reasoning: outcome.reasoning.clone(),
                    swipes: outcome.swipes.clone(),
                });
            }
        }
        if done {
            break;
        }
    }
    if let Some(acc) = tools.take() {
        outcome.tool_calls = acc.finish();
    }
    Ok(outcome)
}
