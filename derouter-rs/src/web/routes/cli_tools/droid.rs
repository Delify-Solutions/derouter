//! Factory Droid settings — reads/writes `~/.factory/settings.json`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

fn droid_dir() -> std::path::PathBuf {
    common::home_dir().join(".factory")
}

fn settings_path() -> std::path::PathBuf {
    droid_dir().join("settings.json")
}

async fn check_installed() -> bool {
    common::check_installed("droid", &[settings_path()]).await
}

fn has_derouter(settings: &serde_json::Value) -> bool {
    settings
        .get("customModels")
        .and_then(|m| m.as_array())
        .map(|arr| arr.iter().any(|m| m.get("id").and_then(|i| i.as_str()).map(|s| s.starts_with("custom:derouter")).unwrap_or(false)))
        .unwrap_or(false)
}

/// GET — read settings.json, report derouter status.
pub async fn get() -> Response {
    let installed = check_installed().await;
    if !installed {
        return Json(serde_json::json!({
            "installed": false,
            "settings": null,
            "message": "Factory Droid CLI is not installed",
        }))
        .into_response();
    }

    let settings = common::read_json_file(&settings_path()).await;

    Json(serde_json::json!({
        "installed": true,
        "settings": settings,
        "hasderouter": settings.as_ref().map(has_derouter).unwrap_or(false),
        "settingsPath": settings_path().to_string_lossy(),
    }))
    .into_response()
}

/// POST — write derouter customModels to settings.json.
pub async fn post(body: Json<serde_json::Value>) -> Response {
    let body = body.0;
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let model = body.get("model").and_then(|v| v.as_str());
    let models = body.get("models").and_then(|v| v.as_array());
    let active_model = body.get("activeModel").and_then(|v| v.as_str());

    let models_array: Vec<String> = if let Some(arr) = models {
        arr.iter().filter_map(|m| m.as_str().map(|s| s.to_string())).collect()
    } else if let Some(m) = model {
        vec![m.to_string()]
    } else {
        vec![]
    };

    if base_url.is_empty() || models_array.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "baseUrl and at least one model are required"})),
        )
            .into_response();
    }

    let _ = tokio::fs::create_dir_all(droid_dir()).await;

    let mut settings = common::read_json_file(&settings_path()).await.unwrap_or(serde_json::json!({}));
    if !settings.is_object() {
        settings = serde_json::json!({});
    }
    let obj = settings.as_object_mut().unwrap();

    // Ensure customModels array exists
    if !obj.contains_key("customModels") {
        obj.insert("customModels".to_string(), serde_json::json!([]));
    }

    let custom_models = obj.get_mut("customModels").unwrap().as_array_mut().unwrap();

    // Remove all existing derouter configs
    custom_models.retain(|m| {
        m.get("id").and_then(|i| i.as_str()).map(|s| !s.starts_with("custom:derouter")).unwrap_or(true)
    });

    let normalized_base_url = common::normalize_v1(base_url);
    let key_to_use = if api_key.is_empty() { "your_api_key" } else { api_key };

    // Determine active model index
    let mut default_index: i64 = 0;
    if let Some(am) = active_model {
        if am.is_empty() {
            default_index = -1;
        } else {
            default_index = models_array.iter().position(|m| m == am).map(|i| i as i64).unwrap_or(0);
        }
    }

    // Add entries for all requested models
    for (i, m) in models_array.iter().enumerate() {
        custom_models.push(serde_json::json!({
            "model": m,
            "id": format!("custom:derouter-{}", i),
            "index": i,
            "baseUrl": normalized_base_url,
            "apiKey": key_to_use,
            "displayName": m,
            "maxOutputTokens": 131072,
            "noImageSupport": false,
            "provider": "openai",
        }));
    }

    // Set default model: reorder so the default comes first
    if default_index >= 0 && (default_index as usize) < custom_models.len() {
        let idx = default_index as usize;
        let default_entry = custom_models.remove(idx);
        let mut new_entry = default_entry.clone();
        if let Some(obj) = new_entry.as_object_mut() {
            obj.insert("index".to_string(), serde_json::json!(0));
        }
        custom_models.insert(0, new_entry);
        // Re-index
        for (i, m) in custom_models.iter_mut().enumerate() {
            if let Some(obj) = m.as_object_mut() {
                obj.insert("index".to_string(), serde_json::json!(i));
            }
        }
    }

    if let Err(e) = common::write_json_file(&settings_path(), &settings).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to update droid settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "Factory Droid settings applied successfully!",
        "settingsPath": settings_path().to_string_lossy(),
    }))
    .into_response()
}

/// DELETE — remove derouter customModels from settings.json.
pub async fn delete() -> Response {
    let mut settings = match common::read_json_file(&settings_path()).await {
        Some(s) => s,
        None => {
            return Json(serde_json::json!({
                "success": true,
                "message": "No settings file to reset",
            }))
            .into_response();
        }
    };

    if let Some(obj) = settings.as_object_mut() {
        if let Some(custom_models) = obj.get_mut("customModels").and_then(|m| m.as_array_mut()) {
            custom_models.retain(|m| {
                m.get("id").and_then(|i| i.as_str()).map(|s| !s.starts_with("custom:derouter")).unwrap_or(true)
            });
            if custom_models.is_empty() {
                obj.remove("customModels");
            }
        }
    }

    if let Err(e) = common::write_json_file(&settings_path(), &settings).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to reset droid settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "derouter settings removed successfully",
    }))
    .into_response()
}
