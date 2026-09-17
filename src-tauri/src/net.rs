//! 同步用的薄 HTTP 通道。
//!
//! ## 为什么 HTTP 在 Rust 侧
//!
//! 渲染进程里的 `fetch` 受同源策略约束：后端（Spring Boot）没有配置 CORS 响应头，
//! WebView 的源（`http://tauri.localhost`）不在白名单里，请求走不通。而且同步要带
//! 账号密码与 JWT，把它放在能直接被页面脚本读到的地方也没有必要。
//!
//! ## 为什么这个模块**不**解释业务状态码
//!
//! 与插件的 `send()` 一一对应：它只负责把字节发出去、把响应原样带回来。
//! 401 要不要续期、404 是不是"云端没有这个附件"这类判断属于同步逻辑，
//! 放在那里（可被单测覆盖）比埋在一层不透明的封装里更清楚——插件正是这么分的。
//!
//! 传输层失败（连不上、DNS、TLS、超时）才返回 `Err`，且消息与插件一致，
//! 免得同一件事在两边显示成两种说法。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use ureq::http::{Request, Response};
use ureq::tls::{TlsConfig, TlsProvider};
use ureq::{Agent, Body};

/// 默认超时。首轮同步可能一次推很多篇，比普通请求给得宽一些。
const DEFAULT_TIMEOUT_MS: u64 = 120_000;

#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    /// 原样返回（**含大小写**，可能有重复键）。前端按小写比对取值——
    /// 与插件的 `headerValue` 同一条约定：响应头键的大小写没有契约保证。
    pub headers: Vec<HttpHeader>,
    /// 响应体的 base64。二进制（附件字节）与文本共用一条通道。
    pub body_base64: String,
}

fn build_agent(timeout_ms: Option<u64>) -> Agent {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    ureq::Agent::config_builder()
        // 4xx/5xx 不当异常：调用方要看的正是状态码本身
        .http_status_as_error(false)
        .timeout_global(Some(timeout))
        // ureq 的 TlsConfig 默认 provider 是 rustls，而我们只编译了 native-tls
        // （Windows 上走 SChannel，不引入 C 依赖）——不显式指认的话，第一个 https
        // 请求就会 panic（"provider is Rustls but feature is not enabled: rustls"）。
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::NativeTls)
                .build(),
        )
        .build()
        .new_agent()
}

/// 发一次请求，原样带回状态码、响应头与响应体。
///
/// `body_text` 与 `body_base64` 二选一（都为空表示无请求体）：JSON 走前者，
/// 附件字节走后者。分开是为了让调用方不必为了发一段 JSON 去手工 base64。
#[tauri::command]
pub async fn http_request(
    method: String,
    url: String,
    headers: Vec<HttpHeader>,
    body_text: Option<String>,
    body_base64: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<HttpResponse, String> {
    // 阻塞式 IO 放到独立线程：直接在 async 里跑会占住 tokio 的工作线程，界面跟着卡。
    tauri::async_runtime::spawn_blocking(move || {
        send_once(&method, &url, headers, body_text, body_base64, timeout_ms)
    })
    .await
    .map_err(|e| format!("请求线程失败: {e}"))?
}

fn send_once(
    method: &str,
    url: &str,
    headers: Vec<HttpHeader>,
    body_text: Option<String>,
    body_base64: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<HttpResponse, String> {
    if url.trim().is_empty() {
        return Err("请求地址为空".into());
    }
    let body: Vec<u8> = match (body_text, body_base64) {
        (Some(text), _) => text.into_bytes(),
        (None, Some(encoded)) => STANDARD
            .decode(encoded.as_bytes())
            .map_err(|e| format!("请求体解码失败: {e}"))?,
        (None, None) => Vec::new(),
    };

    let mut builder = Request::builder().method(method).uri(url);
    for header in headers {
        builder = builder.header(header.name, header.value);
    }
    let request = builder
        .body(body)
        .map_err(|e| format!("请求构造失败: {e}"))?;

    let response: Response<Body> = build_agent(timeout_ms)
        .run(request)
        .map_err(|e| format!("无法连接同步服务器（{e}）"))?;

    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| HttpHeader {
            name: name.as_str().to_string(),
            value: value.to_str().unwrap_or_default().to_string(),
        })
        .collect();

    let mut response = response;
    let bytes = response
        .body_mut()
        .read_to_vec()
        .map_err(|e| format!("读取响应失败: {e}"))?;

    Ok(HttpResponse {
        status,
        headers,
        body_base64: STANDARD.encode(&bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_url() {
        let result = send_once("GET", "  ", Vec::new(), None, None, Some(1000));
        assert!(result.is_err());
    }

    #[test]
    fn reports_connection_failure_as_transport_error() {
        // 127.0.0.1:1 上没有服务，应当归为"连不上"而不是别的说法
        let result = send_once(
            "GET",
            "http://127.0.0.1:1/api/v1/sync",
            Vec::new(),
            None,
            None,
            Some(1000),
        );
        let message = result.err().expect("应当报错");
        assert!(message.starts_with("无法连接同步服务器"), "{message}");
    }

    /// 手动验证：`cargo test --lib net::tests::https_request_reaches_github -- --ignored`
    /// 依赖外网，不进常规测试；它守住的是"native-tls provider 必须显式指认"这个坑。
    #[test]
    #[ignore = "需要外网"]
    fn https_request_reaches_github() {
        let result = send_once(
            "GET",
            "https://api.github.com/repos/456-77/quick-note/releases/latest",
            vec![HttpHeader { name: "User-Agent".into(), value: "quick-note".into() }],
            None,
            None,
            Some(15_000),
        );
        let response = result.expect("https 请求应当成功（TLS provider 配置正确）");
        assert_eq!(response.status, 200, "GitHub API 应返回 200");
    }
}
