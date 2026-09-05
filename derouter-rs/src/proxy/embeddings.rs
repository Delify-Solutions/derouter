//! Proxy embeddings — /v1/embeddings. Phase 1.
//! Port of src/sse/handlers/embeddings.js.

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::db::DbPool;
use crate::proxy::chat;
use crate::proxy::executors::base;
use crate::db::repos::connections::ConnectionFilter;

pub async fn handle_embeddings(pool: DbPool, body: axum::body::Bytes, headers: HeaderMap) -> Response {
    let api_key = match chat::extract_api_key(&headers) {
        Some(k) => k,
        None => return error_resp(StatusCode::UNAUTHORIZED, "Missing API key"),
    };

    let body_json: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return error_resp(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };

    let model_str = body_json.get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if model_str.is_empty() {
        return error_resp(StatusCode::BAD_REQUEST, "Missing 'model' field");
    }

    // Parse provider/model
    let (provider, model_id) = if model_str.contains('/') {
        let parts: Vec<&str> = model_str.splitn(2, '/').collect();
        (parts[0].to_string(), parts[1].to_string())
    } else {
        ("openai".to_string(), model_str.clone())
    };

    // Get active connections
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

    // Try each connection
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
                    .header("Content-Type", "application/json")
                    .body(axum::body::Body::from(bytes))
                    .unwrap();
            }
            Ok(base::UpstreamResponse::Error { status, message }) => {
                tracing::warn!("Embedding error via {}: {} - {}", conn.id, status, message);
                continue;
            }
            _ => continue,
        }
    }

    error_resp(StatusCode::SERVICE_UNAVAILABLE, "All providers failed for embeddings")
}

fn error_resp(status: StatusCode, message: &str) -> Response {
    (status, axum::Json(json!({
        "error": { "message": message, "type": "invalid_request_error" }
    }))).into_response()
}
