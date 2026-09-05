//! Proxy audio — /v1/audio/speech (TTS) + /v1/audio/transcriptions (STT). Phase 1.
//! Port of src/sse/handlers/tts.js + stt.js.

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::db::DbPool;
use crate::proxy::chat;
use crate::proxy::executors::base;
use crate::db::repos::connections::ConnectionFilter;

/// POST /v1/audio/speech — TTS
pub async fn handle_tts(pool: DbPool, body: axum::body::Bytes, headers: HeaderMap) -> Response {
    let _api_key = match chat::extract_api_key(&headers) {
        Some(k) => k,
        None => return error_resp(StatusCode::UNAUTHORIZED, "Missing API key"),
    };

    let body_json: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return error_resp(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };

    let model_str = body_json.get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("tts-1")
        .to_string();

    let (provider, model_id) = if model_str.contains('/') {
        let parts: Vec<&str> = model_str.splitn(2, '/').collect();
        (parts[0].to_string(), parts[1].to_string())
    } else {
        ("openai".to_string(), model_str.clone())
    };

    let pool_clone = pool.clone();
    let provider_for_error = provider.clone();
    let connections_list = match tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let conn = pool_clone.get()?;
        crate::db::repos::connections::get_provider_connections(&conn, &ConnectionFilter {
            provider: Some(provider),
            is_active: Some(true),
        })
    })
    .await
    {
        Ok(Ok(conns)) => conns,
        _ => return error_resp(StatusCode::INTERNAL_SERVER_ERROR, "Database error"),
    };

    if connections_list.is_empty() {
        return error_resp(StatusCode::SERVICE_UNAVAILABLE, &format!("No connections for provider '{}'", provider_for_error));
    }

    for conn in &connections_list {
        let executor = base::select_executor(&conn.provider);
        let mut body = body_json.clone();
        if let Some(obj) = body.as_object_mut() {
            obj.insert("model".to_string(), json!(model_id));
        }

        match executor.complete(conn, body, headers.clone()).await {
            Ok(base::UpstreamResponse::Json { body: bytes, .. }) => {
                return Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "audio/mpeg")
                    .body(axum::body::Body::from(bytes))
                    .unwrap();
            }
            Ok(base::UpstreamResponse::Error { status, message }) => {
                tracing::warn!("TTS error via {}: {} - {}", conn.id, status, message);
                continue;
            }
            _ => continue,
        }
    }

    error_resp(StatusCode::SERVICE_UNAVAILABLE, "All providers failed for TTS")
}

/// POST /v1/audio/transcriptions — STT
pub async fn handle_stt(pool: DbPool, body: axum::body::Bytes, headers: HeaderMap) -> Response {
    let _api_key = match chat::extract_api_key(&headers) {
        Some(k) => k,
        None => return error_resp(StatusCode::UNAUTHORIZED, "Missing API key"),
    };

    // STT uses multipart form data, not JSON
    // For now, pass through to the upstream as-is
    let pool_clone = pool.clone();
    let connections_list = match tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let conn = pool_clone.get()?;
        crate::db::repos::connections::get_provider_connections(&conn, &ConnectionFilter {
            provider: Some("openai".to_string()),
            is_active: Some(true),
        })
    })
    .await
    {
        Ok(Ok(conns)) => conns,
        _ => return error_resp(StatusCode::INTERNAL_SERVER_ERROR, "Database error"),
    };

    if connections_list.is_empty() {
        return error_resp(StatusCode::SERVICE_UNAVAILABLE, "No connections for audio transcription");
    }

    // STT requires multipart handling — pass through the raw body
    for conn in &connections_list {
        let base_url = base::get_base_url(&conn.data, "https://api.openai.com");
        let api_key = base::get_connection_auth(&conn.data);
        let url = format!("{}/v1/audio/transcriptions", base_url.trim_end_matches('/'));

        let client = base::build_client();
        let mut req = client.post(&url);
        if let Some(key) = &api_key {
            req = req.header("Authorization", format!("Bearer {}", key));
        }

        // Copy content type from client request (multipart boundary)
        if let Some(ct) = headers.get("content-type") {
            req = req.header("Content-Type", ct);
        }

        let resp = match req.body(body.clone()).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("STT error via {}: {}", conn.id, e);
                continue;
            }
        };

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            tracing::warn!("STT error via {}: {} - {}", conn.id, status, text);
            continue;
        }

        let bytes = resp.bytes().await.unwrap_or_default();
        return Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "application/json")
            .body(axum::body::Body::from(bytes))
            .unwrap();
    }

    error_resp(StatusCode::SERVICE_UNAVAILABLE, "All providers failed for STT")
}

fn error_resp(status: StatusCode, message: &str) -> Response {
    (status, axum::Json(json!({
        "error": { "message": message, "type": "invalid_request_error" }
    }))).into_response()
}
