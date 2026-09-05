//! OpenAI-compatible executor — Phase 1.
//! Covers providers with a custom base URL + Bearer auth.
//! Uses /v1/chat/completions endpoint.
//! Examples: openai-compatible-chat-* providers, glm, etc.

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth, get_base_url};
use crate::db::repos::connections::ProviderConnection;

pub struct OpenAiCompatExecutor;

#[async_trait::async_trait]
impl ProviderExecutor for OpenAiCompatExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let base_url = get_base_url(&conn.data, "https://api.openai.com");

        // Some compatible providers may have the full path in the base URL
        let url = if base_url.contains("/v1/chat/completions") {
            base_url.clone()
        } else if base_url.ends_with("/v1") {
            format!("{}/chat/completions", base_url)
        } else {
            format!("{}/v1/chat/completions", base_url.trim_end_matches('/'))
        };

        let mut body = body;
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(true));
        }

        let client = build_client();
        let mut req = client
            .post(&url)
            .header("Content-Type", "application/json");

        // Auth: Bearer token if available, else may be no-auth
        if let Some(api_key) = get_connection_auth(&conn.data) {
            req = req.header("Authorization", format!("Bearer {}", api_key));
        }

        let resp = req.json(&body).send().await?;

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
        let base_url = get_base_url(&conn.data, "https://api.openai.com");

        let url = if base_url.contains("/v1/chat/completions") {
            base_url.clone()
        } else if base_url.ends_with("/v1") {
            format!("{}/chat/completions", base_url)
        } else {
            format!("{}/v1/chat/completions", base_url.trim_end_matches('/'))
        };

        let mut body = body;
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(false));
        }

        let client = build_client();
        let mut req = client
            .post(&url)
            .header("Content-Type", "application/json");

        if let Some(api_key) = get_connection_auth(&conn.data) {
            req = req.header("Authorization", format!("Bearer {}", api_key));
        }

        let resp = req.json(&body).send().await?;

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
