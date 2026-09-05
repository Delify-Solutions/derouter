//! Locale route — JSON API.
//! GET /api/locale — return supported locales and current locale.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::db::DbPool;
use crate::auth;

/// GET /api/locale — return locale info.
pub async fn locale(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Phase 2: return static locale list. Phase 3 can add dynamic locale support.
    Json(serde_json::json!({
        "locales": ["en"],
        "current": "en",
    })).into_response()
}

/// POST /api/locale — set locale (sets a cookie, Phase 2 stub).
pub async fn set_locale(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: axum::Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let locale = body.0.get("locale").and_then(|v| v.as_str()).unwrap_or("en");
    if locale.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid locale"}))).into_response();
    }

    Json(serde_json::json!({"success": true, "locale": locale})).into_response()
}
