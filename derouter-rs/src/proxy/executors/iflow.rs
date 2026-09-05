//! iFlow executor.
//! Port of open-sse/executors/iflow.js.
//!
//! Talks to https://apis.iflow.cn/v1/chat/completions
//! Auth: Bearer token + HMAC-SHA256 signature.
//! For each request, iFlow requires:
//! - A random session UUID (session-id header)
//! - A timestamp (x-iflow-timestamp header, ms since epoch)
//! - An HMAC-SHA256 signature of "{userAgent}:{sessionID}:{timestamp}" keyed by the API key
//!   (x-iflow-signature header, hex-encoded)
//! - stream_options.include_usage injected for streaming requests

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth};
use crate::db::repos::connections::ProviderConnection;

pub struct IFlowExecutor;

const DEFAULT_BASE_URL: &str = "https://apis.iflow.cn/v1/chat/completions";
const USER_AGENT: &str = "iFlow-Cli";

type HmacSha256 = Hmac<Sha256>;

/// Create the iFlow HMAC-SHA256 signature.
/// Payload: "{userAgent}:{sessionID}:{timestamp}", key: apiKey, output: hex.
fn create_iflow_signature(user_agent: &str, session_id: &str, timestamp: i64, api_key: &str) -> String {
    if api_key.is_empty() {
        return String::new();
    }
    let payload = format!("{}:{}:{}", user_agent, session_id, timestamp);
    let mut mac = match HmacSha256::new_from_slice(api_key.as_bytes()) {
        Ok(m) => m,
        Err(_) => return String::new(),
    };
    mac.update(payload.as_bytes());
    let result = mac.finalize();
    let bytes = result.into_bytes();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Generate a UUID v4 string.
fn generate_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Get current timestamp in milliseconds.
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Inject stream_options.include_usage for streaming requests if not already present.
fn transform_request(body: &mut serde_json::Value, stream: bool) {
    if stream {
        if let Some(obj) = body.as_object_mut() {
            let has_messages = obj.get("messages").is_some();
            let has_stream_options = obj.get("stream_options").is_some();
            if has_messages && !has_stream_options {
                obj.insert(
                    "stream_options".to_string(),
                    serde_json::json!({"include_usage": true}),
                );
            }
        }
    }
}

#[async_trait::async_trait]
impl ProviderExecutor for IFlowExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        mut body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("iFlow connection missing API key"))?;

        let base_url = conn
            .data
            .get("baseUrl")
            .or_else(|| conn.data.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASE_URL);
        let url = base_url.to_string();

        transform_request(&mut body, true);
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(true));
        }

        let session_id = format!("session-{}", generate_uuid());
        let timestamp = now_ms();
        let signature = create_iflow_signature(USER_AGENT, &session_id, timestamp, &api_key);

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("User-Agent", USER_AGENT)
            .header("session-id", &session_id)
            .header("x-iflow-timestamp", timestamp.to_string())
            .header("x-iflow-signature", &signature)
            .header("Accept", "text/event-stream")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(status.as_u16())?,
                message: text,
            });
        }

        let stream = resp
            .bytes_stream()
            .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

        Ok(UpstreamResponse::Stream {
            headers: HeaderMap::new(),
            stream: Box::new(stream),
        })
    }

    async fn complete(
        &self,
        conn: &ProviderConnection,
        mut body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("iFlow connection missing API key"))?;

        let base_url = conn
            .data
            .get("baseUrl")
            .or_else(|| conn.data.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASE_URL);
        let url = base_url.to_string();

        transform_request(&mut body, false);
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(false));
        }

        let session_id = format!("session-{}", generate_uuid());
        let timestamp = now_ms();
        let signature = create_iflow_signature(USER_AGENT, &session_id, timestamp, &api_key);

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("User-Agent", USER_AGENT)
            .header("session-id", &session_id)
            .header("x-iflow-timestamp", timestamp.to_string())
            .header("x-iflow-signature", &signature)
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(status.as_u16())?,
                message: text,
            });
        }

        let bytes = resp.bytes().await?;
        Ok(UpstreamResponse::Json {
            status: StatusCode::OK,
            headers: HeaderMap::new(),
            body: bytes,
        })
    }
}
