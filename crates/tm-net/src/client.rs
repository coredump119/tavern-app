use std::sync::OnceLock;
use std::time::Duration;

/// 全进程单例：rustls、HTTP/2、连接池；流式请求不设总超时。证书来源见 `trust_roots`。
pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let builder = reqwest::Client::builder()
            .user_agent(concat!("TavernMobile/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(30))
            .pool_idle_timeout(Duration::from_secs(90));
        trust_roots(builder).build().expect("reqwest client")
    })
}

/// Android：平台校验器没经 JNI 初始化就 panic，改用随包的 Mozilla 根证书（DEV_NOTES §6）。
#[cfg(target_os = "android")]
fn trust_roots(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder.tls_certs_only(
        webpki_root_certs::TLS_SERVER_ROOT_CERTS
            .iter()
            .filter_map(|der| reqwest::Certificate::from_der(der).ok()),
    )
}

/// 其余平台走平台证书校验（系统根证书）。
#[cfg(not(target_os = "android"))]
fn trust_roots(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder
}
