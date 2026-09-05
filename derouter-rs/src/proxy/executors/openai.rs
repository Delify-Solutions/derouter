//! OpenAI executor — Phase 1.
//! Port of open-sse/executors/default.js for OpenAI connections.
//! Auth: Bearer token from connection.data.apiKey
//! Endpoint: https://api.openai.com/v1/chat/completions

use std::collections::HashMap;

use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use futures::StreamExt;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth, get_base_url};
use crate::db::repos::connections::ProviderConnection;

pub struct OpenAiExecutor;

const DEFAULT_BASE_URL: &str = "https://api.openai.com";

#[async_trait::async_trait]
impl ProviderExecutor for OpenAiExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("OpenAI connection missing API key"))?;

        let base_url = get_base_url(&conn.data, DEFAULT_BASE_URL);
        let url = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));

        // Ensure stream is true in the body
        let mut body = body;
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(true));
        }

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
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
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("OpenAI connection missing API key"))?;

        let base_url = get_base_url(&conn.data, DEFAULT_BASE_URL);
        let url = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));

        // Ensure stream is false in the body
        let mut body = body;
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(false));
        }

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
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
