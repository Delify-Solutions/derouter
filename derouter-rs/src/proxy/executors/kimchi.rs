//! Kimchi executor.
//! Port of open-sse/executors/kimchi.js.
//!
//! Talks to https://llm.kimchi.dev/openai/v1/chat/completions
//! OpenAI-compatible gateway. Auth: Bearer token.
//! Body transform:
//! - Merges top-level `system` field into messages as a system message (first position)
//! - Strips Anthropic-specific top-level fields: anthropic_version, anthropic_beta,
//!   client_metadata, mcp_servers, stop_sequences, thinking, top_k, system
//! - For Anthropic-backed models (claude in id), strips reasoning_effort/reasoning/thinking
//! - Strips cache_control/signature from message parts and tool definitions
//! - Strips long reasoning_content from assistant messages (placeholder up to 8 chars kept)

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth};
use crate::db::repos::connections::ProviderConnection;

pub struct KimchiExecutor;

const DEFAULT_BASE_URL: &str = "https://llm.kimchi.dev/openai/v1/chat/completions";
const REASONING_PLACEHOLDER_MAX_LEN: usize = 8;

/// Top-level fields to strip (Anthropic gateway drops these before forwarding to OpenAI).
const TOP_LEVEL_DROPS: &[&str] = &[
    "anthropic_version",
    "anthropic_beta",
    "client_metadata",
    "mcp_servers",
    "stop_sequences",
    "thinking",
    "top_k",
];

/// Check if model is Anthropic-backed (has "claude" or "anthropic" in the id).
fn is_anthropic_backed_model(model: &str) -> bool {
    let lower = model.to_lowercase();
    if lower.contains("claude") || lower.contains("anthropic") {
        return true;
    }
    false
}

/// Convert a system value (string or array) to text.
fn system_to_text(system: &serde_json::Value) -> String {
    if let Some(s) = system.as_str() {
        return s.to_string();
    }
    if let Some(arr) = system.as_array() {
        return arr
            .iter()
            .filter_map(|part| {
                if let Some(s) = part.as_str() {
                    Some(s.to_string())
                } else if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                    Some(t.to_string())
                } else {
                    None
                }
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
    }
    String::new()
}

/// Merge top-level `system` into messages as the first system message.
fn merge_top_level_system(body: &mut serde_json::Value) {
    let system = body.get("system").cloned();
    let messages_is_array = body.get("messages").map(|v| v.is_array()).unwrap_or(false);

    if system.is_none() || !messages_is_array {
        return;
    }

    let text = system_to_text(&system.unwrap()).trim().to_string();
    if text.is_empty() {
        return;
    }

    if let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) {
        // Find existing system message
        let existing_idx = messages.iter().position(|m| {
            m.get("role").and_then(|v| v.as_str()) == Some("system")
        });

        if let Some(idx) = existing_idx {
            let existing = &mut messages[idx];
            if let Some(content) = existing.get("content").and_then(|v| v.as_str()) {
                let merged = format!("{}\n\n{}", text, content);
                existing["content"] = serde_json::Value::String(merged);
            } else if let Some(arr) = existing.get_mut("content").and_then(|v| v.as_array_mut()) {
                arr.insert(0, serde_json::json!({"type": "text", "text": text}));
            }
        } else {
            messages.insert(0, serde_json::json!({"role": "system", "content": text}));
        }
    }
}

/// Strip cache_control and signature from message content parts.
fn strip_message_artifacts(body: &mut serde_json::Value) {
    if let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) {
        for msg in messages.iter_mut() {
            if let Some(obj) = msg.as_object_mut() {
                obj.remove("cache_control");
            }
            if let Some(content) = msg.get_mut("content").and_then(|v| v.as_array_mut()) {
                for part in content.iter_mut() {
                    if let Some(obj) = part.as_object_mut() {
                        obj.remove("cache_control");
                        obj.remove("signature");
                    }
                }
            }
        }
    }
}

/// Strip cache_control from tool definitions.
fn strip_tool_artifacts(body: &mut serde_json::Value) {
    if let Some(tools) = body.get_mut("tools").and_then(|v| v.as_array_mut()) {
        for tool in tools.iter_mut() {
            if let Some(obj) = tool.as_object_mut() {
                obj.remove("cache_control");
            }
        }
    }
}

/// Strip reasoning_content from assistant messages (only if longer than placeholder threshold).
fn strip_reasoning_content(body: &mut serde_json::Value) {
    if let Some(messages) = body.get_mut("messages").and_then(|v| v.as_array_mut()) {
        for msg in messages.iter_mut() {
            let is_assistant = msg.get("role").and_then(|v| v.as_str()) == Some("assistant");
            if !is_assistant {
                continue;
            }
            let rc_len = msg
                .get("reasoning_content")
                .and_then(|v| v.as_str())
                .map(|s| s.len())
                .unwrap_or(0);
            if rc_len > REASONING_PLACEHOLDER_MAX_LEN {
                if let Some(obj) = msg.as_object_mut() {
                    obj.remove("reasoning_content");
                }
            }
        }
    }
}

/// Full request transform for Kimchi.
fn transform_request(body: &mut serde_json::Value, model: &str) {
    merge_top_level_system(body);

    if let Some(obj) = body.as_object_mut() {
        for key in TOP_LEVEL_DROPS {
            obj.remove(*key);
        }
        obj.remove("system");
    }

    if is_anthropic_backed_model(model) {
        if let Some(obj) = body.as_object_mut() {
            obj.remove("reasoning_effort");
            obj.remove("reasoning");
            obj.remove("thinking");
        }
    }

    strip_message_artifacts(body);
    strip_tool_artifacts(body);
    strip_reasoning_content(body);
}

#[async_trait::async_trait]
impl ProviderExecutor for KimchiExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        mut body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("Kimchi connection missing API key"))?;

        let base_url = conn
            .data
            .get("baseUrl")
            .or_else(|| conn.data.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASE_URL);
        let url = base_url.to_string();

        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        transform_request(&mut body, &model);
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(true));
        }

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("User-Agent", "kimchi/0.1.50")
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
            .ok_or_else(|| anyhow::anyhow!("Kimchi connection missing API key"))?;

        let base_url = conn
            .data
            .get("baseUrl")
            .or_else(|| conn.data.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASE_URL);
        let url = base_url.to_string();

        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        transform_request(&mut body, &model);
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(false));
        }

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key))
            .header("User-Agent", "kimchi/0.1.50")
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
