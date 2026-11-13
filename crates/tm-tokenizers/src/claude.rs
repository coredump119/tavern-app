//! ST src/prompt-converters.js convertClaudePrompt(messages, false, '', false, false, '', false) 的移植，
//! 仅用于 Claude 族 web-tokenizer 计数时把消息拼成一段文本。
use serde_json::Value;

#[derive(Clone)]
struct Msg {
    role: String,
    name: Option<String>,
    content: String,
}

pub fn convert_claude_prompt(messages: &[Value]) -> String {
    let mut msgs: Vec<Msg> = messages
        .iter()
        .map(|m| {
            let obj = m.as_object();
            let get = |k: &str| obj.and_then(|o| o.get(k));
            let mut content = match get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Null) | None => String::new(),
                Some(other) => crate::json_value_to_text(other),
            };
            if let Some(tc) = get("tool_calls") {
                if !tc.is_null() {
                    content.push_str(&tc.to_string());
                }
            }
            Msg {
                role: get("role")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                name: get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
                content,
            }
        })
        .collect();

    if !msgs.is_empty() {
        msgs[0].role = "system".into();
        let mut has_user = false;
        let mut first_assistant: Option<usize> = None;
        for (i, m) in msgs.iter().enumerate() {
            if m.role == "user" || m.content.contains("\n\nHuman: ") {
                has_user = true;
            }
            if m.role == "assistant" && i > 0 {
                first_assistant = Some(i);
                break;
            }
        }
        let _ = has_user;
        // withSysPromptSupport=false → 默认格式：第一条设为 user，第一条 assistant 前的 user 消息改为 FixHumMsg
        msgs[0].role = "user".into();
        if let Some(fa) = first_assistant {
            if fa > 0 {
                let idx = fa - 1;
                if idx != 0 && msgs[idx].role == "user" {
                    msgs[idx].role = "FixHumMsg".into();
                }
            }
        }
    }

    let mut out = String::new();
    for (i, v) in msgs.iter().enumerate() {
        let prefix: String = match v.role.as_str() {
            "assistant" => "\n\nAssistant: ".into(),
            "user" => "\n\nHuman: ".into(),
            "system" => {
                if i == 0 {
                    String::new()
                } else if v.name.as_deref() == Some("example_assistant") {
                    "\n\nA: ".into()
                } else if v.name.as_deref() == Some("example_user") {
                    "\n\nH: ".into()
                } else {
                    "\n\n".into()
                }
            }
            "FixHumMsg" => "\n\nFirst message: ".into(),
            _ => String::new(),
        };
        let name_prefix = match (&v.name, v.role.as_str()) {
            (Some(n), r) if r != "system" && !n.is_empty() => format!("{n}: "),
            _ => String::new(),
        };
        out.push_str(&prefix);
        out.push_str(&name_prefix);
        out.push_str(&v.content);
    }
    out
}
