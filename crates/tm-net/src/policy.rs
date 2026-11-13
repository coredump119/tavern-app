use std::net::IpAddr;

use url::{Host, Url};

use crate::error::NetError;

/// 本地 / 局域网主机：loopback、RFC1918、link-local、ULA、`localhost`、`*.local` / `*.lan`
pub fn is_local_or_private_host(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || o[0] == 0
                || (o[0] == 100 && (64..=127).contains(&o[1]))
        }
        Host::Ipv6(v6) => {
            let seg = v6.segments();
            v6.is_loopback()
                || (seg[0] & 0xfe00) == 0xfc00
                || (seg[0] & 0xffc0) == 0xfe80
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| is_local_or_private_host(&Host::Ipv4(v4)))
        }
        Host::Domain(d) => {
            let d = d.to_ascii_lowercase();
            d == "localhost"
                || d.ends_with(".localhost")
                || d.ends_with(".local")
                || d.ends_with(".lan")
        }
    }
}

/// 解析并检查 URL：https 放行；http 仅本地 / 局域网，或 `allow_insecure_http`；其它 scheme 拒绝。
pub fn check_url(raw: &str, allow_insecure_http: bool) -> Result<Url, NetError> {
    let url = Url::parse(raw).map_err(|e| NetError::InvalidUrl(e.to_string()))?;
    match url.scheme() {
        "https" => Ok(url),
        "http" => {
            let host = url
                .host()
                .ok_or_else(|| NetError::InvalidUrl("no host".into()))?;
            if allow_insecure_http || is_local_or_private_host(&host) {
                Ok(url)
            } else {
                Err(NetError::InsecureHttp(host.to_string()))
            }
        }
        other => Err(NetError::InvalidUrl(format!("unsupported scheme {other}"))),
    }
}

/// ST 服务端把 `localhost` 换成 127.0.0.1（避免 Node 走 IPv6 失败）；这里保留同样的习惯
pub fn normalize_localhost(raw: &str) -> String {
    raw.replace("localhost", "127.0.0.1")
}

#[allow(dead_code)]
fn _ip(_: IpAddr) {}
