//! CommandCode executor.
//! Port of open-sse/executors/commandcode.js.
//!
//! Talks to https://api.commandcode.ai/alpha/generate
//! Auth: Bearer <user_xxx> API key (stored as connection.data.apiKey or accessToken).
//! Adds the per-request `x-session-id` header expected by CommandCode upstream.
//!
//! Upstream returns AI SDK v5 NDJSON (one JSON event per line, no `data:` prefix).
//! The NDJSON-to-OpenAI SSE translation happens downstream in the proxy pipeline
//! via the translator adapter (select_response_adapter for FORMAT_COMMANDCODE),
//! so the executor just passes the raw byte stream through — same pattern as
//! iflow/grok_cli/etc.

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth};
use crate::db::repos::connections::ProviderConnection;

pub struct CommandCodeExecutor;

const DEFAULT_BASE_URL: &str = "https://api.commandcode.ai/alpha/generate";

/// Parse a CommandCode error response body.
/// Mirrors Node `parseError`: try JSON.parse, extract `error.message`/`message`/
/// `error.code`/`statusCode`, fall back to body text or status text.
fn parse_commandcode_error(body_text: &str, status: u16) -> (u16, String) {
    let parsed: Option<serde_json::Value> = serde_json::from_str(body_text).ok();

    if let Some(parsed) = parsed {
        let err_obj = parsed
            .get("error")
            .map(|v| v)
            .unwrap_or(&parsed);

        let msg = err_obj
            .get("message")
            .and_then(|v| v.as_str())
            .or_else(|| parsed.get("message").and_then(|v| v.as_str()))
            .or_else(|| err_obj.get("error").and_then(|v| v.as_str()))
            .unwrap_or(body_text);

        let code = err_obj
            .get("code")
            .and_then(|v| v.as_u64())
            .or_else(|| err_obj.get("statusCode").and_then(|v| v.as_u64()))
            .or_else(|| parsed.get("statusCode").and_then(|v| v.as_u64()))
            .map(|c| c as u16)
            .unwrap_or(status);

        let message = if msg.is_empty() {
            format!("CommandCode upstream error: {}", status)
        } else {
            msg.to_string()
        };

        return (code, message);
    }

    // Fall back to body text or generic message
    let message = if body_text.is_empty() {
        format!("CommandCode upstream error: {}", status)
    } else {
        body_text.to_string()
    };
    (status, message)
}

#[async_trait::async_trait]
impl ProviderExecutor for CommandCodeExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        mut body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let api_key = get_connection_auth(&conn.data)
            .or_else(|| {
                conn.data
                    .get("accessToken")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .ok_or_else(|| anyhow::anyhow!("CommandCode connection missing API key"))?;

        let base_url = conn
            .data
            .get("baseUrl")
            .or_else(|| conn.data.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASE_URL);
        let url = base_url.to_string();

        // CommandCode always forces stream=true (registry force_stream + Node transformRequest)
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(true));
        }

        let session_id = uuid::Uuid::new_v4().to_string();

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("x-session-id", &session_id)
            .header("Accept", "text/event-stream")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let (code, message) = parse_commandcode_error(&text, status.as_u16());
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(code)?,
                message,
            });
        }

        // Pass raw byte stream through — the translator adapter handles NDJSON→OpenAI SSE
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
            .or_else(|| {
                conn.data
                    .get("accessToken")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .ok_or_else(|| anyhow::anyhow!("CommandCode connection missing API key"))?;

        let base_url = conn
            .data
            .get("baseUrl")
            .or_else(|| conn.data.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASE_URL);
        let url = base_url.to_string();

        // CommandCode always forces stream=true (registry force_stream + Node transformRequest)
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(true));
        }

        let session_id = uuid::Uuid::new_v4().to_string();

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("x-session-id", &session_id)
            .header("Accept", "text/event-stream")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let (code, message) = parse_commandcode_error(&text, status.as_u16());
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(code)?,
                message,
            });
        }

        // Read full body — the translator adapter handles NDJSON→OpenAI JSON conversion
        let bytes = resp.bytes().await?;
        Ok(UpstreamResponse::Json {
            status: StatusCode::OK,
            headers: HeaderMap::new(),
            body: bytes,
        })
    }
}
