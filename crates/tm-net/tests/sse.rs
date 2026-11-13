use serde_json::json;
use tm_net::{JsonChunker, SseParser};

#[test]
fn splits_events_like_st() {
    let mut p = SseParser::new();
    let evs = p.push("data: a\n\nevent: ping\ndata: b\ndata: c\n\n: comment\n\nid: 7\ndata:d\n\n");
    assert_eq!(evs.len(), 3);
    assert_eq!(
        (evs[0].event.as_str(), evs[0].data.as_str()),
        ("message", "a")
    );
    assert_eq!(
        (evs[1].event.as_str(), evs[1].data.as_str()),
        ("ping", "b\nc")
    );
    assert_eq!(
        (evs[2].data.as_str(), evs[2].last_event_id.as_str()),
        ("d", "7")
    );
}

#[test]
fn handles_partial_chunks_and_crlf() {
    let mut p = SseParser::new();
    assert!(p.push("data: {\"x\":").is_empty());
    assert!(p.push("1}\r\n").is_empty());
    let evs = p.push("\r\ndata: [DONE]\r\n\r\n");
    assert_eq!(evs.len(), 2);
    assert_eq!(evs[0].data, "{\"x\":1}");
    assert_eq!(evs[1].data, "[DONE]");
    assert_eq!(p.pending(), "");
    // \r\r 也是分隔符；data 为空的事件跳过
    let evs = p.push("event: x\r\rdata: y\n\n");
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].data, "y");
}

#[test]
fn json_chunker_pulls_complete_values() {
    let mut c = JsonChunker::new();
    assert!(c.push("{\"response\":\"he").is_empty());
    let v = c.push("llo\"}\n{\"response\":\" world\"}");
    assert_eq!(
        v,
        vec![json!({"response":"hello"}), json!({"response":" world"})]
    );
    assert_eq!(c.push("{\"done\":true}"), vec![json!({"done":true})]);
}
