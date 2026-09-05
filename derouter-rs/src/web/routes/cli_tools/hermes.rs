//! Hermes settings — reads/writes `~/.hermes/config.yaml` (regex-based model block) and `~/.hermes/.env`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

fn hermes_dir() -> std::path::PathBuf {
    common::home_dir().join(".hermes")
}

fn config_path() -> std::path::PathBuf {
    hermes_dir().join("config.yaml")
}

fn env_path() -> std::path::PathBuf {
    hermes_dir().join(".env")
}

async fn check_installed() -> bool {
    common::check_installed("hermes", &[config_path()]).await
}

/// Match the `model:` block in YAML (top-level key with indented children).
fn build_model_block(model: &str, base_url: &str) -> String {
    format!(
        "model:\n  default: \"{}\"\n  provider: \"custom\"\n  base_url: \"{}\"\n  api_key: ${{OPENAI_API_KEY}}\n",
        model, base_url
    )
}

/// Parse model block fields from YAML text.
fn parse_model_block(yaml: &str) -> Option<serde_json::Value> {
    // Find "model:" at start of a line
    let lines: Vec<&str> = yaml.lines().collect();
    let mut start = None;
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("model:") {
            start = Some(i);
            break;
        }
    }
    let start = start?;

    // Collect indented lines after "model:"
    let mut body = String::new();
    for line in &lines[start + 1..] {
        if line.is_empty() || line.starts_with(' ') || line.starts_with('\t') {
            body.push_str(line);
            body.push('\n');
        } else {
            break;
        }
    }

    let get = |key: &str| -> Option<String> {
        for line in body.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix(&format!("{}:", key)) {
                let val = rest.trim();
                let val = val.trim_matches('"').trim_matches('\'');
                let val = val.trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
        None
    };

    Some(serde_json::json!({
        "default": get("default"),
        "provider": get("provider"),
        "base_url": get("base_url"),
        "api_key": get("api_key"),
    }))
}

/// Replace or insert the model block in the YAML text.
fn upsert_model_block(yaml: &str, new_block: &str) -> String {
    // Find the model: block
    let lines: Vec<&str> = yaml.lines().collect();
    let mut start = None;
    let mut end = lines.len();
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("model:") {
            start = Some(i);
            // Find the end of the block (next non-indented, non-empty line)
            for (j, subsequent) in lines[i + 1..].iter().enumerate() {
                if !subsequent.is_empty() && !subsequent.starts_with(' ') && !subsequent.starts_with('\t') {
                    end = i + 1 + j;
                    break;
                }
            }
            break;
        }
    }

    if let Some(s) = start {
        // Replace existing block
        let before = lines[..s].join("\n");
        let after = lines[end..].join("\n");
        let mut result = before.to_string();
        if !result.is_empty() && !result.ends_with('\n') {
            result.push('\n');
        }
        result.push_str(new_block);
        if !after.is_empty() {
            result.push_str(&after);
        }
        result
    } else {
        // Insert at the beginning
        if yaml.is_empty() {
            new_block.to_string()
        } else {
            format!("{}\n{}", new_block, yaml)
        }
    }
}

/// Remove the model block from the YAML text.
fn remove_model_block(yaml: &str) -> String {
    let lines: Vec<&str> = yaml.lines().collect();
    let mut start = None;
    let mut end = lines.len();
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("model:") {
            start = Some(i);
            for (j, subsequent) in lines[i + 1..].iter().enumerate() {
                if !subsequent.is_empty() && !subsequent.starts_with(' ') && !subsequent.starts_with('\t') {
                    end = i + 1 + j;
                    break;
                }
            }
            break;
        }
    }

    if let Some(s) = start {
        let before: Vec<&str> = lines[..s].iter().copied().collect();
        let after: Vec<&str> = lines[end..].iter().copied().collect();
        let mut result = before.join("\n");
        if !after.is_empty() {
            if !result.is_empty() {
                result.push('\n');
            }
            result.push_str(&after.join("\n"));
        }
        // Trim leading newlines
        result.trim_start_matches('\n').to_string()
    } else {
        yaml.to_string()
    }
}

/// Upsert an env var line.
fn upsert_env_var(env_text: &str, key: &str, value: &str) -> String {
    let line = format!("{}={}", key, value);
    for (i, l) in env_text.lines().enumerate() {
        if l.starts_with(&format!("{}=", key)) {
            // Replace this line
            let lines: Vec<&str> = env_text.lines().collect();
            let mut result: Vec<String> = lines[..i].iter().map(|s| s.to_string()).collect();
            result.push(line.clone());
            result.extend(lines[i + 1..].iter().map(|s| s.to_string()));
            return result.join("\n") + "\n";
        }
    }
    // Append
    if env_text.is_empty() {
        format!("{}\n", line)
    } else if env_text.ends_with('\n') {
        format!("{}{}\n", env_text, line)
    } else {
        format!("{}\n{}\n", env_text, line)
    }
}

/// GET — read config.yaml, report derouter status.
pub async fn get() -> Response {
    let installed = check_installed().await;
    if !installed {
        return Json(serde_json::json!({
            "installed": false,
            "settings": null,
            "message": "Hermes Agent is not installed",
        }))
        .into_response();
    }

    let yaml = common::read_text_file(&config_path()).await;
    let model = parse_model_block(&yaml);
    let has = model
        .as_ref()
        .and_then(|m| m.get("base_url"))
        .and_then(|b| b.as_str())
        .map(|b| common::is_localhost_url(b))
        .unwrap_or(false)
        && model
            .as_ref()
            .and_then(|m| m.get("provider"))
            .and_then(|p| p.as_str())
            .map(|p| p == "custom")
            .unwrap_or(false);

    Json(serde_json::json!({
        "installed": true,
        "settings": { "model": model },
        "hasderouter": has,
        "configPath": config_path().to_string_lossy(),
    }))
    .into_response()
}

/// POST — update config.yaml model block + .env OPENAI_API_KEY.
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

    let _ = tokio::fs::create_dir_all(hermes_dir()).await;

    let normalized_base_url = common::normalize_v1(base_url);

    let existing_yaml = common::read_text_file(&config_path()).await;
    let new_yaml = upsert_model_block(&existing_yaml, &build_model_block(model, &normalized_base_url));
    if let Err(e) = tokio::fs::write(config_path(), new_yaml.as_bytes()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to update hermes settings: {}", e)})),
        )
            .into_response();
    }

    if !api_key.is_empty() {
        let existing_env = common::read_text_file(&env_path()).await;
        let new_env = upsert_env_var(&existing_env, "OPENAI_API_KEY", api_key);
        let _ = tokio::fs::write(env_path(), new_env.as_bytes()).await;
    }

    Json(serde_json::json!({
        "success": true,
        "message": "Hermes settings applied successfully!",
        "configPath": config_path().to_string_lossy(),
    }))
    .into_response()
}

/// DELETE — remove model block from config.yaml.
pub async fn delete() -> Response {
    let yaml = match common::read_text_file_opt(&config_path()).await {
        Some(y) => y,
        None => {
            return Json(serde_json::json!({
                "success": true,
                "message": "No config file to reset",
            }))
            .into_response();
        }
    };

    let new_yaml = remove_model_block(&yaml);
    if let Err(e) = tokio::fs::write(config_path(), new_yaml.as_bytes()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to reset hermes settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "derouter model block removed",
    }))
    .into_response()
}
