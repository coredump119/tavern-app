//! Local crash log (DEV_NOTES §9.38): JSON lines in `<app data>/logs/`, outside the data root, so a
//! backup never carries it. Nothing here touches the network; export is a manual copy.
//! Every field is redacted here before it reaches the disk, whatever the caller passed.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;
use std::sync::LazyLock;

pub const LOG_FILE: &str = "crash.log";
/// past this size only the newest half is kept
const MAX_BYTES: u64 = 256 * 1024;
const MAX_FIELD: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    /// unix millis
    pub t: u64,
    /// `js` | `promise` | `rust`
    pub kind: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub stack: String,
}

/// (pattern, replacement), applied in order
static RULES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}", "$1 ***"),
        (r"(?i)\b(sk|pk|rk|gsk|xai|key)-[A-Za-z0-9_-]{8,}", "$1-***"),
        (
            r#"(?i)\b((?:api[_-]?key|x-api-key|authorization|proxy_password|password|passwd|secret|token|key)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+"#,
            "$1***",
        ),
        (r"://[^/\s:@]+:[^/\s@]+@", "://***@"),
        (r#"(https?://[^\s"'?#]+)\?[^\s"']*"#, "$1?***"),
        (r"/(Users|home)/[^/\s]+/", "/$1/~/"),
        (r"[A-Za-z0-9+_=-]{40,}", "***"),
    ]
    .into_iter()
    .map(|(pattern, to)| (Regex::new(pattern).expect("static pattern"), to))
    .collect()
});

/// Strip what could be a credential or identify the user: auth schemes, key-shaped tokens,
/// `key=value` pairs, URL userinfo and query strings, home folder names, long opaque runs.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for (re, to) in RULES.iter() {
        if re.is_match(&out) {
            out = re.replace_all(&out, *to).into_owned();
        }
    }
    out
}

fn clip(mut s: String) -> String {
    if s.len() > MAX_FIELD {
        let mut end = MAX_FIELD;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push('…');
    }
    s
}

/// Append one entry (redacted, clipped). Trims the file when it grows past the cap.
pub fn append(dir: &Path, mut entry: Entry) -> std::io::Result<()> {
    entry.message = clip(redact(&entry.message));
    entry.source = clip(redact(&entry.source));
    entry.stack = clip(redact(&entry.stack));
    std::fs::create_dir_all(dir)?;
    let path = dir.join(LOG_FILE);
    let mut line = serde_json::to_string(&entry)?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    file.write_all(line.as_bytes())?;
    if file.metadata()?.len() > MAX_BYTES {
        drop(file);
        trim(&path)?;
    }
    Ok(())
}

/// Keep the newest lines that fit in half the cap.
fn trim(path: &Path) -> std::io::Result<()> {
    let bytes = std::fs::read(path)?;
    let from = bytes.len().saturating_sub((MAX_BYTES / 2) as usize);
    let start = bytes[from..]
        .iter()
        .position(|&b| b == b'\n')
        .map_or(bytes.len(), |i| from + i + 1);
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &bytes[start..])?;
    std::fs::rename(&tmp, path)
}

/// All entries, oldest first. Lines that do not parse are skipped.
pub fn read(dir: &Path) -> std::io::Result<Vec<Entry>> {
    match std::fs::read_to_string(dir.join(LOG_FILE)) {
        Ok(text) => Ok(text
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

pub fn clear(dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(dir.join(LOG_FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(message: &str) -> Entry {
        Entry {
            t: 1,
            kind: "js".into(),
            message: message.into(),
            source: String::new(),
            stack: String::new(),
        }
    }

    #[test]
    fn redacts_credentials_and_identity() {
        let cases = [
            ("Authorization: Bearer abc.def-123", "abc.def-123"),
            ("failed with sk-test1234567890abcd", "test1234567890abcd"),
            (r#"{"api_key":"hunter2hunter2"}"#, "hunter2hunter2"),
            ("proxy_password = opensesame", "opensesame"),
            ("GET https://u:pw@example.test/v1", "u:pw@"),
            (
                "GET https://example.test/v1/models?key=abcd1234&x=1",
                "abcd1234",
            ),
            ("at /Users/someone/project/src/main.rs:3", "someone"),
            (
                "blob AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA end",
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            ),
        ];
        for (input, secret) in cases {
            let out = redact(input);
            assert!(!out.contains(secret), "{input} -> {out}");
        }
        // the part that says what failed stays readable
        assert_eq!(
            redact("GET https://example.test/v1/models?key=abcd1234"),
            "GET https://example.test/v1/models?***"
        );
        assert_eq!(
            redact("TypeError: x is not a function"),
            "TypeError: x is not a function"
        );
    }

    #[test]
    fn append_redacts_and_read_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        assert!(read(&logs).unwrap().is_empty());
        let mut e = entry("boom token=abcdef123456");
        e.stack = "at f (https://example.test/a.js?v=secretsecret:1:2)".into();
        append(&logs, e).unwrap();
        append(&logs, entry("second")).unwrap();
        let got = read(&logs).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].message, "boom token=***");
        assert!(!got[0].stack.contains("secretsecret"));
        assert_eq!(got[1].message, "second");
        clear(&logs).unwrap();
        clear(&logs).unwrap();
        assert!(read(&logs).unwrap().is_empty());
    }

    #[test]
    fn long_fields_are_clipped_and_the_file_keeps_only_the_newest_half() {
        let dir = tempfile::tempdir().unwrap();
        let big = "x ".repeat(MAX_FIELD);
        for i in 0..80u64 {
            let mut e = entry(&big);
            e.t = i;
            append(dir.path(), e).unwrap();
        }
        let size = std::fs::metadata(dir.path().join(LOG_FILE)).unwrap().len();
        assert!(size <= MAX_BYTES, "{size}");
        let got = read(dir.path()).unwrap();
        assert!(got.len() < 80 && !got.is_empty());
        assert_eq!(got.last().unwrap().t, 79);
        assert!(got
            .iter()
            .all(|e| e.message.len() <= MAX_FIELD + '…'.len_utf8()));
        // whole lines only
        assert!(got.windows(2).all(|w| w[1].t == w[0].t + 1));
    }
}
