//! Kilo Code settings — reads/writes `~/.local/share/kilo/auth.json` and VS Code settings.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

fn data_dir() -> std::path::PathBuf {
    common::home_dir().join(".local").join("share").join("kilo")
}

fn auth_path() -> std::path::PathBuf {
    data_dir().join("auth.json")
}

fn vscode_settings_path() -> std::path::PathBuf {
    common::home_dir().join(".config").join("Code").join("User").join("settings.json")
}

async fn check_installed() -> bool {
    common::check_installed("kilo", &[auth_path()]).await
}

fn has_derouter(auth: &serde_json::Value) -> bool {
    let entry = auth.get("openai-compatible").or_else(|| auth.get("derouter"));
    let base_url = entry
        .and_then(|e| {
            e.get("baseUrl")
                .or_else(|| e.get("baseURL"))
        })
        .and_then(|u| u.as_str())
        .unwrap_or("");
    common::is_localhost_url(base_url)
}

/// GET — read auth.json, report derouter status.
pub async fn get() -> Response {
    let installed = check_installed().await;
    if !installed {
        return Json(serde_json::json!({
            "installed": false,
            "settings": null,
            "message": "Kilo Code CLI is not installed",
        }))
        .into_response();
    }

    let auth = common::read_json_file(&auth_path()).await;
    let auth_keys: Vec<String> = auth
        .as_ref()
        .and_then(|a| a.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();

    Json(serde_json::json!({
        "installed": true,
        "settings": { "auth": auth_keys },
        "hasderouter": auth.as_ref().map(has_derouter).unwrap_or(false),
        "authPath": auth_path().to_string_lossy(),
    }))
    .into_response()
}

/// POST — write derouter settings to auth.json + VS Code settings.
pub async fn post(body: Json<serde_json::Value>) -> Response {
    let body = body.0;
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("");

    if base_url.is_empty() || api_key.is_empty() || model.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "baseUrl, apiKey and model are required"})),
        )
            .into_response();
    }

    let normalized_base_url = common::normalize_v1(base_url);

    // Update auth.json
    let mut auth = common::read_json_file(&auth_path()).await.unwrap_or(serde_json::json!({}));
    if !auth.is_object() {
        auth = serde_json::json!({});
    }
    auth.as_object_mut().unwrap().insert(
        "openai-compatible".to_string(),
        serde_json::json!({
            "type": "api-key",
            "apiKey": api_key,
            "baseUrl": normalized_base_url,
            "model": model,
        }),
    );

    if let Err(e) = common::write_json_file(&auth_path(), &auth).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to update kilo settings: {}", e)})),
        )
            .into_response();
    }

    // Best-effort: update VS Code extension settings
    let mut vscode = common::read_json_file(&vscode_settings_path()).await.unwrap_or(serde_json::json!({}));
    if !vscode.is_object() {
        vscode = serde_json::json!({});
    }
    let vscode_obj = vscode.as_object_mut().unwrap();
    vscode_obj.insert(
        "kilocode.customProvider".to_string(),
        serde_json::json!({
            "name": "derouter",
            "baseURL": normalized_base_url,
            "apiKey": api_key,
        }),
    );
    vscode_obj.insert("kilocode.defaultModel".to_string(), serde_json::json!(model));
    let _ = common::write_json_file(&vscode_settings_path(), &vscode).await;

    Json(serde_json::json!({
        "success": true,
        "message": "Kilo Code settings applied successfully!",
        "authPath": auth_path().to_string_lossy(),
    }))
    .into_response()
}

/// DELETE — remove derouter from auth.json + VS Code settings.
pub async fn delete() -> Response {
    let auth = match common::read_json_file(&auth_path()).await {
        Some(a) => a,
        None => {
            return Json(serde_json::json!({
                "success": true,
                "message": "No settings file to reset",
            }))
            .into_response();
        }
    };

    let mut auth = auth;
    if let Some(obj) = auth.as_object_mut() {
        obj.remove("openai-compatible");
        obj.remove("derouter");
    }

    if let Err(e) = common::write_json_file(&auth_path(), &auth).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to reset kilo settings: {}", e)})),
        )
            .into_response();
    }

    // Remove from VS Code settings
    if let Some(vscode) = common::read_json_file(&vscode_settings_path()).await {
        let mut vscode = vscode;
        if let Some(obj) = vscode.as_object_mut() {
            obj.remove("kilocode.customProvider");
            obj.remove("kilocode.defaultModel");
            let _ = common::write_json_file(&vscode_settings_path(), &vscode).await;
        }
    }

    Json(serde_json::json!({
        "success": true,
        "message": "derouter settings removed from Kilo Code",
    }))
    .into_response()
}
