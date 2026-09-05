//! OpenCode settings — reads/writes `~/.config/opencode/opencode.json`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

fn config_dir() -> std::path::PathBuf {
    common::home_dir().join(".config").join("opencode")
}

fn config_path() -> std::path::PathBuf {
    config_dir().join("opencode.json")
}

async fn check_installed() -> bool {
    common::check_installed("opencode", &[config_path()]).await
}

fn has_derouter(config: &serde_json::Value) -> bool {
    config
        .get("provider")
        .and_then(|p| p.get("derouter"))
        .is_some()
}

/// GET — read opencode.json, report derouter provider info.
pub async fn get() -> Response {
    let installed = check_installed().await;
    if !installed {
        return Json(serde_json::json!({
            "installed": false,
            "config": null,
            "message": "OpenCode CLI is not installed",
        }))
        .into_response();
    }

    let config = common::read_json_file(&config_path()).await;
    let provider_config = config.as_ref().and_then(|c| c.get("provider")?.get("derouter"));
    let model_map = provider_config.and_then(|p| p.get("models")).and_then(|m| m.as_object());
    let models: Vec<String> = model_map.map(|m| m.keys().cloned().collect()).unwrap_or_default();

    let active_model = config
        .as_ref()
        .and_then(|c| c.get("model"))
        .and_then(|m| m.as_str())
        .filter(|m| m.starts_with("derouter/"))
        .map(|m| m.replace("derouter/", ""));

    let base_url = provider_config
        .and_then(|p| p.get("options"))
        .and_then(|o| o.get("baseURL"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string());

    Json(serde_json::json!({
        "installed": true,
        "config": config,
        "hasderouter": config.as_ref().map(has_derouter).unwrap_or(false),
        "configPath": config_path().to_string_lossy(),
        "opencode": {
            "models": models,
            "activeModel": active_model,
            "baseURL": base_url,
        },
    }))
    .into_response()
}

/// POST — apply derouter as openai-compatible provider.
pub async fn post(body: Json<serde_json::Value>) -> Response {
    let body = body.0;
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let model = body.get("model").and_then(|v| v.as_str());
    let models = body.get("models").and_then(|v| v.as_array());
    let active_model = body.get("activeModel").and_then(|v| v.as_str());
    let subagent_model = body.get("subagentModel").and_then(|v| v.as_str());

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

    let normalized_base_url = common::normalize_v1(base_url);
    let key_to_use = if api_key.is_empty() { "sk_derouter" } else { api_key };
    let effective_subagent_model = subagent_model.unwrap_or(&models_array[0]);

    let mut config = common::read_json_file(&config_path()).await.unwrap_or(serde_json::json!({}));
    if !config.is_object() {
        config = serde_json::json!({});
    }
    let obj = config.as_object_mut().unwrap();

    // Ensure provider object
    if !obj.contains_key("provider") {
        obj.insert("provider".to_string(), serde_json::json!({}));
    }

    // Get or create derouter provider entry, preserving existing models
    let provider_obj = obj.get_mut("provider").unwrap().as_object_mut().unwrap();
    let existing_provider = provider_obj
        .entry("derouter".to_string())
        .or_insert_with(|| {
            serde_json::json!({
                "npm": "@ai-sdk/openai-compatible",
                "options": {},
                "models": {}
            })
        });

    // Merge options (overwrite baseURL/apiKey)
    let provider = existing_provider.as_object_mut().unwrap();
    if !provider.contains_key("options") {
        provider.insert("options".to_string(), serde_json::json!({}));
    }
    let options = provider.get_mut("options").unwrap().as_object_mut().unwrap();
    options.insert("baseURL".to_string(), serde_json::json!(normalized_base_url));
    options.insert("apiKey".to_string(), serde_json::json!(key_to_use));

    // Ensure models map exists
    if !provider.contains_key("models") {
        provider.insert("models".to_string(), serde_json::json!({}));
    }
    let models_map = provider.get_mut("models").unwrap().as_object_mut().unwrap();

    for m in &models_array {
        if m.is_empty() {
            continue;
        }
        models_map.insert(
            m.clone(),
            serde_json::json!({
                "name": m,
                "modalities": {
                    "input": ["text", "image"],
                    "output": ["text"]
                }
            }),
        );
    }

    // Set the active model
    if let Some(am) = active_model {
        if am.is_empty() {
            obj.insert("model".to_string(), serde_json::json!(""));
        } else {
            obj.insert("model".to_string(), serde_json::json!(format!("derouter/{}", am)));
        }
    } else {
        let first = &models_array[0];
        obj.insert("model".to_string(), serde_json::json!(format!("derouter/{}", first)));
    }

    // Add subagent configuration
    if !obj.contains_key("agent") {
        obj.insert("agent".to_string(), serde_json::json!({}));
    }
    let agent = obj.get_mut("agent").unwrap().as_object_mut().unwrap();
    agent.insert(
        "explorer".to_string(),
        serde_json::json!({
            "description": "Fast explorer subagent for codebase exploration",
            "mode": "subagent",
            "model": format!("derouter/{}", effective_subagent_model),
        }),
    );

    if let Err(e) = common::write_json_file(&config_path(), &config).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to apply settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "OpenCode settings applied successfully!",
        "configPath": config_path().to_string_lossy(),
    }))
    .into_response()
}

/// DELETE — remove derouter provider from opencode.json.
pub async fn delete() -> Response {
    let mut config = match common::read_json_file(&config_path()).await {
        Some(c) => c,
        None => {
            return Json(serde_json::json!({
                "success": true,
                "message": "No config file to reset",
            }))
            .into_response();
        }
    };

    if !config.is_object() {
        return Json(serde_json::json!({
            "success": true,
            "message": "No config file to reset",
        }))
        .into_response();
    }

    let obj = config.as_object_mut().unwrap();

    // Remove derouter provider
    if let Some(provider) = obj.get_mut("provider").and_then(|p| p.as_object_mut()) {
        provider.remove("derouter");
    }

    // Clear model if it starts with derouter/
    if let Some(model) = obj.get("model").and_then(|m| m.as_str()) {
        if model.starts_with("derouter/") {
            obj.remove("model");
        }
    }

    // Remove subagent configuration
    if let Some(agent) = obj.get_mut("agent").and_then(|a| a.as_object_mut()) {
        if let Some(explorer) = agent.get("explorer").and_then(|e| e.get("model")).and_then(|m| m.as_str()) {
            if explorer.starts_with("derouter/") {
                agent.remove("explorer");
                if agent.is_empty() {
                    obj.remove("agent");
                }
            }
        }
    }

    if let Err(e) = common::write_json_file(&config_path(), &config).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to reset opencode settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "derouter settings removed from OpenCode",
    }))
    .into_response()
}

/// DELETE with optional `?model=` query param — remove a specific model or the entire derouter provider.
pub async fn delete_with_model(model_to_remove: Option<String>) -> Response {
    let mut config = match common::read_json_file(&config_path()).await {
        Some(c) => c,
        None => {
            return Json(serde_json::json!({
                "success": true,
                "message": "No config file to reset",
            }))
            .into_response();
        }
    };

    if !config.is_object() {
        return Json(serde_json::json!({
            "success": true,
            "message": "No config file to reset",
        }))
        .into_response();
    }

    let message;

    if let Some(model) = &model_to_remove {
        // Remove just that model
        let provider_empty;
        let was_active;
        {
            let obj = config.as_object_mut().unwrap();
            let provider = obj
                .get_mut("provider")
                .and_then(|p| p.get_mut("derouter"))
                .and_then(|d| d.get_mut("models"))
                .and_then(|m| m.as_object_mut());
            if let Some(provider) = provider {
                provider.remove(model);
                provider_empty = provider.is_empty();
            } else {
                provider_empty = true;
            }
            // Check if removed model was the active one
            was_active = obj
                .get("model")
                .and_then(|m| m.as_str())
                .map(|m| m == format!("derouter/{}", model))
                .unwrap_or(false);
        }

        if provider_empty {
            // No models left, remove the provider entirely
            let obj = config.as_object_mut().unwrap();
            if let Some(providers) = obj.get_mut("provider").and_then(|p| p.as_object_mut()) {
                providers.remove("derouter");
            }
            if obj.get("model").and_then(|m| m.as_str()).map(|m| m.starts_with("derouter/")).unwrap_or(false) {
                obj.remove("model");
            }
        } else if was_active {
            // Switch active model to first remaining
            let remaining: Vec<String> = {
                let obj = config.as_object().unwrap();
                obj.get("provider")
                    .and_then(|p| p.get("derouter"))
                    .and_then(|d| d.get("models"))
                    .and_then(|m| m.as_object())
                    .map(|m| m.keys().cloned().collect())
                    .unwrap_or_default()
            };
            let obj = config.as_object_mut().unwrap();
            if let Some(first) = remaining.first() {
                obj.insert("model".to_string(), serde_json::json!(format!("derouter/{}", first)));
            }
        }
        message = format!("Model \"{}\" removed", model);
    } else {
        // Remove entire derouter provider
        let obj = config.as_object_mut().unwrap();
        if let Some(provider) = obj.get_mut("provider").and_then(|p| p.as_object_mut()) {
            provider.remove("derouter");
        }
        if obj.get("model").and_then(|m| m.as_str()).map(|m| m.starts_with("derouter/")).unwrap_or(false) {
            obj.remove("model");
        }

        // Remove subagent configuration
        if let Some(agent) = obj.get_mut("agent").and_then(|a| a.as_object_mut()) {
            if let Some(explorer) = agent.get("explorer").and_then(|e| e.get("model")).and_then(|m| m.as_str()) {
                if explorer.starts_with("derouter/") {
                    agent.remove("explorer");
                    if agent.is_empty() {
                        obj.remove("agent");
                    }
                }
            }
        }
        message = "derouter settings removed from OpenCode".to_string();
    }

    if let Err(e) = common::write_json_file(&config_path(), &config).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to reset opencode settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": message,
    }))
    .into_response()
}

/// PATCH — partial update (e.g., clearActiveModel).
pub async fn patch(body: Json<serde_json::Value>) -> Response {
    let body = body.0;
    let clear_active_model = body.get("clearActiveModel").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut config = match common::read_json_file(&config_path()).await {
        Some(c) => c,
        None => {
            return Json(serde_json::json!({
                "success": true,
                "message": "No config file found",
            }))
            .into_response();
        }
    };

    if !config.is_object() {
        config = serde_json::json!({});
    }

    if clear_active_model {
        if let Some(obj) = config.as_object_mut() {
            if let Some(model) = obj.get("model").and_then(|m| m.as_str()) {
                if model.starts_with("derouter/") {
                    obj.insert("model".to_string(), serde_json::json!(""));
                }
            }
        }
    }

    if let Err(e) = common::write_json_file(&config_path(), &config).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to patch settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "Settings updated",
    }))
    .into_response()
}

