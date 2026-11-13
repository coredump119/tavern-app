//! zip export / import of the whole data root (DEV_NOTES §5.1): files only, index and keys
//! excluded, settings.json secrets blanked on export. Import strips a single wrapping folder
//! (users zip `default-user/` itself) and refuses zip-slip paths.

use crate::layout::{self, SECRETS_FILE, SETTINGS_FILE};
use crate::settings::scrub_secrets;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use zip::write::SimpleFileOptions;

#[derive(Debug, thiserror::Error)]
pub enum ArchiveError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsafe path in archive: {0}")]
    UnsafePath(String),
}

#[derive(Debug, Serialize, Default, Clone, PartialEq, Eq)]
pub struct ExportReport {
    pub files: usize,
    pub skipped_private: usize,
    pub scrubbed_secrets: Vec<String>,
}

#[derive(Debug, Serialize, Default, Clone, PartialEq, Eq)]
pub struct ImportReport {
    pub files: usize,
    pub skipped: Vec<String>,
    pub stripped_prefix: Option<String>,
    /// Contents of secrets.json from the archive, never written to disk (goes to the keyring).
    pub secrets: Option<serde_json::Value>,
}

pub fn export(
    root: &Path,
    zip_path: &Path,
    include_secrets: bool,
) -> Result<ExportReport, ArchiveError> {
    let file = std::fs::File::create(zip_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut report = ExportReport::default();
    let mut entries: Vec<PathBuf> = walkdir::WalkDir::new(root)
        .min_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().strip_prefix(root).unwrap().to_path_buf())
        .collect();
    entries.sort();
    for rel in entries {
        if layout::is_private_path(&rel) && !(include_secrets && rel.as_os_str() == SECRETS_FILE) {
            report.skipped_private += 1;
            continue;
        }
        let name = rel.to_string_lossy().replace('\\', "/");
        zip.start_file(&name, opts)?;
        if !include_secrets && rel.as_os_str() == SETTINGS_FILE {
            let mut v: serde_json::Value =
                serde_json::from_slice(&std::fs::read(root.join(&rel))?)?;
            for (p, _) in scrub_secrets(&mut v) {
                report.scrubbed_secrets.push(p);
            }
            zip.write_all(&serde_json::to_vec_pretty(&v)?)?;
        } else {
            let mut f = std::fs::File::open(root.join(&rel))?;
            std::io::copy(&mut f, &mut zip)?;
        }
        report.files += 1;
    }
    zip.finish()?;
    Ok(report)
}

fn safe_relative(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(x) => out.push(x),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Directory inside the archive that is the ST user data root: the shallowest one holding
/// `settings.json` or a `characters/` folder. `Some("")` means the archive root itself;
/// `None` means no data root could be found (nothing recognisable — import everything as-is).
fn detect_prefix(names: &[String]) -> Option<String> {
    let mut best: Option<String> = None;
    for n in names {
        let parent = if let Some(p) = n.strip_suffix(&format!("/{SETTINGS_FILE}")) {
            Some(p.to_string())
        } else if n == SETTINGS_FILE {
            Some(String::new())
        } else if let Some(i) = n.find(&format!("{}/", layout::CHARACTERS)) {
            let p = &n[..i];
            if p.is_empty() || p.ends_with('/') {
                Some(p.trim_end_matches('/').to_string())
            } else {
                None
            }
        } else {
            None
        };
        if let Some(p) = parent {
            let depth = if p.is_empty() {
                0
            } else {
                p.matches('/').count() + 1
            };
            let best_depth = best.as_ref().map(|b| {
                if b.is_empty() {
                    0
                } else {
                    b.matches('/').count() + 1
                }
            });
            if best_depth.is_none_or(|d| depth < d) {
                best = Some(p);
            }
        }
    }
    best
}

pub fn import(zip_path: &Path, root: &Path) -> Result<ImportReport, ArchiveError> {
    let file = std::fs::File::open(zip_path)?;
    let mut zip = zip::ZipArchive::new(file)?;
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| {
            zip.by_index(i)
                .ok()
                .and_then(|f| f.name().ok().map(|n| n.to_string()))
        })
        .filter(|n| !n.ends_with('/'))
        .collect();
    let prefix = detect_prefix(&names);
    let mut report = ImportReport {
        stripped_prefix: prefix.clone().filter(|p| !p.is_empty()),
        ..Default::default()
    };
    layout::ensure_layout(root)?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        let raw = entry.name()?.to_string();
        let stripped = match prefix.as_deref() {
            Some("") | None => raw.clone(),
            Some(p) => match raw.strip_prefix(&format!("{p}/")) {
                Some(rest) => rest.to_string(),
                None => {
                    // outside the data root (e.g. ST's data/_errors/): not ours
                    report.skipped.push(raw);
                    continue;
                }
            },
        };
        let Some(rel) = safe_relative(&stripped) else {
            return Err(ArchiveError::UnsafePath(raw));
        };
        if rel.as_os_str() == SECRETS_FILE {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            report.secrets = serde_json::from_slice(&buf).ok();
            report.skipped.push(raw);
            continue;
        }
        if layout::is_private_path(&rel) {
            report.skipped.push(raw);
            continue;
        }
        let dest = root.join(&rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = dest.with_extension(format!(
            "{}.tmp",
            dest.extension()
                .map(|e| e.to_string_lossy().into_owned())
                .unwrap_or_default()
        ));
        {
            let mut out = std::fs::File::create(&tmp)?;
            std::io::copy(&mut entry, &mut out)?;
        }
        std::fs::rename(&tmp, &dest)?;
        report.files += 1;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const CARD: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/formats/tests/fixtures/default_Seraphina.png"
    ));

    fn tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
        walkdir::WalkDir::new(root)
            .min_depth(1)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .map(|e| {
                let rel = e
                    .path()
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                (rel, std::fs::read(e.path()).unwrap())
            })
            .collect()
    }

    fn seed(root: &Path) {
        layout::ensure_layout(root).unwrap();
        std::fs::write(root.join("characters/default_Seraphina.png"), CARD).unwrap();
        std::fs::create_dir_all(root.join("chats/default_Seraphina")).unwrap();
        std::fs::write(root.join("chats/default_Seraphina/a.jsonl"), "{\"user_name\":\"u\"}\n{\"name\":\"L\",\"is_user\":false,\"send_date\":\"d\",\"mes\":\"hi\"}").unwrap();
        std::fs::write(root.join("worlds/Eldoria.json"), "{\"entries\":{}}").unwrap();
        std::fs::write(
            root.join("OpenAI Settings/Default.json"),
            "{\"temperature\":1}",
        )
        .unwrap();
        std::fs::write(
            root.join("settings.json"),
            "{\"username\":\"me\",\"oai_settings\":{\"proxy_password\":\"\"}}",
        )
        .unwrap();
        std::fs::write(root.join("secrets.json"), "{\"api_key_openai\":\"sk-x\"}").unwrap();
        std::fs::write(root.join("index.sqlite"), b"junk").unwrap();
        std::fs::create_dir_all(root.join("thumbnails/avatar")).unwrap();
        std::fs::write(root.join("thumbnails/avatar/x.jpg"), b"cache").unwrap();
    }

    #[test]
    fn export_import_round_trip_is_byte_identical_minus_private_files() {
        let a = tempfile::tempdir().unwrap();
        seed(a.path());
        let zip_path = a
            .path()
            .parent()
            .unwrap()
            .join(format!("tm-export-{}.zip", std::process::id()));
        let rep = export(a.path(), &zip_path, false).unwrap();
        assert_eq!(rep.files, 5);
        assert_eq!(rep.skipped_private, 3); // secrets.json, index.sqlite, thumbnails/avatar/x.jpg
        assert!(rep.scrubbed_secrets.is_empty());

        let b = tempfile::tempdir().unwrap();
        let imp = import(&zip_path, b.path()).unwrap();
        assert_eq!(imp.files, 5);
        assert!(imp.secrets.is_none());
        assert_eq!(imp.stripped_prefix, None);

        let mut expected = tree(a.path());
        expected.retain(|k, _| !layout::is_private_path(Path::new(k)));
        // settings.json is re-serialized (pretty) on export: compare parsed
        let got = tree(b.path());
        assert_eq!(
            got.keys().collect::<Vec<_>>(),
            expected.keys().collect::<Vec<_>>()
        );
        for (k, v) in &expected {
            if k == "settings.json" {
                let x: serde_json::Value = serde_json::from_slice(v).unwrap();
                let y: serde_json::Value = serde_json::from_slice(&got[k]).unwrap();
                assert_eq!(x, y);
            } else {
                assert_eq!(&got[k], v, "{k}");
            }
        }
        std::fs::remove_file(zip_path).ok();
    }

    #[test]
    fn import_strips_wrapper_dir_captures_secrets_and_rejects_slip() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("st.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
            let o = SimpleFileOptions::default();
            z.start_file("default-user/settings.json", o).unwrap();
            z.write_all(b"{\"username\":\"u\"}").unwrap();
            z.start_file("default-user/secrets.json", o).unwrap();
            z.write_all(b"{\"api_key_openai\":\"sk\"}").unwrap();
            z.start_file("default-user/characters/c.png", o).unwrap();
            z.write_all(b"png").unwrap();
            z.finish().unwrap();
        }
        let root = dir.path().join("root");
        let rep = import(&zip_path, &root).unwrap();
        assert_eq!(rep.stripped_prefix.as_deref(), Some("default-user"));
        assert_eq!(rep.files, 2);
        assert_eq!(rep.secrets.unwrap()["api_key_openai"], "sk");
        assert!(root.join("characters/c.png").exists());
        assert!(!root.join("secrets.json").exists());

        let bad = dir.path().join("bad.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&bad).unwrap());
            z.start_file("../evil.txt", SimpleFileOptions::default())
                .unwrap();
            z.write_all(b"x").unwrap();
            z.finish().unwrap();
        }
        assert!(matches!(
            import(&bad, &root),
            Err(ArchiveError::UnsafePath(_))
        ));
    }

    #[test]
    fn import_strips_nested_st_multiuser_root_and_skips_outside_files() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("st.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
            let o = SimpleFileOptions::default();
            for (name, body) in [
                ("data/_errors/url-not-found.html", "<html>"),
                ("data/default-user/settings.json", "{\"username\":\"u\"}"),
                ("data/default-user/characters/c.png", "png"),
                ("data/default-user/worlds/w.json", "{\"entries\":{}}"),
            ] {
                z.start_file(name, o).unwrap();
                z.write_all(body.as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        let root = dir.path().join("root");
        let rep = import(&zip_path, &root).unwrap();
        assert_eq!(rep.stripped_prefix.as_deref(), Some("data/default-user"));
        assert_eq!(rep.files, 3);
        assert_eq!(rep.skipped, vec!["data/_errors/url-not-found.html"]);
        assert!(root.join("worlds/w.json").exists());
        assert!(!root.join("_errors").exists());
        assert_eq!(
            detect_prefix(&["settings.json".into(), "characters/a.png".into()]).as_deref(),
            Some("")
        );
        assert_eq!(detect_prefix(&["x/y.txt".into()]), None);
    }

    #[test]
    fn export_scrubs_secrets_from_settings() {
        let a = tempfile::tempdir().unwrap();
        layout::ensure_layout(a.path()).unwrap();
        std::fs::write(
            a.path().join("settings.json"),
            "{\"oai_settings\":{\"proxy_password\":\"hunter2\"}}",
        )
        .unwrap();
        let zip_path = a.path().join("out.zip");
        let rep = export(a.path(), &zip_path, false).unwrap();
        assert_eq!(rep.scrubbed_secrets, vec!["oai_settings.proxy_password"]);
        let mut z = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();
        let mut s = String::new();
        z.by_name("settings.json")
            .unwrap()
            .read_to_string(&mut s)
            .unwrap();
        assert!(!s.contains("hunter2"));
    }
}
