//! PXPIPE routes — JSON API for process management.
//! Ported from src/app/api/pxpipe/{status,start,stop,restart,proxy,extras}/route.js.
//!
//! GET  /api/pxpipe/status — pxpipe status + settings flags.
//! POST /api/pxpipe/start — warm/launch the pxpipe module.
//! POST /api/pxpipe/stop — stop the pxpipe module.
//! POST /api/pxpipe/restart — reload the pxpipe module.
//! GET  /api/pxpipe/logs — recent events + install log tail.
//! POST /api/pxpipe/health — run health check (GET mirrors POST).

use std::collections::VecDeque;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use axum::Json;
use tokio::sync::Mutex;
use tokio::process::Child;

use crate::auth;
use crate::db::DbPool;
use crate::db::repos::settings;

/// In-process pxpipe state (library mode — not a separate process in Rust).
/// In Node, pxpipe is loaded as an in-process module transform.
/// In Rust, we track a loaded flag + any spawned child process.
struct PxpipeState {
    loaded: bool,
    child: Option<Child>,
    events: VecDeque<serde_json::Value>,
    install_log: VecDeque<String>,
}

static PXPIPE: once_cell::sync::Lazy<Arc<Mutex<PxpipeState>>> =
    once_cell::sync::Lazy::new(|| {
        Arc::new(Mutex::new(PxpipeState {
            loaded: false,
            child: None,
            events: VecDeque::with_capacity(500),
            install_log: VecDeque::with_capacity(200),
        }))
    });

/// GET /api/pxpipe/status — return pxpipe status + settings.
pub async fn status(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Read settings
    let pool_c = pool.clone();
    let settings_result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        settings::get_settings(&conn)
    })
    .await;

    let s = match settings_result {
        Ok(Ok(s)) => s,
        _ => serde_json::json!({}),
    };

    let state = PXPIPE.lock().await;
    let loaded = state.loaded;
    let child_running = state.child.as_ref().map(|c| {
        // Best-effort: try to get the child's PID
        c.id().is_some()
    }).unwrap_or(false);

    Json(serde_json::json!({
        "loaded": loaded,
        "running": child_running,
        "hasChild": state.child.is_some(),
        "enabled": s.get("pxpipeEnabled").and_then(|v| v.as_bool()).unwrap_or(false),
        "autoInstall": s.get("pxpipeAutoInstall").and_then(|v| v.as_bool()).unwrap_or(false),
        "minChars": s.get("pxpipeMinChars"),
        "timeoutMs": s.get("pxpipeTimeoutMs"),
    }))
    .into_response()
}

/// POST /api/pxpipe/start — start pxpipe.
pub async fn start(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // TODO Phase4: full pxpipe module loading (requires the pxpipe npm module or equivalent).
    // For now, we track the loaded state in-process — the transform pipeline can use this flag.
    let mut state = PXPIPE.lock().await;
    state.loaded = true;

    push_event(&mut state, serde_json::json!({
        "type": "start",
        "message": "PXPIPE started (library mode)",
        "timestamp": chrono::Utc::now().to_rfc3339(),
    }));

    Json(serde_json::json!({
        "loaded": true,
        "running": false,
        "hasChild": false,
    }))
    .into_response()
}

/// POST /api/pxpipe/stop — stop pxpipe.
pub async fn stop(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let mut state = PXPIPE.lock().await;
    let was_loaded = state.loaded;

    // Kill child process if any
    if let Some(ref mut child) = state.child {
        let _ = child.kill().await;
    }
    state.child = None;
    state.loaded = false;

    push_event(&mut state, serde_json::json!({
        "type": "stop",
        "message": "PXPIPE stopped",
        "timestamp": chrono::Utc::now().to_rfc3339(),
    }));

    Json(serde_json::json!({
        "stopped": was_loaded,
        "loaded": false,
        "running": false,
        "hasChild": false,
    }))
    .into_response()
}

/// POST /api/pxpipe/restart — restart pxpipe (reload module).
pub async fn restart(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let mut state = PXPIPE.lock().await;

    // Kill any existing child
    if let Some(ref mut child) = state.child {
        let _ = child.kill().await;
    }
    state.child = None;

    // Reload
    state.loaded = true;

    push_event(&mut state, serde_json::json!({
        "type": "restart",
        "message": "PXPIPE restarted",
        "timestamp": chrono::Utc::now().to_rfc3339(),
    }));

    Json(serde_json::json!({
        "loaded": true,
        "running": false,
        "hasChild": false,
    }))
    .into_response()
}

/// GET /api/pxpipe/logs — return recent events + install log tail.
pub async fn logs(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100)
        .min(500);

    let state = PXPIPE.lock().await;
    let events: Vec<serde_json::Value> = state
        .events
        .iter()
        .rev()
        .take(limit)
        .cloned()
        .collect();

    let install_log: Vec<String> = state
        .install_log
        .iter()
        .cloned()
        .collect();

    Json(serde_json::json!({
        "installLog": install_log,
        "events": events,
    }))
    .into_response()
}

/// POST /api/pxpipe/health — run health check (GET mirrors POST).
pub async fn health(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // TODO Phase4: full pxpipe health check calls the pxpipe module's health check function.
    // For now, return a basic healthy status based on loaded state.
    let state = PXPIPE.lock().await;

    Json(serde_json::json!({
        "healthy": state.loaded,
        "checks": [
            {"name": "module_loaded", "ok": state.loaded},
            {"name": "process_running", "ok": state.child.is_some()},
        ],
    }))
    .into_response()
}

/// GET /api/pxpipe/health — mirrors POST (same handler).
pub async fn health_get(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    health(State(pool), headers).await
}

/// GET /api/pxpipe/stats — return pxpipe stats.
pub async fn stats(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let recent_limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100)
        .min(500);

    let state = PXPIPE.lock().await;
    let recent: Vec<serde_json::Value> = state
        .events
        .iter()
        .rev()
        .take(recent_limit)
        .cloned()
        .collect();

    Json(serde_json::json!({
        "totalEvents": state.events.len(),
        "recent": recent,
    }))
    .into_response()
}

/// POST /api/pxpipe/install — install/repair pxpipe.
pub async fn install(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // TODO Phase4: full pxpipe npm install (requires npm/node subprocess).
    // For now, log the attempt and return a basic response.
    tracing::warn!("pxpipe install not yet fully ported (Phase 4) — requires npm subprocess");
    let mut state = PXPIPE.lock().await;
    state.install_log.push_back("PXPIPE install attempted (Phase 4 — npm install not yet ported)".to_string());

    Json(serde_json::json!({
        "installed": false,
        "message": "PXPIPE install not yet ported (Phase 4)",
        "health": {"healthy": false, "checks": [], "error": "Install not ported yet"},
    }))
    .into_response()
}

/// Push an event to the ring buffer.
fn push_event(state: &mut PxpipeState, event: serde_json::Value) {
    if state.events.len() >= 500 {
        state.events.pop_front();
    }
    state.events.push_back(event);
}
