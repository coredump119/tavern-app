//! 非流式的通用 HTTP 调用（模型列表、连接检测、二次探测等）。与 `generate` 共用客户端、URL 策略与密钥头规则。
use std::collections::BTreeMap;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::client::client;
use crate::error::NetError;
use crate::policy::check_url;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    #[default]
    Get,
    Post,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchRequest {
    pub url: String,
    #[serde(default)]
    pub method: HttpMethod,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// 有值且未显式给 auth 头时：`Authorization: Bearer`，或 `auth_header` 指定的头
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub auth_header: Option<String>,
    /// POST 的 JSON 体
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub allow_insecure_http: bool,
    /// 默认 30s
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FetchResponse {
    pub status: u16,
    pub ok: bool,
    /// 能解析成 JSON 时有值
    pub json: Option<Value>,
    /// 原始文本（截断到 64 KiB）
    pub text: String,
    /// 响应头（小写名）
    pub headers: BTreeMap<String, String>,
}

/// 按 `headers` / `api_key` / `auth_header` 组装请求头（generate 与 fetch 共用）
pub fn build_headers(
    headers: &BTreeMap<String, String>,
    api_key: Option<&str>,
    auth_header: Option<&str>,
    json_body: bool,
) -> Result<HeaderMap, NetError> {
    let mut out = HeaderMap::new();
    if json_body {
        out.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    for (k, v) in headers {
        let name = HeaderName::from_bytes(k.as_bytes())
            .map_err(|e| NetError::InvalidUrl(format!("header {k}: {e}")))?;
        let value = HeaderValue::from_str(v)
            .map_err(|e| NetError::InvalidUrl(format!("header {k}: {e}")))?;
        out.insert(name, value);
    }
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        // `auth_header` is a comma-separated list of header names; `bearer` (or none at all)
        // means `Authorization: Bearer <key>`, any other name carries the raw key (DEV_NOTES §9.19).
        let names: Vec<&str> = auth_header
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .collect();
        let names = if names.is_empty() {
            vec!["bearer"]
        } else {
            names
        };
        for name in names {
            if name.eq_ignore_ascii_case("bearer") {
                if !out.contains_key(AUTHORIZATION) {
                    out.insert(
                        AUTHORIZATION,
                        HeaderValue::from_str(&format!("Bearer {key}"))
                            .map_err(|e| NetError::InvalidUrl(e.to_string()))?,
                    );
                }
                continue;
            }
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|e| NetError::InvalidUrl(format!("auth header: {e}")))?;
            if !out.contains_key(&name) {
                out.insert(
                    name,
                    HeaderValue::from_str(key).map_err(|e| NetError::InvalidUrl(e.to_string()))?,
                );
            }
        }
    }
    Ok(out)
}

/// 发一次请求并读完响应。非 2xx 不是 Err（`ok=false`，调用方按 ST 语义处理）；只有传输 / 策略错误是 Err。
pub async fn fetch(
    req: &FetchRequest,
    cancel: &CancellationToken,
) -> Result<FetchResponse, NetError> {
    let url = check_url(&req.url, req.allow_insecure_http)?;
    let headers = build_headers(
        &req.headers,
        req.api_key.as_deref(),
        req.auth_header.as_deref(),
        req.body.is_some(),
    )?;
    let mut builder = match req.method {
        HttpMethod::Get => client().get(url),
        HttpMethod::Post => client().post(url),
    }
    .headers(headers)
    .timeout(std::time::Duration::from_millis(
        req.timeout_ms.unwrap_or(30_000),
    ));
    if let Some(body) = &req.body {
        builder = builder.json(body);
    }
    let response = tokio::select! {
        r = builder.send() => r?,
        _ = cancel.cancelled() => return Err(NetError::Aborted),
    };
    let status = response.status();
    let mut out_headers = BTreeMap::new();
    for (k, v) in response.headers() {
        if let Ok(s) = v.to_str() {
            out_headers.insert(k.as_str().to_ascii_lowercase(), s.to_string());
        }
    }
    let text = tokio::select! {
        t = response.text() => t?,
        _ = cancel.cancelled() => return Err(NetError::Aborted),
    };
    let json = serde_json::from_str::<Value>(&text).ok();
    let mut truncated = text;
    if truncated.len() > 65536 {
        let mut cut = 65536;
        while !truncated.is_char_boundary(cut) {
            cut -= 1;
        }
        truncated.truncate(cut);
    }
    Ok(FetchResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        json,
        text: truncated,
        headers: out_headers,
    })
}

#[cfg(test)]
mod header_tests {
    use super::*;

    #[test]
    fn auth_header_list() {
        let none = BTreeMap::new();
        let h = build_headers(&none, Some("k"), None, false).unwrap();
        assert_eq!(h.get(AUTHORIZATION).unwrap(), "Bearer k");
        let h = build_headers(&none, Some("k"), Some("x-api-key"), false).unwrap();
        assert_eq!(h.get("x-api-key").unwrap(), "k");
        assert!(h.get(AUTHORIZATION).is_none());
        let h = build_headers(&none, Some("k"), Some("X-API-KEY, bearer"), true).unwrap();
        assert_eq!(h.get("x-api-key").unwrap(), "k");
        assert_eq!(h.get(AUTHORIZATION).unwrap(), "Bearer k");
        assert_eq!(h.get(CONTENT_TYPE).unwrap(), "application/json");
        let h = build_headers(&none, None, Some("x-api-key,bearer"), false).unwrap();
        assert!(h.is_empty());
        let mut explicit = BTreeMap::new();
        explicit.insert("authorization".to_string(), "Basic z".to_string());
        let h = build_headers(&explicit, Some("k"), Some("bearer"), false).unwrap();
        assert_eq!(h.get(AUTHORIZATION).unwrap(), "Basic z");
    }
}
