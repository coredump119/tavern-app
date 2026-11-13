//! The extension host's own origin (DEV_NOTES §9.34): `tmext://localhost`
//! (`http://tmext.localhost` on Android and Windows).
//!
//! SillyTavern extensions are ES modules written against ST's URL layout: they live under
//! `/scripts/extensions/third-party/<name>/` and import `/script.js`, `/scripts/*.js` and friends
//! by relative or absolute path. Serving them from one origin with that layout keeps every such
//! specifier working. Two kinds of path are answered:
//! - an installed extension's files, straight from `<data root>/extensions/<name>/`;
//! - any other script path, with a generated stand-in module whose exports read from the table
//!   the app keeps in `globalThis.__tmStModules`.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::http::{header, HeaderValue, Method, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};
use tm_data::extensions::{resolve_file, URL_PREFIX};

pub const SCHEME: &str = "tmext";

type Body = Vec<u8>;

/// Host module path → the names its stand-in exports. Set by the app before it loads extensions.
#[derive(Default)]
pub struct Shims(Mutex<HashMap<String, BTreeSet<String>>>);

impl Shims {
    pub fn set(&self, table: HashMap<String, BTreeSet<String>>) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = table;
        }
    }

    fn names(&self, path: &str) -> Vec<String> {
        self.0
            .lock()
            .ok()
            .and_then(|guard| guard.get(path).map(|set| set.iter().cloned().collect()))
            .unwrap_or_default()
    }
}

/// Words that cannot be declared with `export let`.
const RESERVED: &[&str] = &[
    "arguments",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "eval",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
];

fn exportable(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
        && !RESERVED.contains(&name)
}

/// The stand-in for one host module. Every export starts as whatever the app put in the table
/// (undefined when it has nothing by that name) and follows later changes through `__live`, the
/// way ST's own `export let` bindings do. A module nobody registered a name for reports itself to
/// the page: a computed `import()` path is invisible to the static import scan.
pub fn shim_source(path: &str, names: &[String]) -> String {
    let key = serde_json::to_string(path).unwrap_or_else(|_| "\"\"".into());
    let mut out = format!("const m = ((globalThis.__tmStModules ??= {{}})[{key}] ??= {{}});\n");
    if names.is_empty() {
        out.push_str(&format!("globalThis.__tmStModuleLoad?.({key});\n"));
    }
    let named: Vec<&String> = names.iter().filter(|n| exportable(n)).collect();
    if !named.is_empty() {
        let declarations: Vec<String> = named.iter().map(|n| format!("{n} = m.{n}")).collect();
        out.push_str(&format!("export let {};\n", declarations.join(", ")));
        out.push_str("(m.__live ??= []).push((k, v) => {\n  switch (k) {\n");
        for name in &named {
            out.push_str(&format!("    case \"{name}\": {name} = v; break;\n"));
        }
        out.push_str("  }\n});\n");
    }
    if names.iter().any(|n| n == "default") {
        out.push_str("export default m.default;\n");
    }
    out
}

fn mime_for(path: &str) -> &'static str {
    match path
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("wasm") => "application/wasm",
        Some("txt" | "md") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn respond(status: StatusCode, mime: &str, body: Body) -> Response<Body> {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(mime) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    // module scripts and fetches from the app document are cross-origin requests
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // an extension can be replaced on disk; the stand-ins change with what is installed
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn plain(status: StatusCode, message: &str) -> Response<Body> {
    respond(
        status,
        "text/plain; charset=utf-8",
        message.as_bytes().to_vec(),
    )
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Debug, PartialEq, Eq)]
enum Target {
    /// `<name>`, `<path inside the extension>`
    File(String, String),
    Shim,
    None,
}

fn target(path: &str) -> Target {
    if path.contains("..") || path.contains('\\') || path.contains("//") {
        return Target::None;
    }
    if let Some(rest) = path.strip_prefix(URL_PREFIX) {
        return match rest.split_once('/') {
            Some((name, rel)) if !name.is_empty() && !rel.is_empty() => {
                Target::File(name.to_owned(), rel.to_owned())
            }
            _ => Target::None,
        };
    }
    if path.ends_with(".js") {
        Target::Shim
    } else {
        Target::None
    }
}

fn data_root<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("data"))
}

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return responder.respond(plain(StatusCode::METHOD_NOT_ALLOWED, "method not allowed"));
    }
    let path = percent_decode(request.uri().path());
    match target(&path) {
        Target::None => responder.respond(plain(StatusCode::NOT_FOUND, "not found")),
        Target::Shim => {
            let names = ctx.app_handle().state::<Shims>().names(&path);
            let body = shim_source(&path, &names).into_bytes();
            responder.respond(respond(StatusCode::OK, mime_for(&path), body));
        }
        Target::File(name, rel) => {
            let Some(file) =
                data_root(ctx.app_handle()).and_then(|root| resolve_file(&root, &name, &rel))
            else {
                return responder.respond(plain(StatusCode::NOT_FOUND, "not found"));
            };
            // disk read off the webview's thread
            tauri::async_runtime::spawn_blocking(move || {
                let response = match std::fs::read(&file) {
                    Ok(body) => respond(StatusCode::OK, mime_for(&rel), body),
                    Err(_) => plain(StatusCode::NOT_FOUND, "not found"),
                };
                responder.respond(response);
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_split_into_extension_files_and_stand_ins() {
        assert_eq!(
            target("/scripts/extensions/third-party/sample/dist/index.js"),
            Target::File("sample".into(), "dist/index.js".into())
        );
        assert_eq!(target("/script.js"), Target::Shim);
        assert_eq!(target("/scripts/extensions/regex/engine.js"), Target::Shim);
        for path in [
            "/",
            "/index.html",
            "/scripts/extensions/third-party/sample",
            "/scripts/extensions/third-party//x.js",
            "/scripts/extensions/third-party/sample/../other/x.js",
            "/scripts\\x.js",
            "/css/style.css",
        ] {
            assert_eq!(target(path), Target::None, "{path}");
        }
    }

    #[test]
    fn a_stand_in_exports_the_registered_names_with_live_bindings() {
        let names = [
            "chat".to_owned(),
            "default".to_owned(),
            "this_chid".to_owned(),
        ];
        let source = shim_source("/script.js", &names);
        assert!(source.starts_with(
            "const m = ((globalThis.__tmStModules ??= {})[\"/script.js\"] ??= {});\n"
        ));
        assert!(source.contains("export let chat = m.chat, this_chid = m.this_chid;\n"));
        assert!(source.contains("case \"this_chid\": this_chid = v; break;"));
        assert!(source.contains("export default m.default;\n"));
        assert!(!source.contains("default = "));
        assert!(!source.contains("__tmStModuleLoad"));
    }

    #[test]
    fn names_that_cannot_be_declared_are_left_out() {
        let names = [
            "class".to_owned(),
            "a-b".to_owned(),
            "1x".to_owned(),
            "ok".to_owned(),
        ];
        let source = shim_source("/scripts/utils.js", &names);
        assert!(source.contains("export let ok = m.ok;\n"));
        assert!(!source.contains("class"));
        assert!(!source.contains("a-b"));
    }

    #[test]
    fn an_unknown_module_is_a_valid_empty_module_that_reports_itself() {
        let source = shim_source("/scripts/\"odd\".js", &[]);
        assert_eq!(
            source,
            "const m = ((globalThis.__tmStModules ??= {})[\"/scripts/\\\"odd\\\".js\"] ??= {});\n\
             globalThis.__tmStModuleLoad?.(\"/scripts/\\\"odd\\\".js\");\n"
        );
    }

    #[test]
    fn responses_are_readable_across_origins_and_never_cached() {
        let response = respond(StatusCode::OK, mime_for("a/b.JS"), Vec::new());
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
}
