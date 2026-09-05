//! CodeBuddy CN executor.
//! Port of open-sse/executors/codebuddy-cn.js.
//!
//! Talks to https://copilot.tencent.com/v2/chat/completions
//! OpenAI-compatible but stream-only — non-stream requests are rejected by the gateway (code 11101).
//! The executor forces stream=true and applies a body transform:
//! - Replaces agent/CLI system prompts (Claude Code, Cursor, etc. — those ≥2000 chars or matching
//!   an identity-marker regex) with a neutral prompt to avoid Tencent content-filter rejections.
//! - Removes reasoning_effort if "none"/"off", else sets reasoning_summary="auto"

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;

use super::base::{ProviderExecutor, UpstreamResponse, build_client, get_connection_auth};
use crate::db::repos::connections::ProviderConnection;

pub struct CodebuddyCnExecutor;

const DEFAULT_BASE_URL: &str = "https://copilot.tencent.com/v2/chat/completions";
const NEUTRAL_PROMPT: &str = "You are a helpful AI assistant that helps with software engineering tasks.";

/// Check if a system message is an agent/CLI identity prompt that should be neutralized.
/// Matches the Node AGENT_PATTERN regex + length > 2000 catch-all.
fn is_agent_prompt(text: &str) -> bool {
    if text.len() > 2000 {
        return true;
    }
    let lower = text.to_lowercase();
    // Check for common agent identity markers (simplified from the Node regex)
    let patterns = [
        "you are claude code",
        "claude code",
        "anthropic's official cli",
        "anthropic official cli",
        "you are cursor",
        "you are windsurf",
        "you are cline",
        "you are aider",
        "you are continue",
        "you are copilot",
        "you are cody",
        "you are an agent",
        "you are an ai agent",
        "you are a coding agent",
        "you are a code agent",
        "you are an ai coding agent",
        "cc_entrypoint",
        "you are a powerful ai agent",
        "you are an ai",
        "orchestration capabilities",
        "ohmyopencode",
        "<agent-identity>",
        "<role>",
        "<behavior_instructions>",
        "give feedback",
        "claude code issues",
    ];
    for p in &patterns {
        if lower.contains(p) {
            return true;
        }
    }
    false
}

/// Flatten message content (string or array of text blocks) to a single string.
fn flatten_content(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        return arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
    }
    String::new()
}

/// Transform the request body for CodeBuddy CN.
/// Force stream, neutralize agent system prompts, handle reasoning params.
fn transform_request(body: &mut serde_json::Value) {
    if let Some(obj) = body.as_object_mut() {
        // Force stream
        obj.insert("stream".to_string(), serde_json::json!(true));

        // Neutralize agent system prompts
        if let Some(messages) = obj.get_mut("messages").and_then(|v| v.as_array_mut()) {
            for message in messages.iter_mut() {
                let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("");
                if role != "system" {
                    continue;
                }
                let content = message.get("content").cloned().unwrap_or(serde_json::Value::Null);
                let text = flatten_content(&content);
                if text.is_empty() {
                    continue;
                }
                if is_agent_prompt(&text) {
                    // Replace with neutral prompt, preserving original shape
                    if content.is_string() {
                        message["content"] = serde_json::Value::String(NEUTRAL_PROMPT.to_string());
                    } else {
                        message["content"] = serde_json::json!([{"type": "text", "text": NEUTRAL_PROMPT}]);
                    }
                }
            }
        }

        // Reasoning handling
        let eff = obj.get("reasoning_effort").and_then(|v| v.as_str()).map(|s| s.to_string());
        if let Some(eff) = eff {
            if eff == "none" || eff == "off" {
                obj.remove("reasoning_effort");
            } else {
                obj.insert("reasoning_summary".to_string(), serde_json::json!("auto"));
            }
        }
    }
}

fn add_provider_headers(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    req.header("User-Agent", "CLI/2.108.1 CodeBuddy/2.108.1")
        .header("X-Product", "SaaS")
        .header("X-IDE-Type", "CLI")
        .header("X-IDE-Name", "CLI")
        .header("x-requested-with", "XMLHttpRequest")
        .header("x-codebuddy-request", "1")
}

#[async_trait::async_trait]
impl ProviderExecutor for CodebuddyCnExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        mut body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("CodeBuddy CN connection missing API key"))?;

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
        // CodeBuddy CN is stream-only; force stream and return a stream response.
        let api_key = get_connection_auth(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("CodeBuddy CN connection missing API key"))?;

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
