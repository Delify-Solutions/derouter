//! Antigravity executor.
//! Port of open-sse/executors/antigravity.js.
//!
//! Routes requests to Google Antigravity's Cloud Code Assist endpoint
//! (https://daily-cloudcode-pa.googleapis.com/v1internal).
//!
//! Auth: OAuth access token (from connection.data.accessToken or apiKey).
//! Sent as `Authorization: Bearer <token>`.
//!
//! The request body follows the Gemini CLI envelope shape:
//! `{ project, model, userAgent, requestType, requestId, request: <gemini-body> }`.
//! Stream: `{base}:streamGenerateContent?alt=sse`
//! Non-stream: `{base}:generateContent`
//!
//! NOTE: The Node version applies extensive request transforms (tool cloaking,
//! schema sanitization, system prompt rewriting, thinking field stripping).
//! Those transforms are not yet ported. The body is forwarded as-is in the
//! envelope. When the translator/transform layer is available, it should be
//! wired in here. The response is forwarded as-is (SSE or JSON).

use axum::http::{HeaderMap, StatusCode};
use futures::StreamExt;

use super::base::{ProviderExecutor, UpstreamResponse, build_client};
use crate::db::repos::connections::ProviderConnection;

pub struct AntigravityExecutor;

const DEFAULT_BASE_URL: &str = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_USER_AGENT: &str = "antigravity/ide/0.1.0 darwin/arm64";

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

/// Get project ID from credentials
fn get_project_id(data: &serde_json::Value) -> String {
    data.get("projectId")
        .or_else(|| data.get("project_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            // Generate a random project ID like the Node version
            let adjs = ["useful", "bright", "swift", "calm", "bold"];
            let nouns = ["fuze", "wave", "spark", "flow", "core"];
            let adj = adjs[rand::random::<usize>() % adjs.len()];
            let noun = nouns[rand::random::<usize>() % nouns.len()];
            let suffix = &uuid::Uuid::new_v4().to_string()[..5];
            format!("{}-{}-{}", adj, noun, suffix)
        })
}

/// Get providerSpecificData
fn get_psd(data: &serde_json::Value) -> Option<&serde_json::Value> {
    data.get("providerSpecificData").or_else(|| data.get("provider_specific_data"))
}

/// Determine the base URL from connection data or default
fn get_base_url(data: &serde_json::Value) -> String {
    // Node version supports baseUrls array (for failover)
    if let Some(base_urls) = data.get("baseUrls").or_else(|| data.get("base_urls")).and_then(|v| v.as_array()) {
        if let Some(first) = base_urls.first().and_then(|v| v.as_str()) {
            return first.to_string();
        }
    }
    if let Some(base_url) = data
        .get("baseUrl")
        .or_else(|| data.get("base_url"))
        .and_then(|v| v.as_str())
    {
        return base_url.to_string();
    }
    DEFAULT_BASE_URL.to_string()
}

/// Fields that Google generateContent rejects (set by thinkingUnified.js at root)
const ANTIGRAVITY_REQUEST_BLACKLIST: &[&str] = &[
    "output_config",
    "thinking",
    "reasoning_effort",
    "reasoning",
    "enable_thinking",
    "thinking_budget",
    "thinkingConfig",
];

/// Strip blacklisted fields from an object
fn strip_blacklisted(obj: &mut serde_json::Map<String, serde_json::Value>) {
    for key in ANTIGRAVITY_REQUEST_BLACKLIST {
        obj.remove(*key);
    }
}

/// Build the IDE request ID (antigravity format: agent/{convId}/{ts}/{trajectoryId}/{step})
fn build_ide_request_id(body: &serde_json::Value, model: &str, request_type: &str) -> String {
    // Check if body already has a valid requestId
    if let Some(rid) = body.get("requestId").and_then(|v| v.as_str()) {
        if rid.starts_with("agent/") {
            return rid.to_string();
        }
    }

    let session_id = body
        .get("request")
        .and_then(|r| r.get("sessionId"))
        .and_then(|v| v.as_str())
        .or_else(|| body.get("sessionId").and_then(|v| v.as_str()))
        .unwrap_or("anonymous")
        .to_string();

    let conversation_id = uuid_from_seed(&format!("antigravity:conversation:{}", session_id));
    let trajectory_id = uuid_from_seed(&format!(
        "antigravity:trajectory:{}:{}:{}",
        session_id, model, request_type
    ));
    let content_count = body
        .get("request")
        .and_then(|r| r.get("contents"))
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(1);
    let step = std::cmp::max(1, content_count * 2 - 1);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    format!("agent/{}/{}/{}/{}", conversation_id, ts, trajectory_id, step)
}

/// Generate a UUID from a seed string (SHA256 hash, first 16 bytes)
fn uuid_from_seed(seed: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(seed);
    let mut bytes = [0u8; 16];
    let result = h.finalize();
    bytes.copy_from_slice(&result[..16]);
    // Set version and variant bits
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Detect if a model is an image generation model
fn is_image_model(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("image") || m.contains("imagen") || m.contains("image-generation")
}

/// Wrap the body in the Antigravity envelope
fn build_antigravity_body(
    body: &serde_json::Value,
    model: &str,
    data: &serde_json::Value,
    stream: bool,
) -> serde_json::Value {
    let project_id = get_project_id(data);
    let request_type = if is_image_model(model) { "image_gen" } else { "agent" };

    // Strip blacklisted fields from the request body
    let mut request = body
        .get("request")
        .cloned()
        .unwrap_or_else(|| body.clone());

    if let Some(obj) = request.as_object_mut() {
        strip_blacklisted(obj);

        // Strip stream_options for non-streaming
        if stream != true {
            obj.remove("stream_options");
        }

        // Cap maxOutputTokens
        if let Some(gc) = obj.get_mut("generationConfig").and_then(|v| v.as_object_mut()) {
            if let Some(max_tokens) = gc.get("maxOutputTokens").and_then(|v| v.as_u64()) {
                if max_tokens > 64000 {
                    gc.insert("maxOutputTokens".to_string(), serde_json::json!(64000));
                }
            }
        }
    }

    let request_id = build_ide_request_id(body, model, request_type);

    serde_json::json!({
        "project": project_id,
        "model": model,
        "userAgent": "antigravity",
        "requestType": request_type,
        "requestId": request_id,
        "request": request,
    })
}

#[async_trait::async_trait]
impl ProviderExecutor for AntigravityExecutor {
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

impl AntigravityExecutor {
    async fn execute(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        stream: bool,
    ) -> anyhow::Result<UpstreamResponse> {
        let access_token = get_access_token(&conn.data)
            .ok_or_else(|| anyhow::anyhow!("Antigravity connection missing access token"))?;

        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .or_else(|| body.get("request").and_then(|r| r.get("model")).and_then(|v| v.as_str()))
            .unwrap_or("gemini-2.0-flash")
            .to_string();

        let base_url = get_base_url(&conn.data);

        // Image models force non-streaming
        let force_non_stream = is_image_model(&model);
        let use_stream = stream && !force_non_stream;

        let action = if use_stream {
            "streamGenerateContent?alt=sse"
        } else {
            "generateContent"
        };
        let url = format!("{}/v1internal:{}", base_url.trim_end_matches('/'), action);

        let wrapped = build_antigravity_body(&body, &model, &conn.data, use_stream);

        let client = build_client();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", access_token))
            .header("User-Agent", ANTIGRAVITY_USER_AGENT)
            .json(&wrapped)
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

        if use_stream {
            let stream = resp
                .bytes_stream()
                .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
            Ok(UpstreamResponse::Stream {
                headers: HeaderMap::new(),
                stream: Box::new(stream),
            })
        } else {
            let bytes = resp.bytes().await?;
            Ok(UpstreamResponse::Json {
                status: StatusCode::OK,
                headers: HeaderMap::new(),
                body: bytes,
            })
        }
    }
}
