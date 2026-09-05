//! Proxy search — /v1/search. Phase 1.

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::db::DbPool;
use crate::proxy::chat;
use crate::proxy::executors::base;
use crate::db::repos::connections::ConnectionFilter;

pub async fn handle_search(pool: DbPool, body: axum::body::Bytes, headers: HeaderMap) -> Response {
    let _api_key = match chat::extract_api_key(&headers) {
        Some(k) => k,
        None => return error_resp(StatusCode::UNAUTHORIZED, "Missing API key"),
    };

    let body_json: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return error_resp(StatusCode::BAD_REQUEST, "Invalid JSON body"),
    };

    // Search providers — try ollama-search, then others with searchConfig
    let pool_clone = pool.clone();
    let connections_list = match tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let conn = pool_clone.get()?;
        // Get all active connections, filter for search-capable ones
        crate::db::repos::connections::get_provider_connections(&conn, &ConnectionFilter {
            provider: None,
            is_active: Some(true),
        })
    })
    .await
    {
        Ok(Ok(conns)) => conns,
        _ => return error_resp(StatusCode::INTERNAL_SERVER_ERROR, "Database error"),
    };

    // Find a search-capable provider
    let search_conns: Vec<_> = connections_list.iter().filter(|c| {
        let p = c.provider.to_lowercase();
        p.contains("search") || p == "ollama" || p == "google" || p == "gemini"
    }).collect();

    if search_conns.is_empty() {
        return error_resp(StatusCode::SERVICE_UNAVAILABLE, "No search-capable providers available");
    }

    for conn in search_conns {
        let executor = base::select_executor(&conn.provider);
        match executor.complete(conn, body_json.clone(), headers.clone()).await {
            Ok(base::UpstreamResponse::Json { body: bytes, .. }) => {
                return Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "application/json")
                    .body(axum::body::Body::from(bytes))
                    .unwrap();
            }
            Ok(base::UpstreamResponse::Error { status, message }) => {
                tracing::warn!("Search error via {}: {} - {}", conn.id, status, message);
                continue;
            }
            _ => continue,
        }
    }

    error_resp(StatusCode::SERVICE_UNAVAILABLE, "All providers failed for search")
}

fn error_resp(status: StatusCode, message: &str) -> Response {
    (status, axum::Json(json!({
        "error": { "message": message, "type": "invalid_request_error" }
    }))).into_response()
}
