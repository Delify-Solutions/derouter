//! OpenCode executor.
//! Port of open-sse/executors/opencode.js.
//!
//! Talks to https://opencode.ai.
//! OpenCode is a no-auth provider (Authorization: Bearer public).
//! Models muse-spark-1.2/1.3-contributor-free use the /zen/v1/responses endpoint;
//! every other model uses /zen/v1/chat/completions.
//! Headers include x-opencode-client, x-opencode-session, x-opencode-request, x-opencode-project.
//! The session/request IDs are UUID-prefixed (ses_/msg_) and can be overridden by
//! downstream headers (x-opencode-session, x-opencode-request, etc.).

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;

use super::base::{ProviderExecutor, UpstreamResponse, build_client};
use crate::db::repos::connections::ProviderConnection;

pub struct OpenCodeExecutor;

const DEFAULT_BASE_URL: &str = "https://opencode.ai";
const OPENCODE_UA: &str = "opencode";

/// Models that use the /zen/v1/responses endpoint instead of /zen/v1/chat/completions.
fn is_responses_model(model: &str) -> bool {
    // Strip thinking suffix like "model(level)"
    let base = strip_thinking_suffix(model);
    base == "muse-spark-1.2-contributor-free" || base == "muse-spark-1.3-contributor-free"
}

/// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
fn strip_thinking_suffix(model: &str) -> String {
    // Remove trailing "(...)" if present
    let m = model.trim();
    if let Some(idx) = m.rfind('(') {
        if m.ends_with(')') {
            return m[..idx].trim().to_string();
        }
    }
    m.to_string()
}

fn generate_request_id() -> String {
    format!(
        "msg_{}",
        uuid::Uuid::new_v4().to_string().replace('-', "")
    )
}

fn generate_session_id() -> String {
    format!(
        "ses_{}",
        uuid::Uuid::new_v4().to_string().replace('-', "")
    )
}

/// Get a header value (case-insensitive) from the connection data's rawHeaders.
fn get_raw_header(data: &serde_json::Value, name: &str) -> Option<String> {
    let raw = data.get("rawHeaders").or_else(|| data.get("raw_headers"))?;
    let lower = name.to_lowercase();
    if let Some(obj) = raw.as_object() {
        for (k, v) in obj {
            if k.to_lowercase() == lower {
                return v.as_str().map(|s| s.to_string());
            }
        }
    }
    None
}

/// Build the URL for the request based on whether the model uses the responses endpoint.
fn build_url(base_url: &str, model: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if is_responses_model(model) {
        format!("{}/zen/v1/responses", base)
    } else {
        format!("{}/zen/v1/chat/completions", base)
    }
}

/// For responses-endpoint models, normalize the Chat fields to the Responses API shape.
fn normalize_for_responses(body: &mut serde_json::Value) {
    if let Some(obj) = body.as_object_mut() {
        // max_output_tokens = max_completion_tokens or max_tokens
        if obj.get("max_output_tokens").is_none() {
            if let Some(mc) = obj.get("max_completion_tokens").cloned() {
                obj.insert("max_output_tokens".to_string(), mc);
            } else if let Some(mt) = obj.get("max_tokens").cloned() {
                obj.insert("max_output_tokens".to_string(), mt);
            }
        }
        obj.remove("max_tokens");
        obj.remove("max_completion_tokens");

        // reasoning normalization: reasoning_effort → reasoning.effort + reasoning.summary
        let effort = obj.get("reasoning_effort").and_then(|v| v.as_str()).map(|s| s.to_string());
        if let Some(effort) = effort {
            let mut reasoning = obj.get("reasoning").cloned().unwrap_or(serde_json::json!({}));
            if let Some(r_obj) = reasoning.as_object_mut() {
                r_obj.insert("effort".to_string(), serde_json::Value::String(effort));
                if r_obj.get("summary").is_none() {
                    r_obj.insert("summary".to_string(), serde_json::json!("auto"));
                }
            } else {
                reasoning = serde_json::json!({"effort": effort, "summary": "auto"});
            }
            obj.insert("reasoning".to_string(), reasoning);
            obj.remove("reasoning_effort");
        }
    }
}

#[async_trait::async_trait]
impl ProviderExecutor for OpenCodeExecutor {
    async fn stream(
        &self,
        conn: &ProviderConnection,
        mut body: serde_json::Value,
        headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let base_url = conn
            .data
            .get("baseUrl")
            .or_else(|| conn.data.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASE_URL);

        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let url = build_url(base_url, &model);

        if is_responses_model(&model) {
            normalize_for_responses(&mut body);
        }
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(true));
        }

        // Resolve opencode session/headers from downstream or generate
        let session_id = get_raw_header(&conn.data, "x-opencode-session")
            .or_else(|| headers.get("x-opencode-session").and_then(|v| v.to_str().ok()).map(|s| s.to_string()))
            .unwrap_or_else(generate_session_id);

        let request_id = get_raw_header(&conn.data, "x-opencode-request")
            .or_else(|| headers.get("x-opencode-request").and_then(|v| v.to_str().ok()).map(|s| s.to_string()))
            .unwrap_or_else(generate_request_id);

        let client_id = get_raw_header(&conn.data, "x-opencode-client")
            .or_else(|| headers.get("x-opencode-client").and_then(|v| v.to_str().ok()).map(|s| s.to_string()))
            .unwrap_or_else(|| "desktop".to_string());

        let project_id = get_raw_header(&conn.data, "x-opencode-project")
            .or_else(|| headers.get("x-opencode-project").and_then(|v| v.to_str().ok()).map(|s| s.to_string()))
            .unwrap_or_else(|| "global".to_string());

        // Check if downstream user-agent contains "opencode"
        let downstream_ua = get_raw_header(&conn.data, "user-agent")
            .or_else(|| headers.get("user-agent").and_then(|v| v.to_str().ok()).map(|s| s.to_string()))
            .unwrap_or_default();
        let user_agent = if downstream_ua.to_lowercase().contains("opencode") {
            downstream_ua
        } else {
            OPENCODE_UA.to_string()
        };

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer public")
            .header("User-Agent", &user_agent)
            .header("x-opencode-client", &client_id)
            .header("x-opencode-session", &session_id)
            .header("x-opencode-request", &request_id)
            .header("x-opencode-project", &project_id)
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
        headers: HeaderMap,
    ) -> anyhow::Result<UpstreamResponse> {
        let base_url = conn
            .data
            .get("baseUrl")
            .or_else(|| conn.data.get("base_url"))
            .and_then(|v| v.as_str())
            .unwrap_or(DEFAULT_BASE_URL);

        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let url = build_url(base_url, &model);

        if is_responses_model(&model) {
            normalize_for_responses(&mut body);
        }
        if let Some(obj) = body.as_object_mut() {
            obj.insert("stream".to_string(), serde_json::json!(false));
        }

        let session_id = get_raw_header(&conn.data, "x-opencode-session")
            .or_else(|| headers.get("x-opencode-session").and_then(|v| v.to_str().ok()).map(|s| s.to_string()))
            .unwrap_or_else(generate_session_id);
        let request_id = get_raw_header(&conn.data, "x-opencode-request")
            .or_else(|| headers.get("x-opencode-request").and_then(|v| v.to_str().ok()).map(|s| s.to_string()))
            .unwrap_or_else(generate_request_id);
        let client_id = get_raw_header(&conn.data, "x-opencode-client")
            .unwrap_or_else(|| "desktop".to_string());
        let project_id = get_raw_header(&conn.data, "x-opencode-project")
            .unwrap_or_else(|| "global".to_string());
        let downstream_ua = get_raw_header(&conn.data, "user-agent")
            .or_else(|| headers.get("user-agent").and_then(|v| v.to_str().ok()).map(|s| s.to_string()))
            .unwrap_or_default();
        let user_agent = if downstream_ua.to_lowercase().contains("opencode") {
            downstream_ua
        } else {
            OPENCODE_UA.to_string()
        };

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer public")
            .header("User-Agent", &user_agent)
            .header("x-opencode-client", &client_id)
            .header("x-opencode-session", &session_id)
            .header("x-opencode-request", &request_id)
            .header("x-opencode-project", &project_id)
            .header("Accept", "*/*")
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
