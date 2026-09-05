//! GitHub Copilot executor.
//! Port of open-sse/executors/github.js.
//!
//! Routes chat completions through GitHub Copilot's API:
//! - /chat/completions for gpt/gemini/grok models (OpenAI-compatible)
//! - /responses for codex models (OpenAI Responses API)
//! - /v1/messages for Claude models (Anthropic-native shim)
//!
//! Auth: GitHub OAuth → Copilot token exchange. `conn.data.copilotToken` or
//! `conn.data.accessToken` is sent as Bearer. The connection may also have
//! `refreshToken` for token refresh.
//!
//! NOTE: The Node version uses translator adapters (openai→claude, openai→responses)
//! for Claude and codex models. Those adapters are not yet ported. This executor
//! forwards the body as-is to /chat/completions (OpenAI shape). When the translator
//! is wired, Claude models will route to /v1/messages and codex models to /responses.
//! For now, all models use /chat/completions.

use axum::http::{HeaderMap, HeaderValue, StatusCode};
use futures::StreamExt;
use uuid::Uuid;

use super::base::{ProviderExecutor, UpstreamResponse, build_client};
use crate::db::repos::connections::ProviderConnection;

pub struct GithubExecutor;

const CHAT_COMPLETIONS_URL: &str = "https://api.githubcopilot.com/chat/completions";
const RESPONSES_URL: &str = "https://api.githubcopilot.com/responses";
const MESSAGES_URL: &str = "https://api.githubcopilot.com/v1/messages";
const GITHUB_COPILOT_API_VERSION: &str = "2025-04-01";
const VSCODE_VERSION: &str = "1.110.0";
const COPILOT_CHAT_VERSION: &str = "0.38.0";
const USER_AGENT: &str = "GitHubCopilotChat/0.38.0";
const ANTHROPIC_API_VERSION: &str = "2023-06-01";

/// Is this a Claude model? (routed to /v1/messages in the Node version)
fn is_claude_model(model: &str) -> bool {
    model.to_lowercase().contains("claude")
}

/// Newer OpenAI models (gpt-5+, o1, o3, o4) require max_completion_tokens
fn requires_max_completion_tokens(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("gpt-5") || m.contains("o1-") || m.contains("o3-") || m.contains("o4-")
}

/// Sanitize messages for GitHub Copilot /chat/completions endpoint.
/// Only 'text' and 'image_url' content part types are accepted.
/// Tool-related content (tool_use, tool_result, thinking) must be serialized as text.
fn sanitize_messages_for_chat_completions(body: &serde_json::Value) -> serde_json::Value {
    let mut result = body.clone();
    if let Some(obj) = result.as_object_mut() {
        if let Some(messages) = obj.get_mut("messages").and_then(|v| v.as_array_mut()) {
            for msg in messages.iter_mut() {
                // Skip messages with no content
                if msg.get("content").is_none() {
                    continue;
                }
                // String content is fine
                if msg.get("content").and_then(|v| v.as_str()).is_some() {
                    continue;
                }
                // Array content: filter/convert unsupported part types
                if let Some(content) = msg.get_mut("content").and_then(|v| v.as_array_mut()) {
                    let mut clean = Vec::new();
                    for part in content.iter() {
                        let ptype = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if ptype == "text" || ptype == "image_url" {
                            clean.push(part.clone());
                        } else {
                            // Serialize tool_use, tool_result, thinking, etc. as text
                            let text = part
                                .get("text")
                                .or_else(|| part.get("content"))
                                .and_then(|v| v.as_str())
                                .unwrap_or(&part.to_string())
                                .to_string();
                            if !text.is_empty() {
                                clean.push(serde_json::json!({"type": "text", "text": text}));
                            }
                        }
                    }
                    if clean.is_empty() {
                        if let Some(mobj) = msg.as_object_mut() {
                            mobj.insert("content".to_string(), serde_json::Value::Null);
                        }
                    } else {
                        if let Some(mobj) = msg.as_object_mut() {
                            mobj.insert(
                                "content".to_string(),
                                serde_json::Value::Array(clean),
                            );
                        }
                    }
                }
            }
        }
    }
    result
}

/// Transform request body for GitHub Copilot.
fn transform_request(model: &str, body: &serde_json::Value) -> serde_json::Value {
    let mut transformed = body.clone();
    if let Some(obj) = transformed.as_object_mut() {
        // Handle max_tokens → max_completion_tokens for newer models
        if requires_max_completion_tokens(model) {
            if let Some(max_tokens) = obj.remove("max_tokens") {
                obj.insert("max_completion_tokens".to_string(), max_tokens);
            }
        }
        // Strip "none" reasoning_effort
        if obj.get("reasoning_effort").and_then(|v| v.as_str()) == Some("none") {
            obj.remove("reasoning_effort");
        }
    }
    transformed
}

/// Build the headers for GitHub Copilot requests.
fn build_headers(token: &str, stream: bool) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", token)) {
        headers.insert("Authorization", val);
    }
    headers.insert("Content-Type", HeaderValue::from_static("application/json"));
    headers.insert(
        "copilot-integration-id",
        HeaderValue::from_static("vscode-chat"),
    );
    if let Ok(val) = HeaderValue::from_str(&format!("vscode/{}", VSCODE_VERSION)) {
        headers.insert("editor-version", val);
    }
    if let Ok(val) = HeaderValue::from_str(&format!("copilot-chat/{}", COPILOT_CHAT_VERSION)) {
        headers.insert("editor-plugin-version", val);
    }
    headers.insert("User-Agent", HeaderValue::from_static(USER_AGENT));
    headers.insert(
        "openai-intent",
        HeaderValue::from_static("conversation-panel"),
    );
    headers.insert(
        "x-github-api-version",
        HeaderValue::from_static(GITHUB_COPILOT_API_VERSION),
    );
    if let Ok(val) = HeaderValue::from_str(&Uuid::new_v4().to_string()) {
        headers.insert("x-request-id", val);
    }
    headers.insert(
        "x-vscode-user-agent-library-version",
        HeaderValue::from_static("electron-fetch"),
    );
    headers.insert("X-Initiator", HeaderValue::from_static("user"));
    headers.insert(
        "anthropic-version",
        HeaderValue::from_static(ANTHROPIC_API_VERSION),
    );
    headers.insert(
        "Accept",
        if stream {
            HeaderValue::from_static("text/event-stream")
        } else {
            HeaderValue::from_static("application/json")
        },
    );
    headers
}

/// Resolve the auth token (prefer copilotToken, fallback to accessToken/apiKey)
fn get_copilot_token(data: &serde_json::Value) -> Option<String> {
    data.get("copilotToken")
        .or_else(|| data.get("accessToken"))
        .or_else(|| data.get("apiKey"))
        .or_else(|| data.get("api_key"))
        .or_else(|| data.get("token"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[async_trait::async_trait]
impl ProviderExecutor for GithubExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        self.execute(conn, body, true).await
    }

    async fn complete(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        self.execute(conn, body, false).await
    }
}

impl GithubExecutor {
    async fn execute(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        stream: bool,
    ) -> anyhow::Result<UpstreamResponse> {
        let token = get_copilot_token(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("GitHub Copilot connection missing copilotToken or accessToken"))?;

        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("gpt-4o")
            .to_string();

        // NOTE: In the Node version, Claude models route to /v1/messages (Anthropic-native)
        // and codex models to /responses (OpenAI Responses API). The translator adapters
        // for those routes are not yet ported. For now, all models use /chat/completions.
        // When the translator is wired, route Claude → MESSAGES_URL, codex → RESPONSES_URL.
        let url = CHAT_COMPLETIONS_URL.to_string();

        // Sanitize messages for /chat/completions
        let sanitized = sanitize_messages_for_chat_completions(&body);
        let transformed = transform_request(&model, &sanitized);

        let mut send_body = transformed;
        if let Some(obj) = send_body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(stream));
        }

        let headers = build_headers(&token, stream);

        let client = build_client();
        let mut req = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", token))
            .header("copilot-integration-id", "vscode-chat")
            .header("editor-version", format!("vscode/{}", VSCODE_VERSION))
            .header(
                "editor-plugin-version",
                format!("copilot-chat/{}", COPILOT_CHAT_VERSION),
            )
            .header("User-Agent", USER_AGENT)
            .header("openai-intent", "conversation-panel")
            .header("x-github-api-version", GITHUB_COPILOT_API_VERSION)
            .header("x-request-id", Uuid::new_v4().to_string())
            .header("x-vscode-user-agent-library-version", "electron-fetch")
            .header("X-Initiator", "user")
            .header("anthropic-version", ANTHROPIC_API_VERSION);

        if stream {
            req = req.header("Accept", "text/event-stream");
        } else {
            req = req.header("Accept", "application/json");
        }

        // Add static headers from connection data (headers field)
        if let Some(static_headers) = conn.data.get("headers").and_then(|v| v.as_object()) {
            for (k, v) in static_headers {
                if let Some(vs) = v.as_str() {
                    if let Ok(name) = axum::http::HeaderName::from_bytes(k.as_bytes()) {
                        if let Ok(val) = axum::http::HeaderValue::from_str(vs) {
                            req = req.header(name, val);
                        }
                    }
                }
            }
        }

        let resp = req.json(&send_body).send().await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(status.as_u16())?,
                message: text,
            });
        }

        if stream {
            let s = resp
                .bytes_stream()
                .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
            Ok(UpstreamResponse::Stream {
                headers,
                stream: Box::new(s),
            })
        } else {
            let bytes = resp.bytes().await?;
            Ok(UpstreamResponse::Json {
                status: StatusCode::OK,
                headers,
                body: bytes,
            })
        }
    }
}
