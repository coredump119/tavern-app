//! First-run default content, ST content-manager `seedContentForUser` semantics (DEV_NOTES §9.19):
//! every bundle item whose `filename` is not yet in `<root>/content.log` is logged and, if the
//! target file does not exist, written. Deleting a seeded file therefore never brings it back.

use serde::Deserialize;
use std::path::Path;

pub const CONTENT_LOG: &str = "content.log";

#[derive(Debug, Deserialize)]
pub struct ContentItem {
    /// ST's `default/content` relative name — the content.log key
    pub filename: String,
    /// path under the data root, e.g. `instruct/Alpaca.json`
    pub target: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct ContentBundle {
    pub items: Vec<ContentItem>,
}

#[derive(Debug, thiserror::Error)]
pub enum ContentError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("bundle: {0}")]
    Bundle(#[from] serde_json::Error),
    #[error("refused target path: {0}")]
    Target(String),
}

/// Seed `bundle_json` into `root`. Returns the targets written.
pub fn seed(root: &Path, bundle_json: &str) -> Result<Vec<String>, ContentError> {
    let bundle: ContentBundle = serde_json::from_str(bundle_json)?;
    let log_path = root.join(CONTENT_LOG);
    let existing = std::fs::read_to_string(&log_path).unwrap_or_default();
    let mut log: Vec<String> = existing
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect();
    let mut written = Vec::new();
    for item in &bundle.items {
        if log.iter().any(|l| l == &item.filename) {
            continue;
        }
        let rel = Path::new(&item.target);
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(ContentError::Target(item.target.clone()));
        }
        log.push(item.filename.clone());
        let path = root.join(rel);
        if path.exists() {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, item.content.as_bytes())?;
        written.push(item.target.clone());
    }
    let tmp = root.join(format!("{CONTENT_LOG}.tmp"));
    std::fs::write(&tmp, log.join("\n"))?;
    std::fs::rename(&tmp, &log_path)?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_once_and_respects_deletions_and_existing_files() {
        let root = std::env::temp_dir().join(format!("tm-content-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("context")).unwrap();
        std::fs::write(root.join("context/B.json"), "mine").unwrap();
        let bundle = r#"{"items":[
            {"filename":"presets/instruct/A.json","target":"instruct/A.json","content":"a"},
            {"filename":"presets/context/B.json","target":"context/B.json","content":"b"}
        ]}"#;
        assert_eq!(seed(&root, bundle).unwrap(), vec!["instruct/A.json"]);
        assert_eq!(
            std::fs::read_to_string(root.join("context/B.json")).unwrap(),
            "mine"
        );
        let log = std::fs::read_to_string(root.join(CONTENT_LOG)).unwrap();
        assert_eq!(log, "presets/instruct/A.json\npresets/context/B.json");
        std::fs::remove_file(root.join("instruct/A.json")).unwrap();
        assert!(seed(&root, bundle).unwrap().is_empty());
        assert!(!root.join("instruct/A.json").exists());
        let bad = r#"{"items":[{"filename":"x","target":"../x.json","content":""}]}"#;
        assert!(matches!(seed(&root, bad), Err(ContentError::Target(_))));
        let _ = std::fs::remove_dir_all(&root);
    }
}
