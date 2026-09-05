//! Grok CLI executor.
//! Port of open-sse/executors/grok-cli.js.
//!
//! Routes completions through Grok's CLI chat proxy
//! (https://cli-chat-proxy.grok.com/v1/responses).
//!
//! Auth: OAuth device-code access token (from connection.data.accessToken or apiKey).
//! Sent as Bearer token.
//!
//! Request format: OpenAI Responses API (input array, not messages).
//! The body is normalized to match the Responses API allowlist.
//!
//! Aliases: grok-cli, gcli, gb

use axum::http::{HeaderMap, HeaderValue, StatusCode};
use futures::StreamExt;
use uuid::Uuid;

use super::base::{ProviderExecutor, UpstreamResponse, build_client};
use crate::db::repos::connections::ProviderConnection;

pub struct GrokCliExecutor;

const GROK_CLI_BASE_URL: &str = "https://cli-chat-proxy.grok.com/v1/responses";
const GROK_CLI_CLIENT_IDENTIFIER: &str = "grok-shell";
const GROK_CLI_VERSION: &str = "0.2.99";

/// Response API allowlist — only these fields are sent upstream.
const RESPONSES_API_ALLOWLIST: &[&str] = &[
    "model",
    "input",
    "instructions",
    "tools",
    "tool_choice",
    "stream",
    "store",
    "reasoning",
    "include",
    "temperature",
    "top_p",
    "max_output_tokens",
    "parallel_tool_calls",
    "text",
    "metadata",
    "prompt_cache_key",
];

/// Normalize reasoning effort value
fn normalize_effort(value: &str) -> String {
    let effort = value.trim().to_lowercase();
    if effort == "max" {
        return "xhigh".to_string();
    }
    match effort.as_str() {
        "low" | "medium" | "high" | "xhigh" => effort,
        _ => "high".to_string(),
    }
}

/// Resolve effort level from model id suffix (e.g. "grok-4-high" → "high")
fn resolve_effort_from_model(model_id: &str) -> Option<String> {
    for level in &["low", "medium", "high", "xhigh"] {
        if model_id.ends_with(&format!("-{}", level)) {
            return Some(level.to_string());
        }
    }
    None
}

/// Get access token (prefer accessToken, then apiKey/token)
fn get_access_token(data: &serde_json::Value) -> Option<String> {
    data.get("accessToken")
        .or_else(|| data.get("access_token"))
        .or_else(|| data.get("apiKey"))
        .or_else(|| data.get("api_key"))
        .or_else(|| data.get("token"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Get providerSpecificData
fn get_psd(data: &serde_json::Value) -> Option<&serde_json::Value> {
    data.get("providerSpecificData")
        .or_else(|| data.get("provider_specific_data"))
}

/// Normalize the request body for Grok CLI Responses API.
/// Strips non-allowlisted fields, normalizes input, sets stream/store, resolves model.
fn transform_request(model: &str, body: &serde_json::Value) -> serde_json::Value {
    let mut body = body.clone();

    // Ensure input exists
    if body.get("input").is_none() {
        if let Some(messages) = body.get("messages").and_then(|v| v.as_array()) {
            if !messages.is_empty() {
                // Convert messages to input messages (string content)
                let input: Vec<serde_json::Value> = messages
                    .iter()
                    .map(|m| {
                        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("user");
                        let content = if let Some(s) = m.get("content").and_then(|v| v.as_str()) {
                            s.to_string()
                        } else {
                            serde_json::to_string(m.get("content").unwrap_or(&serde_json::Value::Null))
                                .unwrap_or_default()
                        };
                        serde_json::json!({
                            "type": "message",
                            "role": role,
                            "content": content,
                        })
                    })
                    .collect();
                if let Some(obj) = body.as_object_mut() {
                    obj.insert("input".to_string(), serde_json::Value::Array(input));
                    obj.remove("messages");
                }
            } else {
                if let Some(obj) = body.as_object_mut() {
                    obj.insert(
                        "input".to_string(),
                        serde_json::json!([{"type":"message","role":"user","content":"..."}]),
                    );
                }
            }
        } else {
            if let Some(obj) = body.as_object_mut() {
                obj.insert(
                    "input".to_string(),
                    serde_json::json!([{"type":"message","role":"user","content":"..."}]),
                );
            }
        }
    }

    // Resolve effort from model suffix
    let model_effort = resolve_effort_from_model(model);
    let resolved_model = if let Some(ref effort) = model_effort {
        model.trim_end_matches(&format!("-{}", effort)).to_string()
    } else {
        model.to_string()
    };

    // Set defaults
    if let Some(obj) = body.as_object_mut() {
        obj.insert("stream".to_string(), serde_json::json!(true));
        obj.insert("store".to_string(), serde_json::json!(false));
        obj.insert("model".to_string(), serde_json::Value::String(resolved_model.clone()));
    }

    // Reasoning effort
    let existing_reasoning = body.get("reasoning").cloned();
    let raw_effort = body
        .get("reasoning_effort")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or(model_effort.clone());

    let reasoning = if let Some(existing) = existing_reasoning {
        let mut r = existing;
        if let Some(obj) = r.as_object_mut() {
            // Set effort if not present
            if !obj.contains_key("effort") {
                if let Some(effort) = &raw_effort {
                    obj.insert("effort".to_string(), serde_json::Value::String(normalize_effort(effort)));
                }
            }
            if !obj.contains_key("summary") {
                obj.insert("summary".to_string(), serde_json::json!("concise"));
            }
        }
        r
    } else {
        let mut r = serde_json::Map::new();
        r.insert("summary".to_string(), serde_json::json!("concise"));
        if let Some(effort) = &raw_effort {
            r.insert("effort".to_string(), serde_json::Value::String(normalize_effort(effort)));
        }
        serde_json::Value::Object(r)
    };

    if let Some(obj) = body.as_object_mut() {
        obj.insert("reasoning".to_string(), reasoning);
        obj.remove("reasoning_effort");
    }

    // Add encrypted_content include
    if let Some(obj) = body.as_object_mut() {
        let include = obj
            .get("include")
            .and_then(|v| v.as_array())
            .map(|a| a.clone())
            .unwrap_or_default();
        let mut include = include;
        if !include.iter().any(|v| v.as_str() == Some("reasoning.encrypted_content")) {
            include.push(serde_json::Value::String(
                "reasoning.encrypted_content".to_string(),
            ));
        }
        obj.insert("include".to_string(), serde_json::Value::Array(include));
    }

    // Strip Chat Completions leftovers
    if let Some(obj) = body.as_object_mut() {
        for key in &[
            "messages",
            "max_tokens",
            "max_completion_tokens",
            "n",
            "seed",
            "logprobs",
            "top_logprobs",
            "frequency_penalty",
            "presence_penalty",
            "logit_bias",
            "user",
            "stream_options",
            "prompt_cache_retention",
            "safety_identifier",
            "previous_response_id",
        ] {
            obj.remove(*key);
        }

        // Strip non-allowlisted fields
        let allowlist: std::collections::HashSet<&str> =
            RESPONSES_API_ALLOWLIST.iter().copied().collect();
        let to_remove: Vec<String> = obj
            .keys()
            .filter(|k| !allowlist.contains(k.as_str()))
            .cloned()
            .collect();
        for key in to_remove {
            obj.remove(&key);
        }
    }

    body
}

/// Build the headers for Grok CLI requests.
fn build_headers(token: &str, model: &str, data: &serde_json::Value) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", token)) {
        headers.insert("Authorization", val);
    }
    headers.insert("Content-Type", HeaderValue::from_static("application/json"));
    headers.insert(
        "Accept",
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(
        "User-Agent",
        HeaderValue::from_static("grok-shell/0.2.99 (linux; x86_64)"),
    );
    headers.insert(
        "x-grok-client-identifier",
        HeaderValue::from_static(GROK_CLI_CLIENT_IDENTIFIER),
    );
    headers.insert(
        "x-grok-client-version",
        HeaderValue::from_static(GROK_CLI_VERSION),
    );

    let session_id = Uuid::new_v4().to_string();
    let req_id = Uuid::new_v4().to_string();
    if let Ok(val) = HeaderValue::from_str(&session_id) {
        headers.insert("x-grok-session-id", val.clone());
        headers.insert("x-grok-conv-id", val);
    }
    if let Ok(val) = HeaderValue::from_str(&req_id) {
        headers.insert("x-grok-req-id", val);
    }
    headers.insert("x-grok-turn-idx", HeaderValue::from_static("1"));
    if let Ok(val) = HeaderValue::from_str(model) {
        headers.insert("x-grok-model-override", val);
    }

    // Identity headers from providerSpecificData
    if let Some(psd) = get_psd(data) {
        if let Some(email) = psd.get("email").or_else(|| data.get("email")).and_then(|v| v.as_str()) {
            if let Ok(val) = HeaderValue::from_str(email) {
                headers.insert("x-email", val);
            }
        }
        if let Some(user_id) = psd
            .get("userId")
            .or_else(|| psd.get("user_id"))
            .or_else(|| data.get("userId"))
            .or_else(|| data.get("user_id"))
            .and_then(|v| v.as_str())
        {
            if let Ok(val) = HeaderValue::from_str(user_id) {
                headers.insert("x-userid", val);
            }
        }
        if let Some(agent_id) = psd
            .get("deviceId")
            .or_else(|| psd.get("agentId"))
            .and_then(|v| v.as_str())
        {
            if let Ok(val) = HeaderValue::from_str(agent_id) {
                headers.insert("x-grok-agent-id", val);
            }
        }
    }

    headers
}

#[async_trait::async_trait]
impl ProviderExecutor for GrokCliExecutor {
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
        // Grok CLI is stream-only; route complete through stream
        self.execute(conn, body, true).await
    }
}

impl GrokCliExecutor {
    async fn execute(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        _stream: bool,
    ) -> anyhow::Result<UpstreamResponse> {
        let token = get_access_token(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("Grok CLI connection missing access token"))?;

        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("grok-build")
            .to_string();

        let transformed = transform_request(&model, &body);
        let resolved_model = transformed
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or(&model)
            .to_string();

        let headers = build_headers(&token, &resolved_model, &conn.data);

        let client = build_client();
        let mut req = client
            .post(GROK_CLI_BASE_URL)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .header("Authorization", format!("Bearer {}", token))
            .header("User-Agent", "grok-shell/0.2.99 (linux; x86_64)")
            .header("x-grok-client-identifier", GROK_CLI_CLIENT_IDENTIFIER)
            .header("x-grok-client-version", GROK_CLI_VERSION);

        // Session/conv/request IDs
        let session_id = Uuid::new_v4().to_string();
        let req_id = Uuid::new_v4().to_string();
        req = req
            .header("x-grok-session-id", &session_id)
            .header("x-grok-conv-id", &session_id)
            .header("x-grok-req-id", &req_id)
            .header("x-grok-turn-idx", "1")
            .header("x-grok-model-override", &resolved_model);

        // Identity headers
        if let Some(psd) = get_psd(&conn.data) {
            if let Some(email) = psd
                .get("email")
                .or_else(|| conn.data.get("email"))
                .and_then(|v| v.as_str())
            {
                req = req.header("x-email", email);
            }
            if let Some(user_id) = psd
                .get("userId")
                .or_else(|| psd.get("user_id"))
                .or_else(|| conn.data.get("userId"))
                .or_else(|| conn.data.get("user_id"))
                .and_then(|v| v.as_str())
            {
                req = req.header("x-userid", user_id);
            }
            if let Some(agent_id) = psd
                .get("deviceId")
                .or_else(|| psd.get("agentId"))
                .and_then(|v| v.as_str())
            {
                req = req.header("x-grok-agent-id", agent_id);
            }
        }

        let resp = req.json(&transformed).send().await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            // Parse error for better messages
            if status.as_u16() == 402 {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                    let msg = json
                        .get("error")
                        .or_else(|| json.get("message"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(&text);
                    return Ok(UpstreamResponse::Error {
                        status: StatusCode::from_u16(402)?,
                        message: msg.to_string(),
                    });
                }
            }
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(status.as_u16())?,
                message: text,
            });
        }

        let stream = resp
            .bytes_stream()
            .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

        Ok(UpstreamResponse::Stream {
            headers,
            stream: Box::new(stream),
        })
    }
}
