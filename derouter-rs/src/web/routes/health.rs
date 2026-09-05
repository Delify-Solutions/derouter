//! Health check route — PUBLIC (no auth).
//! GET /api/health — 200 {ok:true, db:"ok", version, uptimeSeconds} or 503 on DB failure.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::db::DbPool;

/// GET /api/health — public health check (no auth required).
pub async fn health(
    State(pool): State<DbPool>,
) -> Response {
    // Test DB connection
    let pool_c = pool.clone();
    let db_ok = tokio::task::spawn_blocking(move || -> bool {
        match pool_c.get() {
            Ok(conn) => {
                // Simple query to verify DB is responsive
                conn.execute_batch("SELECT 1").is_ok()
            }
            Err(_) => false,
        }
    })
    .await
    .unwrap_or(false);

    let version = env!("CARGO_PKG_VERSION");
    let uptime = crate::APP_START.elapsed().as_secs();

    if db_ok {
        Json(serde_json::json!({
            "ok": true,
            "db": "ok",
            "version": version,
            "uptimeSeconds": uptime,
        })).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "ok": false,
                "db": "error",
                "version": version,
                "uptimeSeconds": uptime,
            })),
        ).into_response()
    }
}
