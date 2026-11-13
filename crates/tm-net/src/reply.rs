//! 各后端回复的提取：
//! - 流式：ST openai.js getStreamingReply（CC 各源）与 textgen-settings.js generateTextGenWithStreaming（TC）
//! - 非流式：ST 取 choices[0].message.content / choices[0].text / content / response
//! - 错误：ST tryParseStreamingError（error.message | error | message | detail）
use serde_json::Value;

use crate::types::ReplyFormat;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Delta {
    pub text: String,
    pub reasoning: String,
    /// 多 swipe：(swipe 下标, 增量文本)
    pub swipe: Option<(usize, String)>,
}

fn s(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(x)) => Some(x.clone()),
        Some(Value::Array(parts)) => {
            // Mistral 等：content 为 [{type:'text', text}] 数组
            let joined: String = parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect();
            Some(joined)
        }
        _ => None,
    }
}

fn first_choice(json: &Value) -> Option<&Value> {
    json.get("choices").and_then(|c| c.get(0))
}

fn choice_index(choice: Option<&Value>) -> u64 {
    choice
        .and_then(|c| c.get("index"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

/// CC：choices[0].delta.content ?? message.content ?? text
fn openai_like_text(json: &Value) -> String {
    let c = first_choice(json);
    s(c.and_then(|c| c.pointer("/delta/content")))
        .or_else(|| s(c.and_then(|c| c.pointer("/message/content"))))
        .or_else(|| s(c.and_then(|c| c.get("text"))))
        .unwrap_or_default()
}

fn choices_pick(json: &Value, path: &str) -> Option<String> {
    json.get("choices")?
        .as_array()?
        .iter()
        .find_map(|c| c.pointer(path).and_then(Value::as_str).map(str::to_string))
}

/// getStreamingReply(data, state) 的文本与 reasoning 增量
fn cc_stream_reply(source: &str, json: &Value) -> (String, String) {
    match source {
        "claude" => (
            s(json.pointer("/delta/text")).unwrap_or_default(),
            s(json.pointer("/delta/thinking")).unwrap_or_default(),
        ),
        "makersuite" | "vertexai" => {
            let parts = json
                .pointer("/candidates/0/content/parts")
                .and_then(Value::as_array);
            let text = parts
                .and_then(|p| {
                    p.iter()
                        .find(|x| !x.get("thought").and_then(Value::as_bool).unwrap_or(false))
                })
                .and_then(|x| x.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let thought = parts
                .and_then(|p| {
                    p.iter()
                        .find(|x| x.get("thought").and_then(Value::as_bool).unwrap_or(false))
                })
                .and_then(|x| x.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            (text, thought)
        }
        "cohere" => (
            s(json.pointer("/delta/message/content/text"))
                .or_else(|| s(json.pointer("/delta/message/tool_plan")))
                .unwrap_or_default(),
            String::new(),
        ),
        "deepseek" | "xai" => (
            s(first_choice(json).and_then(|c| c.pointer("/delta/content"))).unwrap_or_default(),
            choices_pick(json, "/delta/reasoning_content").unwrap_or_default(),
        ),
        "openrouter" => (
            openai_like_text(json),
            choices_pick(json, "/delta/reasoning")
                .or_else(|| choices_pick(json, "/delta/reasoning_content"))
                .or_else(|| choices_pick(json, "/message/reasoning"))
                .or_else(|| choices_pick(json, "/message/reasoning_content"))
                .unwrap_or_default(),
        ),
        "custom" | "pollinations" | "aimlapi" | "moonshot" | "cometapi" | "electronhub"
        | "nanogpt" | "zai" | "siliconflow" | "chutes" | "workers_ai" => (
            openai_like_text(json),
            choices_pick(json, "/delta/reasoning_content")
                .or_else(|| choices_pick(json, "/delta/reasoning"))
                .unwrap_or_default(),
        ),
        "mistralai" => (
            openai_like_text(json),
            first_choice(json)
                .and_then(|c| c.pointer("/delta/content/0/thinking/0/text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
        _ => (openai_like_text(json), String::new()),
    }
}

/// 一个流式 JSON 块 → delta
pub fn extract_stream_delta(format: &ReplyFormat, json: &Value) -> Delta {
    match format {
        ReplyFormat::ChatCompletion { source } => {
            let idx = choice_index(first_choice(json));
            let (text, reasoning) = cc_stream_reply(source, json);
            if idx > 0 {
                // 多 swipe：只累计文本（ST 不记录 swipe 的 reasoning）
                Delta {
                    swipe: Some((idx as usize - 1, text)),
                    ..Default::default()
                }
            } else {
                Delta {
                    text,
                    reasoning,
                    swipe: None,
                }
            }
        }
        ReplyFormat::TextCompletion { .. } => {
            let c = first_choice(json);
            let idx = choice_index(c);
            if idx > 0 {
                return Delta {
                    swipe: Some((
                        idx as usize - 1,
                        s(c.and_then(|c| c.get("text"))).unwrap_or_default(),
                    )),
                    ..Default::default()
                };
            }
            let top_index = json.get("index").and_then(Value::as_u64).unwrap_or(0);
            if top_index > 0 {
                // llama.cpp 多 swipe
                return Delta {
                    swipe: Some((
                        top_index as usize - 1,
                        s(json.get("content")).unwrap_or_default(),
                    )),
                    ..Default::default()
                };
            }
            let text = s(c.and_then(|c| c.get("text")))
                .filter(|t| !t.is_empty())
                .or_else(|| s(json.get("content")))
                .unwrap_or_default();
            let reasoning = s(c.and_then(|c| c.get("reasoning")))
                .or_else(|| s(c.and_then(|c| c.get("thinking"))))
                .unwrap_or_default();
            Delta {
                text,
                reasoning,
                swipe: None,
            }
        }
    }
}

/// Ollama JSON 行 → ST 服务端转成的 `{choices:[{text, thinking}]}`
pub fn ollama_to_choices(json: &Value) -> Value {
    serde_json::json!({
        "choices": [{
            "text": json.get("response").and_then(Value::as_str).unwrap_or_default(),
            "thinking": json.get("thinking").and_then(Value::as_str).unwrap_or_default(),
        }]
    })
}

/// 非流式整段回复 → (text, reasoning)
pub fn extract_full_reply(format: &ReplyFormat, json: &Value) -> (String, String) {
    match format {
        ReplyFormat::ChatCompletion { source } => match source.as_str() {
            "claude" => (
                json.get("content")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                            .filter_map(|p| p.get("text").and_then(Value::as_str))
                            .collect::<String>()
                    })
                    .unwrap_or_default(),
                json.get("content")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter(|p| p.get("type").and_then(Value::as_str) == Some("thinking"))
                            .filter_map(|p| p.get("thinking").and_then(Value::as_str))
                            .collect::<String>()
                    })
                    .unwrap_or_default(),
            ),
            _ => {
                let c = first_choice(json);
                (
                    s(c.and_then(|c| c.pointer("/message/content")))
                        .or_else(|| s(c.and_then(|c| c.get("text"))))
                        .unwrap_or_default(),
                    choices_pick(json, "/message/reasoning_content")
                        .or_else(|| choices_pick(json, "/message/reasoning"))
                        .unwrap_or_default(),
                )
            }
        },
        ReplyFormat::TextCompletion { api_type } => {
            if api_type == "ollama" {
                return (
                    s(json.get("response")).unwrap_or_default(),
                    s(json.get("thinking")).unwrap_or_default(),
                );
            }
            let c = first_choice(json);
            (
                s(c.and_then(|c| c.get("text")))
                    .or_else(|| s(c.and_then(|c| c.pointer("/message/content"))))
                    .or_else(|| s(json.get("content")))
                    .unwrap_or_default(),
                s(c.and_then(|c| c.get("reasoning")))
                    .or_else(|| s(c.and_then(|c| c.get("thinking"))))
                    .unwrap_or_default(),
            )
        }
    }
}

/// tryParseStreamingError：有错误信息则返回
pub fn detect_error(json: &Value) -> Option<String> {
    if !json.is_object() {
        return None;
    }
    if let Some(err) = json.get("error") {
        if let Some(m) = err.get("message").and_then(Value::as_str) {
            return Some(m.to_string());
        }
        if let Some(m) = err.as_str() {
            return Some(m.to_string());
        }
        if err.is_object() || err.as_bool() == Some(true) {
            return Some(
                json.get("response")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| err.to_string()),
            );
        }
    }
    if let Some(m) = json.get("message").and_then(Value::as_str) {
        return Some(m.to_string());
    }
    if let Some(d) = json.get("detail") {
        return Some(
            d.pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if let Some(t) = d.as_str() {
                        t.to_string()
                    } else {
                        d.to_string()
                    }
                }),
        );
    }
    None
}
