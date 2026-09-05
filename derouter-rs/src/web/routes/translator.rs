//! Translator routes — JSON API for the request translator console.
//! Ported from src/app/api/translator/{load,save,send,translate,console-logs}/route.js.
//!
//! GET  /api/translator/load?file=xxx — load a translator log file.
//! POST /api/translator/save — save content to a translator log file.
//! POST /api/translator/send — send a request to a provider (SSE stream).
//! POST /api/translator/translate — run translation pipeline steps 1-3.
//! GET  /api/translator/console-logs — get in-memory console log buffer.
//! DELETE /api/translator/console-logs — clear the console log buffer.
//! GET  /api/translator/console-logs/stream — SSE stream of console logs.

use std::collections::VecDeque;
use std::sync::Arc;

use axum::extract::Query;
use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use tokio::sync::{broadcast, Mutex};

use crate::auth;
use crate::db::DbPool;

/// Allowed translator log filenames (security: only these can be read/written).
const ALLOWED_FILES: &[&str] = &[
    "1_req_client.json",
    "2_req_source.json",
    "3_req_openai.json",
    "4_req_target.json",
    "5_res_provider.txt",
    "6_res_openai.txt",
    "7_res_client.txt",
    "7_res_client.json",
];

/// In-memory console log ring buffer + broadcast channel for SSE.
struct ConsoleLogBuffer {
    logs: VecDeque<String>,
    tx: broadcast::Sender<ConsoleLogEvent>,
}

/// Events emitted on the console log SSE stream.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type")]
enum ConsoleLogEvent {
    Init { logs: Vec<String> },
    Line { line: String },
    Lines { lines: Vec<String> },
    Clear,
}

static CONSOLE_LOGS: once_cell::sync::Lazy<Arc<Mutex<ConsoleLogBuffer>>> =
    once_cell::sync::Lazy::new(|| {
        let (tx, _rx) = broadcast::channel(256);
        Arc::new(Mutex::new(ConsoleLogBuffer {
            logs: VecDeque::with_capacity(1000),
            tx,
        }))
    });

/// GET /api/translator/load?file=xxx — load a translator log file.
pub async fn load(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let file = match params.get("file") {
        Some(f) => f,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"success": false, "error": "File parameter required"})),
            )
                .into_response();
        }
    };

    if !ALLOWED_FILES.contains(&file.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"success": false, "error": "Invalid file name"})),
        )
            .into_response();
    }

    let logs_dir = translator_logs_dir();
    let file_path = logs_dir.join(file);

    match tokio::fs::read_to_string(&file_path).await {
        Ok(content) => Json(serde_json::json!({"success": true, "content": content})).into_response(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"success": false, "error": "File not found"})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"success": false, "error": e.to_string()})),
        )
            .into_response(),
    }
}

/// POST /api/translator/save — save content to a translator log file.
pub async fn save(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let file = body.get("file").and_then(|v| v.as_str()).unwrap_or("");
    let content = body.get("content");

    if file.is_empty() || content.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"success": false, "error": "File and content required"})),
        )
            .into_response();
    }

    if !ALLOWED_FILES.contains(&file) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"success": false, "error": "Invalid file name"})),
        )
            .into_response();
    }

    let logs_dir = translator_logs_dir();

    // Create directory if missing
    if let Err(e) = tokio::fs::create_dir_all(&logs_dir).await {
        if e.kind() != std::io::ErrorKind::AlreadyExists {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"success": false, "error": e.to_string()})),
            )
                .into_response();
        }
    }

    let file_path = logs_dir.join(file);
    let content_str = match content.unwrap() {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };

    match tokio::fs::write(&file_path, content_str.as_bytes()).await {
        Ok(()) => Json(serde_json::json!({"success": true})).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"success": false, "error": e.to_string()})),
        )
            .into_response(),
    }
}

/// POST /api/translator/send — send a request to a provider (SSE stream).
/// Ported from src/app/api/translator/send/route.js.
/// The Node version uses getExecutor to proxy to the provider with SSE streaming.
pub async fn send(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let provider = body.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let body_val = body.get("body");

    if provider.is_empty() || model.is_empty() || body_val.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"success": false, "error": "provider, model, and body required"})),
        )
            .into_response();
    }

    // Look up provider connection for API key
    let pool_c = pool.clone();
    let provider_c = provider.to_string();
    let conn_result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<crate::db::repos::connections::ProviderConnection>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let conns = crate::db::repos::connections::get_provider_connections(
            &conn,
            &crate::db::repos::connections::ConnectionFilter {
                provider: Some(provider_c.clone()),
                is_active: Some(true),
            },
        )?;
        Ok(conns.into_iter().next())
    })
    .await;

    let connection = match conn_result {
        Ok(Ok(Some(c))) => c,
        Ok(Ok(None)) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"success": false, "error": format!("No active connection for provider: {}", provider)})),
            )
                .into_response();
        }
        Ok(Err(e)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"success": false, "error": e.to_string()})),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"success": false, "error": e.to_string()})),
            )
                .into_response();
        }
    };

    let api_key = connection
        .data
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Mask the key in error messages
    let masked_key = "****".to_string();

    // Build the request to the provider
    // TODO Phase4: full provider executor routing (getExecutor in Node maps provider → URL/headers/body transform).
    // For now, we proxy to OpenAI-compatible endpoints directly.
    let base_url = connection
        .data
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("https://api.openai.com")
        .to_string();

    let stream = body_val
        .unwrap()
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let endpoint = if stream { "/v1/chat/completions" } else { "/v1/chat/completions" };
    let target_url = format!("{}{}", base_url, endpoint);

    // Build request body for the provider
    let mut request_body = body_val.unwrap().clone();
    if let Some(obj) = request_body.as_object_mut() {
        obj.insert("model".to_string(), serde_json::json!(model));
        if !stream {
            obj.insert("stream".to_string(), serde_json::json!(false));
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_default();

    let req = client
        .post(&target_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body);

    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[Translator] Send error: {} (key: {})", e, masked_key);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"success": false, "error": e.to_string()})),
            )
                .into_response();
        }
    };

    let status = res.status();
    if !status.is_success() {
        let error_text = res.text().await.unwrap_or_default();
        tracing::error!("[Translator] Provider error {}: {}", status.as_u16(), &error_text[..error_text.len().min(500)]);
        return (
            status,
            Json(serde_json::json!({
                "success": false,
                "error": format!("Provider error: {}", status.as_u16()),
                "details": error_text,
            })),
        )
            .into_response();
    }

    if stream {
        // Stream the SSE response through
        let byte_stream = res.bytes_stream();
        (
            [
                (header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream")),
                (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
                (header::CONNECTION, HeaderValue::from_static("keep-alive")),
            ],
            axum::body::Body::from_stream(byte_stream),
        )
            .into_response()
    } else {
        // Return JSON response
        let json: serde_json::Value = match res.json().await {
            Ok(v) => v,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"success": false, "error": format!("Failed to parse response: {}", e)})),
                )
                    .into_response();
            }
        };
        Json(json).into_response()
    }
}

/// POST /api/translator/translate — run translation pipeline steps 1-3.
/// Ported from src/app/api/translator/translate/route.js.
/// The Node version calls translateRequest which is part of the open-sse translator module.
pub async fn translate(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let step = body.get("step").and_then(|v| v.as_u64()).unwrap_or(0);
    let body_val = body.get("body");

    if step == 0 || body_val.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"success": false, "error": "Step and body required"})),
        )
            .into_response();
    }

    match step {
        1 => {
            // Step 1: Detect provider + formats from the client request
            let client_body = body_val.unwrap();
            let model = client_body.get("model").and_then(|v| v.as_str()).unwrap_or("");

            if model.is_empty() {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"success": false, "error": "model required in body"})),
                )
                    .into_response();
            }

            // Look up provider for this model
            let (provider, resolved_model) = resolve_model_provider(pool, model).await;

            // Detect source format (simplified: OpenAI vs Anthropic vs Gemini)
            let source_format = detect_format(client_body);

            // Target format based on provider
            let target_format = get_target_format(&provider);

            Json(serde_json::json!({
                "success": true,
                "result": {
                    "provider": provider,
                    "model": resolved_model,
                    "sourceFormat": source_format,
                    "targetFormat": target_format,
                }
            }))
            .into_response()
        }
        2 => {
            // Step 2: Translate source → OpenAI intermediate
            // TODO Phase4: full source→OpenAI translation (requires the open-sse translator module).
            // For now, pass through the body as-is (most clients already send OpenAI format).
            let client_body = body_val.unwrap();
            let model = client_body.get("model").and_then(|v| v.as_str()).unwrap_or("");
            let (provider, _) = resolve_model_provider(pool, model).await;

            tracing::warn!("translator step 2 (source→OpenAI) not fully ported (Phase 4) — passing through");
            let result = client_body.clone();

            Json(serde_json::json!({
                "success": true,
                "result": {"body": result},
                "provider": provider,
            }))
            .into_response()
        }
        3 => {
            // Step 3: OpenAI intermediate → target + build URL/headers
            let openai_body = body_val.unwrap();
            let provider = body.get("provider").and_then(|v| v.as_str()).unwrap_or("");
            let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("");

            if provider.is_empty() || model.is_empty() {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"success": false, "error": "provider and model required"})),
                )
                    .into_response();
            }

            // Look up connection for URL/credentials
            let pool_c = pool.clone();
            let provider_c = provider.to_string();
            let conn_result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<crate::db::repos::connections::ProviderConnection>> {
                let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
                let conns = crate::db::repos::connections::get_provider_connections(
                    &conn,
                    &crate::db::repos::connections::ConnectionFilter {
                        provider: Some(provider_c.clone()),
                        is_active: Some(true),
                    },
                )?;
                Ok(conns.into_iter().next())
            })
            .await;

            let connection = match conn_result {
                Ok(Ok(Some(c))) => c,
                Ok(Ok(None)) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({"success": false, "error": format!("No active connection for provider: {}", provider)})),
                    )
                        .into_response();
                }
                Ok(Err(e)) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"success": false, "error": e.to_string()})),
                    )
                        .into_response();
                }
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"success": false, "error": e.to_string()})),
                    )
                        .into_response();
                }
            };

            let base_url = connection
                .data
                .get("baseUrl")
                .and_then(|v| v.as_str())
                .unwrap_or("https://api.openai.com")
                .to_string();

            let url = format!("{}/v1/chat/completions", base_url);

            // Build headers (mask API key)
            let api_key = connection
                .data
                .get("apiKey")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let headers_json = serde_json::json!({
                "Authorization": "****",
                "Content-Type": "application/json",
            });
            let _ = api_key; // used in the actual request, masked in display

            // TODO Phase4: full OpenAI→target format translation.
            tracing::warn!("translator step 3 (OpenAI→target) not fully ported (Phase 4) — passing through");
            let final_body = openai_body.clone();

            Json(serde_json::json!({
                "success": true,
                "result": {
                    "url": url,
                    "headers": headers_json,
                    "body": final_body,
                }
            }))
            .into_response()
        }
        _ => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"success": false, "error": "Invalid step (1-3)"})),
        )
            .into_response(),
    }
}

/// GET /api/translator/console-logs — get in-memory console log buffer.
pub async fn console_logs_get(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let state = CONSOLE_LOGS.lock().await;
    let logs: Vec<String> = state.logs.iter().cloned().collect();

    Json(serde_json::json!({"success": true, "logs": logs})).into_response()
}

/// DELETE /api/translator/console-logs — clear the console log buffer.
pub async fn console_logs_delete(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let mut state = CONSOLE_LOGS.lock().await;
    state.logs.clear();
    let _ = state.tx.send(ConsoleLogEvent::Clear);

    Json(serde_json::json!({"success": true})).into_response()
}

/// GET /api/translator/console-logs/stream — SSE stream of console logs.
pub async fn console_logs_stream(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let state = CONSOLE_LOGS.lock().await;
    let buffered: Vec<String> = state.logs.iter().cloned().collect();
    let rx = state.tx.subscribe();
    drop(state);

    let stream = async_stream::stream! {
        // Send buffered logs on connect
        if !buffered.is_empty() {
            let event = ConsoleLogEvent::Init { logs: buffered };
            let json = serde_json::to_string(&event).unwrap_or_default();
            yield Ok::<_, std::convert::Infallible>(format!("data: {}\n\n", json));
        }

        // Stream new events
        let mut rx = rx;
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let json = serde_json::to_string(&event).unwrap_or_default();
                    yield Ok(format!("data: {}\n\n", json));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    };

    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream")),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-transform")),
            (header::CONNECTION, HeaderValue::from_static("keep-alive")),
            (axum::http::HeaderName::from_static("x-accel-buffering"), HeaderValue::from_static("no")),
        ],
        axum::body::Body::from_stream(stream),
    )
        .into_response()
}

// ===== Helpers =====

/// Get the translator logs directory.
/// Node uses process.cwd()/logs/translator.
/// In Rust, we use DATA_DIR/logs/translator.
fn translator_logs_dir() -> std::path::PathBuf {
    let data_dir = std::env::var("DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
            home.join(".derouter")
        });
    data_dir.join("logs").join("translator")
}

/// Detect the request format from the body shape.
/// Simplified version of open-sse/services/provider.js detectFormat.
fn detect_format(body: &serde_json::Value) -> &'static str {
    // Anthropic Messages API: has "messages" but no "messages" with role "system" at top level
    // and may have "max_tokens" as required field
    if body.get("max_tokens").is_some() && body.get("messages").is_some() && body.get("system").is_none() {
        // Could be Anthropic or OpenAI — check for Anthropic-specific fields
        if body.get("top_k").is_some() || body.get("metadata").is_some() {
            return "anthropic";
        }
    }

    // Gemini: has "contents" array
    if body.get("contents").is_some() {
        return "gemini";
    }

    // Default: OpenAI
    "openai"
}

/// Get the target format for a provider.
/// Simplified version of open-sse/services/provider.js getTargetFormat.
fn get_target_format(provider: &str) -> &'static str {
    match provider {
        "anthropic" | "claude" => "anthropic",
        "gemini" | "google" => "gemini",
        _ => "openai",
    }
}

/// Resolve a model name to its provider.
/// Queries the provider connections to find which provider serves this model.
async fn resolve_model_provider(pool: DbPool, model: &str) -> (String, String) {
    // Simple heuristic: check model name prefix
    let (provider, resolved_model) = if model.starts_with("claude-") || model.starts_with("anthropic/") {
        ("anthropic".to_string(), model.to_string())
    } else if model.starts_with("gemini-") || model.starts_with("google/") {
        ("gemini".to_string(), model.to_string())
    } else if model.contains('/') {
        // Format: "provider/model"
        let parts: Vec<&str> = model.splitn(2, '/').collect();
        (parts[0].to_string(), parts[1].to_string())
    } else {
        // Default to openai
        ("openai".to_string(), model.to_string())
    };

    // TODO Phase4: full model→provider resolution via getModelInfo (queries DB for model→provider mapping).
    let _ = pool;
    (provider, resolved_model)
}
