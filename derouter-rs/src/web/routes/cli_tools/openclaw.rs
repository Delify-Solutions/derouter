//! OpenClaw settings — reads/writes `~/.openclaw/openclaw.json` and per-agent `models.json`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

fn openclaw_dir() -> std::path::PathBuf {
    common::home_dir().join(".openclaw")
}

fn settings_path() -> std::path::PathBuf {
    openclaw_dir().join("openclaw.json")
}

async fn check_installed() -> bool {
    common::check_installed("openclaw", &[settings_path()]).await
}

fn resolve_agent_model(m: &serde_json::Value) -> String {
    if let Some(s) = m.as_str() {
        return s.to_string();
    }
    if let Some(obj) = m.as_object() {
        if let Some(primary) = obj.get("primary").and_then(|p| p.as_str()) {
            return primary.to_string();
        }
    }
    String::new()
}

fn has_derouter(settings: &serde_json::Value) -> bool {
    settings
        .get("models")
        .and_then(|m| m.get("providers"))
        .and_then(|p| p.get("derouter"))
        .is_some()
}

/// Read per-agent models.json and return current model id.
async fn read_agent_model(agent_dir: &str) -> Option<String> {
    let path = std::path::PathBuf::from(agent_dir).join("models.json");
    let data = common::read_json_file(&path).await?;
    data.get("providers")
        .and_then(|p| p.get("derouter"))
        .and_then(|d| d.get("models"))
        .and_then(|m| m.as_array())
        .and_then(|arr| arr.first())
        .and_then(|m| m.get("id"))
        .and_then(|id| id.as_str())
        .map(|s| s.to_string())
}

/// Write per-agent models.json
async fn write_agent_models(agent_dir: &str, model: &str, base_url: &str, api_key: &str) {
    let path = std::path::PathBuf::from(agent_dir);
    let models_path = path.join("models.json");

    let _ = tokio::fs::create_dir_all(&path).await;

    let mut existing = common::read_json_file(&models_path).await.unwrap_or(serde_json::json!({}));
    if !existing.is_object() {
        existing = serde_json::json!({});
    }
    let obj = existing.as_object_mut().unwrap();

    if !obj.contains_key("providers") {
        obj.insert("providers".to_string(), serde_json::json!({}));
    }

    let providers = obj.get_mut("providers").unwrap().as_object_mut().unwrap();
    let key_to_use = if api_key.is_empty() { "your_api_key" } else { api_key };
    let name = model.split('/').next_back().unwrap_or(model);
    providers.insert(
        "derouter".to_string(),
        serde_json::json!({
            "baseUrl": base_url,
            "apiKey": key_to_use,
            "api": "openai-completions",
            "models": [{"id": model, "name": name}],
        }),
    );

    let _ = common::write_json_file(&models_path, &existing).await;
}

/// GET — read settings + enrich agents with current per-agent model.
pub async fn get() -> Response {
    let installed = check_installed().await;
    if !installed {
        return Json(serde_json::json!({
            "installed": false,
            "settings": null,
            "message": "Open Claw CLI is not installed",
        }))
        .into_response();
    }

    let settings = common::read_json_file(&settings_path()).await;

    // Enrich agents list with current per-agent model from models.json
    let agent_list = settings
        .as_ref()
        .and_then(|s| s.get("agents"))
        .and_then(|a| a.get("list"))
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default();

    let mut enriched_agents = Vec::new();
    for agent in &agent_list {
        let agent_dir = agent.get("agentDir").and_then(|d| d.as_str());
        let agent_model = if let Some(dir) = agent_dir {
            read_agent_model(dir).await
        } else {
            None
        };
        let mut enriched = agent.clone();
        if let Some(obj) = enriched.as_object_mut() {
            let resolved = resolve_agent_model(&obj.get("model").cloned().unwrap_or(serde_json::json!(null)));
            obj.insert("model".to_string(), serde_json::json!(resolved));
            obj.insert("currentModel".to_string(), serde_json::json!(agent_model));
        }
        enriched_agents.push(enriched);
    }

    let settings_for_response = settings.clone().unwrap_or(serde_json::json!(null));

    Json(serde_json::json!({
        "installed": true,
        "settings": settings_for_response,
        "agents": enriched_agents,
        "hasderouter": settings.as_ref().map(has_derouter).unwrap_or(false),
        "settingsPath": settings_path().to_string_lossy(),
    }))
    .into_response()
}

/// POST — write derouter to openclaw.json + per-agent models.json.
pub async fn post(body: Json<serde_json::Value>) -> Response {
    let body = body.0;
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let agent_models = body.get("agentModels").and_then(|v| v.as_object());

    if base_url.is_empty() || model.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "baseUrl and model are required"})),
        )
            .into_response();
    }

    let _ = tokio::fs::create_dir_all(openclaw_dir()).await;

    let mut settings = common::read_json_file(&settings_path()).await.unwrap_or(serde_json::json!({}));
    if !settings.is_object() {
        settings = serde_json::json!({});
    }
    let obj = settings.as_object_mut().unwrap();

    // Ensure nested structure — use a helper to avoid holding multiple mutable borrows
    {
        if !obj.contains_key("agents") {
            obj.insert("agents".to_string(), serde_json::json!({}));
        }
        let agents = obj.get_mut("agents").unwrap().as_object_mut().unwrap();
        if !agents.contains_key("defaults") {
            agents.insert("defaults".to_string(), serde_json::json!({}));
        }
        let defaults = agents.get_mut("defaults").unwrap().as_object_mut().unwrap();
        if !defaults.contains_key("model") {
            defaults.insert("model".to_string(), serde_json::json!({}));
        }
        if !defaults.contains_key("models") {
            defaults.insert("models".to_string(), serde_json::json!({}));
        }
    }

    {
        if !obj.contains_key("models") {
            obj.insert("models".to_string(), serde_json::json!({}));
        }
        let models = obj.get_mut("models").unwrap().as_object_mut().unwrap();
        if !models.contains_key("providers") {
            models.insert("providers".to_string(), serde_json::json!({}));
        }
    }

    let normalized_base_url = common::normalize_v1(base_url);
    let full_model_id = format!("derouter/{}", model);

    // Collect all unique models (default + per-agent)
    let mut all_model_ids = vec![model.to_string()];
    if let Some(am) = agent_models {
        for (_, v) in am {
            if let Some(m) = v.as_str() {
                if !m.is_empty() && !all_model_ids.contains(&m.to_string()) {
                    all_model_ids.push(m.to_string());
                }
            }
        }
    }

    // Remove all old derouter/* entries from agents.defaults.models and add fresh ones
    {
        let agents = obj.get_mut("agents").unwrap().as_object_mut().unwrap();
        let defaults = agents.get_mut("defaults").unwrap().as_object_mut().unwrap();
        let defaults_models = defaults.get_mut("models").unwrap().as_object_mut().unwrap();
        let keys_to_remove: Vec<String> = defaults_models
            .keys()
            .filter(|k| k.starts_with("derouter/"))
            .cloned()
            .collect();
        for k in keys_to_remove {
            defaults_models.remove(&k);
        }
        // Add fresh derouter models to allowlist
        for m in &all_model_ids {
            defaults_models.insert(format!("derouter/{}", m), serde_json::json!({}));
        }

        // Update default model
        let defaults_model = defaults.get_mut("model").unwrap().as_object_mut().unwrap();
        defaults_model.insert("primary".to_string(), serde_json::json!(full_model_id));
    }

    // Remove old derouter model from each agent in agents.list
    {
        let agents = obj.get_mut("agents").unwrap().as_object_mut().unwrap();
        if let Some(list) = agents.get_mut("list").and_then(|l| l.as_array_mut()) {
            for agent in list.iter_mut() {
                if let Some(a_obj) = agent.as_object_mut() {
                    let model_val = a_obj.get("model").cloned().unwrap_or(serde_json::json!(null));
                    let resolved = resolve_agent_model(&model_val);
                    if resolved.starts_with("derouter/") {
                        a_obj.remove("model");
                    }
                }
            }
        }
    }

    let key_to_use = if api_key.is_empty() { "your_api_key".to_string() } else { api_key.to_string() };

    // Update models.providers.derouter with all models
    {
        let models = obj.get_mut("models").unwrap().as_object_mut().unwrap();
        let providers = models.get_mut("providers").unwrap().as_object_mut().unwrap();
        let model_entries: Vec<serde_json::Value> = all_model_ids
            .iter()
            .map(|m| {
                let name = m.split('/').next_back().unwrap_or(m);
                serde_json::json!({"id": m, "name": name})
            })
            .collect();
        providers.insert(
            "derouter".to_string(),
            serde_json::json!({
                "baseUrl": normalized_base_url,
                "apiKey": key_to_use,
                "api": "openai-completions",
                "models": model_entries,
            }),
        );
    }

    // Set per-agent model in agents.list and write models.json
    {
        let agents = obj.get_mut("agents").unwrap().as_object_mut().unwrap();
        if let Some(list) = agents.get_mut("list").and_then(|l| l.as_array_mut()) {
            for agent in list.iter_mut() {
                if let Some(a_obj) = agent.as_object_mut() {
                    let agent_id = a_obj.get("id").and_then(|i| i.as_str()).unwrap_or("");
                    if let Some(am) = agent_models.and_then(|am| am.get(agent_id)).and_then(|v| v.as_str()) {
                        if !am.is_empty() {
                            a_obj.insert("model".to_string(), serde_json::json!(format!("derouter/{}", am)));
                        }
                    }
                }
            }

            // Write per-agent models.json for agents with agentDir
            for agent in list.iter() {
                if let Some(agent_dir) = agent.get("agentDir").and_then(|d| d.as_str()) {
                    let agent_id = agent.get("id").and_then(|i| i.as_str()).unwrap_or("");
                    let model_to_write = agent_models
                        .and_then(|am| am.get(agent_id))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or(model);
                    write_agent_models(agent_dir, model_to_write, &normalized_base_url, &key_to_use).await;
                }
            }
        }
    }

    if let Err(e) = common::write_json_file(&settings_path(), &settings).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to update openclaw settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "Open Claw settings applied successfully!",
        "settingsPath": settings_path().to_string_lossy(),
    }))
    .into_response()
}

/// DELETE — remove derouter from openclaw.json.
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
        // Remove derouter from models.providers
        if let Some(providers) = obj.get_mut("models").and_then(|m| m.get_mut("providers")).and_then(|p| p.as_object_mut()) {
            providers.remove("derouter");
            if providers.is_empty() {
                if let Some(models) = obj.get_mut("models").and_then(|m| m.as_object_mut()) {
                    models.remove("providers");
                }
            }
        }

        // Remove derouter models from agents.defaults.models allowlist
        if let Some(defaults_models) = obj
            .get_mut("agents")
            .and_then(|a| a.get_mut("defaults"))
            .and_then(|d| d.get_mut("models"))
            .and_then(|m| m.as_object_mut())
        {
            let keys_to_remove: Vec<String> = defaults_models
                .keys()
                .filter(|k| k.starts_with("derouter/"))
                .cloned()
                .collect();
            for k in keys_to_remove {
                defaults_models.remove(&k);
            }
            if defaults_models.is_empty() {
                if let Some(defaults) = obj.get_mut("agents").and_then(|a| a.get_mut("defaults")).and_then(|d| d.as_object_mut()) {
                    defaults.remove("models");
                }
            }
        }

        // Reset agents.defaults.model.primary if it uses derouter
        if let Some(primary) = obj
            .get_mut("agents")
            .and_then(|a| a.get_mut("defaults"))
            .and_then(|d| d.get_mut("model"))
            .and_then(|m| m.as_object_mut())
            .and_then(|mo| mo.get("primary"))
            .and_then(|p| p.as_str())
        {
            if primary.starts_with("derouter/") {
                if let Some(model_obj) = obj
                    .get_mut("agents")
                    .and_then(|a| a.get_mut("defaults"))
                    .and_then(|d| d.get_mut("model"))
                    .and_then(|m| m.as_object_mut())
                {
                    model_obj.remove("primary");
                }
            }
        }
    }

    if let Err(e) = common::write_json_file(&settings_path(), &settings).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to reset openclaw settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "derouter settings removed successfully",
    }))
    .into_response()
}
