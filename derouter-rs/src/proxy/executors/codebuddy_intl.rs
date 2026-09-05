//! CodeBuddy International executor.
//! Port of open-sse/executors/codebuddy-intl.js.
//!
//! Talks to https://www.codebuddy.ai/v2/chat/completions
//! OpenAI-compatible but stream-only — non-stream requests are rejected by the gateway.
//! The executor forces stream=true and applies a body transform:
//! - Removes reasoning_effort if "none"/"off", else sets reasoning_summary="auto"
//! - Injects a leading system message "You are CodeBuddy Code."
//! - Converts user string content to typed text blocks [{type:"text",text}]
//! - Strips system/developer messages from the original list (system is replaced)

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth};
use crate::db::repos::connections::ProviderConnection;

pub struct CodebuddyIntlExecutor;

const DEFAULT_BASE_URL: &str = "https://www.codebuddy.ai/v2/chat/completions";

/// Transform the request body for CodeBuddy Intl.
/// Force stream, add reasoning_summary, prepend a system prompt,
/// and convert user string content to typed blocks.
fn transform_request(body: &mut serde_json::Value) {
    if let Some(obj) = body.as_object_mut() {
        // Force stream
        obj.insert("stream".to_string(), serde_json::json!(true));

        // Reasoning handling
        let eff = obj
            .get("reasoning_effort")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if let Some(eff) = eff {
            if eff == "none" || eff == "off" {
                obj.remove("reasoning_effort");
            } else {
                obj.insert("reasoning_summary".to_string(), serde_json::json!("auto"));
            }
        }

        // Extract messages, filter system/developer, prepend system prompt
        let original_messages = obj.get("messages").and_then(|v| v.as_array()).cloned();
        let mut new_messages = vec![serde_json::json!({
            "role": "system",
            "content": "You are CodeBuddy Code."
        })];

        if let Some(messages) = original_messages {
            for message in messages {
                let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("");
                if role == "system" || role == "developer" {
                    continue;
                }
                if role == "user" {
                    if let Some(content) = message.get("content").and_then(|v| v.as_str()) {
                        let mut msg = message.clone();
                        msg["content"] =
                            serde_json::json!([{"type": "text", "text": content}]);
                        new_messages.push(msg);
                    } else {
                        new_messages.push(message);
                    }
                } else {
                    new_messages.push(message);
                }
            }
        }

        obj.insert(
            "messages".to_string(),
            serde_json::Value::Array(new_messages),
        );
    }
}

fn add_provider_headers(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    req.header("User-Agent", "IDE/2.108.1 CodeBuddy/2.108.1")
        .header("X-Product", "SaaS")
        .header("X-IDE-Type", "IDE")
        .header("X-IDE-Name", "IDE")
        .header("x-requested-with", "XMLHttpRequest")
        .header("x-codebuddy-request", "1")
}

#[async_trait::async_trait]
impl ProviderExecutor for CodebuddyIntlExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        mut body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("CodeBuddy Intl connection missing API key"))?;

        let base_url = conn
            .data
            .get("baseUrl")
            .or_else(|| conn.data.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASE_URL);
        let url = base_url.to_string();

        transform_request(&mut body);

        let client = build_client();
        let resp = add_provider_headers(
            client
                .post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream"),
        )
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
        // CodeBuddy Intl is stream-only; force stream and return a stream response.
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("CodeBuddy Intl connection missing API key"))?;

        let base_url = conn
            .data
            .get("baseUrl")
            .or_else(|| conn.data.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASE_URL);
        let url = base_url.to_string();

        transform_request(&mut body);

        let client = build_client();
        let resp = add_provider_headers(
            client
                .post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream"),
        )
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
}
