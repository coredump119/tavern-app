//! The TavernHelper realm (DEV_NOTES §7, §9.5).
//!
//! Scripts shipped inside character cards and presets run in iframes served from their own origin,
//! `tmhelper://localhost` (`http://tmhelper.localhost` on Android and Windows). That origin is
//! cross-origin to the app, so those scripts cannot touch the app document or its IPC bridge.
//!
//! Two parts live here:
//! - the `tmhelper` URI scheme handler, which serves only the realm's own pages and bundles;
//! - the invoke-system script, which keeps the IPC invoke key out of every sub-frame.

use tauri::http::{header, HeaderValue, Method, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "tmhelper";

/// Card scripts get the same latitude they have in SillyTavern: inline script, `eval`, any HTTPS
/// resource. They get no IPC and no app document.
const CSP_COMMON: &str = "default-src 'self' https: data: blob:; \
script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:; \
style-src 'self' 'unsafe-inline' https:; \
img-src 'self' https: http: data: blob: asset: http://asset.localhost; \
media-src 'self' https: http: data: blob:; \
font-src 'self' https: data:; \
frame-src 'self' https: blob: data:";

/// The dev server's HMR socket needs `ws:` / `http:`; release builds only talk to TLS endpoints.
#[cfg(dev)]
const CSP_CONNECT: &str = "connect-src 'self' https: wss: http: ws:";
#[cfg(not(dev))]
const CSP_CONNECT: &str = "connect-src 'self' https: wss:";

type Body = Vec<u8>;

/// Tauri's IPC bootstrap, limited to the top frame. `__INVOKE_KEY__` is filled in by
/// [`tauri::Builder::invoke_system`].
pub fn invoke_system_script() -> String {
    let os = serde_json::to_string(std::env::consts::OS).unwrap_or_else(|_| "\"\"".into());
    include_str!("ipc_top_frame.js").replace("__TM_OS_NAME__", &os)
}

/// Whether a request path belongs to the realm. Release builds serve the two realm pages and the
/// hashed bundles they import; nothing else, and never the app shell.
fn servable(path: &str) -> bool {
    if path.contains("..") || path.contains('\\') || path.contains("//") {
        return false;
    }
    if cfg!(dev) {
        // the dev server resolves module ids all over its root (`/src`, `/@vite`, `/node_modules`)
        return path != "/" && path != "/index.html";
    }
    path.starts_with("/th/") || path.starts_with("/assets/")
}

/// Paths cards written for SillyTavern hard-code, answered with the realm's own copy of the file
/// (`tools/th-libs/copy.mjs` puts those under `/th/lib/`). An explicit list on purpose: nothing
/// else outside the realm's folders may become reachable.
const ALIASES: &[(&str, &str)] = &[
    (
        "/scripts/extensions/third-party/JS-Slash-Runner/lib/tailwindcss.min.js",
        "/th/lib/tailwindcss.min.js",
    ),
    ("/lib/jquery-3.5.1.min.js", "/th/lib/jquery.min.js"),
    ("/lib/jquery-ui.min.js", "/th/lib/jquery-ui.min.js"),
    (
        "/lib/jquery.ui.touch-punch.min.js",
        "/th/lib/jquery.ui.touch-punch.min.js",
    ),
    (
        "/css/fontawesome.min.css",
        "/th/lib/fontawesome/css/fontawesome.min.css",
    ),
    (
        "/css/solid.min.css",
        "/th/lib/fontawesome/css/solid.min.css",
    ),
    (
        "/css/brands.min.css",
        "/th/lib/fontawesome/css/brands.min.css",
    ),
    // the two stylesheets above ask for their fonts relative to where they were requested
    (
        "/webfonts/fa-solid-900.woff2",
        "/th/lib/fontawesome/webfonts/fa-solid-900.woff2",
    ),
    (
        "/webfonts/fa-brands-400.woff2",
        "/th/lib/fontawesome/webfonts/fa-brands-400.woff2",
    ),
];

/// The path a request is answered from: an alias's target, any other path as it is.
fn resolve(path: &str) -> &str {
    ALIASES
        .iter()
        .find(|(from, _)| *from == path)
        .map_or(path, |(_, to)| to)
}

fn plain(status: StatusCode, message: &str) -> Response<Body> {
    let mut response = Response::new(message.as_bytes().to_vec());
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

fn ok(mime: &str, body: Body) -> Response<Body> {
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(mime) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    if let Ok(value) = HeaderValue::from_str(&format!("{CSP_COMMON}; {CSP_CONNECT}")) {
        headers.insert(header::CONTENT_SECURITY_POLICY, value);
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return responder.respond(plain(StatusCode::METHOD_NOT_ALLOWED, "method not allowed"));
    }
    if !servable(resolve(request.uri().path())) {
        return responder.respond(plain(StatusCode::NOT_FOUND, "not found"));
    }
    serve(ctx, request, responder);
}

/// Dev: forward to the Vite dev server, so the realm gets the same module graph and HMR as the app.
#[cfg(dev)]
fn serve<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let Some(base) = ctx.app_handle().config().build.dev_url.clone() else {
        return responder.respond(plain(StatusCode::NOT_FOUND, "no dev server"));
    };
    let path = resolve(request.uri().path());
    let target = match request.uri().query() {
        Some(query) => format!("{path}?{query}"),
        None => path.to_owned(),
    };
    tauri::async_runtime::spawn(async move {
        let response = match proxy(&base, &target).await {
            Ok(response) => response,
            Err(e) => plain(StatusCode::BAD_GATEWAY, &e.to_string()),
        };
        responder.respond(response);
    });
}

#[cfg(dev)]
async fn proxy(base: &tauri::Url, target: &str) -> Result<Response<Body>, reqwest::Error> {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap_or_default()
    });
    let url = format!("{}{target}", base.origin().ascii_serialization());
    let upstream = client.get(url).send().await?;
    let status = upstream.status();
    let mime = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let body = upstream.bytes().await?.to_vec();
    let mut response = ok(&mime, body);
    *response.status_mut() =
        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    Ok(response)
}

/// Release: answer from the embedded frontend bundle.
#[cfg(not(dev))]
fn serve<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    use std::collections::HashSet;
    use std::sync::OnceLock;

    // The resolver answers unknown paths with `index.html`; the realm must never serve the app
    // shell, so only paths that exist as embedded assets get through.
    static KNOWN: OnceLock<HashSet<String>> = OnceLock::new();
    let resolver = ctx.app_handle().asset_resolver();
    let known = KNOWN.get_or_init(|| {
        resolver
            .iter()
            .map(|(path, _)| path.into_owned())
            .filter(|path| servable(path))
            .collect()
    });
    let path = resolve(request.uri().path());
    let response = match known.get(path).and_then(|p| resolver.get(p.clone())) {
        Some(asset) => ok(&asset.mime_type, asset.bytes),
        None => plain(StatusCode::NOT_FOUND, "not found"),
    };
    responder.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_and_the_app_shell_are_never_servable() {
        for path in ["/", "/index.html", "/th/../index.html", "/th//x", "/th\\x"] {
            assert!(!servable(path), "{path}");
        }
        assert!(servable("/th/hub.html"));
        assert!(servable("/assets/slot-abc.js"));
    }

    #[test]
    fn hard_coded_library_paths_resolve_into_the_library_folder() {
        assert_eq!(
            resolve("/scripts/extensions/third-party/JS-Slash-Runner/lib/tailwindcss.min.js"),
            "/th/lib/tailwindcss.min.js"
        );
        assert_eq!(
            resolve("/webfonts/fa-solid-900.woff2"),
            "/th/lib/fontawesome/webfonts/fa-solid-900.woff2"
        );
        for (from, to) in ALIASES {
            assert!(to.starts_with("/th/lib/"), "{to}");
            assert!(servable(to), "{to}");
            assert!(!from.starts_with("/th/") && !from.starts_with("/assets/"));
            // one hop only: a target is never itself an alias
            assert_eq!(resolve(to), *to);
        }
    }

    #[test]
    fn other_paths_are_left_alone() {
        for path in [
            "/",
            "/index.html",
            "/th/hub.html",
            "/lib/toastr.min.js",
            "/lib/jquery-3.5.1.min.js/",
            "/lib/../lib/jquery-ui.min.js",
            "/scripts/extensions/third-party/JS-Slash-Runner/dist/index.js",
            "/scripts/extensions/third-party/JS-Slash-Runner/lib/TAILWINDCSS.min.js",
            "/webfonts/fa-solid-900.ttf",
        ] {
            assert_eq!(resolve(path), path);
        }
        // what is not listed stays outside the realm in a release build
        if !cfg!(dev) {
            assert!(!servable(resolve("/lib/toastr.min.js")));
            assert!(!servable(resolve("/css/jquery-ui.min.css")));
        }
        assert!(!servable(resolve("/lib/../lib/jquery-ui.min.js")));
    }

    #[test]
    fn responses_carry_the_realm_policy() {
        let response = ok("text/html", Vec::new());
        let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap();
        assert!(csp.contains("script-src 'self' 'unsafe-inline' 'unsafe-eval'"));
        assert!(!csp.contains("ipc:"));
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
    }

    #[test]
    fn the_invoke_script_is_top_frame_only_and_keeps_the_key_token() {
        let script = invoke_system_script();
        let guard = script.find("window.self !== window.top").unwrap();
        let key = script.find("__INVOKE_KEY__").unwrap();
        assert!(guard < key);
        assert!(!script.contains("__TM_OS_NAME__"));
    }
}
