//! Third-party extensions on disk (DEV_NOTES §9.6, §9.34): `<root>/extensions/<name>/`, the same
//! place SillyTavern keeps a user's extensions. Listing also reports which host modules
//! (`/script.js`, `/scripts/*.js`, …) each extension imports and under which names, so the app can
//! serve stand-in modules exporting exactly those.

use crate::layout::EXTENSIONS;
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Seek};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

/// Where ST serves a user's extensions from; module specifiers resolve against this.
pub const URL_PREFIX: &str = "/scripts/extensions/third-party/";
const MANIFEST: &str = "manifest.json";
/// Left in the folder of an extension installed from a repository address: that address.
const SOURCE: &str = ".tm-source";
const MAX_ENTRIES: usize = 20_000;
const MAX_UNPACKED: u64 = 200 * 1024 * 1024;
/// Larger scripts are not scanned for imports (bundled libraries, not entry modules).
const MAX_SCANNED: u64 = 8 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ExtensionError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("invalid extension name: {0}")]
    Name(String),
    #[error("unsafe path in archive: {0}")]
    UnsafePath(String),
    #[error("manifest.json not found at the top of the archive")]
    NoManifest,
    #[error("manifest.json is not valid JSON: {0}")]
    Manifest(String),
    #[error("archive is too large")]
    TooLarge,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ExtensionInfo {
    pub name: String,
    /// Parsed `manifest.json`; null when it is missing or broken (see `error`).
    pub manifest: serde_json::Value,
    pub error: Option<String>,
    /// Host module path → names imported from it (empty for dynamic or namespace imports).
    pub imports: BTreeMap<String, BTreeSet<String>>,
    /// Repository address it was installed from; None for a zip install.
    pub source: Option<String>,
}

/// A folder name ST would accept: one path segment, not hidden.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains(['/', '\\', '\0'])
        && name != ".."
        && name.len() <= 128
}

fn dir(root: &Path, name: &str) -> Result<PathBuf, ExtensionError> {
    if !valid_name(name) {
        return Err(ExtensionError::Name(name.to_owned()));
    }
    Ok(root.join(EXTENSIONS).join(name))
}

/// The file behind `<URL_PREFIX><name>/<rel>`, or None when the path tries to leave the folder.
pub fn resolve_file(root: &Path, name: &str, rel: &str) -> Option<PathBuf> {
    let mut path = dir(root, name).ok()?;
    for part in Path::new(rel).components() {
        match part {
            Component::Normal(x) if !x.to_string_lossy().starts_with('.') => path.push(x),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(path)
}

fn read_info(name: String, folder: &Path) -> ExtensionInfo {
    let (manifest, error) = match std::fs::read(folder.join(MANIFEST)) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) if value.is_object() => (value, None),
            Ok(_) => (
                serde_json::Value::Null,
                Some("manifest.json is not an object".into()),
            ),
            Err(e) => (serde_json::Value::Null, Some(e.to_string())),
        },
        Err(e) => (serde_json::Value::Null, Some(e.to_string())),
    };
    let imports = scan_folder(&name, folder);
    let source = std::fs::read_to_string(folder.join(SOURCE))
        .ok()
        .map(|text| text.trim().to_owned())
        .filter(|text| github_source(text).is_some());
    ExtensionInfo {
        name,
        manifest,
        error,
        imports,
        source,
    }
}

/// Every installed extension, sorted by name.
pub fn list(root: &Path) -> Result<Vec<ExtensionInfo>, ExtensionError> {
    let base = root.join(EXTENSIONS);
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&base) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_name(&name) || !entry.path().is_dir() {
            continue;
        }
        out.push(read_info(name, &entry.path()));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn remove(root: &Path, name: &str) -> Result<(), ExtensionError> {
    let folder = dir(root, name)?;
    match std::fs::remove_dir_all(folder) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

fn safe_relative(name: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in Path::new(name).components() {
        match part {
            Component::Normal(x) => out.push(x),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// `Repo-main` → `Repo`: GitHub's "Download ZIP" names the folder after the branch.
fn name_from_folder(folder: &str) -> &str {
    folder
        .strip_suffix("-main")
        .or_else(|| folder.strip_suffix("-master"))
        .filter(|rest| !rest.is_empty())
        .unwrap_or(folder)
}

/// Unpacks an extension zip into `<root>/extensions/<name>/`, replacing an older copy.
///
/// A single wrapping folder is stripped and gives the name; without one, `fallback_name` (the zip
/// file's stem) does. `manifest.json` has to sit at the top after stripping.
pub fn install_zip(
    root: &Path,
    zip_path: &Path,
    fallback_name: &str,
) -> Result<ExtensionInfo, ExtensionError> {
    unpack_zip(root, std::fs::File::open(zip_path)?, None, fallback_name)
}

/// A GitHub repository an extension installs from (DEV_NOTES §9.6).
#[derive(Debug, Clone, PartialEq)]
pub struct GithubSource {
    /// the repository name: the extension's folder name, as `git clone` would give ST
    pub name: String,
    /// normalized repository address, kept in `.tm-source`
    pub url: String,
    pub zip_url: String,
}

fn is_slug(part: &str) -> bool {
    !part.is_empty()
        && !part.starts_with('.')
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Parses `https://github.com/<owner>/<repo>[.git][/tree/<branch>]`; any other host or shape is None.
pub fn github_source(input: &str) -> Option<GithubSource> {
    // scheme and host are case-insensitive (a phone keyboard capitalizes the first letter)
    const PREFIX: &str = "https://github.com/";
    let input = input.trim();
    let head = input.get(..PREFIX.len())?;
    if !head.eq_ignore_ascii_case(PREFIX) {
        return None;
    }
    let rest = &input[PREFIX.len()..];
    let rest = rest.split(['?', '#']).next()?.trim_end_matches('/');
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|part| is_slug(part))?;
    let repo = parts.next()?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if !is_slug(repo) || !valid_name(repo) {
        return None;
    }
    let (suffix, reference) = match parts.next() {
        None => (String::new(), "HEAD".to_owned()),
        Some("tree") => {
            let branch: Vec<&str> = parts.collect();
            if branch.is_empty() || !branch.iter().all(|part| is_slug(part)) {
                return None;
            }
            let branch = branch.join("/");
            (format!("/tree/{branch}"), format!("refs/heads/{branch}"))
        }
        Some(_) => return None,
    };
    Some(GithubSource {
        name: repo.to_owned(),
        url: format!("https://github.com/{owner}/{repo}{suffix}"),
        zip_url: format!("https://codeload.github.com/{owner}/{repo}/zip/{reference}"),
    })
}

/// Installs a downloaded repository archive as `<root>/extensions/<source.name>/` and records the
/// address next to it, so the extension can be updated from the same place.
pub fn install_github_zip(
    root: &Path,
    bytes: Vec<u8>,
    source: &GithubSource,
) -> Result<ExtensionInfo, ExtensionError> {
    unpack_zip(root, std::io::Cursor::new(bytes), Some(source), "")
}

fn unpack_zip<R: Read + Seek>(
    root: &Path,
    reader: R,
    origin: Option<&GithubSource>,
    fallback_name: &str,
) -> Result<ExtensionInfo, ExtensionError> {
    let mut zip = zip::ZipArchive::new(reader)?;
    if zip.len() > MAX_ENTRIES {
        return Err(ExtensionError::TooLarge);
    }
    let mut files: Vec<(usize, PathBuf)> = Vec::new();
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        let raw = entry.name()?.to_string();
        // macOS Finder adds these next to the real content
        if raw.starts_with("__MACOSX/") || raw.ends_with(".DS_Store") {
            continue;
        }
        total = total.saturating_add(entry.size());
        if total > MAX_UNPACKED {
            return Err(ExtensionError::TooLarge);
        }
        let rel = safe_relative(&raw).ok_or(ExtensionError::UnsafePath(raw))?;
        files.push((i, rel));
    }
    let top_level = files.iter().any(|(_, rel)| rel.as_os_str() == MANIFEST);
    let wrapper: Option<String> = if top_level {
        None
    } else {
        let mut firsts = files.iter().map(|(_, rel)| {
            rel.components()
                .next()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
        });
        let first = firsts.next().flatten().ok_or(ExtensionError::NoManifest)?;
        if !firsts.all(|f| f.as_deref() == Some(first.as_str())) {
            return Err(ExtensionError::NoManifest);
        }
        Some(first)
    };
    let name = match (origin, &wrapper) {
        (Some(source), _) => source.name.clone(),
        (None, Some(folder)) => name_from_folder(folder).to_owned(),
        (None, None) => name_from_folder(fallback_name).to_owned(),
    };
    let target = dir(root, &name)?;
    let base = root.join(EXTENSIONS);
    let staging = base.join(format!(".tmp-{name}"));
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    let mut unpack = || -> Result<(), ExtensionError> {
        let mut found = false;
        for (i, rel) in &files {
            let rel = match &wrapper {
                Some(folder) => rel.strip_prefix(folder).unwrap_or(rel),
                None => rel.as_path(),
            };
            found |= rel.as_os_str() == MANIFEST;
            let dest = staging.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let entry = zip.by_index(*i)?;
            let mut out = std::fs::File::create(&dest)?;
            // the declared size was checked above; `take` holds a lying header to it
            std::io::copy(&mut entry.take(MAX_UNPACKED), &mut out)?;
        }
        if !found {
            return Err(ExtensionError::NoManifest);
        }
        let manifest = std::fs::read(staging.join(MANIFEST))?;
        serde_json::from_slice::<serde_json::Value>(&manifest)
            .map_err(|e| ExtensionError::Manifest(e.to_string()))?;
        // the record is ours: an archive does not get to bring its own
        match origin {
            Some(source) => std::fs::write(staging.join(SOURCE), &source.url)?,
            None => {
                let _ = std::fs::remove_file(staging.join(SOURCE));
            }
        }
        Ok(())
    };
    if let Err(e) = unpack() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    if target.exists() {
        std::fs::remove_dir_all(&target)?;
    }
    std::fs::rename(&staging, &target)?;
    Ok(read_info(name, &target))
}

// ---- import scan ----

fn static_import() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // `import a, { b as c } from "x"`, `export { d } from 'x'`, minified or not
        Regex::new(r#"\b(?:import|export)\b\s*([^"'`();=]*?)\s*\bfrom\s*["']([^"'\n]+)["']"#)
            .expect("static import pattern")
    })
}

fn bare_import() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // `import "x"` and `import("x")`
        Regex::new(r#"\bimport\s*\(?\s*["'`]([^"'`\n$]+)["'`]"#).expect("bare import pattern")
    })
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// The names an import clause asks for: `a, { b as c, default as d }` → `default`, `b`, `default`.
fn clause_names(clause: &str) -> Vec<String> {
    let mut out = Vec::new();
    let (head, braces) = match (clause.find('{'), clause.rfind('}')) {
        (Some(open), Some(close)) if open < close => (&clause[..open], &clause[open + 1..close]),
        _ => (clause, ""),
    };
    let default = head.trim().trim_end_matches(',').trim();
    if is_identifier(default) && default != "type" {
        out.push("default".to_owned());
    }
    for part in braces.split(',') {
        let name = part.split_whitespace().next().unwrap_or("");
        if is_identifier(name) {
            out.push(name.to_owned());
        }
    }
    out
}

/// Resolves a module specifier against the importing module's URL path. None for bare
/// specifiers, full URLs and anything that is not a script.
fn resolve_specifier(from: &str, specifier: &str) -> Option<String> {
    let specifier = specifier.split(['?', '#']).next().unwrap_or("");
    let joined = if specifier.starts_with('/') {
        specifier.to_owned()
    } else if specifier.starts_with("./") || specifier.starts_with("../") {
        let folder = from.rsplit_once('/').map_or("", |(folder, _)| folder);
        format!("{folder}/{specifier}")
    } else {
        return None;
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let path = format!("/{}", parts.join("/"));
    path.ends_with(".js").then_some(path)
}

/// Host modules one script imports. `module_path` is the script's own URL path.
pub fn scan_imports(source: &str, module_path: &str) -> BTreeMap<String, BTreeSet<String>> {
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut add = |specifier: &str, names: Vec<String>| {
        let Some(path) = resolve_specifier(module_path, specifier) else {
            return;
        };
        // another extension's file, or its own: served as is, not a host module
        if path.starts_with(URL_PREFIX) {
            return;
        }
        out.entry(path).or_default().extend(names);
    };
    for found in static_import().captures_iter(source) {
        add(&found[2], clause_names(&found[1]));
    }
    for found in bare_import().captures_iter(source) {
        add(&found[1], Vec::new());
    }
    out
}

fn scan_folder(name: &str, folder: &Path) -> BTreeMap<String, BTreeSet<String>> {
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let walker = walkdir::WalkDir::new(folder)
        .into_iter()
        .filter_entry(|e| {
            let file_name = e.file_name().to_string_lossy();
            e.depth() == 0 || !(file_name.starts_with('.') || file_name == "node_modules")
        })
        .flatten();
    for entry in walker {
        let path = entry.path();
        let is_script = matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("js" | "mjs")
        );
        if !is_script || !entry.file_type().is_file() {
            continue;
        }
        if entry.metadata().map_or(true, |m| m.len() > MAX_SCANNED) {
            continue;
        }
        let Ok(rel) = path.strip_prefix(folder) else {
            continue;
        };
        let mut source = String::new();
        if std::fs::File::open(path)
            .and_then(|mut f| f.read_to_string(&mut source))
            .is_err()
        {
            continue;
        }
        let rel = rel.to_string_lossy().replace('\\', "/");
        let module_path = format!("{URL_PREFIX}{name}/{rel}");
        for (host, names) in scan_imports(&source, &module_path) {
            out.entry(host).or_default().extend(names);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn zip_of(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ext.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for (name, body) in files {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        (dir, path)
    }

    fn names(map: &BTreeMap<String, BTreeSet<String>>, path: &str) -> Vec<String> {
        map.get(path)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }

    const HERE: &str = "/scripts/extensions/third-party/sample/index.js";

    #[test]
    fn scan_finds_relative_and_absolute_host_imports() {
        let source = r#"
            import { eventSource, event_types as types } from '../../../../script.js';
            import {extension_settings,getContext}from"../../../extensions.js";
            import * as utils from '/scripts/utils.js';
            import helper from './helper.js';
            import 'https://example.com/x.js';
            export { saveSettingsDebounced } from '../../../../script.js?v=2';
        "#;
        let found = scan_imports(source, HERE);
        assert_eq!(
            names(&found, "/script.js"),
            ["eventSource", "event_types", "saveSettingsDebounced"]
        );
        assert_eq!(
            names(&found, "/scripts/extensions.js"),
            ["extension_settings", "getContext"]
        );
        assert!(found.contains_key("/scripts/utils.js"));
        assert!(names(&found, "/scripts/utils.js").is_empty());
        // its own file and the external url are not host modules
        assert_eq!(found.len(), 3);
    }

    #[test]
    fn scan_sees_default_and_dynamic_imports() {
        let source = r#"
            import moment, { duration } from '/lib/moment.js';
            const m = await import("/scripts/world-info.js");
            const n = await import(`/scripts/power-user.js`);
            const skipped = await import(`/scripts/${name}.js`);
        "#;
        let found = scan_imports(source, HERE);
        assert_eq!(names(&found, "/lib/moment.js"), ["default", "duration"]);
        assert!(found.contains_key("/scripts/world-info.js"));
        assert!(found.contains_key("/scripts/power-user.js"));
        assert_eq!(found.len(), 3);
    }

    #[test]
    fn resolve_file_stays_inside_the_extension() {
        let root = Path::new("/data");
        assert_eq!(
            resolve_file(root, "sample", "dist/index.js"),
            Some(PathBuf::from("/data/extensions/sample/dist/index.js"))
        );
        assert_eq!(resolve_file(root, "sample", "../other/x.js"), None);
        assert_eq!(resolve_file(root, "sample", ".git/config"), None);
        assert_eq!(resolve_file(root, "../x", "a.js"), None);
        assert_eq!(resolve_file(root, "a/b", "a.js"), None);
    }

    #[test]
    fn install_strips_the_github_wrapper_and_lists_the_extension() {
        let (_keep, zip) = zip_of(&[
            (
                "Sample-Ext-main/manifest.json",
                r#"{"display_name":"Sample","js":"index.js"}"#,
            ),
            (
                "Sample-Ext-main/index.js",
                "import { eventSource } from '../../../../script.js';",
            ),
            (
                "Sample-Ext-main/node_modules/dep/index.js",
                "import { x } from '/script.js';",
            ),
        ]);
        let root = tempfile::tempdir().unwrap();
        let info = install_zip(root.path(), &zip, "ext").unwrap();
        assert_eq!(info.name, "Sample-Ext");
        assert_eq!(info.manifest["display_name"], "Sample");
        assert_eq!(names(&info.imports, "/script.js"), ["eventSource"]);
        assert!(root.path().join("extensions/Sample-Ext/index.js").is_file());
        assert!(!root.path().join("extensions/.tmp-Sample-Ext").exists());

        let listed = list(root.path()).unwrap();
        assert_eq!(listed, vec![info]);
        remove(root.path(), "Sample-Ext").unwrap();
        assert!(list(root.path()).unwrap().is_empty());
    }

    #[test]
    fn install_without_wrapper_uses_the_zip_name_and_replaces_the_old_copy() {
        let root = tempfile::tempdir().unwrap();
        let (_a, first) = zip_of(&[("manifest.json", "{}"), ("old.js", "")]);
        install_zip(root.path(), &first, "plain").unwrap();
        let (_b, second) = zip_of(&[("manifest.json", "{}"), ("new.js", "")]);
        let info = install_zip(root.path(), &second, "plain").unwrap();
        assert_eq!(info.name, "plain");
        assert!(root.path().join("extensions/plain/new.js").is_file());
        assert!(!root.path().join("extensions/plain/old.js").exists());
    }

    #[test]
    fn install_refuses_archives_that_are_not_extensions() {
        let root = tempfile::tempdir().unwrap();
        let (_a, no_manifest) = zip_of(&[("a/index.js", ""), ("b/index.js", "")]);
        assert!(matches!(
            install_zip(root.path(), &no_manifest, "x"),
            Err(ExtensionError::NoManifest)
        ));
        let (_b, broken) = zip_of(&[("manifest.json", "{not json")]);
        assert!(matches!(
            install_zip(root.path(), &broken, "x"),
            Err(ExtensionError::Manifest(_))
        ));
        let (_c, slip) = zip_of(&[("manifest.json", "{}"), ("../evil.js", "")]);
        assert!(matches!(
            install_zip(root.path(), &slip, "x"),
            Err(ExtensionError::UnsafePath(_))
        ));
        assert!(list(root.path()).unwrap().is_empty());
    }

    #[test]
    fn list_reports_a_broken_manifest_instead_of_hiding_the_folder() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("extensions/broken");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("manifest.json"), "[]").unwrap();
        let listed = list(root.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].manifest.is_null());
        assert!(listed[0].error.is_some());
    }

    #[test]
    fn github_source_accepts_repository_addresses_only() {
        let plain = github_source(" https://github.com/someone/Some-Ext.git ").unwrap();
        assert_eq!(plain.name, "Some-Ext");
        assert_eq!(plain.url, "https://github.com/someone/Some-Ext");
        assert_eq!(
            plain.zip_url,
            "https://codeload.github.com/someone/Some-Ext/zip/HEAD"
        );
        let shouted = github_source("HTTPS://GitHub.com/someone/ext").unwrap();
        assert_eq!(shouted.url, "https://github.com/someone/ext");
        let branch = github_source("https://github.com/someone/ext/tree/dev/next/").unwrap();
        assert_eq!(branch.url, "https://github.com/someone/ext/tree/dev/next");
        assert_eq!(
            branch.zip_url,
            "https://codeload.github.com/someone/ext/zip/refs/heads/dev/next"
        );
        for bad in [
            "http://github.com/someone/ext",
            "https://github.com.evil.example/someone/ext",
            "https://gitlab.com/someone/ext",
            "https://github.com/someone",
            "https://github.com/someone/ext/blob/main/index.js",
            "https://github.com/someone/../ext",
            "https://github.com/someone/ext/tree/..",
            "https://github.com/some one/ext",
        ] {
            assert_eq!(github_source(bad), None, "{bad}");
        }
    }

    #[test]
    fn github_install_names_by_repository_and_records_the_address() {
        let (_dir, path) = zip_of(&[
            (
                "someone-ext-0a1b2c3/manifest.json",
                r#"{"display_name":"x"}"#,
            ),
            ("someone-ext-0a1b2c3/index.js", ""),
            (
                "someone-ext-0a1b2c3/.tm-source",
                "https://github.com/other/thing",
            ),
        ]);
        let root = tempfile::tempdir().unwrap();
        let source = github_source("https://github.com/someone/ext").unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let info = install_github_zip(root.path(), bytes, &source).unwrap();
        assert_eq!(info.name, "ext");
        assert_eq!(
            info.source.as_deref(),
            Some("https://github.com/someone/ext")
        );

        // the same archive as a plain zip: its own record does not survive
        let info = install_zip(root.path(), &path, "ext").unwrap();
        assert_eq!(info.name, "someone-ext-0a1b2c3");
        assert_eq!(info.source, None);
    }
}
