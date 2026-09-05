//! CLI tools routes — JSON API for reading/writing per-tool settings.
//! Ported from src/app/api/cli-tools/ — now writes REAL on-disk configs.
//!
//! GET  /api/cli-tools/all-statuses — aggregate all tool statuses in one round-trip.
//! GET  /api/cli-tools/{tool} — read settings for a specific tool.
//! POST /api/cli-tools/{tool} — write settings for a specific tool.
//! DELETE /api/cli-tools/{tool} — reset settings for a specific tool.

pub mod common;
pub mod codex;
pub mod claude;
pub mod cowork;
pub mod cowork_mcp;
pub mod antigravity;
pub mod copilot;
pub mod cline;
pub mod opencode;
pub mod jcode;
pub mod kilo;
pub mod deepseek_tui;
pub mod droid;
pub mod openclaw;
pub mod hermes;
pub mod grok_build;
pub mod devin;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use std::collections::HashMap;

use crate::auth;
use crate::db::DbPool;

/// Known CLI tool names (matches the Node all-statuses STATUS_GETTERS map).
const KNOWN_TOOLS: &[&str] = &[
    "claude",
    "codex",
    "opencode",
    "droid",
    "openclaw",
    "hermes",
    "cowork",
    "copilot",
    "cline",
    "kilo",
    "deepseek-tui",
    "jcode",
    "grok-build",
    "devin",
];

/// GET /api/cli-tools/all-statuses — aggregate all tool statuses by calling each tool's get().
pub async fn all_statuses(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let mut statuses = serde_json::Map::new();

    for tool in KNOWN_TOOLS {
        let result = dispatch_get(tool).await;
        let json: serde_json::Value = match result {
            Ok(j) => j,
            Err(e) => serde_json::json!({"error": e}),
        };
        statuses.insert(tool.to_string(), json);
    }

    Json(serde_json::Value::Object(statuses)).into_response()
}

/// GET /api/cli-tools/{tool} — read settings for a specific tool.
pub async fn get_tool(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(tool): Path<String>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    if !KNOWN_TOOLS.contains(&tool.as_str()) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("Unknown tool: {}", tool)})),
        )
            .into_response();
    }

    match dispatch_get(&tool).await {
        Ok(json) => Json(json).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

/// POST /api/cli-tools/{tool} — write settings for a specific tool.
pub async fn set_tool(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(tool): Path<String>,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    if !KNOWN_TOOLS.contains(&tool.as_str()) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("Unknown tool: {}", tool)})),
        )
            .into_response();
    }

    match dispatch_post(&tool, body).await {
        Ok(json) => Json(json).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

/// DELETE /api/cli-tools/{tool} — reset settings for a specific tool.
/// Supports optional `?model=<name>` query param for opencode per-model removal.
pub async fn delete_tool(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(tool): Path<String>,
    query: Query<HashMap<String, String>>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    if !KNOWN_TOOLS.contains(&tool.as_str()) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("Unknown tool: {}", tool)})),
        )
            .into_response();
    }

    let model_param = query.get("model").cloned();

    match dispatch_delete(&tool, model_param).await {
        Ok(json) => Json(json).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

/// PATCH /api/cli-tools/{tool} — partial update (e.g., opencode clearActiveModel).
pub async fn patch_tool(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(tool): Path<String>,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    if !KNOWN_TOOLS.contains(&tool.as_str()) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("Unknown tool: {}", tool)})),
        )
            .into_response();
    }

    match dispatch_patch(&tool, body).await {
        Ok(json) => Json(json).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

// ===== Dispatcher =====

async fn dispatch_get(tool: &str) -> Result<serde_json::Value, String> {
    // Mask API keys in GET responses before returning.
    let response = match tool {
        "codex" => codex::get().await,
        "claude" => claude::get().await,
        "cowork" => cowork::get().await,
        "copilot" => copilot::get().await,
        "cline" => cline::get().await,
        "opencode" => opencode::get().await,
        "jcode" => jcode::get().await,
        "kilo" => kilo::get().await,
        "deepseek-tui" => deepseek_tui::get().await,
        "droid" => droid::get().await,
        "openclaw" => openclaw::get().await,
        "hermes" => hermes::get().await,
        "grok-build" => grok_build::get().await,
        "devin" => devin::get().await,
        _ => return Err(format!("Unknown tool: {}", tool)),
    };

    // Extract JSON from response and apply key masking
    let json = extract_json_response(response).await;
    Ok(common::mask_api_keys(json))
}

async fn dispatch_post(tool: &str, body: Json<serde_json::Value>) -> Result<serde_json::Value, String> {
    let response = match tool {
        "codex" => codex::post(body).await,
        "claude" => claude::post(body).await,
        "cowork" => cowork::post(body).await,
        "copilot" => copilot::post(body).await,
        "cline" => cline::post(body).await,
        "opencode" => opencode::post(body).await,
        "jcode" => jcode::post(body).await,
        "kilo" => kilo::post(body).await,
        "deepseek-tui" => deepseek_tui::post(body).await,
        "droid" => droid::post(body).await,
        "openclaw" => openclaw::post(body).await,
        "hermes" => hermes::post(body).await,
        "grok-build" => grok_build::post(body).await,
        // devin has no POST (install detection only)
        _ => return Err(format!("Unknown tool: {}", tool)),
    };

    Ok(extract_json_response(response).await)
}

async fn dispatch_delete(tool: &str, model_param: Option<String>) -> Result<serde_json::Value, String> {
    let response = match tool {
        "codex" => codex::delete().await,
        "claude" => claude::delete().await,
        "cowork" => cowork::delete().await,
        "copilot" => copilot::delete().await,
        "cline" => cline::delete().await,
        "opencode" => {
            if model_param.is_some() {
                opencode::delete_with_model(model_param).await
            } else {
                opencode::delete().await
            }
        }
        "jcode" => jcode::delete().await,
        "kilo" => kilo::delete().await,
        "deepseek-tui" => deepseek_tui::delete().await,
        "droid" => droid::delete().await,
        "openclaw" => openclaw::delete().await,
        "hermes" => hermes::delete().await,
        "grok-build" => grok_build::delete().await,
        // devin has no DELETE (install detection only)
        _ => return Err(format!("Unknown tool: {}", tool)),
    };

    Ok(extract_json_response(response).await)
}

async fn dispatch_patch(tool: &str, body: Json<serde_json::Value>) -> Result<serde_json::Value, String> {
    let response = match tool {
        "opencode" => opencode::patch(body).await,
        // Other tools don't support PATCH yet
        _ => return Err(format!("PATCH not supported for tool: {}", tool)),
    };

    Ok(extract_json_response(response).await)
}

/// Extract the JSON body from an Axum Response, or return a fallback error JSON.
async fn extract_json_response(response: Response) -> serde_json::Value {
    // Try to extract the JSON body from the response
    let (parts, body) = response.into_parts();
    let bytes = match axum::body::to_bytes(body, 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return serde_json::json!({"error": "Failed to read response body"}),
    };
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        // If we can't parse, check the status code
        let status = parts.status;
        if status == StatusCode::UNAUTHORIZED {
            serde_json::json!({"error": "Unauthorized"})
        } else if status.is_client_error() {
            serde_json::json!({"error": format!("HTTP {}", status.as_u16())})
        } else if status.is_server_error() {
            serde_json::json!({"error": format!("HTTP {}", status.as_u16())})
        } else {
            serde_json::json!({})
        }
    });
    json
}
