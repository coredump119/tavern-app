//! ST public/scripts/sse-stream.js EventSourceStream 的切分规则：
//! 事件以 `\r\n\r\n` | `\r\r` | `\n\n` 分隔，行以 `\n` | `\r` | `\r\n` 分隔，
//! 字段按 `([^:]+)(?:: ?(.*))?` 解析；data 多行以 `\n` 拼接并去掉最后一个换行；data 为空的事件跳过。

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    /// 默认 "message"
    pub event: String,
    pub data: String,
    pub last_event_id: String,
}

#[derive(Debug, Default)]
pub struct SseParser {
    buffer: String,
    last_event_id: String,
}

fn find_separator(s: &str) -> Option<(usize, usize)> {
    let b = s.as_bytes();
    for i in 0..b.len() {
        if b[i..].starts_with(b"\r\n\r\n") {
            return Some((i, 4));
        }
        if b[i..].starts_with(b"\r\r") {
            return Some((i, 2));
        }
        if b[i..].starts_with(b"\n\n") {
            return Some((i, 2));
        }
    }
    None
}

fn parse_field(line: &str) -> Option<(&str, &str)> {
    // 正则 `([^:]+)(?:: ?(.*))?` 的首个匹配：跳过开头的 ':'，字段名为到下一个 ':' 为止
    let start = line.find(|c| c != ':')?;
    let rest = &line[start..];
    match rest.find(':') {
        Some(idx) => {
            let field = &rest[..idx];
            let mut value = &rest[idx + 1..];
            if let Some(v) = value.strip_prefix(' ') {
                value = v;
            }
            Some((field, value))
        }
        None => Some((rest, "")),
    }
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂入解码后的文本，返回新完成的事件
    pub fn push(&mut self, chunk: &str) -> Vec<SseEvent> {
        self.buffer.push_str(chunk);
        let mut out = Vec::new();
        while let Some((idx, len)) = find_separator(&self.buffer) {
            let event_chunk: String = self.buffer[..idx].to_string();
            self.buffer.drain(..idx + len);
            if let Some(ev) = self.parse_event(&event_chunk) {
                out.push(ev);
            }
        }
        out
    }

    fn parse_event(&mut self, chunk: &str) -> Option<SseEvent> {
        let mut event_type = String::new();
        let mut data = String::new();
        for line in chunk.split(['\n', '\r']) {
            let Some((field, value)) = parse_field(line) else {
                continue;
            };
            match field {
                "event" => event_type = value.to_string(),
                "data" => {
                    data.push_str(value);
                    data.push('\n');
                }
                "id" if !value.contains('\0') => self.last_event_id = value.to_string(),
                _ => {}
            }
        }
        if data.is_empty() {
            return None;
        }
        if data.ends_with('\n') {
            data.pop();
        }
        Some(SseEvent {
            event: if event_type.is_empty() {
                "message".into()
            } else {
                event_type
            },
            data,
            last_event_id: self.last_event_id.clone(),
        })
    }

    pub fn pending(&self) -> &str {
        &self.buffer
    }
}

/// Ollama 等「每块一个 JSON」的流：累积后尽量多地取出完整 JSON 值（ST parseOllamaStream 的健壮版）
#[derive(Debug, Default)]
pub struct JsonChunker {
    buffer: String,
}

impl JsonChunker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &str) -> Vec<serde_json::Value> {
        self.buffer.push_str(chunk);
        let mut out = Vec::new();
        let mut consumed = 0usize;
        {
            let mut stream =
                serde_json::Deserializer::from_str(&self.buffer).into_iter::<serde_json::Value>();
            loop {
                match stream.next() {
                    Some(Ok(v)) => {
                        out.push(v);
                        consumed = stream.byte_offset();
                    }
                    Some(Err(e)) if e.is_eof() => break,
                    Some(Err(_)) => {
                        // 坏数据：丢掉到目前为止的缓冲，避免永远卡住
                        consumed = self.buffer.len();
                        break;
                    }
                    None => break,
                }
            }
        }
        self.buffer.drain(..consumed);
        out
    }
}
