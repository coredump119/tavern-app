#[derive(Debug, thiserror::Error)]
pub enum NetError {
    /// the reason only: error text reaches the page, scripts and the crash log, and the
    /// address may carry a key (DEV_NOTES §9.38)
    #[error("invalid url: {0}")]
    InvalidUrl(String),
    /// holds the host for callers; the message leaves it out
    #[error("insecure http to non-local host refused")]
    InsecureHttp(String),
    #[error("transport error: {0}")]
    Transport(String),
    #[error("http {status}: {message}")]
    Http { status: u16, message: String },
    #[error("upstream error: {0}")]
    Upstream(String),
    #[error("aborted")]
    Aborted,
    #[error("json error: {0}")]
    Json(String),
}

impl From<reqwest::Error> for NetError {
    fn from(e: reqwest::Error) -> Self {
        // reqwest prints the full URL, and a URL can carry a key in its query
        NetError::Transport(e.without_url().to_string())
    }
}

impl From<serde_json::Error> for NetError {
    fn from(e: serde_json::Error) -> Self {
        NetError::Json(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transport_errors_do_not_carry_the_url() {
        // a port nothing listens on: bind, note the port, close
        let port = {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let url = format!("http://127.0.0.1:{port}/v1/models?key=SECRETVALUE");
        let e = reqwest::Client::new().get(&url).send().await.unwrap_err();
        assert!(
            e.to_string().contains("SECRETVALUE"),
            "reqwest no longer prints the url"
        );
        let text = NetError::from(e).to_string();
        assert!(
            !text.contains("SECRETVALUE") && !text.contains("127.0.0.1"),
            "{text}"
        );
    }
}
