//! Xiaomi Token Plan executor.
//! Port of open-sse/executors/xiaomi-tokenplan.js.
//!
//! Token Plan keys are region-specific. The base URL is resolved from
//! providerSpecificData.region (sgp/cn/ams), defaulting to sgp.
//! When the transport format is "claude", routes to /anthropic/v1/messages;
//! otherwise uses the OpenAI-compatible /chat/completions path.
//!
//! Auth: Bearer token (openai transport) or x-api-key (claude transport).

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth};
use crate::db::repos::connections::ProviderConnection;

pub struct XiaomiTokenplanExecutor;

const DEFAULT_BASE_URL: &str = "https://token-plan-sgp.xiaomimimo.com/v1";

fn resolve_region_base_url(data: &serde_json::Value) -> String {
    let region = data
        .get("providerSpecificData")
        .and_then(|p| p.get("region"))
        .and_then(|r| r.as_str())
        .unwrap_or("sgp");

    match region {
        "cn" => "https://token-plan-cn.xiaomimimo.com/v1".to_string(),
        "ams" => "https://token-plan-ams.xiaomimimo.com/v1".to_string(),
        _ => "https://token-plan-sgp.xiaomimimo.com/v1".to_string(),
    }
}

fn is_claude_transport(data: &serde_json::Value) -> bool {
    data.get("runtimeTransport")
        .and_then(|rt| rt.get("format"))
        .and_then(|f| f.as_str())
        .map(|s| s == "claude")
        .unwrap_or(false)
}

#[async_trait::async_trait]
impl ProviderExecutor for XiaomiTokenplanExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("Xiaomi Token Plan connection missing API key"))?;

        let base_url = resolve_region_base_url(&conn.data);
        let claude = is_claude_transport(&conn.data);

        let url = if claude {
            format!(
                "{}/anthropic/v1/messages",
                base_url.trim_end_matches("/v1").trim_end_matches('/')
            )
        } else {
            format!("{}/chat/completions", base_url.trim_end_matches('/'))
        };

        let mut body = body;
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(true));
        }

        let client = build_client();
        let mut req = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream");

        if claude {
            req = req
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01");
        } else {
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
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("Xiaomi Token Plan connection missing API key"))?;

        let base_url = resolve_region_base_url(&conn.data);
        let claude = is_claude_transport(&conn.data);

        let url = if claude {
            format!(
                "{}/anthropic/v1/messages",
                base_url.trim_end_matches("/v1").trim_end_matches('/')
            )
        } else {
            format!("{}/chat/completions", base_url.trim_end_matches('/'))
        };

        let mut body = body;
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(false));
        }

        let client = build_client();
        let mut req = client.post(&url).header("Content-Type", "application/json");

        if claude {
            req = req
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01");
        } else {
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
