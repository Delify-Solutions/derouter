//! Zed executor.
//! Port of open-sse/executors/zed.js.
//!
//! Routes requests to Zed's hosted LLM aggregator (cloud.zed.dev/completions),
//! a multi-format proxy fronting Anthropic/OpenAI/Google/xAI depending on the model.
//!
//! Wire protocol: POST /completions with an NDJSON/SSE-ish body-per-line response
//! stream (`{"event": <provider-shaped-chunk>}` / `{"status": ...}` / `[DONE]`),
//! authenticated with a short-lived LLM bearer token exchanged from the
//! RSA-decrypted access_token.
//!
//! Auth (non-standard): "Authorization: <user_id> <access_token>" for the LLM
//! token exchange (POST /client/llm_tokens), then "Authorization: Bearer <llm_token>"
//! for the completion call. The LLM token is cached per-process for 50 minutes.
//!
//! NOTE: This executor overrides the full pipeline. The Node version uses
//! translator adapters (openai→claude, openai→gemini, openai→responses) to
//! shape the request for each upstream provider Zed fronts. In the Rust port,
//! the translator adapters are not yet available, so this executor forwards
//! the body as-is (OpenAI shape). For Anthropic/Google-backed models accessed
//! through Zed, the request shape may need the translator when it's ready.
//! The NDJSON→SSE response conversion is implemented inline.

use std::collections::HashMap;

use axum::http::{HeaderMap, StatusCode};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use once_cell::sync::Lazy;
use tokio::sync::Mutex;

use super::base::{ProviderExecutor, UpstreamResponse, build_client};
use crate::db::repos::connections::ProviderConnection;

pub struct ZedExecutor;

const ZED_CLOUD_BASE: &str = "https://cloud.zed.dev";
const ZED_LLM_BASE: &str = "https://cloud.zed.dev";
const LLM_TOKEN_TTL_MS: u64 = 50 * 60 * 1000;

const ZED_HEADERS_CLIENT_SUPPORTS_STATUS: &str = "x-zed-client-supports-status-messages";
const ZED_HEADERS_CLIENT_SUPPORTS_STREAM_ENDED: &str =
    "x-zed-client-supports-stream-ended-request-completion-status";

/// Per-process LLM token cache: key = "userId:org:token_suffix", value = (token, expires_at_ms)
static LLM_TOKEN_CACHE: Lazy<Mutex<HashMap<String, (String, u64)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Build the Zed user auth header: "{user_id} {access_token}".
fn build_zed_user_auth_header(data: &serde_json::Value) -> anyhow::Result<String> {
    let psd = data
        .get("providerSpecificData")
        .or_else(|| data.get("provider_specific_data"));
    let user_id = psd
        .and_then(|p| p.get("userId").or_else(|| p.get("user_id")))
        .or_else(|| data.get("userId").or_else(|| data.get("user_id")))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Zed credential missing userId"))?;
    let access_token = data
        .get("accessToken")
        .or_else(|| data.get("access_token"))
        .or_else(|| data.get("apiKey"))
        .or_else(|| data.get("api_key"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Zed credential missing accessToken"))?;
    Ok(format!("{} {}", user_id, access_token))
}

/// Resolve organization id from credentials or fetch from user info.
fn resolve_organization_id(data: &serde_json::Value) -> Option<String> {
    let psd = data
        .get("providerSpecificData")
        .or_else(|| data.get("provider_specific_data"));
    let explicit = psd
        .and_then(|p| {
            p.get("organizationId")
                .or_else(|| p.get("organization_id"))
                .or_else(|| p.get("defaultOrganizationId"))
                .or_else(|| p.get("default_organization_id"))
        })
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    explicit
}

/// Get the system id from credentials (optional header).
fn get_system_id(data: &serde_json::Value) -> String {
    data.get("providerSpecificData")
        .or_else(|| data.get("provider_specific_data"))
        .and_then(|p| p.get("systemId").or_else(|| p.get("system_id")))
        .or_else(|| data.get("systemId").or_else(|| data.get("system_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Fetch a short-lived LLM bearer token from Zed cloud (cached per-process).
async fn fetch_zed_llm_token(
    data: &serde_json::Value,
    force_refresh: bool,
) -> anyhow::Result<String> {
    let user_id = data
        .get("providerSpecificData")
        .or_else(|| data.get("provider_specific_data"))
        .and_then(|p| p.get("userId").or_else(|| p.get("user_id")))
        .or_else(|| data.get("userId").or_else(|| data.get("user_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let token_short: String = data
        .get("accessToken")
        .or_else(|| data.get("access_token"))
        .or_else(|| data.get("apiKey"))
        .and_then(|v| v.as_str())
        .map(|s| s.chars().rev().take(16).collect())
        .unwrap_or_default();
    let org = resolve_organization_id(data).unwrap_or_else(|| "default".to_string());
    let cache_key = format!("{}:{}:{}", user_id, org, token_short);

    if !force_refresh {
        let cache = LLM_TOKEN_CACHE.lock().await;
        if let Some((token, expires_at)) = cache.get(&cache_key) {
            if *expires_at > now_ms() {
                return Ok(token.clone());
            }
        }
    }

    let organization_id = match resolve_organization_id(data) {
        Some(o) => o,
        None => {
            // Fetch user info to resolve org
            let auth_header = build_zed_user_auth_header(data)?;
            let client = build_client();
            let mut req = client
                .get(format!("{}/client/users/me", ZED_CLOUD_BASE))
                .header("Accept", "application/json")
                .header("Authorization", &auth_header);
            let sid = get_system_id(data);
            if !sid.is_empty() {
                req = req.header("x-zed-system-id", &sid);
            }
            let resp = req.send().await?;
            if !resp.status().is_success() {
                anyhow::bail!("Zed: failed to fetch user info for org resolution");
            }
            let user_info: serde_json::Value = resp.json().await?;
            user_info
                .get("default_organization_id")
                .or_else(|| user_info.get("defaultOrganizationId"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| anyhow::anyhow!("Zed: no organization selected"))?
        }
    };

    let auth_header = build_zed_user_auth_header(data)?;
    let client = build_client();
    let mut req = client
        .post(format!("{}/client/llm_tokens", ZED_CLOUD_BASE))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Authorization", &auth_header);
    let sid = get_system_id(data);
    if !sid.is_empty() {
        req = req.header("x-zed-system-id", &sid);
    }
    let resp = req
        .json(&serde_json::json!({"organization_id": organization_id}))
        .send()
        .await?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        anyhow::bail!("Zed LLM token fetch failed: {}", err);
    }

    let data_resp: serde_json::Value = resp.json().await?;
    let token = data_resp
        .get("token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            data_resp
                .get("token")
                .and_then(|v| v.as_array())
                .and_then(|arr| arr.first())
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .ok_or_else(|| anyhow::anyhow!("Zed did not return an LLM token"))?;

    let expires_at = now_ms() + LLM_TOKEN_TTL_MS;
    LLM_TOKEN_CACHE.lock().await.insert(cache_key, (token.clone(), expires_at));
    Ok(token)
}

/// Determine which upstream provider Zed fronts for a model (inferring from name).
fn normalize_zed_provider(value: &str, model: &str) -> &'static str {
    let raw = value.to_lowercase();
    if raw == "anthropic" {
        return "Anthropic";
    }
    if raw == "openai" || raw == "open_ai" {
        return "OpenAi";
    }
    if raw == "google" || raw == "gemini" {
        return "Google";
    }
    if raw == "xai" || raw == "x_ai" || raw == "x-ai" {
        return "XAi";
    }
    let m = model.to_lowercase();
    if m.contains("claude") {
        return "Anthropic";
    }
    if m.contains("gemini") {
        return "Google";
    }
    if m.contains("grok") || m.contains("xai") {
        return "XAi";
    }
    "OpenAi"
}

/// Unwrap a line from Zed's NDJSON stream into an event/status/done marker.
enum ZedLine {
    Event(serde_json::Value),
    Status(serde_json::Value),
    Done,
    None,
}

fn unwrap_zed_line(line: &str) -> ZedLine {
    let text = line.trim();
    if text.is_empty() {
        return ZedLine::None;
    }
    let text = if let Some(rest) = text.strip_prefix("data:") {
        rest.trim_start()
    } else {
        text
    };
    if text == "[DONE]" {
        return ZedLine::Done;
    }
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return ZedLine::None,
    };
    if parsed.get("event").is_some() {
        return ZedLine::Event(parsed.get("event").cloned().unwrap());
    }
    if parsed.get("status").is_some() {
        return ZedLine::Status(parsed.get("status").cloned().unwrap());
    }
    // If the parsed object itself is the event
    ZedLine::Event(parsed)
}

/// Create an error chunk in OpenAI chat completion shape.
fn create_error_chunk(model: &str, message: &str) -> String {
    let chunk = serde_json::json!({
        "id": format!("chatcmpl-zed-error-{}", now_ms()),
        "object": "chat.completion.chunk",
        "created": now_ms() / 1000,
        "model": model,
        "choices": [{
            "index": 0,
            "delta": {"content": format!("[Zed error] {}", message)},
            "finish_reason": "stop"
        }]
    });
    format!("data: {}\n\n", chunk)
}

/// Normalize a Zed status frame.
fn normalize_status(status: &serde_json::Value) -> Option<(String, serde_json::Value)> {
    if let Some(s) = status.as_str() {
        return Some((s.to_string(), serde_json::Value::Null));
    }
    if let Some(obj) = status.as_object() {
        if let Some((key, val)) = obj.iter().next() {
            return Some((key.clone(), val.clone()));
        }
    }
    None
}

/// Wrap the Zed NDJSON response stream into SSE format.
/// Each line from Zed is parsed as NDJSON; events are re-emitted as SSE `data:` lines.
/// Status frames ("failed"/"stream_ended") are converted to error chunks or
/// stream termination.
fn wrap_zed_completion_stream(
    upstream: impl Stream<Item = Result<Bytes, reqwest::Error>> + Send + Unpin + 'static,
    model: String,
) -> Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send + Unpin> {
    use tokio::sync::mpsc;
    use tokio_stream::wrappers::ReceiverStream;

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(32);

    tokio::spawn(async move {
        let mut upstream = Box::pin(upstream);
        let mut buffer = String::new();
        let mut done = false;

        while !done {
            // Process complete lines from buffer
            while let Some(nl) = buffer.find('\n') {
                let line = buffer[..nl].to_string();
                buffer = buffer[nl + 1..].to_string();
                let output = process_zed_line(&line, &model, &mut done);
                if !output.is_empty() {
                    if tx.send(Ok(Bytes::from(output))).await.is_err() {
                        return;
                    }
                }
                if done {
                    break;
                }
            }
            if done {
                break;
            }

            // Read more data from upstream
            match upstream.next().await {
                Some(Ok(chunk)) => {
                    buffer.push_str(&String::from_utf8_lossy(&chunk));
                }
                Some(Err(e)) => {
                    let _ = tx.send(Err(std::io::Error::new(std::io::ErrorKind::Other, e))).await;
                    return;
                }
                None => {
                    // Process remaining buffer
                    if !buffer.is_empty() {
                        let mut local_done = false;
                        let output = process_zed_line(&buffer, &model, &mut local_done);
                        if !output.is_empty() {
                            let _ = tx.send(Ok(Bytes::from(output))).await;
                        }
                    }
                    break;
                }
            }
        }

        // Emit final [DONE]
        let _ = tx.send(Ok(Bytes::from("data: [DONE]\n\n"))).await;
    });

    Box::new(ReceiverStream::new(rx))
}

/// Process a single NDJSON line from Zed and return SSE-formatted output.
/// Returns the SSE bytes to emit, or empty string if nothing to emit.
fn process_zed_line(line: &str, model: &str, done: &mut bool) -> String {
    match unwrap_zed_line(line) {
        ZedLine::None => String::new(),
        ZedLine::Done => {
            *done = true;
            String::new()
        }
        ZedLine::Status(status) => {
            let (stype, sval) = normalize_status(&status).unwrap_or((String::new(), serde_json::Value::Null));
            if stype == "failed" || sval.get("failed").is_some() {
                let failed = sval.get("failed").cloned().unwrap_or(sval);
                let msg = failed
                    .get("message")
                    .or_else(|| failed.get("error"))
                    .or_else(|| failed.get("code"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("request failed")
                    .to_string();
                let chunk = create_error_chunk(model, &msg);
                *done = true;
                chunk
            } else if stype == "stream_ended" || stype.contains("stream_ended") {
                *done = true;
                String::new()
            } else {
                String::new()
            }
        }
        ZedLine::Event(event) => {
            // Forward the event as-is in SSE format.
            // NOTE: The Node version applies provider-specific response translators
            // (claude→openai, gemini→openai, etc.) here. In the Rust port those adapters
            // are not yet available, so events are forwarded directly. For Anthropic/
            // Gemini-backed models, the response shape may differ from OpenAI format
            // until the translator is wired.
            format!("data: {}\n\n", event)
        }
    }
}

#[async_trait::async_trait]
impl ProviderExecutor for ZedExecutor {
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
        // Zed is stream-only (forceStream); route complete through stream.
        self.execute(conn, body, true).await
    }
}

impl ZedExecutor {
    async fn execute(
        &self,
        conn: &ProviderConnection,
        body: serde_json::Value,
        stream: bool,
    ) -> anyhow::Result<UpstreamResponse> {
        let model = body
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        // Determine provider from connection data or infer from model name
        let provider_name = conn
            .data
            .get("providerSpecificData")
            .or_else(|| conn.data.get("provider_specific_data"))
            .and_then(|p| p.get("provider"))
            .and_then(|v| v.as_str())
            .map(|s| normalize_zed_provider(s, &model))
            .unwrap_or_else(|| normalize_zed_provider("", &model));

        // Build the Zed completion payload.
        // NOTE: The Node version wraps the body in a provider-specific request
        // (openai→claude, openai→gemini, openai→responses) via translator adapters.
        // Those adapters are not yet ported, so we forward the body as-is.
        let thread_id = body.get("thread_id").and_then(|v| v.as_str()).map(|s| s.to_string());
        let prompt_id = body.get("prompt_id").and_then(|v| v.as_str()).map(|s| s.to_string());

        let payload = serde_json::json!({
            "thread_id": thread_id,
            "prompt_id": prompt_id,
            "provider": provider_name,
            "model": model,
            "provider_request": body,
        });

        // Fetch LLM token (with retry on 401)
        let llm_token = fetch_zed_llm_token(&conn.data, false).await?;

        let url = format!("{}/completions", ZED_LLM_BASE);

        let send_request = |token: String| {
            let client = build_client();
            client.post(&url)
                .header("Content-Type", "application/json")
                .header("Accept", "application/x-ndjson, text/event-stream, */*")
                .header("User-Agent", "derouter/zed")
                .header("x-zed-version", "0.200.0")
                .header(ZED_HEADERS_CLIENT_SUPPORTS_STATUS, "true")
                .header(ZED_HEADERS_CLIENT_SUPPORTS_STREAM_ENDED, "true")
                .header("Authorization", format!("Bearer {}", token))
                .json(&payload)
        };

        let mut resp = send_request(llm_token).send().await?;

        // Retry on 401 with fresh token
        if resp.status().as_u16() == 401 {
            let new_token = fetch_zed_llm_token(&conn.data, true).await?;
            resp = send_request(new_token).send().await?;
        }

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            // Parse Zed error format
            let (error_status, error_msg) = parse_zed_error(status.as_u16(), &text);
            return Ok(UpstreamResponse::Error {
                status: StatusCode::from_u16(error_status)?,
                message: error_msg,
            });
        }

        if stream {
            let upstream = resp.bytes_stream();
            let boxed = wrap_zed_completion_stream(upstream, model);
            Ok(UpstreamResponse::Stream {
                headers: HeaderMap::new(),
                stream: boxed,
            })
        } else {
            // Zed is stream-only but if called for complete, aggregate the stream
            let bytes = resp.bytes().await?;
            Ok(UpstreamResponse::Json {
                status: StatusCode::OK,
                headers: HeaderMap::new(),
                body: bytes,
            })
        }
    }
}

/// Parse Zed's error response format.
fn parse_zed_error(status: u16, body_text: &str) -> (u16, String) {
    let parsed: serde_json::Value = serde_json::from_str(body_text).unwrap_or(serde_json::json!({}));

    let error_obj = parsed.get("error");
    let code = parsed
        .get("code")
        .and_then(|v| v.as_str())
        .or_else(|| error_obj.and_then(|e| e.get("code")).and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    let raw_message = parsed
        .get("message")
        .and_then(|v| v.as_str())
        .or_else(|| error_obj.and_then(|e| e.get("message")).and_then(|v| v.as_str()))
        .unwrap_or(body_text)
        .to_string();

    if code == "trial_blocked" {
        return (
            status,
            format!(
                "Zed trial access is blocked upstream. The account can list hosted models, but Zed is refusing completions until trial/billing access is enabled or unblocked. Zed says: {}",
                raw_message
            ),
        );
    }
    if !code.is_empty() {
        return (status, format!("Zed {}: {}", code, raw_message));
    }
    (status, raw_message)
}
