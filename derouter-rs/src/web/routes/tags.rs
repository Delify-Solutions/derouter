//! Tags route — returns ollama models list.
//! GET /api/tags — {models:[...]} from OLLAMA_MODELS static const.

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::db::DbPool;
use crate::auth;
use crate::providers::ollama_models::OLLAMA_MODELS;

/// GET /api/tags — return ollama models list (behind auth).
pub async fn tags(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    Json(serde_json::json!({"models": OLLAMA_MODELS})).into_response()
}
