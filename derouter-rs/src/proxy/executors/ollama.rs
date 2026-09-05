//! Ollama executor — Phase 1.
//! Port of open-sse/providers/registry/ollama.js.
//! Auth: None (local) or Bearer for ollama.com
//! Endpoint: /api/chat
//! Format: Ollama-native (model, messages, stream, options)

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth, get_base_url};
use crate::db::repos::connections::ProviderConnection;

pub struct OllamaExecutor;

const DEFAULT_BASE_URL: &str = "https://ollama.com";

#[async_trait::async_trait]
impl ProviderExecutor for OllamaExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let base_url = get_base_url(&conn.data, DEFAULT_BASE_URL);
        let url = format!("{}/api/chat", base_url.trim_end_matches('/'));

        // Convert to Ollama format
        let ollama_body = convert_to_ollama_format(&body, true);

        let client = build_client();
        let mut req = client
            .post(&url)
            .header("Content-Type", "application/json");

        // Auth may be present for ollama.com, or absent for local
        if let Some(api_key) = get_connection_auth(&conn.data) {
            req = req.header("Authorization", format!("Bearer {}", api_key));
        }

        let resp = req.json(&ollama_body).send().await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(status.as_u16())?,
                message: text,
            });
        }

        let stream = resp.bytes_stream().map(|r| {
            r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        });

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
        let base_url = get_base_url(&conn.data, DEFAULT_BASE_URL);
        let url = format!("{}/api/chat", base_url.trim_end_matches('/'));

        let ollama_body = convert_to_ollama_format(&body, false);

        let client = build_client();
        let mut req = client
            .post(&url)
            .header("Content-Type", "application/json");

        if let Some(api_key) = get_connection_auth(&conn.data) {
            req = req.header("Authorization", format!("Bearer {}", api_key));
        }

        let resp = req.json(&ollama_body).send().await?;

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

/// Convert OpenAI chat completions format to Ollama format
fn convert_to_ollama_format(body: &serde_json::Value, stream: bool) -> serde_json::Value {
    let model = body.get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("llama3.2")
        .to_string();

    let messages = body.get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut result = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": stream,
    });

    // Map OpenAI params to Ollama options
    let mut options = serde_json::Map::new();
    for (oai_key, ollama_key) in &[
        ("temperature", "temperature"),
        ("top_p", "top_p"),
        ("max_tokens", "num_predict"),
    ] {
        if let Some(val) = body.get(*oai_key) {
            options.insert(ollama_key.to_string(), val.clone());
        }
    }
    if !options.is_empty() {
        result["options"] = serde_json::Value::Object(options);
    }

    result
}
