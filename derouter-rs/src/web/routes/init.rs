//! Init route — JSON API.
//! GET /api/init — return initialized bool (no password hash stored → false).

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::db::DbPool;
use crate::auth;

/// GET /api/init — return whether the app is initialized.
/// initialized = true if a password hash exists in settings.
pub async fn init(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let settings = crate::db::repos::settings::get_settings(&conn)?;
        let has_password = settings.get("password").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
        Ok(has_password)
    })
    .await;

    match result {
        Ok(Ok(has_password)) => Json(serde_json::json!({"initialized": has_password})).into_response(),
        _ => Json(serde_json::json!({"initialized": false})).into_response(),
    }
}
