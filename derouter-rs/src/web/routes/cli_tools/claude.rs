//! Claude CLI settings — reads/writes `~/.claude/settings.json` (env fields) and `~/.claude.json` (mcpServers).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

/// The exa MCP plugin entry shape (from coworkPlugins DEFAULT_PLUGINS).
const EXA_MCP_URL: &str = "https://mcp.exa.ai/mcp";

fn settings_path() -> std::path::PathBuf {
    common::home_dir().join(".claude").join("settings.json")
}

fn claude_json_path() -> std::path::PathBuf {
    common::home_dir().join(".claude.json")
}

async fn check_installed() -> bool {
    common::check_installed("claude", &[settings_path()]).await
}

/// Read ~/.claude.json, tolerating trailing commas.
async fn read_claude_json() -> Option<serde_json::Value> {
    common::read_json_file(&claude_json_path()).await
}

/// Write mcpServers.exa into ~/.claude.json (merge with existing mcpServers).
async fn write_claude_json_mcp(mcp_servers: Option<&serde_json::Map<String, serde_json::Value>>) {
    let path = claude_json_path();
    let mut data = common::read_json_file(&path).await.unwrap_or(serde_json::json!({}));

    if let Some(obj) = data.as_object_mut() {
        if let Some(servers) = mcp_servers {
            // Merge into existing mcpServers
            if !obj.contains_key("mcpServers") {
                obj.insert("mcpServers".to_string(), serde_json::json!({}));
            }
            if let Some(serde_json::Value::Object(existing)) = obj.get_mut("mcpServers") {
                for (k, v) in servers {
                    existing.insert(k.clone(), v.clone());
                }
            }
        } else {
            // Remove exa from mcpServers
            if let Some(serde_json::Value::Object(existing)) = obj.get_mut("mcpServers") {
                existing.remove("exa");
                if existing.is_empty() {
                    obj.remove("mcpServers");
                }
            }
        }
    }

    let _ = common::write_json_file(&path, &data).await;
}

/// GET — read settings + report hasderouter + exaMcpEnabled.
pub async fn get() -> Response {
    let installed = check_installed().await;

    if !installed {
        return Json(serde_json::json!({
            "installed": false,
            "settings": null,
            "message": "Claude CLI is not installed",
        }))
        .into_response();
    }

    let settings = common::read_json_file(&settings_path()).await;
    let hasderouter = settings
        .as_ref()
        .and_then(|s| s.get("env"))
        .and_then(|e| e.get("ANTHROPIC_BASE_URL"))
        .is_some();

    let claude_json = read_claude_json().await;
    let exa_mcp_enabled = claude_json
        .as_ref()
        .and_then(|c| c.get("mcpServers"))
        .and_then(|m| m.get("exa"))
        .is_some();

    Json(serde_json::json!({
        "installed": true,
        "settings": settings,
        "hasderouter": hasderouter,
        "exaMcpEnabled": exa_mcp_enabled,
        "settingsPath": settings_path().to_string_lossy(),
    }))
    .into_response()
}

/// POST — write env fields to settings.json, toggle exa MCP in ~/.claude.json.
pub async fn post(body: Json<serde_json::Value>) -> Response {
    let body = body.0;
    let env = body.get("env");
    let exa_mcp_enabled = body.get("exaMcpEnabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let max_context_tokens = body.get("maxContextTokens");

    if env.is_none() || !env.unwrap().is_object() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid env object"})),
        )
            .into_response();
    }

    let path = settings_path();

    // Read current settings
    let mut current_settings = common::read_json_file(&path).await.unwrap_or(serde_json::json!({}));

    // Ensure it's an object
    if !current_settings.is_object() {
        current_settings = serde_json::json!({});
    }

    let obj = current_settings.as_object_mut().unwrap();

    // Set hasCompletedOnboarding
    obj.insert("hasCompletedOnboarding".to_string(), serde_json::json!(true));

    // Merge env
    let mut new_env = if let Some(existing_env) = obj.get("env").cloned() {
        if let Some(mut existing) = existing_env.as_object().cloned() {
            if let Some(incoming) = env.and_then(|e| e.as_object()) {
                for (k, v) in incoming {
                    // Normalize ANTHROPIC_BASE_URL to ensure /v1 suffix
                    if k == "ANTHROPIC_BASE_URL" {
                        if let Some(url) = v.as_str() {
                            let normalized = common::normalize_v1(url);
                            existing.insert(k.clone(), serde_json::json!(normalized));
                            continue;
                        }
                    }
                    existing.insert(k.clone(), v.clone());
                }
            }
            existing
        } else {
            env.and_then(|e| e.as_object().cloned()).unwrap_or_default()
        }
    } else {
        env.and_then(|e| e.as_object().cloned()).unwrap_or_default()
    };

    // CLAUDE_CODE_MAX_CONTEXT_TOKENS — only set when a concrete value is chosen
    if let Some(mct) = max_context_tokens {
        if let Some(val) = mct.as_str() {
            new_env.insert("CLAUDE_CODE_MAX_CONTEXT_TOKENS".to_string(), serde_json::json!(val));
        } else if let Some(val) = mct.as_i64() {
            new_env.insert("CLAUDE_CODE_MAX_CONTEXT_TOKENS".to_string(), serde_json::json!(val.to_string()));
        }
    } else {
        new_env.remove("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    }

    obj.insert("env".to_string(), serde_json::Value::Object(new_env));

    if let Err(e) = common::write_json_file(&path, &current_settings).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to update claude settings: {}", e)})),
        )
            .into_response();
    }

    // Exa MCP toggle — write to ~/.claude.json
    if exa_mcp_enabled {
        let mut mcp = serde_json::Map::new();
        mcp.insert(
            "exa".to_string(),
            serde_json::json!({
                "type": "http",
                "url": EXA_MCP_URL,
            }),
        );
        write_claude_json_mcp(Some(&mcp)).await;
    } else {
        write_claude_json_mcp(None).await;
    }

    Json(serde_json::json!({
        "success": true,
        "message": "Settings updated successfully",
    }))
    .into_response()
}

/// DELETE — remove derouter env fields from settings.json + remove exa MCP from ~/.claude.json.
pub async fn delete() -> Response {
    let path = settings_path();

    let mut current_settings = match common::read_json_file(&path).await {
        Some(s) => s,
        None => {
            return Json(serde_json::json!({
                "success": true,
                "message": "No settings file to reset",
            }))
            .into_response();
        }
    };

    let reset_keys = [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "API_TIMEOUT_MS",
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    ];

    if let Some(obj) = current_settings.as_object_mut() {
        if let Some(serde_json::Value::Object(env)) = obj.get_mut("env") {
            for key in reset_keys {
                env.remove(key);
            }
            if env.is_empty() {
                obj.remove("env");
            }
        }
    }

    // Remove exa MCP from ~/.claude.json
    write_claude_json_mcp(None).await;

    if let Err(e) = common::write_json_file(&path, &current_settings).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to reset claude settings: {}", e)})),
        )
            .into_response();
    }

    Json(serde_json::json!({
        "success": true,
        "message": "Settings reset successfully",
    }))
    .into_response()
}
