//! Codex CLI settings — reads/writes `~/.codex/config.toml` (TOML) and `~/.codex/auth.json`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

fn codex_dir() -> std::path::PathBuf {
    common::home_dir().join(".codex")
}

fn config_path() -> std::path::PathBuf {
    codex_dir().join("config.toml")
}

fn auth_path() -> std::path::PathBuf {
    codex_dir().join("auth.json")
}

/// Check if codex CLI is installed (binary on PATH or config file exists).
async fn check_installed() -> bool {
    common::check_installed("codex", &[config_path()]).await
}

/// GET — read config.toml as raw text, report hasderouter.
pub async fn get() -> Response {
    let installed = check_installed().await;

    if !installed {
        return Json(serde_json::json!({
            "installed": false,
            "config": null,
            "message": "Codex CLI is not installed",
        }))
        .into_response();
    }

    let config = common::read_text_file_opt(&config_path()).await;
    let hasderouter = config
        .as_ref()
        .map(|c| {
            c.contains("model_provider = \"derouter\"")
                || c.contains("[model_providers.derouter]")
        })
        .unwrap_or(false);

    Json(serde_json::json!({
        "installed": true,
        "config": config,
        "hasderouter": hasderouter,
        "configPath": config_path().to_string_lossy(),
    }))
    .into_response()
}

/// POST — parse config.toml, merge derouter settings, write back. apiKey goes to Authorization header, not auth.json.
pub async fn post(body: Json<serde_json::Value>) -> Response {
    let body = body.0;
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let subagent_model = body.get("subagentModel").and_then(|v| v.as_str()).unwrap_or("");

    if base_url.is_empty() || api_key.is_empty() || model.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "baseUrl, apiKey and model are required"})),
        )
            .into_response();
    }

    // Ensure directory exists
    if let Err(e) = tokio::fs::create_dir_all(codex_dir()).await {
        if e.kind() != std::io::ErrorKind::AlreadyExists {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("Failed to create .codex dir: {}", e)})),
            )
                .into_response();
        }
    }

    // Read and parse existing config
    let existing = common::read_text_file_opt(&config_path()).await.unwrap_or_default();
    let mut parsed: toml::Value = toml::from_str(&existing).unwrap_or(toml::Value::Table(toml::Table::new()));

    let table = parsed.as_table_mut().unwrap();

    // Set model and model_provider
    table.insert("model".to_string(), toml::Value::String(model.to_string()));
    table.insert(
        "model_provider".to_string(),
        toml::Value::String("derouter".to_string()),
    );

    // Normalize base URL — append /v1 only once
    let normalized_base_url = common::normalize_v1(base_url);

    // Build the derouter provider section
    let mut derouter_provider = toml::Table::new();
    derouter_provider.insert("name".to_string(), toml::Value::String("derouter".to_string()));
    derouter_provider.insert("base_url".to_string(), toml::Value::String(normalized_base_url.clone()));
    derouter_provider.insert("wire_api".to_string(), toml::Value::String("responses".to_string()));

    // http_headers with Authorization
    let mut http_headers = toml::Table::new();
    http_headers.insert(
        "Authorization".to_string(),
        toml::Value::String(format!("Bearer {}", api_key)),
    );
    derouter_provider.insert("http_headers".to_string(), toml::Value::Table(http_headers));

    // Ensure model_providers table exists
    if !table.contains_key("model_providers") {
        table.insert("model_providers".to_string(), toml::Value::Table(toml::Table::new()));
    }
    if let Some(toml::Value::Table(mp)) = table.get_mut("model_providers") {
        mp.insert("derouter".to_string(), toml::Value::Table(derouter_provider));
    }

    // Remove legacy agents.subagent role
    if let Some(toml::Value::Table(agents)) = table.get_mut("agents") {
        agents.remove("subagent");
    } else {
        table.insert("agents".to_string(), toml::Value::Table(toml::Table::new()));
    }
    if let Some(toml::Value::Table(agents)) = table.get_mut("agents") {
        let sm = if subagent_model.is_empty() { model } else { subagent_model };
        agents.insert(
            "default_subagent_model".to_string(),
            toml::Value::String(sm.to_string()),
        );
    }

    // Serialize and write
    let config_content = toml::to_string(&parsed).unwrap_or_default();
    if let Err(e) = tokio::fs::write(config_path(), config_content.as_bytes()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to write config: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "Codex settings applied successfully!",
        "configPath": config_path().to_string_lossy(),
    }))
    .into_response()
}

/// DELETE — remove derouter from config.toml + remove OPENAI_API_KEY/auth_mode from auth.json.
pub async fn delete() -> Response {
    // Read and parse existing config
    let existing = match common::read_text_file_opt(&config_path()).await {
        Some(c) => c,
        None => {
            return Json(serde_json::json!({
                "success": true,
                "message": "No config file to reset",
            }))
            .into_response();
        }
    };

    let mut parsed: toml::Value = toml::from_str(&existing).unwrap_or(toml::Value::Table(toml::Table::new()));
    let table = parsed.as_table_mut().unwrap();

    // Remove derouter related root fields only if they point to derouter
    if table.get("model_provider").and_then(|v| v.as_str()) == Some("derouter") {
        table.remove("model");
        table.remove("model_provider");
    }

    // Remove derouter provider section
    if let Some(toml::Value::Table(mp)) = table.get_mut("model_providers") {
        mp.remove("derouter");
    }

    // Remove subagent configuration
    if let Some(toml::Value::Table(agents)) = table.get_mut("agents") {
        agents.remove("default_subagent_model");
        agents.remove("subagent");
    }

    let config_content = toml::to_string(&parsed).unwrap_or_default();
    if let Err(e) = tokio::fs::write(config_path(), config_content.as_bytes()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to write config: {}", e)})),
        )
            .into_response();
    }

    // Remove OPENAI_API_KEY from auth.json
    if let Some(auth_content) = common::read_text_file_opt(&auth_path()).await {
        if let Ok(mut auth_data) = serde_json::from_str::<serde_json::Value>(&auth_content) {
            if let Some(obj) = auth_data.as_object_mut() {
                obj.remove("OPENAI_API_KEY");
                obj.remove("auth_mode");

                if obj.is_empty() {
                    let _ = tokio::fs::remove_file(auth_path()).await;
                } else {
                    let _ = tokio::fs::write(
                        auth_path(),
                        serde_json::to_string_pretty(&auth_data).unwrap_or_default().as_bytes(),
                    )
                    .await;
                }
            }
        }
    }

    Json(serde_json::json!({
        "success": true,
        "message": "derouter settings removed successfully",
    }))
    .into_response()
}
