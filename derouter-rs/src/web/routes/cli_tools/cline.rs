//! Cline settings — reads/writes `~/.cline/data/globalState.json` and `secrets.json`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

fn data_dir() -> std::path::PathBuf {
    common::home_dir().join(".cline").join("data")
}

fn global_state_path() -> std::path::PathBuf {
    data_dir().join("globalState.json")
}

fn secrets_path() -> std::path::PathBuf {
    data_dir().join("secrets.json")
}

async fn check_installed() -> bool {
    common::check_installed("cline", &[global_state_path()]).await
}

fn has_derouter(global_state: &serde_json::Value) -> bool {
    let is_openai = global_state
        .get("actModeApiProvider")
        .and_then(|v| v.as_str())
        .map(|s| s == "openai")
        .unwrap_or(false)
        || global_state
            .get("planModeApiProvider")
            .and_then(|v| v.as_str())
            .map(|s| s == "openai")
            .unwrap_or(false);
    let base_url = global_state.get("openAiBaseUrl").and_then(|v| v.as_str()).unwrap_or("");
    is_openai && common::is_localhost_url(base_url)
}

/// GET — read globalState.json, report derouter status.
pub async fn get() -> Response {
    let installed = check_installed().await;
    if !installed {
        return Json(serde_json::json!({
            "installed": false,
            "settings": null,
            "message": "Cline CLI is not installed",
        }))
        .into_response();
    }

    let global_state = common::read_json_file(&global_state_path()).await;

    let response = serde_json::json!({
        "installed": true,
        "settings": {
            "actModeApiProvider": global_state.as_ref().and_then(|g| g.get("actModeApiProvider")).cloned(),
            "planModeApiProvider": global_state.as_ref().and_then(|g| g.get("planModeApiProvider")).cloned(),
            "openAiBaseUrl": global_state.as_ref().and_then(|g| g.get("openAiBaseUrl")).cloned(),
            "openAiModelId": global_state.as_ref().and_then(|g| g.get("openAiModelId")).cloned(),
        },
        "hasderouter": global_state.as_ref().map(has_derouter).unwrap_or(false),
        "globalStatePath": global_state_path().to_string_lossy(),
    });

    Json(response).into_response()
}

/// POST — write derouter settings to globalState.json + secrets.json.
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

    // Cline expects base WITHOUT /v1
    let normalized_base_url = common::strip_v1(base_url);

    // Update globalState.json
    let mut global_state = common::read_json_file(&global_state_path()).await.unwrap_or(serde_json::json!({}));
    if !global_state.is_object() {
        global_state = serde_json::json!({});
    }
    let obj = global_state.as_object_mut().unwrap();
    obj.insert("actModeApiProvider".to_string(), serde_json::json!("openai"));
    obj.insert("planModeApiProvider".to_string(), serde_json::json!("openai"));
    obj.insert("openAiBaseUrl".to_string(), serde_json::json!(normalized_base_url));
    obj.insert("openAiModelId".to_string(), serde_json::json!(model));
    obj.insert("planModeOpenAiModelId".to_string(), serde_json::json!(model));

    if let Err(e) = common::write_json_file(&global_state_path(), &global_state).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to update cline settings: {}", e)})),
        )
            .into_response();
    }

    // Update secrets.json
    let mut secrets = common::read_json_file(&secrets_path()).await.unwrap_or(serde_json::json!({}));
    if !secrets.is_object() {
        secrets = serde_json::json!({});
    }
    secrets.as_object_mut().unwrap().insert("openAiApiKey".to_string(), serde_json::json!(api_key));
    if let Err(e) = common::write_json_file(&secrets_path(), &secrets).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to write secrets: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "Cline settings applied successfully!",
        "globalStatePath": global_state_path().to_string_lossy(),
    }))
    .into_response()
}

/// DELETE — remove derouter settings from globalState.json + secrets.json.
pub async fn delete() -> Response {
    let global_state = match common::read_json_file(&global_state_path()).await {
        Some(s) => s,
        None => {
            return Json(serde_json::json!({
                "success": true,
                "message": "No settings file to reset",
            }))
            .into_response();
        }
    };

    let mut global_state = global_state;
    if let Some(obj) = global_state.as_object_mut() {
        if obj.get("actModeApiProvider").and_then(|v| v.as_str()) == Some("openai") {
            obj.remove("openAiBaseUrl");
            obj.remove("openAiModelId");
            obj.remove("planModeOpenAiModelId");
            obj.insert("actModeApiProvider".to_string(), serde_json::json!("cline"));
            obj.insert("planModeApiProvider".to_string(), serde_json::json!("cline"));
        }
    }

    if let Err(e) = common::write_json_file(&global_state_path(), &global_state).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to reset cline settings: {}", e)})),
        )
            .into_response();
    }

    // Remove openAiApiKey from secrets
    let mut secrets = common::read_json_file(&secrets_path()).await.unwrap_or(serde_json::json!({}));
    if let Some(obj) = secrets.as_object_mut() {
        obj.remove("openAiApiKey");
    }
    let _ = common::write_json_file(&secrets_path(), &secrets).await;

    Json(serde_json::json!({
        "success": true,
        "message": "derouter settings removed from Cline",
    }))
    .into_response()
}
