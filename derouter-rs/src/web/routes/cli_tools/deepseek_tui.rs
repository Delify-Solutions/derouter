//! DeepSeek TUI settings — reads/writes `~/.deepseek/config.toml` (simple TOML text).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

fn deepseek_dir() -> std::path::PathBuf {
    common::home_dir().join(".deepseek")
}

fn config_path() -> std::path::PathBuf {
    deepseek_dir().join("config.toml")
}

async fn check_installed() -> bool {
    common::check_installed("deepseek", &[config_path()]).await
}

/// GET — read config.toml.
pub async fn get() -> Response {
    let installed = check_installed().await;
    if !installed {
        return Json(serde_json::json!({
            "installed": false,
            "settings": null,
            "message": "DeepSeek TUI is not installed",
        }))
        .into_response();
    }

    let toml_text = common::read_text_file(&config_path()).await;
    // Parse with the toml crate for structured response
    let parsed: toml::Value = toml::from_str(&toml_text).unwrap_or(toml::Value::Table(toml::Table::new()));

    // Check hasderouter
    let has = parsed
        .get("provider")
        .and_then(|v| v.as_str())
        .map(|p| p == "openai")
        .unwrap_or(false)
        && parsed
            .get("providers.openai")
            .and_then(|p| p.get("base_url"))
            .and_then(|b| b.as_str())
            .map(|b| common::is_localhost_url(b))
            .unwrap_or(false);

    // Convert to JSON for response
    let settings = toml_to_json(&parsed);

    Json(serde_json::json!({
        "installed": true,
        "settings": settings,
        "hasderouter": has,
        "configPath": config_path().to_string_lossy(),
    }))
    .into_response()
}

/// POST — write derouter config (provider=openai with base_url/api_key/model).
pub async fn post(body: Json<serde_json::Value>) -> Response {
    let body = body.0;
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("");

    if base_url.is_empty() || model.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "baseUrl and model are required"})),
        )
            .into_response();
    }

    let _ = tokio::fs::create_dir_all(deepseek_dir()).await;

    let normalized_base_url = common::normalize_v1(base_url);
    let key_to_use = if api_key.is_empty() { "sk_derouter" } else { api_key };

    let config_content = format!(
        "provider = \"openai\"\n\n[providers.openai]\nbase_url = \"{}\"\napi_key = \"{}\"\nmodel = \"{}\"\n",
        normalized_base_url, key_to_use, model
    );

    if let Err(e) = tokio::fs::write(config_path(), config_content.as_bytes()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to update deepseek-tui settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "DeepSeek TUI settings applied successfully!",
        "configPath": config_path().to_string_lossy(),
    }))
    .into_response()
}

/// DELETE — reset to DeepSeek defaults.
pub async fn delete() -> Response {
    let path = config_path();
    if tokio::fs::metadata(&path).await.is_err() {
        return Json(serde_json::json!({
            "success": true,
            "message": "No config file to reset",
        }))
        .into_response();
    }

    let default_config = "provider = \"deepseek\"\n";
    if let Err(e) = tokio::fs::write(&path, default_config.as_bytes()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to reset deepseek-tui settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "derouter config reset to DeepSeek defaults",
    }))
    .into_response()
}

fn toml_to_json(val: &toml::Value) -> serde_json::Value {
    match val {
        toml::Value::String(s) => serde_json::json!(s),
        toml::Value::Integer(i) => serde_json::json!(i),
        toml::Value::Float(f) => serde_json::json!(f),
        toml::Value::Boolean(b) => serde_json::json!(b),
        toml::Value::Array(arr) => serde_json::Value::Array(arr.iter().map(toml_to_json).collect()),
        toml::Value::Table(table) => {
            let mut map = serde_json::Map::new();
            for (k, v) in table {
                map.insert(k.clone(), toml_to_json(v));
            }
            serde_json::Value::Object(map)
        }
        toml::Value::Datetime(dt) => serde_json::json!(dt.to_string()),
    }
}
