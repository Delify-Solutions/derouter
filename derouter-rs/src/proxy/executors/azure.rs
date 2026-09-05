//! Azure OpenAI executor — Phase 1.
//! Port of open-sse/providers/registry/azure.js.
//! Auth: api-key header from connection.data.apiKey
//! Endpoint: {baseUrl}/openai/deployments/{model}/chat/completions?api-version=2024-10-21
//! User provides base URL and accountId in connection data.

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth, get_base_url};
use crate::db::repos::connections::ProviderConnection;

pub struct AzureExecutor;

const API_VERSION: &str = "2024-10-21";

#[async_trait::async_trait]
impl ProviderExecutor for AzureExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("Azure connection missing API key"))?;

        let base_url = get_base_url(&conn.data, "");
        if base_url.is_empty() {
            return Err(anyhow::anyhow!("Azure connection missing base URL"));
        }

        let model = body.get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("gpt-4o")
            .to_string();

        let url = format!(
            "{}/openai/deployments/{}/chat/completions?api-version={}",
            base_url.trim_end_matches('/'),
            model,
            API_VERSION
        );

        let mut body = body;
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(true));
        }

        let client = build_client();
        let resp = client
            .post(&url)
            .header("api-key", &api_key)
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
            .ok_or_else(|| anyhow::anyhow!("Azure connection missing API key"))?;

        let base_url = get_base_url(&conn.data, "");
        if base_url.is_empty() {
            return Err(anyhow::anyhow!("Azure connection missing base URL"));
        }

        let model = body.get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("gpt-4o")
            .to_string();

        let url = format!(
            "{}/openai/deployments/{}/chat/completions?api-version={}",
            base_url.trim_end_matches('/'),
            model,
            API_VERSION
        );

        let mut body = body;
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(false));
        }

        let client = build_client();
        let resp = client
            .post(&url)
            .header("api-key", &api_key)
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
