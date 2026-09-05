//! jcode settings — reads/writes `~/.jcode/config.toml` (TOML) and `~/.config/jcode/provider-derouter.env`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

fn jcode_config_dir() -> std::path::PathBuf {
    common::home_dir().join(".jcode")
}

fn config_path() -> std::path::PathBuf {
    jcode_config_dir().join("config.toml")
}

fn provider_env_path() -> std::path::PathBuf {
    let xdg = std::env::var("XDG_CONFIG_HOME").map(std::path::PathBuf::from).unwrap_or_else(|_| {
        common::home_dir().join(".config")
    });
    xdg.join("jcode").join("provider-derouter.env")
}

async fn check_installed() -> bool {
    common::check_installed("jcode", &[jcode_config_dir()]).await
}

fn has_derouter(config: &toml::Value) -> bool {
    config
        .get("providers")
        .and_then(|p| p.get("derouter"))
        .is_some()
        || config
            .get("providers")
            .and_then(|p| p.as_table())
            .map(|t| {
                t.values().any(|v| {
                    v.get("base_url")
                        .and_then(|b| b.as_str())
                        .map(|s| s.contains("localhost:20128"))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
}

/// GET — read config.toml, report derouter status.
pub async fn get() -> Response {
    let installed = check_installed().await;
    if !installed {
        return Json(serde_json::json!({
            "installed": false,
            "message": "jcode not installed. Install via: curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash",
        }))
        .into_response();
    }

    let existing = common::read_text_file_opt(&config_path()).await.unwrap_or_default();
    let parsed: toml::Value = toml::from_str(&existing).unwrap_or(toml::Value::Table(toml::Table::new()));

    // Convert toml::Value to serde_json::Value for the response
    let config_json = toml_to_json(&parsed);
    let has = has_derouter(&parsed);

    Json(serde_json::json!({
        "installed": true,
        "config": config_json,
        "hasderouter": has,
        "configPath": config_path().to_string_lossy(),
    }))
    .into_response()
}

/// POST — write derouter provider to config.toml + API key to provider-derouter.env.
pub async fn post(body: Json<serde_json::Value>) -> Response {
    let body = body.0;
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let models = body.get("models").and_then(|v| v.as_array());

    if base_url.is_empty() || api_key.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "baseUrl and apiKey are required"})),
        )
            .into_response();
    }

    let normalized_base_url = common::normalize_v1(base_url);

    let default_model = models
        .and_then(|arr| arr.first())
        .and_then(|m| m.as_str())
        .unwrap_or("cc/claude-opus-4-7");

    // Read existing config
    let existing = common::read_text_file_opt(&config_path()).await.unwrap_or_default();
    let mut parsed: toml::Value = toml::from_str(&existing).unwrap_or(toml::Value::Table(toml::Table::new()));
    let table = parsed.as_table_mut().unwrap();

    // Ensure providers table exists
    if !table.contains_key("providers") {
        table.insert("providers".to_string(), toml::Value::Table(toml::Table::new()));
    }

    let providers = table.get_mut("providers").unwrap().as_table_mut().unwrap();
    let mut derouter = toml::Table::new();
    derouter.insert("type".to_string(), toml::Value::String("openai-compatible".to_string()));
    derouter.insert("base_url".to_string(), toml::Value::String(normalized_base_url));
    derouter.insert("auth".to_string(), toml::Value::String("bearer".to_string()));
    derouter.insert("api_key_env".to_string(), toml::Value::String("JCODE_DEROUTER_API_KEY".to_string()));
    derouter.insert("env_file".to_string(), toml::Value::String("provider-derouter.env".to_string()));
    derouter.insert("default_model".to_string(), toml::Value::String(default_model.to_string()));
    derouter.insert("requires_api_key".to_string(), toml::Value::Boolean(true));
    providers.insert("derouter".to_string(), toml::Value::Table(derouter));

    // Ensure jcode config dir exists
    let _ = tokio::fs::create_dir_all(jcode_config_dir()).await;
    let config_content = toml::to_string(&parsed).unwrap_or_default();
    if let Err(e) = tokio::fs::write(config_path(), config_content.as_bytes()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to write config: {}", e)})),
        )
            .into_response();
    }

    // Write provider env
    let env_dir = provider_env_path().parent().map(|p| p.to_path_buf());
    if let Some(dir) = env_dir {
        let _ = tokio::fs::create_dir_all(&dir).await;
    }

    // Read existing env file
    let existing_env = common::read_text_file_opt(&provider_env_path()).await.unwrap_or_default();
    let mut env_lines: Vec<(String, String)> = Vec::new();
    for line in existing_env.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(eq_idx) = trimmed.find('=') {
            let key = trimmed[..eq_idx].trim().to_string();
            let mut value = trimmed[eq_idx + 1..].trim().to_string();
            if (value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')) {
                value = value[1..value.len() - 1].to_string();
            }
            env_lines.push((key, value));
        }
    }

    // Upsert JCODE_DEROUTER_API_KEY
    if let Some(entry) = env_lines.iter_mut().find(|(k, _)| k == "JCODE_DEROUTER_API_KEY") {
        entry.1 = api_key.to_string();
    } else {
        env_lines.push(("JCODE_DEROUTER_API_KEY".to_string(), api_key.to_string()));
    }

    let mut env_content = String::from("# jcode provider environment variables\n");
    for (key, value) in &env_lines {
        env_content.push_str(&format!("{}=\"{}\"\n", key, value));
    }

    if let Err(e) = tokio::fs::write(provider_env_path(), env_content.as_bytes()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to write env: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "jcode configured successfully. Use: jcode --provider-profile derouter",
        "configPath": config_path().to_string_lossy(),
    }))
    .into_response()
}

/// DELETE — remove derouter from config.toml + remove API key from env.
pub async fn delete() -> Response {
    let existing = common::read_text_file_opt(&config_path()).await.unwrap_or_default();
    let mut parsed: toml::Value = toml::from_str(&existing).unwrap_or(toml::Value::Table(toml::Table::new()));
    let table = parsed.as_table_mut().unwrap();

    if !table.contains_key("providers") {
        return Json(serde_json::json!({
            "success": true,
            "message": "No configuration to remove",
        }))
        .into_response();
    }

    if let Some(providers) = table.get_mut("providers").and_then(|p| p.as_table_mut()) {
        providers.remove("derouter");
    }

    let config_content = toml::to_string(&parsed).unwrap_or_default();
    if let Err(e) = tokio::fs::write(config_path(), config_content.as_bytes()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to write config: {}", e)})),
        )
            .into_response();
    }

    // Remove JCODE_DEROUTER_API_KEY from env
    let existing_env = common::read_text_file_opt(&provider_env_path()).await.unwrap_or_default();
    let mut env_lines: Vec<(String, String)> = Vec::new();
    for line in existing_env.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(eq_idx) = trimmed.find('=') {
            let key = trimmed[..eq_idx].trim().to_string();
            if key == "JCODE_DEROUTER_API_KEY" {
                continue;
            }
            let mut value = trimmed[eq_idx + 1..].trim().to_string();
            if (value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')) {
                value = value[1..value.len() - 1].to_string();
            }
            env_lines.push((key, value));
        }
    }

    let mut env_content = String::from("# jcode provider environment variables\n");
    for (key, value) in &env_lines {
        env_content.push_str(&format!("{}=\"{}\"\n", key, value));
    }

    let _ = tokio::fs::write(provider_env_path(), env_content.as_bytes()).await;

    Json(serde_json::json!({
        "success": true,
        "message": "derouter configuration removed from jcode",
    }))
    .into_response()
}

/// Convert a toml::Value to serde_json::Value.
fn toml_to_json(val: &toml::Value) -> serde_json::Value {
    match val {
        toml::Value::String(s) => serde_json::json!(s),
        toml::Value::Integer(i) => serde_json::json!(i),
        toml::Value::Float(f) => serde_json::json!(f),
        toml::Value::Boolean(b) => serde_json::json!(b),
        toml::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(toml_to_json).collect())
        }
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
