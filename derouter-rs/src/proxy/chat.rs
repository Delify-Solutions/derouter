//! Proxy chat — handleChat. Phase 1.
//! Port of src/sse/handlers/chat.js + open-sse/handlers/chatCore/*.
//!
//! Flow:
//!   1. Extract apiKey from Authorization/x-api-key
//!   2. Parse body, extract model
//!   3. enforceKeyAccess (D8: before any upstream call)
//!   4. getComboModels (resolve combo to model list)
//!   5. Handle each model candidate: find connections, try each (fallback)
//!   6. Stream via SSE or return JSON
//!   7. Save usage + request detail

use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response, Sse};
use futures::stream::Stream;
use tokio_stream::StreamExt;

use crate::db::DbPool;
use crate::db::repos::{api_keys, connections, request_details, usage};
use crate::db::repos::connections::ConnectionFilter;

use super::detail;
use super::executors::base::{self, ProviderExecutor, UpstreamResponse};
use super::limits;
use super::resolve;

/// Main chat completions handler — entry point for /v1/chat/completions.
/// Also used for /v1/messages (Anthropic), /v1/responses (OpenAI Responses).
pub async fn handle_chat(
    pool: DbPool,
    body: Bytes,
    headers: HeaderMap,
    endpoint: &str,
) -> Response {
    // 1. Extract API key from headers
    let api_key = match extract_api_key(&headers) {
        Some(k) => k,
        None => return error_response(StatusCode::UNAUTHORIZED, "Missing API key"),
    };

    // 2. Parse body
    let body_json: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };

    let model_str = body_json.get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if model_str.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "Missing 'model' field");
    }

    // 3. enforceKeyAccess (D8: before any upstream call)
    let pool_for_db = pool.clone();
    let key_check = tokio::task::spawn_blocking({
        let pool = pool_for_db.clone();
        let api_key = api_key.clone();
        let model_str = model_str.clone();
        move || -> Result<api_keys::ApiKeyForAuth, limits::AccessError> {
            let conn = pool.get().map_err(|_| limits::AccessError::KeyNotFound)?;
            limits::enforce_key_access(&conn, &api_key, &model_str)
        }
    })
    .await;

    let key_auth = match key_check {
        Ok(Ok(auth)) => auth,
        Ok(Err(access_err)) => {
            let (status, json) = access_err.to_error_response();
            return (status, axum::Json(json)).into_response();
        }
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Database error"),
    };

    // 4. Resolve combo models
    let pool_for_resolve = pool.clone();
    let model_candidates = tokio::task::spawn_blocking({
        let pool = pool_for_resolve.clone();
        let model_str = model_str.clone();
        move || -> anyhow::Result<Vec<String>> {
            let conn = pool.get()?;
            Ok::<_, anyhow::Error>(resolve::get_combo_models(&conn, &model_str))
        }
    })
    .await
    .unwrap()
    .unwrap_or_default();

    // 5. Determine if streaming
    let wants_stream = body_json.get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // 6. Try each model candidate (fallback strategy)
    let requested_model = detail::extract_requested_model(&body_json);

    let pool_for_chat = pool.clone();
    let chat_result = try_chat_with_fallback(
        pool_for_chat,
        &model_candidates,
        &body_json,
        &headers,
        &api_key,
        &requested_model,
        &key_auth,
        wants_stream,
        endpoint,
    )
    .await;

    match chat_result {
        Ok(resp) => resp,
        Err(e) => {
            tracing::error!("Chat handler error: {}", e);
            error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
        }
    }
}

/// Try each model candidate with fallback.
/// For each candidate (provider/model), find active prioritized connections
/// and try each one. If all fail, move to the next candidate.
async fn try_chat_with_fallback(
    pool: DbPool,
    model_candidates: &[String],
    body: &serde_json::Value,
    headers: &HeaderMap,
    api_key: &str,
    requested_model: &Option<String>,
    key_auth: &api_keys::ApiKeyForAuth,
    wants_stream: bool,
    endpoint: &str,
) -> anyhow::Result<Response> {
    let mut last_error = String::new();

    for candidate in model_candidates {
        // Parse provider/model from the candidate string
        let (provider, model_id) = parse_provider_model(candidate);

        // Get active connections for this provider
        let pool_conn = pool.clone();
        let connections_list = tokio::task::spawn_blocking({
            let pool = pool_conn.clone();
            let provider = provider.clone();
            move || -> anyhow::Result<Vec<connections::ProviderConnection>> {
                let conn = pool.get()?;
                connections::get_provider_connections(&conn, &ConnectionFilter {
                    provider: Some(provider),
                    is_active: Some(true),
                })
            }
        })
        .await??;

        if connections_list.is_empty() {
            last_error = format!("No active connections for provider '{}'", provider);
            continue;
        }

        // Try each connection for this provider (priority order)
        for conn in &connections_list {
            let executor = base::select_executor(&conn.provider);
            let mut body_for_upstream = body.clone();
            // Set the resolved model in the body
            if let Some(obj) = body_for_upstream.as_object_mut() {
                obj.insert("model".to_string(), serde_json::Value::String(model_id.clone()));
            }

            let result = if wants_stream {
                executor.stream(conn, body_for_upstream.clone(), headers.clone()).await
            } else {
                executor.complete(conn, body_for_upstream.clone(), headers.clone()).await
            };

            match result {
                Ok(UpstreamResponse::Stream { stream, .. }) => {
                    // Save usage (estimated for streaming — actual usage comes from SSE)
                    save_usage_async(
                        pool.clone(),
                        &conn.provider,
                        &model_id,
                        &conn.id,
                        api_key,
                        endpoint,
                        requested_model,
                        wants_stream,
                    )
                    .await;

                    // Save request detail
                    save_detail_async(
                        pool.clone(),
                        Some(&conn.provider),
                        &model_id,
                        requested_model,
                        Some(&conn.id),
                        api_key,
                        "streaming",
                        body,
                        Some(headers),
                    )
                    .await;

                    // Return SSE stream
                    return Ok(build_sse_response(stream));
                }
                Ok(UpstreamResponse::Json { body: resp_bytes, .. }) => {
                    // Parse the response to extract usage
                    let resp_json: serde_json::Value = serde_json::from_slice(&resp_bytes)
                        .unwrap_or(serde_json::json!({}));

                    let tokens = detail::extract_usage_from_response(&resp_json);

                    // Save usage
                    save_usage_with_tokens(
                        pool.clone(),
                        &conn.provider,
                        &model_id,
                        &conn.id,
                        api_key,
                        endpoint,
                        requested_model,
                        &tokens,
                    )
                    .await;

                    // Save request detail
                    save_detail_async(
                        pool.clone(),
                        Some(&conn.provider),
                        &model_id,
                        requested_model,
                        Some(&conn.id),
                        api_key,
                        "success",
                        body,
                        Some(headers),
                    )
                    .await;

                    // Return JSON response
                    return Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/json")
                        .body(Body::from(resp_bytes))
                        .unwrap());
                }
                Ok(UpstreamResponse::Error { status, message }) => {
                    tracing::warn!(
                        "Upstream error for {} via {}: {} - {}",
                        candidate,
                        conn.id,
                        status,
                        &message[..message.len().min(200)]
                    );
                    last_error = format!("{}: {}", status, message);
                    // Try next connection
                    continue;
                }
                Err(e) => {
                    tracing::warn!("Executor error for {} via {}: {}", candidate, conn.id, e);
                    last_error = e.to_string();
                    continue;
                }
            }
        }
    }

    // All candidates failed — save usage with error status so RPM still counts
    save_usage_error(
        pool.clone(),
        api_key,
        endpoint,
        requested_model,
        &last_error,
    )
    .await;

    // Save request detail with error status
    save_detail_async(
        pool.clone(),
        None,
        &model_candidates.first().cloned().unwrap_or_default(),
        requested_model,
        None,
        api_key,
        "error",
        body,
        Some(headers),
    )
    .await;

    Ok(error_response(StatusCode::SERVICE_UNAVAILABLE, &format!(
        "All providers failed for model '{}'. Last error: {}",
        model_candidates.first().unwrap_or(&"".to_string()),
        last_error
    )))
}

/// Parse a "provider/model" string into (provider, model_id).
/// If no slash, treat the whole string as a model with "openai" as default provider.
fn parse_provider_model(s: &str) -> (String, String) {
    if let Some(slash_pos) = s.find('/') {
        let provider = s[..slash_pos].to_string();
        let model = s[slash_pos + 1..].to_string();
        (provider, model)
    } else {
        // No slash — it might be a combo (already resolved) or direct model
        // Default to "openai" as provider
        ("openai".to_string(), s.to_string())
    }
}

/// Extract API key from Authorization: Bearer ... or x-api-key header
pub fn extract_api_key(headers: &HeaderMap) -> Option<String> {
    // Try Authorization: Bearer <key>
    if let Some(auth) = headers.get("authorization") {
        if let Ok(s) = auth.to_str() {
            if let Some(key) = s.strip_prefix("Bearer ") {
                return Some(key.to_string());
            }
            // Some clients send just the key
            return Some(s.to_string());
        }
    }
    // Try x-api-key
    if let Some(key) = headers.get("x-api-key") {
        if let Ok(s) = key.to_str() {
            return Some(s.to_string());
        }
    }
    None
}

/// Build an SSE response from a byte stream
fn build_sse_response(
    stream: Box<dyn Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send + Unpin>,
) -> Response {
    // Convert the upstream byte stream into an SSE stream
    // The upstream is already SSE-formatted, so we pass through the bytes
    let body_stream = stream.map(|result| match result {
        Ok(bytes) => Ok::<_, std::convert::Infallible>(bytes),
        Err(e) => {
            tracing::error!("SSE stream error: {}", e);
            Ok(bytes::Bytes::from("data: [DONE]\n\n"))
        }
    });

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
        .body(Body::from_stream(body_stream))
        .unwrap()
}

/// Save usage asynchronously (for streaming — usage estimated or will be updated later)
async fn save_usage_async(
    pool: DbPool,
    provider: &str,
    model: &str,
    connection_id: &str,
    api_key: &str,
    endpoint: &str,
    requested_model: &Option<String>,
    _is_stream: bool,
) {
    let pool = pool.clone();
    let provider = provider.to_string();
    let model = model.to_string();
    let connection_id = connection_id.to_string();
    let api_key = api_key.to_string();
    let endpoint = endpoint.to_string();
    let requested_model = requested_model.clone();

    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool.get()?;
        let entry = usage::UsageEntry {
            timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            provider: Some(provider),
            model: Some(model),
            connection_id: Some(connection_id),
            api_key: Some(api_key),
            endpoint: Some(endpoint),
            prompt_tokens: 0,
            completion_tokens: 0,
            cost: 0.0,
            status: "streaming".to_string(),
            tokens: serde_json::json!({}),
            meta: serde_json::json!({ "requestedModel": requested_model }),
            requested_model,
        };
        usage::save_request_usage(&conn, &entry)?;
        Ok(())
    })
    .await
    .ok();
}

/// Save usage with actual token counts (for non-streaming)
async fn save_usage_with_tokens(
    pool: DbPool,
    provider: &str,
    model: &str,
    connection_id: &str,
    api_key: &str,
    endpoint: &str,
    requested_model: &Option<String>,
    tokens: &serde_json::Value,
) {
    let pool = pool.clone();
    let provider = provider.to_string();
    let model = model.to_string();
    let connection_id = connection_id.to_string();
    let api_key = api_key.to_string();
    let endpoint = endpoint.to_string();
    let requested_model = requested_model.clone();
    let tokens = tokens.clone();

    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool.get()?;
        let prompt_tokens = tokens.get("prompt_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let completion_tokens = tokens.get("completion_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        let entry = usage::UsageEntry {
            timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            provider: Some(provider),
            model: Some(model),
            connection_id: Some(connection_id),
            api_key: Some(api_key),
            endpoint: Some(endpoint),
            prompt_tokens,
            completion_tokens,
            cost: 0.0, // TODO: calculate cost from pricing
            status: "ok".to_string(),
            tokens: tokens.clone(),
            meta: serde_json::json!({ "requestedModel": requested_model }),
            requested_model,
        };
        usage::save_request_usage(&conn, &entry)?;
        Ok(())
    })
    .await
    .ok();
}

/// Save usage for an error response — so RPM counting still works even when upstream fails.
async fn save_usage_error(
    pool: DbPool,
    api_key: &str,
    endpoint: &str,
    requested_model: &Option<String>,
    error_message: &str,
) {
    let pool = pool.clone();
    let api_key = api_key.to_string();
    let endpoint = endpoint.to_string();
    let requested_model = requested_model.clone();
    let error_message = error_message[..error_message.len().min(500)].to_string();

    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool.get()?;
        let entry = usage::UsageEntry {
            timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            provider: None,
            model: None,
            connection_id: None,
            api_key: Some(api_key),
            endpoint: Some(endpoint),
            prompt_tokens: 0,
            completion_tokens: 0,
            cost: 0.0,
            status: format!("error: {}", error_message),
            tokens: serde_json::json!({}),
            meta: serde_json::json!({ "requestedModel": requested_model }),
            requested_model,
        };
        usage::save_request_usage(&conn, &entry)?;
        Ok(())
    })
    .await
    .ok();
}

/// Save request detail asynchronously
async fn save_detail_async(
    pool: DbPool,
    provider: Option<&str>,
    model: &str,
    requested_model: &Option<String>,
    connection_id: Option<&str>,
    api_key: &str,
    status: &str,
    request_body: &serde_json::Value,
    request_headers: Option<&HeaderMap>,
) {
    let pool = pool.clone();

    // Build the request object including headers (sanitized in flush)
    let request_with_headers = if let Some(hdrs) = request_headers {
        let mut req_obj = if let Some(obj) = request_body.as_object() {
            obj.clone()
        } else {
            serde_json::Map::new()
        };
        let headers_json: serde_json::Map<String, serde_json::Value> = hdrs.iter()
            .filter_map(|(k, v)| {
                v.to_str().ok().map(|s| (k.as_str().to_string(), serde_json::json!(s)))
            })
            .collect();
        req_obj.insert("headers".to_string(), serde_json::Value::Object(headers_json));
        serde_json::Value::Object(req_obj)
    } else {
        request_body.clone()
    };

    let detail = request_details::DetailItem::build(
        provider.map(|s| s.to_string()),
        Some(model.to_string()),
        requested_model.clone(),
        connection_id.map(|s| s.to_string()),
        Some(api_key.to_string()),
        Some(status.to_string()),
        serde_json::Value::Null,
        serde_json::Value::Null,
        request_with_headers,
        serde_json::json!({}), // provider_request — not tracked separately for now
        serde_json::json!({}), // provider_response
        serde_json::json!({}), // response
    );

    request_details::save_request_detail(pool, detail).await;
}

/// Helper: build an error JSON response
fn error_response(status: StatusCode, message: &str) -> Response {
    (
        status,
        axum::Json(serde_json::json!({
            "error": {
                "message": message,
                "type": "invalid_request_error",
            }
        })),
    )
        .into_response()
}

// Re-export Bytes type
use axum::body::Bytes;
