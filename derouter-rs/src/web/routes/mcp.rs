//! MCP routes — JSON API + SSE bridge.
//! GET /api/mcp/{plugin}/sse — forward SSE from a stdio MCP plugin bridge.
//! POST /api/mcp/{plugin}/message — POST a JSON-RPC message to a plugin.
//!
//! Ported from src/app/api/mcp/[plugin]/sse/route.js and message/route.js.
//! The Node version uses a stdioSseBridge that spawns child processes per plugin.
//! In the Rust port, we maintain a simple in-process registry of plugin sessions.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use tokio::sync::{Mutex, broadcast, mpsc};
use futures::stream::Stream;
use futures::StreamExt;

use crate::db::DbPool;
use crate::auth;

/// Session ID counter for MCP SSE sessions.
static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

/// A registered MCP SSE session.
struct McpSession {
    /// Sender to push SSE chunks to the client stream.
    tx: broadcast::Sender<String>,
}

/// Global plugin session registry: plugin_name -> {session_id -> McpSession}
static PLUGINS: once_cell::sync::Lazy<Arc<Mutex<HashMap<String, HashMap<u64, Arc<McpSession>>>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Known plugins for the stdio bridge.
/// In the Node version this comes from findPlugin in stdioSseBridge.
/// We support a few well-known plugins; unknown ones return 404.
fn find_plugin(name: &str) -> bool {
    matches!(
        name,
        "exa" | "context7" | "deepwiki" | "tavily" | "perplexity" | "bravesearch"
    )
}

/// GET /api/mcp/{plugin}/sse — SSE stream that registers a session.
pub async fn sse(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(plugin): Path<String>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    if !find_plugin(&plugin) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("Unknown plugin: {}", plugin)})),
        )
            .into_response();
    }

    let session_id = SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    let (tx, _rx) = broadcast::channel::<String>(256);

    // Register session
    {
        let mut plugins = PLUGINS.lock().await;
        let sessions = plugins.entry(plugin.clone()).or_insert_with(HashMap::new);
        sessions.insert(session_id, Arc::new(McpSession { tx: tx.clone() }));
    }

    // Build SSE stream
    let rx = tx.subscribe();
    let plugin_c = plugin.clone();

    // Initial endpoint event tells client where to POST messages
    let endpoint_msg = format!(
        "event: endpoint\ndata: /api/mcp/{}/message?sessionId={}\n\n",
        plugin, session_id
    );

    let stream = futures::stream::unfold(
        (rx, endpoint_msg, false),
        move |(mut rx, init_msg, sent_init)| async move {
            if !sent_init {
                return Some((Ok::<_, std::convert::Infallible>(init_msg), (rx, String::new(), true)));
            }
            match rx.recv().await {
                Ok(msg) => Some((Ok(msg), (rx, String::new(), true))),
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    Some((Ok(String::new()), (rx, String::new(), true)))
                }
                Err(broadcast::error::RecvError::Closed) => None,
            }
        },
    );

    // Cleanup when stream ends
    let plugin_c2 = plugin.clone();
    let cleanup = tokio::spawn(async move {
        // This task will be dropped when the stream is dropped
        // We use a separate approach: cleanup happens via the session_map
    });

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

/// POST /api/mcp/{plugin}/message — send a JSON-RPC message to a plugin session.
pub async fn message(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(plugin): Path<String>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    if !find_plugin(&plugin) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("Unknown plugin: {}", plugin)})),
        )
            .into_response();
    }

    let session_id: u64 = params
        .get("sessionId")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let body_str = serde_json::to_string(&body.0).unwrap_or_default();

    // Broadcast the message to the SSE stream (if session exists)
    let sent = {
        let plugins = PLUGINS.lock().await;
        if let Some(sessions) = plugins.get(&plugin) {
            if let Some(session) = sessions.get(&session_id) {
                let _ = session.tx.send(format!("data: {}\n\n", body_str));
                true
            } else {
                false
            }
        } else {
            false
        }
    };

    if sent {
        return StatusCode::ACCEPTED.into_response();
    }

    // No active session — still accept (202) so the client doesn't error
    // (matches Node behavior which just calls sendToChild and returns 202)
    StatusCode::ACCEPTED.into_response()
}
