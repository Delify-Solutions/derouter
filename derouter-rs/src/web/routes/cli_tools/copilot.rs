//! Copilot (VS Code) settings — reads/writes `chatLanguageModels.json`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

fn config_path() -> std::path::PathBuf {
    let home = common::home_dir();
    if std::env::consts::OS == "windows" {
        let appdata = std::env::var("APPDATA").map(std::path::PathBuf::from).unwrap_or(home.clone());
        appdata.join("Code").join("User").join("chatLanguageModels.json")
    } else if std::env::consts::OS == "macos" {
        home.join("Library").join("Application Support").join("Code").join("User").join("chatLanguageModels.json")
    } else {
        home.join(".config").join("Code").join("User").join("chatLanguageModels.json")
    }
}

/// GET — read chatLanguageModels.json, report derouter entry.
pub async fn get() -> Response {
    let config = common::read_json_file(&config_path()).await;
    let entry = config.as_ref().and_then(|c| c.as_array()).and_then(|arr| {
        arr.iter().find(|e| e.get("name").and_then(|n| n.as_str()) == Some("derouter"))
    });

    let hasderouter = entry.is_some();
    let current_model = entry
        .and_then(|e| e.get("models"))
        .and_then(|m| m.as_array())
        .and_then(|arr| arr.first())
        .and_then(|m| m.get("id"))
        .and_then(|id| id.as_str())
        .map(|s| s.to_string());
    let current_url = entry
        .and_then(|e| e.get("models"))
        .and_then(|m| m.as_array())
        .and_then(|arr| arr.first())
        .and_then(|m| m.get("url"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string());

    Json(serde_json::json!({
        "installed": true,
        "config": config,
        "hasderouter": hasderouter,
        "configPath": config_path().to_string_lossy(),
        "currentModel": current_model,
        "currentUrl": current_url,
    }))
    .into_response()
}

/// POST — apply derouter entry to chatLanguageModels.json (replace existing or append).
pub async fn post(body: Json<serde_json::Value>) -> Response {
    let body = body.0;
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let models = body.get("models").and_then(|v| v.as_array());

    if base_url.is_empty() || models.map(|m| m.is_empty()).unwrap_or(true) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "baseUrl and models are required"})),
        )
            .into_response();
    }

    let path = config_path();

    // Read existing config array
    let mut config: Vec<serde_json::Value> = common::read_json_file(&path)
        .await
        .and_then(|c| c.as_array().cloned())
        .unwrap_or_default();

    let endpoint_url = format!("{}/chat/completions#models.ai.azure.com", base_url);
    let key_to_use = if api_key.is_empty() { "sk_derouter" } else { api_key };

    let model_entries: Vec<serde_json::Value> = models
        .unwrap()
        .iter()
        .filter_map(|m| m.as_str())
        .map(|id| {
            serde_json::json!({
                "id": id,
                "name": id,
                "url": endpoint_url,
                "toolCalling": true,
                "vision": false,
                "maxInputTokens": 128000,
                "maxOutputTokens": 16000,
            })
        })
        .collect();

    let new_entry = serde_json::json!({
        "name": "derouter",
        "vendor": "azure",
        "apiKey": key_to_use,
        "models": model_entries,
    });

    // Replace existing derouter entry or append
    let idx = config.iter().position(|e| e.get("name").and_then(|n| n.as_str()) == Some("derouter"));
    if let Some(i) = idx {
        config[i] = new_entry;
    } else {
        config.push(new_entry);
    }

    if let Err(e) = common::write_json_file(&path, &serde_json::Value::Array(config)).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to update copilot settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "Copilot settings applied! Reload VS Code to take effect.",
        "configPath": path.to_string_lossy(),
    }))
    .into_response()
}

/// DELETE — remove derouter entry from chatLanguageModels.json.
pub async fn delete() -> Response {
    let path = config_path();

    let config: Vec<serde_json::Value> = match common::read_json_file(&path).await {
        Some(c) => c.as_array().cloned().unwrap_or_default(),
        None => {
            return Json(serde_json::json!({
                "success": true,
                "message": "No config file to reset",
            }))
            .into_response();
        }
    };

    let filtered: Vec<serde_json::Value> = config
        .into_iter()
        .filter(|e| e.get("name").and_then(|n| n.as_str()) != Some("derouter"))
        .collect();

    if let Err(e) = common::write_json_file(&path, &serde_json::Value::Array(filtered)).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to reset copilot settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "derouter removed from Copilot config",
    }))
    .into_response()
}
