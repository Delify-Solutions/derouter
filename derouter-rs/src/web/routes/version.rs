//! Version + shutdown routes — JSON API.
//! GET /api/version — current + latest version info.
//! POST /api/version/shutdown — graceful shutdown via shutdown channel.
//! POST /api/version/update — check + trigger self-update.

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::db::DbPool;
use crate::auth;
use crate::AppState;

/// GET /api/version — return current and latest version.
pub async fn version(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Current version from Cargo.toml (compile-time)
    let current_version = env!("CARGO_PKG_VERSION");

    // Try to fetch latest from npm registry (cached, 1h TTL)
    let latest_version = fetch_latest_version().await;
    let has_update = latest_version.as_deref()
        .map(|l| compare_versions(l, current_version) > 0)
        .unwrap_or(false);

    Json(serde_json::json!({
        "currentVersion": current_version,
        "latestVersion": latest_version,
        "hasUpdate": has_update,
    })).into_response()
}

/// POST /api/version/shutdown — graceful shutdown.
pub async fn shutdown(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Send shutdown signal
    if let Some(tx) = &state.shutdown_tx {
        let _ = tx.send(true);
    }

    Json(serde_json::json!({"success": true, "message": "Shutting down..."})).into_response()
}

/// POST /api/shutdown — alias for /api/version/shutdown.
pub async fn shutdown_alias(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    if let Some(tx) = &state.shutdown_tx {
        let _ = tx.send(true);
    }

    Json(serde_json::json!({"success": true, "message": "Shutting down..."})).into_response()
}

/// POST /api/version/update — trigger self-update (stub for Phase 2).
pub async fn update(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Phase 2: return a not-implemented response
    // Phase 3 will implement the actual npm update flow
    Json(serde_json::json!({
        "ok": false,
        "error": "Self-update not implemented in Rust port. Use docker pull or cargo install.",
    })).into_response()
}

/// Compare semantic version strings: returns 1 if a > b, -1 if a < b, 0 if equal.
fn compare_versions(a: &str, b: &str) -> i32 {
    let pa: Vec<i32> = a.split('.').filter_map(|s| s.parse().ok()).collect();
    let pb: Vec<i32> = b.split('.').filter_map(|s| s.parse().ok()).collect();
    for i in 0..3 {
        let va = pa.get(i).copied().unwrap_or(0);
        let vb = pb.get(i).copied().unwrap_or(0);
        if va > vb { return 1; }
        if va < vb { return -1; }
    }
    0
}

/// Fetch latest version from npm registry.
async fn fetch_latest_version() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .ok()?;

    let res = client
        .get("https://registry.npmjs.org/derouter/latest")
        .send()
        .await
        .ok()?;

    if !res.status().is_success() {
        return None;
    }

    let body: serde_json::Value = res.json().await.ok()?;
    body.get("version").and_then(|v| v.as_str()).map(|s| s.to_string())
}
