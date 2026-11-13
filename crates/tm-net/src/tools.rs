//! 模型请求的工具调用（function calling）：只收集、不执行。
//! 形状移植 ST tool-calling.js（各源的流式 delta 与非流式回复），统一输出为 OpenAI 形：
//! `{ id, type: "function", function: { name, arguments: <JSON 字符串> }, thought_signature? }`。
use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::types::{GenerateRequest, ReplyFormat};

#[derive(Debug, Default, Clone, PartialEq)]
struct Call {
    id: String,
    name: String,
    arguments: String,
    signature: Option<String>,
}

impl Call {
    fn into_value(self, position: usize) -> Value {
        let id = if self.id.is_empty() {
            format!("call_{position}")
        } else {
            self.id
        };
        let arguments = if self.arguments.trim().is_empty() {
            "{}".to_string()
        } else {
            self.arguments
        };
        let mut out = json!({
            "id": id,
            "type": "function",
            "function": { "name": self.name, "arguments": arguments },
        });
        if let Some(signature) = self.signature {
            out["thought_signature"] = Value::String(signature);
        }
        out
    }
}

fn text(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or_default()
}

/// 参数可能是字符串（OpenAI）也可能已是对象（Claude input / Gemini args）
fn arguments_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn set_if_empty(slot: &mut String, value: &str) {
    if slot.is_empty() && !value.is_empty() {
        slot.push_str(value);
    }
}

fn openai_call(item: &Value) -> Call {
    Call {
        id: text(item.get("id")).to_string(),
        name: text(item.pointer("/function/name")).to_string(),
        arguments: arguments_text(item.pointer("/function/arguments")),
        signature: None,
    }
}

fn google_calls(json: &Value) -> Vec<Call> {
    json.pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| {
                    let call = part.get("functionCall")?;
                    Some(Call {
                        id: text(call.get("id")).to_string(),
                        name: text(call.get("name")).to_string(),
                        arguments: arguments_text(call.get("args")),
                        signature: part
                            .get("thoughtSignature")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 本次请求是否带了工具：没带就完全不解析（普通文本路径零开销）
pub fn wants_tool_calls(req: &GenerateRequest) -> bool {
    matches!(req.format, ReplyFormat::ChatCompletion { .. })
        && req
            .body
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| !tools.is_empty())
}

/// 流式：按各源的 delta 形状累计
#[derive(Debug, Default)]
pub struct ToolCallAccumulator {
    calls: BTreeMap<u64, Call>,
}

impl ToolCallAccumulator {
    fn next_index(&self) -> u64 {
        self.calls.keys().next_back().map_or(0, |last| last + 1)
    }

    fn push_openai(&mut self, json: &Value) {
        let Some(items) = json
            .pointer("/choices/0/delta/tool_calls")
            .and_then(Value::as_array)
        else {
            return;
        };
        for item in items {
            let delta = openai_call(item);
            // 个别兼容端不给 index：新 id 开新条目，否则接在最后一条上
            let index = item
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or_else(|| {
                    let known = self.calls.iter().find(|(_, c)| c.id == delta.id);
                    match (delta.id.is_empty(), known) {
                        (false, Some((i, _))) => *i,
                        (false, None) => self.next_index(),
                        (true, _) => self.next_index().saturating_sub(1),
                    }
                });
            let call = self.calls.entry(index).or_default();
            set_if_empty(&mut call.id, &delta.id);
            set_if_empty(&mut call.name, &delta.name);
            call.arguments.push_str(&delta.arguments);
        }
    }

    fn push_claude(&mut self, json: &Value) {
        let index = json.get("index").and_then(Value::as_u64).unwrap_or(0);
        if let Some(block) = json.get("content_block") {
            if text(block.get("type")) == "tool_use" {
                let call = self.calls.entry(index).or_default();
                call.id = text(block.get("id")).to_string();
                call.name = text(block.get("name")).to_string();
            }
            return;
        }
        if text(json.pointer("/delta/type")) != "input_json_delta" {
            return;
        }
        if let Some(call) = self.calls.get_mut(&index) {
            call.arguments
                .push_str(text(json.pointer("/delta/partial_json")));
        }
    }

    fn push_cohere(&mut self, json: &Value) {
        let Some(delta) = json.pointer("/delta/message/tool_calls") else {
            return;
        };
        let index = json.get("index").and_then(Value::as_u64).unwrap_or(0);
        let part = openai_call(delta);
        let call = self.calls.entry(index).or_default();
        set_if_empty(&mut call.id, &part.id);
        set_if_empty(&mut call.name, &part.name);
        call.arguments.push_str(&part.arguments);
    }

    pub fn push(&mut self, format: &ReplyFormat, json: &Value) {
        let ReplyFormat::ChatCompletion { source } = format else {
            return;
        };
        match source.as_str() {
            "claude" => self.push_claude(json),
            "cohere" => self.push_cohere(json),
            "makersuite" | "vertexai" => {
                // Gemini 每个 functionCall 都是完整的一条
                for call in google_calls(json) {
                    let index = self.next_index();
                    self.calls.insert(index, call);
                }
            }
            _ => self.push_openai(json),
        }
    }

    pub fn finish(self) -> Vec<Value> {
        self.calls
            .into_values()
            .filter(|call| !call.name.is_empty())
            .enumerate()
            .map(|(i, call)| call.into_value(i))
            .collect()
    }
}

/// 非流式：从完整回复里取工具调用
pub fn full_reply_tool_calls(format: &ReplyFormat, json: &Value) -> Vec<Value> {
    let ReplyFormat::ChatCompletion { source } = format else {
        return Vec::new();
    };
    let list = |path: &str| -> Vec<Call> {
        json.pointer(path)
            .and_then(Value::as_array)
            .map(|items| items.iter().map(openai_call).collect())
            .unwrap_or_default()
    };
    let calls: Vec<Call> = match source.as_str() {
        "claude" => json
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|block| text(block.get("type")) == "tool_use")
                    .map(|block| Call {
                        id: text(block.get("id")).to_string(),
                        name: text(block.get("name")).to_string(),
                        arguments: arguments_text(block.get("input")),
                        signature: None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        "cohere" => list("/message/tool_calls"),
        "makersuite" | "vertexai" => google_calls(json),
        _ => list("/choices/0/message/tool_calls"),
    };
    calls
        .into_iter()
        .filter(|call| !call.name.is_empty())
        .enumerate()
        .map(|(i, call)| call.into_value(i))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cc(source: &str) -> ReplyFormat {
        ReplyFormat::ChatCompletion {
            source: source.to_string(),
        }
    }

    fn request(format: ReplyFormat, body: Value) -> GenerateRequest {
        GenerateRequest {
            url: "https://example.invalid/v1/chat/completions".to_string(),
            headers: Default::default(),
            api_key: None,
            auth_header: None,
            body,
            stream: true,
            stream_format: Default::default(),
            format,
            allow_insecure_http: false,
            timeout_ms: None,
        }
    }

    fn collect(source: &str, chunks: &[Value]) -> Vec<Value> {
        let mut acc = ToolCallAccumulator::default();
        for chunk in chunks {
            acc.push(&cc(source), chunk);
        }
        acc.finish()
    }

    #[test]
    fn only_chat_completion_requests_with_tools_are_parsed() {
        let tools = json!({ "tools": [{ "type": "function", "function": { "name": "roll" } }] });
        assert!(wants_tool_calls(&request(cc("openai"), tools.clone())));
        assert!(!wants_tool_calls(&request(
            cc("openai"),
            json!({ "tools": [] })
        )));
        assert!(!wants_tool_calls(&request(
            cc("openai"),
            json!({ "messages": [] })
        )));
        let text = ReplyFormat::TextCompletion {
            api_type: "ooba".to_string(),
        };
        assert!(!wants_tool_calls(&request(text, tools)));
    }

    #[test]
    fn openai_deltas_join_arguments_per_index() {
        let calls = collect(
            "openai",
            &[
                json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [
                    { "index": 0, "id": "call_a", "type": "function",
                      "function": { "name": "roll", "arguments": "" } }
                ] } }] }),
                json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [
                    { "index": 0, "function": { "arguments": "{\"sides\":" } },
                    { "index": 1, "id": "call_b", "function": { "name": "look", "arguments": "{}" } }
                ] } }] }),
                json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [
                    { "index": 0, "function": { "arguments": "6}" } }
                ] } }] }),
                json!({ "choices": [{ "index": 0, "delta": { "content": "done" } }] }),
            ],
        );
        assert_eq!(
            calls,
            vec![
                json!({ "id": "call_a", "type": "function",
                        "function": { "name": "roll", "arguments": "{\"sides\":6}" } }),
                json!({ "id": "call_b", "type": "function",
                        "function": { "name": "look", "arguments": "{}" } }),
            ]
        );
    }

    #[test]
    fn openai_deltas_without_index_split_on_a_new_id() {
        let calls = collect(
            "custom",
            &[
                json!({ "choices": [{ "delta": { "tool_calls": [
                    { "id": "a", "function": { "name": "one", "arguments": "{\"x\"" } }
                ] } }] }),
                json!({ "choices": [{ "delta": { "tool_calls": [
                    { "function": { "arguments": ":1}" } }
                ] } }] }),
                json!({ "choices": [{ "delta": { "tool_calls": [
                    { "id": "b", "function": { "name": "two", "arguments": { "y": 2 } } }
                ] } }] }),
            ],
        );
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["function"]["arguments"], "{\"x\":1}");
        assert_eq!(calls[1]["id"], "b");
        assert_eq!(calls[1]["function"]["arguments"], "{\"y\":2}");
    }

    #[test]
    fn claude_blocks_collect_partial_json() {
        let calls = collect(
            "claude",
            &[
                json!({ "type": "content_block_start", "index": 0,
                        "content_block": { "type": "text", "text": "" } }),
                json!({ "type": "content_block_delta", "index": 0,
                        "delta": { "type": "text_delta", "text": "Rolling." } }),
                json!({ "type": "content_block_start", "index": 1,
                        "content_block": { "type": "tool_use", "id": "toolu_1", "name": "roll", "input": {} } }),
                json!({ "type": "content_block_delta", "index": 1,
                        "delta": { "type": "input_json_delta", "partial_json": "{\"sides\"" } }),
                json!({ "type": "content_block_delta", "index": 1,
                        "delta": { "type": "input_json_delta", "partial_json": ": 20}" } }),
                json!({ "type": "content_block_stop", "index": 1 }),
            ],
        );
        assert_eq!(
            calls,
            vec![json!({ "id": "toolu_1", "type": "function",
                         "function": { "name": "roll", "arguments": "{\"sides\": 20}" } })]
        );
    }

    #[test]
    fn claude_tool_without_input_gets_an_empty_object() {
        let calls = collect(
            "claude",
            &[json!({ "type": "content_block_start", "index": 0,
                      "content_block": { "type": "tool_use", "id": "toolu_2", "name": "look" } })],
        );
        assert_eq!(calls[0]["function"]["arguments"], "{}");
    }

    #[test]
    fn google_function_calls_get_ids_and_keep_the_signature() {
        let calls = collect(
            "makersuite",
            &[
                json!({ "candidates": [{ "content": { "parts": [{ "text": "hm" }] } }] }),
                json!({ "candidates": [{ "content": { "parts": [
                    { "functionCall": { "name": "roll", "args": { "sides": 6 } },
                      "thoughtSignature": "sig" },
                    { "functionCall": { "name": "look", "args": {} } }
                ] } }] }),
            ],
        );
        assert_eq!(
            calls,
            vec![
                json!({ "id": "call_0", "type": "function",
                        "function": { "name": "roll", "arguments": "{\"sides\":6}" },
                        "thought_signature": "sig" }),
                json!({ "id": "call_1", "type": "function",
                        "function": { "name": "look", "arguments": "{}" } }),
            ]
        );
    }

    #[test]
    fn cohere_start_and_delta_events() {
        let calls = collect(
            "cohere",
            &[
                json!({ "type": "tool-call-start", "index": 0, "delta": { "message": { "tool_calls":
                    { "id": "c1", "type": "function", "function": { "name": "roll", "arguments": "" } } } } }),
                json!({ "type": "tool-call-delta", "index": 0, "delta": { "message": { "tool_calls":
                    { "function": { "arguments": "{\"sides\":4}" } } } } }),
                json!({ "type": "content-delta", "delta": { "message": { "content": { "text": "x" } } } }),
            ],
        );
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "c1");
        assert_eq!(calls[0]["function"]["arguments"], "{\"sides\":4}");
    }

    #[test]
    fn full_replies_of_each_shape() {
        let openai = json!({ "choices": [{ "message": { "content": null, "tool_calls": [
            { "id": "call_a", "type": "function", "function": { "name": "roll", "arguments": "{\"sides\":6}" } }
        ] } }] });
        assert_eq!(
            full_reply_tool_calls(&cc("openai"), &openai),
            vec![json!({ "id": "call_a", "type": "function",
                         "function": { "name": "roll", "arguments": "{\"sides\":6}" } })]
        );
        let claude = json!({ "content": [
            { "type": "text", "text": "ok" },
            { "type": "tool_use", "id": "toolu_1", "name": "roll", "input": { "sides": 6 } }
        ] });
        assert_eq!(
            full_reply_tool_calls(&cc("claude"), &claude)[0]["function"]["arguments"],
            "{\"sides\":6}"
        );
        let google = json!({ "candidates": [{ "content": { "parts": [
            { "functionCall": { "name": "roll", "args": { "sides": 6 } } }
        ] } }] });
        assert_eq!(
            full_reply_tool_calls(&cc("vertexai"), &google)[0]["id"],
            "call_0"
        );
        let cohere = json!({ "message": { "tool_calls": [
            { "id": "c1", "type": "function", "function": { "name": "roll", "arguments": "{}" } }
        ] } });
        assert_eq!(full_reply_tool_calls(&cc("cohere"), &cohere)[0]["id"], "c1");
        assert!(full_reply_tool_calls(&cc("openai"), &json!({ "choices": [] })).is_empty());
    }
}
