//! 用一个最小的 tokio HTTP/1.1 服务器模拟各后端，验证流式 / 非流式 / 错误 / 取消。
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tm_net::{
    check_url, detect_error, fetch, generate, CancellationToken, FetchRequest, GenEvent,
    GenerateRequest, HttpMethod, NetError, ReplyFormat, StreamFormat,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone)]
struct Resp {
    status: u16,
    content_type: &'static str,
    chunks: Vec<(&'static str, u64)>,
}

/// 读完请求（含 content-length 正文），按 chunks 逐段写回（每段前等待 delay ms），然后关闭
async fn serve(resp: Resp, seen: Arc<Mutex<Vec<(String, Value)>>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            let resp = resp.clone();
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let (head_end, mut head) = loop {
                    let n = sock.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break (i + 4, String::from_utf8_lossy(&buf[..i]).to_string());
                    }
                };
                let len: usize = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                while buf.len() < head_end + len {
                    let n = sock.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                let body: Value =
                    serde_json::from_slice(&buf[head_end..head_end + len]).unwrap_or(Value::Null);
                head.truncate(head.len());
                seen.lock().unwrap().push((head, body));
                let header = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: {}\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n",
                    resp.status, resp.content_type
                );
                let _ = sock.write_all(header.as_bytes()).await;
                for (chunk, delay) in resp.chunks {
                    if delay > 0 {
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    }
                    let _ = sock
                        .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                        .await;
                    let _ = sock.write_all(chunk.as_bytes()).await;
                    let _ = sock.write_all(b"\r\n").await;
                    let _ = sock.flush().await;
                }
                let _ = sock.write_all(b"0\r\n\r\n").await;
                let _ = sock.shutdown().await;
            });
        }
    });
    format!("http://{addr}")
}

fn cc_req(url: &str, stream: bool, source: &str) -> GenerateRequest {
    GenerateRequest {
        url: format!("{url}/v1/chat/completions"),
        headers: BTreeMap::from([("X-Title".to_string(), "Tavern".to_string())]),
        api_key: Some("sk-test".into()),
        auth_header: None,
        body: json!({"model":"m","messages":[{"role":"user","content":"hi"}],"stream":stream}),
        stream,
        stream_format: StreamFormat::Sse,
        format: ReplyFormat::ChatCompletion {
            source: source.into(),
        },
        allow_insecure_http: false,
        timeout_ms: None,
    }
}

fn collect() -> (Arc<Mutex<Vec<GenEvent>>>, impl FnMut(GenEvent)) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let e2 = events.clone();
    (events, move |ev| e2.lock().unwrap().push(ev))
}

#[tokio::test]
async fn streams_openai_deltas_cumulatively_and_sends_headers() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sse = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hel\"}}]}\n\n",
    );
    let url = serve(
        Resp {
            status: 200,
            content_type: "text/event-stream",
            chunks: vec![
                (sse, 0),
                ("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lo 世\"}}]}\n\ndata: {\"choices\":[{\"index\":1,\"delta\":{\"content\":\"alt\"}}]}\n\n", 10),
                ("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"界\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", 10),
            ],
        },
        seen.clone(),
    )
    .await;
    let (events, sink) = collect();
    let out = generate(cc_req(&url, true, "openai"), CancellationToken::new(), sink)
        .await
        .unwrap();
    assert_eq!(out.text, "Hello 世界");
    assert_eq!(out.swipes, vec!["alt".to_string()]);
    let evs = events.lock().unwrap();
    assert!(matches!(evs[0], GenEvent::Started { status: 200 }));
    let texts: Vec<String> = evs
        .iter()
        .filter_map(|e| {
            if let GenEvent::Delta { text, .. } = e {
                Some(text.clone())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(texts, vec!["", "Hel", "Hello 世", "Hello 世界"]);
    assert!(matches!(evs.last(), Some(GenEvent::Done { text, .. }) if text == "Hello 世界"));
    let (head, body) = &seen.lock().unwrap()[0];
    assert!(head.contains("POST /v1/chat/completions"));
    assert!(head
        .to_ascii_lowercase()
        .contains("authorization: bearer sk-test"));
    assert!(head.contains("X-Title: Tavern") || head.contains("x-title: Tavern"));
    assert_eq!(body["model"], "m");
}

#[tokio::test]
async fn deepseek_reasoning_and_non_stream_reply() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let url = serve(
        Resp {
            status: 200,
            content_type: "text/event-stream",
            chunks: vec![(
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\ndata: [DONE]\n\n",
                0,
            )],
        },
        seen.clone(),
    )
    .await;
    let out = generate(
        cc_req(&url, true, "deepseek"),
        CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(
        (out.text.as_str(), out.reasoning.as_str()),
        ("answer", "think")
    );

    let url = serve(
        Resp {
            status: 200,
            content_type: "application/json",
            chunks: vec![("{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"full\"}}],\"usage\":{}}", 0)],
        },
        seen.clone(),
    )
    .await;
    let (events, sink) = collect();
    let out = generate(
        cc_req(&url, false, "openai"),
        CancellationToken::new(),
        sink,
    )
    .await
    .unwrap();
    assert_eq!(out.text, "full");
    assert!(out.raw.is_some());
    assert!(matches!(
        events.lock().unwrap().last(),
        Some(GenEvent::Done { raw: Some(_), .. })
    ));

    // Claude：x-api-key 头 + 非流式 content 数组
    let url = serve(
        Resp {
            status: 200,
            content_type: "application/json",
            chunks: vec![("{\"type\":\"message\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"hmm\"},{\"type\":\"text\",\"text\":\"claude says\"}]}", 0)],
        },
        seen.clone(),
    )
    .await;
    let mut req = cc_req(&url, false, "claude");
    req.auth_header = Some("x-api-key".into());
    let out = generate(req, CancellationToken::new(), |_| {})
        .await
        .unwrap();
    assert_eq!(
        (out.text.as_str(), out.reasoning.as_str()),
        ("claude says", "hmm")
    );
    let (head, _) = seen.lock().unwrap().last().unwrap().clone();
    assert!(head.to_ascii_lowercase().contains("x-api-key: sk-test"));
    assert!(!head.to_ascii_lowercase().contains("authorization:"));
}

#[tokio::test]
async fn claude_sse_stream_text_and_thinking() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sse = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"content\":[]}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"let me\"}}\n\n",
        "event: ping\ndata: {\"type\":\"ping\"}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\" there\"}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );
    let url = serve(
        Resp {
            status: 200,
            content_type: "text/event-stream",
            chunks: vec![(sse, 0)],
        },
        seen.clone(),
    )
    .await;
    let out = generate(
        cc_req(&url, true, "claude"),
        CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(
        (out.text.as_str(), out.reasoning.as_str()),
        ("Hello there", "let me")
    );

    // Claude 的流内错误事件
    let url = serve(
        Resp {
            status: 200,
            content_type: "text/event-stream",
            chunks: vec![("event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n", 0)],
        },
        seen.clone(),
    )
    .await;
    let err = generate(
        cc_req(&url, true, "claude"),
        CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap_err();
    assert!(matches!(err, NetError::Upstream(ref m) if m == "Overloaded"));
}

#[tokio::test]
async fn gemini_mistral_cohere_deltas() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let url = serve(
        Resp {
            status: 200,
            content_type: "text/event-stream",
            chunks: vec![(
                "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"plan\",\"thought\":true},{\"text\":\"Hi\"}]}}]}\n\ndata: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\" there\"}]},\"finishReason\":\"STOP\"}]}\n\n",
                0,
            )],
        },
        seen.clone(),
    )
    .await;
    let out = generate(
        cc_req(&url, true, "makersuite"),
        CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(
        (out.text.as_str(), out.reasoning.as_str()),
        ("Hi there", "plan")
    );

    let url = serve(
        Resp {
            status: 200,
            content_type: "text/event-stream",
            chunks: vec![(
                "data: {\"choices\":[{\"delta\":{\"content\":[{\"type\":\"thinking\",\"thinking\":[{\"type\":\"text\",\"text\":\"mm\"}]}]}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"Bonjour\"}}]}\n\ndata: [DONE]\n\n",
                0,
            )],
        },
        seen.clone(),
    )
    .await;
    let out = generate(
        cc_req(&url, true, "mistralai"),
        CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(
        (out.text.as_str(), out.reasoning.as_str()),
        ("Bonjour", "mm")
    );

    let url = serve(
        Resp {
            status: 200,
            content_type: "text/event-stream",
            chunks: vec![(
                "data: {\"type\":\"content-delta\",\"delta\":{\"message\":{\"content\":{\"text\":\"Co\"}}}}\n\ndata: {\"type\":\"content-delta\",\"delta\":{\"message\":{\"content\":{\"text\":\"here\"}}}}\n\ndata: {\"type\":\"message-end\"}\n\n",
                0,
            )],
        },
        seen.clone(),
    )
    .await;
    let out = generate(
        cc_req(&url, true, "cohere"),
        CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(out.text, "Cohere");
}

#[tokio::test]
async fn text_completion_llamacpp_and_ollama() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let url = serve(
        Resp {
            status: 200,
            content_type: "text/event-stream",
            chunks: vec![(
                "data: {\"content\":\"A\",\"index\":0}\n\ndata: {\"content\":\"B\",\"index\":1}\n\ndata: {\"choices\":[{\"text\":\"C\",\"reasoning\":\"r\"}]}\n\n",
                0,
            )],
        },
        seen.clone(),
    )
    .await;
    let mut req = cc_req(&url, true, "x");
    req.format = ReplyFormat::TextCompletion {
        api_type: "llamacpp".into(),
    };
    let out = generate(req, CancellationToken::new(), |_| {})
        .await
        .unwrap();
    assert_eq!((out.text.as_str(), out.reasoning.as_str()), ("AC", "r"));
    assert_eq!(out.swipes, vec!["B".to_string()]);

    let url = serve(
        Resp {
            status: 200,
            content_type: "application/x-ndjson",
            chunks: vec![
                ("{\"model\":\"m\",\"response\":\"Hel\",\"thinking\":\"\",\"done\":false}\n", 0),
                ("{\"model\":\"m\",\"response\":\"lo\",\"done\":false}\n{\"model\":\"m\",\"response\":\"\",\"done\":true}\n", 5),
            ],
        },
        seen.clone(),
    )
    .await;
    let mut req = cc_req(&url, true, "x");
    req.stream_format = StreamFormat::JsonLines;
    req.format = ReplyFormat::TextCompletion {
        api_type: "ollama".into(),
    };
    let out = generate(req, CancellationToken::new(), |_| {})
        .await
        .unwrap();
    assert_eq!(out.text, "Hello");
}

#[tokio::test]
async fn http_error_and_upstream_error_payloads() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let url = serve(
        Resp {
            status: 401,
            content_type: "application/json",
            chunks: vec![(
                "{\"error\":{\"message\":\"bad key\",\"type\":\"invalid_request_error\"}}",
                0,
            )],
        },
        seen.clone(),
    )
    .await;
    let (events, sink) = collect();
    let err = generate(cc_req(&url, true, "openai"), CancellationToken::new(), sink)
        .await
        .unwrap_err();
    assert!(matches!(err, NetError::Http { status: 401, ref message } if message == "bad key"));
    assert!(matches!(
        events.lock().unwrap().last(),
        Some(GenEvent::Error {
            status: Some(401),
            ..
        })
    ));

    let url = serve(
        Resp {
            status: 200,
            content_type: "text/event-stream",
            chunks: vec![("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"error\":{\"message\":\"quota\"}}\n\n", 0)],
        },
        seen.clone(),
    )
    .await;
    let err = generate(
        cc_req(&url, true, "openai"),
        CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap_err();
    assert!(matches!(err, NetError::Upstream(ref m) if m == "quota"));

    assert_eq!(
        detect_error(&json!({"error": true, "status": 500, "response": "boom"})),
        Some("boom".into())
    );
    assert_eq!(
        detect_error(&json!({"detail": "nope"})),
        Some("nope".into())
    );
    assert_eq!(detect_error(&json!({"message": "m"})), Some("m".into()));
    assert_eq!(detect_error(&json!({"choices": []})), None);
}

#[tokio::test]
async fn cancel_stops_mid_stream() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let url = serve(
        Resp {
            status: 200,
            content_type: "text/event-stream",
            chunks: vec![
                (
                    "data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n",
                    0,
                ),
                (
                    "data: {\"choices\":[{\"delta\":{\"content\":\" second\"}}]}\n\n",
                    2000,
                ),
            ],
        },
        seen.clone(),
    )
    .await;
    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    let started = std::time::Instant::now();
    let err = generate(cc_req(&url, true, "openai"), cancel, move |ev| {
        if matches!(ev, GenEvent::Delta { .. }) {
            c2.cancel();
        }
    })
    .await
    .unwrap_err();
    assert!(matches!(err, NetError::Aborted));
    assert!(started.elapsed() < Duration::from_millis(1500));
}

#[test]
fn url_policy() {
    assert!(check_url("https://api.openai.com/v1", false).is_ok());
    assert!(check_url("http://127.0.0.1:5000/v1", false).is_ok());
    assert!(check_url("http://localhost:5000", false).is_ok());
    assert!(check_url("http://192.168.1.20:5001", false).is_ok());
    assert!(check_url("http://my-pc.local:8080", false).is_ok());
    assert!(matches!(
        check_url("http://example.com/v1", false),
        Err(NetError::InsecureHttp(_))
    ));
    assert!(check_url("http://example.com/v1", true).is_ok());
    assert!(matches!(
        check_url("ftp://x", false),
        Err(NetError::InvalidUrl(_))
    ));
    assert!(matches!(
        check_url("not a url", false),
        Err(NetError::InvalidUrl(_))
    ));
    // the message names the reason, never the address (it may carry a key; DEV_NOTES §9.38)
    for raw in [
        "http://example.com/v1?key=SECRETVALUE",
        "ftp://example.com/SECRETVALUE",
        "http://exa mple.com/SECRETVALUE",
    ] {
        let message = check_url(raw, false).unwrap_err().to_string();
        assert!(
            !message.contains("SECRETVALUE") && !message.contains("example.com"),
            "{message}"
        );
    }
}

#[tokio::test]
async fn fetch_json_get_and_error_status() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let url = serve(
        Resp {
            status: 200,
            content_type: "application/json",
            chunks: vec![("{\"data\":[{\"id\":\"m1\"}]}", 0)],
        },
        seen.clone(),
    )
    .await;
    let r = fetch(
        &FetchRequest {
            url: format!("{url}/v1/models?x=1"),
            method: HttpMethod::Get,
            headers: BTreeMap::from([("X-Title".to_string(), "Tavern".to_string())]),
            api_key: Some("k".into()),
            auth_header: None,
            body: None,
            allow_insecure_http: false,
            timeout_ms: None,
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(r.ok);
    assert_eq!(r.json.unwrap()["data"][0]["id"], "m1");
    assert_eq!(
        r.headers.get("content-type").map(String::as_str),
        Some("application/json")
    );
    let (head, _) = seen.lock().unwrap()[0].clone();
    assert!(head.starts_with("GET /v1/models?x=1"));
    assert!(head
        .to_ascii_lowercase()
        .contains("authorization: bearer k"));

    let url = serve(
        Resp {
            status: 401,
            content_type: "text/plain",
            chunks: vec![("nope", 0)],
        },
        seen.clone(),
    )
    .await;
    let r = fetch(
        &FetchRequest {
            url: format!("{url}/v1/models"),
            method: HttpMethod::Get,
            headers: BTreeMap::new(),
            api_key: None,
            auth_header: None,
            body: None,
            allow_insecure_http: false,
            timeout_ms: None,
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(!r.ok);
    assert_eq!((r.status, r.json, r.text.as_str()), (401, None, "nope"));

    let err = fetch(
        &FetchRequest {
            url: "http://example.com/models".into(),
            method: HttpMethod::Get,
            headers: BTreeMap::new(),
            api_key: None,
            auth_header: None,
            body: None,
            allow_insecure_http: false,
            timeout_ms: None,
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, NetError::InsecureHttp(_)));
}

#[tokio::test]
async fn tool_calls_are_collected_only_when_the_request_has_tools() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let resp = Resp {
        status: 200,
        content_type: "text/event-stream",
        chunks: vec![
            ("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Let me roll.\"}}]}\n\n", 0),
            ("data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"roll\",\"arguments\":\"{\\\"si\"}}]}}]}\n\n", 5),
            ("data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"des\\\":6}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n", 5),
        ],
    };
    let url = serve(resp.clone(), seen.clone()).await;
    let mut req = cc_req(&url, true, "openai");
    req.body["tools"] = json!([{ "type": "function", "function": { "name": "roll" } }]);
    let (events, sink) = collect();
    let out = generate(req, CancellationToken::new(), sink).await.unwrap();
    assert_eq!(out.text, "Let me roll.");
    let expected = json!({ "id": "call_a", "type": "function",
                           "function": { "name": "roll", "arguments": "{\"sides\":6}" } });
    assert_eq!(out.tool_calls, vec![expected.clone()]);
    let done = events.lock().unwrap().last().cloned().unwrap();
    assert!(matches!(&done, GenEvent::Done { tool_calls, .. } if tool_calls == &vec![expected]));
    assert!(serde_json::to_value(&done)
        .unwrap()
        .get("tool_calls")
        .is_some());

    // the same reply to a request without tools: nothing is parsed, and the event has no such field
    let url = serve(resp, seen.clone()).await;
    let (events, sink) = collect();
    let out = generate(cc_req(&url, true, "openai"), CancellationToken::new(), sink)
        .await
        .unwrap();
    assert!(out.tool_calls.is_empty());
    let done = events.lock().unwrap().last().cloned().unwrap();
    assert!(serde_json::to_value(&done)
        .unwrap()
        .get("tool_calls")
        .is_none());
}
