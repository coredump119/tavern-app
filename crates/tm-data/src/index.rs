//! SQLite index over the data directory (DEV_NOTES §5.3). Disposable: `rebuild` recreates it
//! from files; `scan` only touches entries whose mtime changed. WAL + FTS5 (trigram, so CJK
//! substrings match).

use crate::{card, chat, layout};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS characters(
  avatar TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  fav INTEGER NOT NULL DEFAULT 0,
  create_date TEXT,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats(
  char_avatar TEXT NOT NULL,
  file TEXT NOT NULL,
  mes_count INTEGER NOT NULL,
  last_mes TEXT,
  last_name TEXT,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY(char_avatar, file)
);
CREATE INDEX IF NOT EXISTS chats_by_char ON chats(char_avatar, mtime DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  chat_file UNINDEXED, idx UNINDEXED, name UNINDEXED, content, tokenize='trigram'
);
"#;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct CharacterRow {
    pub avatar: String,
    pub name: String,
    pub tags: Vec<String>,
    pub fav: bool,
    pub create_date: Option<String>,
    pub mtime: i64,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct ChatRow {
    pub char_avatar: String,
    pub file: String,
    pub mes_count: i64,
    pub last_mes: Option<String>,
    pub last_name: Option<String>,
    pub mtime: i64,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub chat_file: String,
    pub idx: i64,
    pub name: String,
    pub snippet: String,
}

#[derive(Debug, Serialize, Default, Clone, PartialEq, Eq)]
pub struct ScanReport {
    pub characters_updated: usize,
    pub characters_removed: usize,
    pub chats_updated: usize,
    pub chats_removed: usize,
}

pub struct Index {
    conn: Connection,
    root: PathBuf,
}

fn mtime_of(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Index {
    pub fn open(root: &Path) -> Result<Self, IndexError> {
        let conn = Connection::open(root.join(layout::INDEX_FILE))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)?;
        let version: Option<i64> = conn
            .query_row("SELECT value FROM meta WHERE key='schema'", [], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .and_then(|s| s.parse().ok());
        let mut me = Self {
            conn,
            root: root.to_path_buf(),
        };
        if version != Some(SCHEMA_VERSION) {
            me.clear()?;
            me.conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES('schema', ?1)",
                params![SCHEMA_VERSION.to_string()],
            )?;
        }
        Ok(me)
    }

    pub fn clear(&mut self) -> Result<(), IndexError> {
        self.conn.execute_batch(
            "DELETE FROM characters; DELETE FROM chats; DELETE FROM messages_fts;",
        )?;
        Ok(())
    }

    /// Drop everything and rescan.
    pub fn rebuild(&mut self) -> Result<ScanReport, IndexError> {
        self.clear()?;
        self.scan()
    }

    /// Incremental: files whose (mtime, size) match the stored row are skipped.
    pub fn scan(&mut self) -> Result<ScanReport, IndexError> {
        let mut report = ScanReport::default();
        let tx = self.conn.transaction()?;

        // characters/*.png
        let mut seen = Vec::new();
        let chars_dir = self.root.join(layout::CHARACTERS);
        if chars_dir.is_dir() {
            for entry in std::fs::read_dir(&chars_dir)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.to_ascii_lowercase().ends_with(".png") {
                    continue;
                }
                let meta = entry.metadata()?;
                let (mtime, size) = (mtime_of(&meta), meta.len() as i64);
                seen.push(name.clone());
                let stored: Option<(i64, i64)> = tx
                    .query_row(
                        "SELECT mtime, size FROM characters WHERE avatar=?1",
                        params![name],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if stored == Some((mtime, size)) {
                    continue;
                }
                let Ok(json) = card::read_card_file(&entry.path()) else {
                    continue;
                };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) else {
                    continue;
                };
                let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
                let pick = |k: &str| data.get(k).or_else(|| v.get(k)).cloned();
                let char_name = pick("name")
                    .and_then(|x| x.as_str().map(String::from))
                    .unwrap_or_default();
                let tags = pick("tags")
                    .and_then(|t| {
                        t.as_array().map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect::<Vec<_>>()
                        })
                    })
                    .unwrap_or_default();
                let fav = data
                    .get("extensions")
                    .and_then(|e| e.get("fav"))
                    .or_else(|| v.get("fav"))
                    .map(|f| f == true || f == "true")
                    .unwrap_or(false);
                let create_date = v
                    .get("create_date")
                    .and_then(|x| x.as_str().map(String::from));
                tx.execute(
                    "INSERT OR REPLACE INTO characters(avatar, name, tags, fav, create_date, mtime, size) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    params![name, char_name, serde_json::to_string(&tags).unwrap(), fav as i64, create_date, mtime, size],
                )?;
                report.characters_updated += 1;
            }
        }
        report.characters_removed += remove_missing(&tx, "characters", "avatar", &seen)?;

        // chats/<char>/*.jsonl
        let mut seen_chats: Vec<String> = Vec::new();
        let chats_dir = self.root.join(layout::CHATS);
        if chats_dir.is_dir() {
            for char_entry in std::fs::read_dir(&chats_dir)? {
                let char_entry = char_entry?;
                if !char_entry.file_type()?.is_dir() {
                    continue;
                }
                let char_avatar = format!("{}.png", char_entry.file_name().to_string_lossy());
                for entry in std::fs::read_dir(char_entry.path())? {
                    let entry = entry?;
                    let file = entry.file_name().to_string_lossy().into_owned();
                    if !file.ends_with(".jsonl") {
                        continue;
                    }
                    let meta = entry.metadata()?;
                    let (mtime, size) = (mtime_of(&meta), meta.len() as i64);
                    let key = format!("{char_avatar}/{file}");
                    seen_chats.push(key.clone());
                    let stored: Option<(i64, i64)> = tx
                        .query_row(
                            "SELECT mtime, size FROM chats WHERE char_avatar=?1 AND file=?2",
                            params![char_avatar, file],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()?;
                    if stored == Some((mtime, size)) {
                        continue;
                    }
                    let Ok(content) = std::fs::read_to_string(entry.path()) else {
                        continue;
                    };
                    let mut count = 0i64;
                    let mut last_mes = None;
                    let mut last_name = None;
                    tx.execute("DELETE FROM messages_fts WHERE chat_file=?1", params![key])?;
                    for (i, line) in content
                        .split('\n')
                        .filter(|l| !l.trim().is_empty())
                        .enumerate()
                    {
                        if i == 0 {
                            continue; // header
                        }
                        let idx = (i - 1) as i64;
                        count += 1;
                        if let Ok(m) = serde_json::from_str::<serde_json::Value>(line) {
                            let mes = m.get("mes").and_then(|x| x.as_str()).unwrap_or("");
                            let name = m.get("name").and_then(|x| x.as_str()).unwrap_or("");
                            tx.execute(
                                "INSERT INTO messages_fts(chat_file, idx, name, content) VALUES(?1,?2,?3,?4)",
                                params![key, idx, name, mes],
                            )?;
                            last_mes = Some(mes.chars().take(200).collect::<String>());
                            last_name = Some(name.to_string());
                        }
                    }
                    tx.execute(
                        "INSERT OR REPLACE INTO chats(char_avatar, file, mes_count, last_mes, last_name, mtime, size) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                        params![char_avatar, file, count, last_mes, last_name, mtime, size],
                    )?;
                    report.chats_updated += 1;
                }
            }
        }
        // remove chats whose files vanished
        {
            let mut stmt = tx.prepare("SELECT char_avatar, file FROM chats")?;
            let existing: Vec<(String, String)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            drop(stmt);
            for (c, f) in existing {
                let key = format!("{c}/{f}");
                if !seen_chats.contains(&key) {
                    tx.execute(
                        "DELETE FROM chats WHERE char_avatar=?1 AND file=?2",
                        params![c, f],
                    )?;
                    tx.execute("DELETE FROM messages_fts WHERE chat_file=?1", params![key])?;
                    report.chats_removed += 1;
                }
            }
        }
        tx.commit()?;
        Ok(report)
    }

    pub fn characters(&self) -> Result<Vec<CharacterRow>, IndexError> {
        let mut stmt = self
            .conn
            .prepare("SELECT avatar, name, tags, fav, create_date, mtime FROM characters ORDER BY name COLLATE NOCASE")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(CharacterRow {
                    avatar: r.get(0)?,
                    name: r.get(1)?,
                    tags: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default(),
                    fav: r.get::<_, i64>(3)? != 0,
                    create_date: r.get(4)?,
                    mtime: r.get(5)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn chats(&self, char_avatar: &str) -> Result<Vec<ChatRow>, IndexError> {
        let mut stmt = self.conn.prepare(
            "SELECT char_avatar, file, mes_count, last_mes, last_name, mtime FROM chats WHERE char_avatar=?1 ORDER BY mtime DESC",
        )?;
        let rows = stmt
            .query_map(params![char_avatar], |r| {
                Ok(ChatRow {
                    char_avatar: r.get(0)?,
                    file: r.get(1)?,
                    mes_count: r.get(2)?,
                    last_mes: r.get(3)?,
                    last_name: r.get(4)?,
                    mtime: r.get(5)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Full-text search over message bodies. `query` is FTS5 syntax; plain words work.
    /// The trigram tokenizer needs ≥ 3 characters, so shorter queries fall back to a LIKE scan.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, IndexError> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        if q.chars().count() < 3 {
            let mut stmt = self.conn.prepare(
                "SELECT chat_file, idx, name, substr(content, 1, 80) FROM messages_fts WHERE content LIKE ?1 ORDER BY chat_file, idx LIMIT ?2",
            )?;
            let like = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
            let rows = stmt
                .query_map(params![like, limit as i64], |r| {
                    Ok(SearchHit {
                        chat_file: r.get(0)?,
                        idx: r.get(1)?,
                        name: r.get(2)?,
                        snippet: r.get(3)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            return Ok(rows);
        }
        let mut stmt = self.conn.prepare(
            "SELECT chat_file, idx, name, snippet(messages_fts, 3, '[', ']', '…', 16) FROM messages_fts WHERE messages_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![q, limit as i64], |r| {
                Ok(SearchHit {
                    chat_file: r.get(0)?,
                    idx: r.get(1)?,
                    name: r.get(2)?,
                    snippet: r.get(3)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn path(&self) -> PathBuf {
        self.root.join(layout::INDEX_FILE)
    }
}

fn remove_missing(
    tx: &rusqlite::Transaction,
    table: &str,
    key: &str,
    seen: &[String],
) -> Result<usize, IndexError> {
    let mut stmt = tx.prepare(&format!("SELECT {key} FROM {table}"))?;
    let existing: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    let mut n = 0;
    for k in existing {
        if !seen.contains(&k) {
            tx.execute(&format!("DELETE FROM {table} WHERE {key}=?1"), params![k])?;
            n += 1;
        }
    }
    Ok(n)
}

// chat module is used for the tail-read based last message in later phases; keep the import honest.
#[allow(dead_code)]
fn _uses_chat(p: &Path) -> Result<chat::ChatTail, chat::ChatError> {
    chat::read_tail(p, 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CARD: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/formats/tests/fixtures/default_Seraphina.png"
    ));
    const CHAT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/formats/tests/fixtures/chat-sample.jsonl"
    ));

    fn seed(root: &Path) {
        layout::ensure_layout(root).unwrap();
        std::fs::write(root.join("characters/default_Seraphina.png"), CARD).unwrap();
        std::fs::create_dir_all(root.join("chats/default_Seraphina")).unwrap();
        std::fs::write(root.join("chats/default_Seraphina/sample.jsonl"), CHAT).unwrap();
    }

    #[test]
    fn rebuild_scan_search_and_removal() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let mut ix = Index::open(dir.path()).unwrap();
        let r = ix.rebuild().unwrap();
        assert_eq!((r.characters_updated, r.chats_updated), (1, 1));

        let chars = ix.characters().unwrap();
        assert_eq!(chars[0].name, "Seraphina");
        assert_eq!(chars[0].avatar, "default_Seraphina.png");
        let chats = ix.chats("default_Seraphina.png").unwrap();
        assert_eq!(chats[0].mes_count, 4);
        assert_eq!(chats[0].last_name.as_deref(), Some("System"));

        // CJK substring search via trigram
        let hits = ix.search("去烧水", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].idx, 2);
        assert!(hits[0].snippet.contains("[去烧水]"));
        // < 3 chars → LIKE fallback
        let short = ix.search("烧水", 10).unwrap();
        assert_eq!(short.len(), 1);
        assert_eq!(short[0].idx, 2);
        assert!(ix.search("oracle", 10).unwrap().is_empty());

        // unchanged files are skipped
        let r2 = ix.scan().unwrap();
        assert_eq!(r2, ScanReport::default());

        // a changed chat is re-indexed, a deleted card is dropped
        chat::append_message(
            &dir.path().join("chats/default_Seraphina/sample.jsonl"),
            r#"{"name":"旅人","is_user":true,"send_date":"x","mes":"oracle 来了","extra":{}}"#,
        )
        .unwrap();
        std::fs::remove_file(dir.path().join("characters/default_Seraphina.png")).unwrap();
        let r3 = ix.scan().unwrap();
        assert_eq!((r3.chats_updated, r3.characters_removed), (1, 1));
        assert_eq!(ix.chats("default_Seraphina.png").unwrap()[0].mes_count, 5);
        assert_eq!(ix.search("oracle", 10).unwrap().len(), 1);
        assert!(ix.characters().unwrap().is_empty());
        assert!(ix.path().exists());
    }
}
