//! Gemini CLI executor.
//! Port of open-sse/executors/gemini-cli.js.
//!
//! Talks to Google Cloud Code Assist: https://cloudcode-pa.googleapis.com/v1internal
//! Auth: Bearer access token (OAuth, from connection.data.accessToken or apiKey)
//! Stream endpoint: {base}:streamGenerateContent?alt=sse
//! Non-stream endpoint: {base}:generateContent
//!
//! The request body is wrapped as { project, model, request: <body> }.
//! The User-Agent and X-Goog-Api-Client headers are set to mimic the Gemini CLI.

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;

use super::base::{ProviderExecutor, UpstreamResponse, build_client};
use crate::db::repos::connections::ProviderConnection;

pub struct GeminiCliExecutor;

const DEFAULT_BASE_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal";
const GEMINI_CLI_VERSION: &str = "0.34.0";
const GEMINI_CLI_API_CLIENT: &str = "google-genai-sdk/1.41.0 gl-node/v22.19.0";

fn gemini_cli_user_agent(model: &str) -> String {
    let platform = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    format!(
        "GeminiCLI/{}/{} ({}; {}; terminal)",
        GEMINI_CLI_VERSION,
        model,
        platform,
        arch
    )
}

/// Get the access token (prefer accessToken, then apiKey/token).
fn get_access_token(data: &serde_json::Value) -> Option<String> {
    data.get("accessToken")
        .or_else(|| data.get("access_token"))
        .or_else(|| data.get("apiKey"))
        .or_else(|| data.get("api_key"))
        .or_else(|| data.get("token"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Get project ID from credentials.
fn get_project_id(data: &serde_json::Value) -> Option<String> {
    data.get("projectId")
        .or_else(|| data.get("project_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Wrap body in the Cloud Code Assist envelope: { project, model, request: <body> }.
fn wrap_body(body: &serde_json::Value, model: &str, data: &serde_json::Value) -> serde_json::Value {
    // If the body is already wrapped (has "request" and "model"), return as-is.
    if body.get("request").is_some() && body.get("model").is_some() {
        return body.clone();
    }
    serde_json::json!({
        "project": get_project_id(data).or_else(|| body.get("project").and_then(|v| v.as_str()).map(|s| s.to_string())),
        "model": model,
        "request": body,
    })
}

#[async_trait::async_trait]
impl ProviderExecutor for GeminiCliExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let access_token = get_access_token(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("Gemini CLI connection missing access token"))?;

        let base_url = conn
            .data
            .get("baseUrl")
            .or_else(|| conn.data.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASE_URL);
        let url = format!("{}:streamGenerateContent?alt=sse", base_url);

        // Extract model from body for User-Agent
        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let wrapped = wrap_body(&body, &model, &conn.data);

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", access_token))
            .header("User-Agent", gemini_cli_user_agent(&model))
            .header("X-Goog-Api-Client", GEMINI_CLI_API_CLIENT)
            .header("Accept", "text/event-stream")
            .json(&wrapped)
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
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let access_token = get_access_token(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("Gemini CLI connection missing access token"))?;

        let base_url = conn
            .data
            .get("baseUrl")
            .or_else(|| conn.data.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASE_URL);
        let url = format!("{}:generateContent", base_url);

        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let wrapped = wrap_body(&body, &model, &conn.data);

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", access_token))
            .header("User-Agent", gemini_cli_user_agent(&model))
            .header("X-Goog-Api-Client", GEMINI_CLI_API_CLIENT)
            .header("Accept", "application/json")
            .json(&wrapped)
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
