//! ST chat jsonl: line 0 = header `{user_name, character_name, create_date, chat_metadata}`,
//! lines 1..n = messages. ST joins lines with `\n` and writes no trailing newline; we tolerate
//! either and always write ST's exact shape back.
//!
//! * `read_tail(path, n)` — last n messages without reading the whole file (reverse block scan)
//! * `append_message(path, line)` — O(1) append
//! * `rewrite_from(path, index, lines)` — replace messages from `index` on (edit / delete / swipe),
//!   temp file + atomic rename
//! * `count_messages(path)`

use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

const BLOCK: usize = 64 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ChatError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("chat file is empty (no header line)")]
    Empty,
    #[error("line {0} is not valid UTF-8")]
    Utf8(usize),
    #[error("message index {index} out of range (chat has {len} messages)")]
    OutOfRange { index: usize, len: usize },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ChatTail {
    /// Raw JSON of line 0.
    pub header: String,
    /// Raw JSON lines of the last `n` messages, in file order.
    pub messages: Vec<String>,
    /// Total number of messages in the file (excluding the header).
    pub total: usize,
    /// Index (0-based, header excluded) of `messages[0]`.
    pub first_index: usize,
}

fn is_blank(line: &[u8]) -> bool {
    line.iter().all(|b| b.is_ascii_whitespace())
}

fn utf8(bytes: &[u8], line_no: usize) -> Result<String, ChatError> {
    let s = std::str::from_utf8(bytes).map_err(|_| ChatError::Utf8(line_no))?;
    Ok(s.trim_end_matches('\r').to_owned())
}

/// Count non-blank lines, streaming forward. Returns (total_lines, header_present).
fn count_lines(file: &mut File) -> Result<usize, ChatError> {
    file.seek(SeekFrom::Start(0))?;
    let mut buf = vec![0u8; BLOCK];
    let mut count = 0usize;
    let mut cur_blank = true; // is the current (unfinished) line blank so far
    let mut saw_any = false;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            saw_any = true;
            if b == b'\n' {
                if !cur_blank {
                    count += 1;
                }
                cur_blank = true;
            } else if !b.is_ascii_whitespace() {
                cur_blank = false;
            }
        }
    }
    if saw_any && !cur_blank {
        count += 1;
    }
    Ok(count)
}

/// Read the first non-blank line as the header.
fn read_header(file: &mut File) -> Result<String, ChatError> {
    file.seek(SeekFrom::Start(0))?;
    let mut buf = Vec::new();
    let mut chunk = vec![0u8; BLOCK];
    loop {
        let n = file.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            buf.truncate(pos);
            break;
        }
    }
    if is_blank(&buf) {
        return Err(ChatError::Empty);
    }
    utf8(&buf, 0)
}

/// Last `n` messages, scanning backwards in blocks so a 3000-floor chat costs ~one block.
pub fn read_tail(path: &Path, n: usize) -> Result<ChatTail, ChatError> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let total_lines = count_lines(&mut file)?;
    if total_lines == 0 {
        return Err(ChatError::Empty);
    }
    let header = read_header(&mut file)?;
    let total = total_lines - 1;
    let want = n.min(total);

    // Collect the last `want` non-blank lines by reading blocks from the end.
    let mut lines: Vec<Vec<u8>> = Vec::with_capacity(want);
    let mut carry: Vec<u8> = Vec::new(); // partial line at the start of the last-read block
    let mut end = len;
    'outer: while end > 0 && lines.len() < want {
        let start = end.saturating_sub(BLOCK as u64);
        let size = (end - start) as usize;
        let mut buf = vec![0u8; size];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buf)?;
        end = start;
        // walk backwards through buf; `carry` holds bytes after the last newline we have seen
        let mut i = size;
        while i > 0 {
            i -= 1;
            if buf[i] == b'\n' {
                let mut line = buf[i + 1..].to_vec();
                line.extend_from_slice(&carry);
                carry.clear();
                if !is_blank(&line) {
                    lines.push(line);
                    if lines.len() == want {
                        break 'outer;
                    }
                }
                buf.truncate(i);
            }
        }
        // whatever remains (no newline seen before it) prefixes the carry
        buf.extend_from_slice(&carry);
        carry = buf;
    }
    // If we hit the start of the file, `carry` is the first line (the header) — never a message
    // unless the file has exactly one message and no header, which read_header already rejected.
    if lines.len() < want && end == 0 && !is_blank(&carry) && total_lines > lines.len() + 1 {
        lines.push(carry);
    }
    lines.truncate(want);
    lines.reverse();

    let first_index = total - lines.len();
    let messages = lines
        .iter()
        .enumerate()
        .map(|(i, l)| utf8(l, first_index + 1 + i))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ChatTail {
        header,
        messages,
        total,
        first_index,
    })
}

/// Append one message line. Ensures exactly one `\n` separates lines; no trailing newline.
pub fn append_message(path: &Path, line: &str) -> Result<(), ChatError> {
    let mut file = OpenOptions::new().append(true).read(true).open(path)?;
    let len = file.metadata()?.len();
    let needs_sep = if len == 0 {
        false
    } else {
        let mut last = [0u8; 1];
        file.seek(SeekFrom::Start(len - 1))?;
        file.read_exact(&mut last)?;
        last[0] != b'\n'
    };
    file.seek(SeekFrom::End(0))?;
    if needs_sep {
        file.write_all(b"\n")?;
    }
    file.write_all(line.trim_end_matches(['\r', '\n']).as_bytes())?;
    file.flush()?;
    Ok(())
}

/// Replace messages from `index` (0-based, header excluded) to the end with `lines`.
/// `index == total` appends; `lines` empty truncates. Written to a temp file then renamed.
pub fn rewrite_from(path: &Path, index: usize, lines: &[String]) -> Result<(), ChatError> {
    let content = std::fs::read(path)?;
    let mut kept: Vec<&[u8]> = content
        .split(|&b| b == b'\n')
        .filter(|l| !is_blank(l))
        .collect();
    if kept.is_empty() {
        return Err(ChatError::Empty);
    }
    let total = kept.len() - 1;
    if index > total {
        return Err(ChatError::OutOfRange { index, len: total });
    }
    kept.truncate(1 + index);
    let mut out = Vec::with_capacity(content.len());
    for (i, l) in kept.iter().enumerate() {
        if i > 0 {
            out.push(b'\n');
        }
        out.extend_from_slice(l.strip_suffix(b"\r").unwrap_or(l));
    }
    for l in lines {
        out.push(b'\n');
        out.extend_from_slice(l.trim_end_matches(['\r', '\n']).as_bytes());
    }
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, &out)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Replace the header line and keep every message byte for byte (chat metadata, chat variables).
/// The messages never pass through the caller, so the cost does not grow with what it holds in
/// memory. Written to a temp file then renamed.
pub fn rewrite_header(path: &Path, header: &str) -> Result<(), ChatError> {
    let header = header.trim_end_matches(['\r', '\n']);
    if header.contains('\n') {
        return Err(
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "header spans lines").into(),
        );
    }
    let content = std::fs::read(path)?;
    let mut start = 0;
    let end = loop {
        if start >= content.len() {
            return Err(ChatError::Empty);
        }
        let len = content[start..]
            .iter()
            .position(|&b| b == b'\n')
            .unwrap_or(content.len() - start);
        if !is_blank(&content[start..start + len]) {
            break start + len;
        }
        start += len + 1;
    };
    let mut out = Vec::with_capacity(header.len() + content.len() - end);
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(&content[end..]);
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, &out)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Create a new chat file from header + message lines (ST style: `\n`-joined, no trailing newline).
/// Creates the parent directory; refuses to overwrite an existing file.
pub fn create_chat(path: &Path, lines: &[String]) -> Result<(), ChatError> {
    if lines.is_empty() {
        return Err(ChatError::Empty);
    }
    if path.exists() {
        return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "chat exists").into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if i > 0 {
            out.push(b'\n');
        }
        out.extend_from_slice(l.trim_end_matches(['\r', '\n']).as_bytes());
    }
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, &out)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn count_messages(path: &Path) -> Result<usize, ChatError> {
    let mut file = File::open(path)?;
    let lines = count_lines(&mut file)?;
    if lines == 0 {
        return Err(ChatError::Empty);
    }
    Ok(lines - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tm-chat-{}-{}", std::process::id(), name));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("chat.jsonl");
        std::fs::write(&p, body).unwrap();
        p
    }
    fn msg(i: usize) -> String {
        format!(
            r#"{{"name":"Lune","is_user":{},"send_date":"d{i}","mes":"m{i}","extra":{{}}}}"#,
            i.is_multiple_of(2)
        )
    }
    fn chat(n: usize, trailing_newline: bool) -> String {
        let mut lines = vec![r#"{"user_name":"you","character_name":"Lune","create_date":"2026-10-31","chat_metadata":{}}"#.to_string()];
        lines.extend((0..n).map(msg));
        let mut s = lines.join("\n");
        if trailing_newline {
            s.push('\n');
        }
        s
    }

    #[test]
    fn rewrite_header_keeps_messages_byte_for_byte() {
        let p = tmp("header", &chat(3, true));
        let before = std::fs::read_to_string(&p).unwrap();
        let (_, messages) = before.split_once('\n').unwrap();
        rewrite_header(&p, "{\"chat_metadata\":{\"variables\":{\"hp\":1}}}\n").unwrap();
        let after = std::fs::read_to_string(&p).unwrap();
        assert_eq!(
            after,
            format!("{{\"chat_metadata\":{{\"variables\":{{\"hp\":1}}}}}}\n{messages}")
        );
        assert_eq!(
            read_tail(&p, 9).unwrap().messages,
            vec![msg(0), msg(1), msg(2)]
        );

        assert!(rewrite_header(&p, "{}\n{}").is_err());
        let empty = tmp("header-empty", "\n\n");
        assert!(matches!(
            rewrite_header(&empty, "{}"),
            Err(ChatError::Empty)
        ));
        // leading blank lines are not the header
        let blank = tmp("header-blank", &format!("\n{}", chat(1, false)));
        rewrite_header(&blank, "{\"user_name\":\"x\"}").unwrap();
        let t = read_tail(&blank, 9).unwrap();
        assert_eq!(t.header, "{\"user_name\":\"x\"}");
        assert_eq!(t.messages, vec![msg(0)]);
    }

    #[test]
    fn tail_reads_last_n_in_order() {
        let p = tmp("tail", &chat(10, false));
        let t = read_tail(&p, 3).unwrap();
        assert_eq!(t.total, 10);
        assert_eq!(t.first_index, 7);
        assert_eq!(t.messages, vec![msg(7), msg(8), msg(9)]);
        assert!(t.header.starts_with(r#"{"user_name""#));
    }

    #[test]
    fn tail_handles_small_files_and_trailing_newline() {
        let p = tmp("small", &chat(2, true));
        let t = read_tail(&p, 50).unwrap();
        assert_eq!(t.messages, vec![msg(0), msg(1)]);
        assert_eq!(t.first_index, 0);
        let p0 = tmp("zero", &chat(0, false));
        let t0 = read_tail(&p0, 5).unwrap();
        assert_eq!(t0.total, 0);
        assert!(t0.messages.is_empty());
        assert!(matches!(
            read_tail(&tmp("empty", ""), 5),
            Err(ChatError::Empty)
        ));
    }

    #[test]
    fn tail_crosses_block_boundaries() {
        // ~3000 floors × ~90 bytes ≈ 270 KB > 4 × BLOCK
        let p = tmp("big", &chat(3000, false));
        let t = read_tail(&p, 50).unwrap();
        assert_eq!(t.total, 3000);
        assert_eq!(t.first_index, 2950);
        assert_eq!(t.messages.len(), 50);
        assert_eq!(t.messages[0], msg(2950));
        assert_eq!(t.messages[49], msg(2999));
        // a message longer than a block
        let long = format!(
            r#"{{"name":"L","is_user":false,"send_date":"x","mes":"{}","extra":{{}}}}"#,
            "a".repeat(BLOCK * 2)
        );
        append_message(&p, &long).unwrap();
        let t2 = read_tail(&p, 2).unwrap();
        assert_eq!(t2.messages, vec![msg(2999), long]);
    }

    #[test]
    fn append_and_rewrite_keep_st_shape() {
        let p = tmp("rw", &chat(3, false));
        append_message(&p, &msg(3)).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), chat(4, false));
        // edit message 2 and drop 3
        rewrite_from(
            &p,
            2,
            &[
                r#"{"name":"Lune","is_user":true,"send_date":"e","mes":"edited","extra":{}}"#
                    .to_string(),
            ],
        )
        .unwrap();
        let s = std::fs::read_to_string(&p).unwrap();
        assert_eq!(s.lines().count(), 4);
        assert!(s.ends_with(r#""mes":"edited","extra":{}}"#));
        assert!(!s.ends_with('\n'));
        // delete everything after header
        rewrite_from(&p, 0, &[]).unwrap();
        assert_eq!(count_messages(&p).unwrap(), 0);
        assert!(matches!(
            rewrite_from(&p, 5, &[]),
            Err(ChatError::OutOfRange { .. })
        ));
        // trailing-newline input gets normalised on rewrite
        let p2 = tmp("rw2", &chat(2, true));
        rewrite_from(&p2, 2, &[msg(2)]).unwrap();
        assert_eq!(std::fs::read_to_string(&p2).unwrap(), chat(3, false));
    }
}

/// ST `renamePastChats`: in every chat of `avatar`, set `name` on each character message (not
/// `is_user`, not `is_system`, not `extra.type == "narrator"`) to `new_name`. The header line and
/// unparsable lines are copied as-is. Returns the number of files rewritten.
pub fn rename_character(root: &Path, avatar: &str, new_name: &str) -> Result<usize, ChatError> {
    let dir = crate::layout::chat_dir(root, avatar);
    if !dir.is_dir() {
        return Ok(0);
    }
    let mut rewritten = 0;
    for entry in std::fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let content = std::fs::read(&path)?;
        let mut out = Vec::with_capacity(content.len() + 64);
        let mut changed = false;
        for (i, raw) in content.split(|&b| b == b'\n').enumerate() {
            if i > 0 {
                out.push(b'\n');
            }
            let line = raw.strip_suffix(b"\r").unwrap_or(raw);
            if i == 0 || is_blank(line) {
                out.extend_from_slice(raw);
                continue;
            }
            let Ok(mut m) = serde_json::from_slice::<serde_json::Value>(line) else {
                out.extend_from_slice(raw);
                continue;
            };
            let skip = m.get("is_user") == Some(&serde_json::Value::Bool(true))
                || m.get("is_system") == Some(&serde_json::Value::Bool(true))
                || m.get("extra")
                    .and_then(|e| e.get("type"))
                    .and_then(|t| t.as_str())
                    == Some("narrator")
                || m.get("name").is_none()
                || m.get("name").and_then(|n| n.as_str()) == Some(new_name);
            if skip {
                out.extend_from_slice(raw);
                continue;
            }
            m["name"] = serde_json::Value::String(new_name.to_string());
            out.extend_from_slice(serde_json::to_string(&m).expect("serialize").as_bytes());
            changed = true;
        }
        if changed {
            let tmp = path.with_extension("jsonl.tmp");
            std::fs::write(&tmp, &out)?;
            std::fs::rename(&tmp, &path)?;
            rewritten += 1;
        }
    }
    Ok(rewritten)
}

#[cfg(test)]
mod rename_tests {
    use super::*;

    #[test]
    fn renames_character_messages_only() {
        let root = std::env::temp_dir().join(format!("tm-rename-chat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("chats/Sera1");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.jsonl");
        std::fs::write(
            &file,
            concat!(
                r#"{"user_name":"User","character_name":"Seraphina","chat_metadata":{}}"#, "\n",
                r#"{"name":"Seraphina","is_user":false,"is_system":false,"mes":"hi","extra":{}}"#, "\n",
                r#"{"name":"User","is_user":true,"is_system":false,"mes":"yo"}"#, "\n",
                r#"{"name":"Seraphina","is_user":false,"is_system":true,"mes":"hidden"}"#, "\n",
                r#"{"name":"Seraphina","is_user":false,"is_system":false,"mes":"n","extra":{"type":"narrator"}}"#, "\n",
                "not json", "\n",
                r#"{"name":"Seraphina","is_user":false,"is_system":false,"mes":"again","swipes":["again"]}"#, "\n",
            ),
        )
        .unwrap();
        assert_eq!(rename_character(&root, "Sera1.png", "Sera").unwrap(), 1);
        let text = std::fs::read_to_string(&file).unwrap();
        let lines: Vec<&str> = text.split('\n').collect();
        assert!(lines[0].contains(r#""character_name":"Seraphina""#));
        assert!(lines[1].starts_with(r#"{"name":"Sera","is_user":false"#));
        assert!(lines[2].contains(r#""name":"User""#));
        assert!(lines[3].contains(r#""name":"Seraphina""#));
        assert!(lines[4].contains(r#""name":"Seraphina""#));
        assert_eq!(lines[5], "not json");
        assert!(lines[6].starts_with(r#"{"name":"Sera","#));
        assert_eq!(lines[7], "");
        // second run: nothing to do
        assert_eq!(rename_character(&root, "Sera1.png", "Sera").unwrap(), 0);
        assert_eq!(rename_character(&root, "Nobody.png", "X").unwrap(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// Write (or overwrite) a chat jsonl from its lines. Used to add the header line ST's
/// `migrateGroupChatsMetadataFormat` expects on legacy group chats. Atomic.
pub fn write_chat(path: &Path, lines: &[String]) -> Result<(), ChatError> {
    if lines.is_empty() {
        return Err(ChatError::Empty);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if i > 0 {
            out.push(b'\n');
        }
        out.extend_from_slice(l.trim_end_matches(['\r', '\n']).as_bytes());
    }
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, &out)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// ST `renameGroupMember` on group chat files: in every `group chats/*.jsonl` listed in `chat_ids`,
/// non-user / non-system messages whose `force_avatar` contains the URL-encoded old avatar get
/// `name`, `force_avatar` (encoded name replaced) and `original_avatar` updated. Returns files touched.
pub fn rename_group_member(
    root: &Path,
    chat_ids: &[String],
    old_avatar: &str,
    new_avatar: &str,
    new_name: &str,
) -> Result<usize, ChatError> {
    let old_enc = encode_uri_component(old_avatar);
    let new_enc = encode_uri_component(new_avatar);
    let mut rewritten = 0;
    for id in chat_ids {
        let path = root
            .join(crate::layout::GROUP_CHATS)
            .join(format!("{id}.jsonl"));
        if !path.is_file() {
            continue;
        }
        let content = std::fs::read(&path)?;
        let mut out = Vec::with_capacity(content.len() + 64);
        let mut changed = false;
        for (i, raw) in content.split(|&b| b == b'\n').enumerate() {
            if i > 0 {
                out.push(b'\n');
            }
            let line = raw.strip_suffix(b"\r").unwrap_or(raw);
            if is_blank(line) {
                out.extend_from_slice(raw);
                continue;
            }
            let Ok(mut m) = serde_json::from_slice::<serde_json::Value>(line) else {
                out.extend_from_slice(raw);
                continue;
            };
            let is_header = m.get("chat_metadata").is_some();
            let skip = is_header
                || m.get("is_user") == Some(&serde_json::Value::Bool(true))
                || m.get("is_system") == Some(&serde_json::Value::Bool(true));
            let fa = m
                .get("force_avatar")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            match (skip, fa) {
                (false, Some(fa)) if fa.contains(&old_enc) => {
                    m["name"] = serde_json::Value::String(new_name.to_string());
                    m["force_avatar"] =
                        serde_json::Value::String(fa.replacen(&old_enc, &new_enc, 1));
                    m["original_avatar"] = serde_json::Value::String(new_avatar.to_string());
                    out.extend_from_slice(serde_json::to_string(&m).expect("serialize").as_bytes());
                    changed = true;
                }
                _ => out.extend_from_slice(raw),
            }
        }
        if changed {
            let tmp = path.with_extension("jsonl.tmp");
            std::fs::write(&tmp, &out)?;
            std::fs::rename(&tmp, &path)?;
            rewritten += 1;
        }
    }
    Ok(rewritten)
}

/// JS `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` is percent-encoded (UTF-8).
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b);
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod group_rename_tests {
    use super::*;

    #[test]
    fn encode_matches_js() {
        assert_eq!(encode_uri_component("Sera (2).png"), "Sera%20(2).png");
        assert_eq!(encode_uri_component("夜 a!~"), "%E5%A4%9C%20a!~");
    }

    #[test]
    fn renames_group_member_messages() {
        let root = std::env::temp_dir().join(format!("tm-grp-rename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("group chats");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("c1.jsonl");
        std::fs::write(
            &file,
            concat!(
                r#"{"chat_metadata":{},"user_name":"unused","character_name":"unused"}"#, "\n",
                r#"{"name":"A","is_user":false,"is_system":false,"mes":"hi","force_avatar":"/thumbnail?type=avatar&file=A%20(2).png","original_avatar":"A (2).png"}"#, "\n",
                r#"{"name":"User","is_user":true,"mes":"yo","force_avatar":"/thumbnail?type=avatar&file=A%20(2).png"}"#, "\n",
                r#"{"name":"B","is_user":false,"is_system":false,"mes":"x","force_avatar":"/thumbnail?type=avatar&file=B.png","original_avatar":"B.png"}"#,
            ),
        )
        .unwrap();
        let ids = vec!["c1".to_string(), "missing".to_string()];
        assert_eq!(
            rename_group_member(&root, &ids, "A (2).png", "Ann.png", "Ann").unwrap(),
            1
        );
        let text = std::fs::read_to_string(&file).unwrap();
        let lines: Vec<&str> = text.split('\n').collect();
        assert!(lines[0].starts_with(r#"{"chat_metadata""#));
        assert!(lines[1].contains(r#""name":"Ann""#));
        assert!(lines[1].contains(r#""force_avatar":"/thumbnail?type=avatar&file=Ann.png""#));
        assert!(lines[1].contains(r#""original_avatar":"Ann.png""#));
        assert!(lines[2].contains(r#""name":"User""#));
        assert!(lines[3].contains(r#""name":"B""#));
        assert_eq!(
            rename_group_member(&root, &ids, "A (2).png", "Ann.png", "Ann").unwrap(),
            0
        );
        write_chat(&file, &["{}".to_string(), "{\"a\":1}".to_string()]).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{}\n{\"a\":1}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
