//! Cowork (Claude Desktop 3p) settings — reads/writes Claude Desktop's configLibrary.
//! Ported from src/app/api/cli-tools/cowork-settings/route.js.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::common;

const PROVIDER: &str = "gateway";

/// Default remote plugins (from coworkPlugins DEFAULT_PLUGINS).
const DEFAULT_PLUGINS: &[(&str, &str, &str, &[&str])] = &[
    ("exa", "Exa", "https://mcp.exa.ai/mcp", &["web_search_exa", "web_fetch_exa"]),
    ("tavily", "Tavily", "https://mcp.tavily.com/mcp", &["tavily_search", "tavily_extract", "tavily_crawl", "tavily_map"]),
];

/// Local stdio plugins (from coworkPlugins LOCAL_STDIO_PLUGINS).
const LOCAL_STDIO_PLUGINS: &[LocalStdioPlugin] = &[LocalStdioPlugin {
    name: "browsermcp",
    title: "Browser MCP",
    command: "npx",
    args: &["-y", "@browsermcp/mcp@latest"],
    tool_names: &[
        "browser_navigate", "browser_snapshot", "browser_click", "browser_type",
        "browser_screenshot", "browser_get_console_logs", "browser_wait",
        "browser_press_key", "browser_go_back", "browser_go_forward",
    ],
}];

struct LocalStdioPlugin {
    name: &'static str,
    title: &'static str,
    command: &'static str,
    args: &'static [&'static str],
    tool_names: &'static [&'static str],
}

/// Hardcoded relax-security profile.
fn security_relax() -> serde_json::Value {
    serde_json::json!({
        "coworkEgressAllowedHosts": ["*"],
        "disabledBuiltinTools": [],
        "isLocalDevMcpEnabled": true,
        "isDesktopExtensionEnabled": true,
        "isDesktopExtensionDirectoryEnabled": true,
        "isDesktopExtensionSignatureRequired": false,
        "isClaudeCodeForDesktopEnabled": true,
        "disableEssentialTelemetry": true,
        "disableNonessentialTelemetry": true,
        "disableNonessentialServices": true,
    })
}

fn candidate_roots() -> Vec<std::path::PathBuf> {
    let home = common::home_dir();
    if std::env::consts::OS == "macos" {
        let base = home.join("Library").join("Application Support");
        vec![base.join("Claude-3p"), base.join("Claude")]
    } else if std::env::consts::OS == "windows" {
        let local_app = std::env::var("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Local"));
        let roaming = std::env::var("APPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Roaming"));
        vec![
            local_app.join("Claude-3p"),
            roaming.join("Claude-3p"),
            local_app.join("Claude"),
            roaming.join("Claude"),
        ]
    } else {
        vec![
            home.join(".config").join("Claude-3p"),
            home.join(".config").join("Claude"),
        ]
    }
}

fn app_install_paths() -> Vec<std::path::PathBuf> {
    let home = common::home_dir();
    if std::env::consts::OS == "macos" {
        vec![
            std::path::PathBuf::from("/Applications/Claude.app"),
            home.join("Applications").join("Claude.app"),
        ]
    } else if std::env::consts::OS == "windows" {
        let local_app = std::env::var("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Local"));
        let program_files = std::env::var("ProgramFiles")
            .unwrap_or_else(|_| "C:\\Program Files".to_string());
        let pf_path = std::path::PathBuf::from(program_files);
        vec![
            local_app.join("AnthropicClaude"),
            pf_path.join("Claude"),
            pf_path.join("AnthropicClaude"),
        ]
    } else {
        vec![]
    }
}

async fn resolve_app_root_for_read() -> std::path::PathBuf {
    let candidates = candidate_roots();
    for dir in &candidates {
        let config_lib = dir.join("configLibrary");
        if tokio::fs::metadata(&config_lib).await.is_ok() {
            return dir.clone();
        }
    }
    candidates.first().cloned().unwrap_or_else(|| common::home_dir())
}

fn write_root() -> std::path::PathBuf {
    candidate_roots().into_iter().next().unwrap_or_else(|| common::home_dir())
}

fn write_config_dir() -> std::path::PathBuf {
    write_root().join("configLibrary")
}

fn write_meta_path() -> std::path::PathBuf {
    write_config_dir().join("_meta.json")
}

fn get_1p_root() -> std::path::PathBuf {
    let home = common::home_dir();
    if std::env::consts::OS == "macos" {
        home.join("Library").join("Application Support").join("Claude")
    } else if std::env::consts::OS == "windows" {
        std::env::var("APPDATA")
            .map(|d| std::path::PathBuf::from(d).join("Claude"))
            .unwrap_or_else(|_| home.join("AppData").join("Roaming").join("Claude"))
    } else {
        home.join(".config").join("Claude")
    }
}

fn get_1p_config_path() -> std::path::PathBuf {
    get_1p_root().join("claude_desktop_config.json")
}

async fn check_installed() -> bool {
    let mut all_paths: Vec<std::path::PathBuf> = candidate_roots();
    all_paths.extend(app_install_paths());
    for dir in &all_paths {
        if tokio::fs::metadata(dir).await.is_ok() {
            return true;
        }
    }
    false
}

/// Build managed MCP server entries from a list of plugin names.
fn build_managed_mcp_servers(plugins: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for p in plugins {
        let name = p.get("name").and_then(|n| n.as_str());
        let url = p.get("url").and_then(|u| u.as_str());
        let name = match name { Some(n) => n, None => continue };
        let url = match url { Some(u) => u, None => continue };
        if seen.contains(name) {
            continue;
        }
        seen.insert(name.to_string());

        let transport = p.get("transport").and_then(|t| t.as_str()).unwrap_or({
            if url.contains("/sse") { "sse" } else { "http" }
        });

        let mut entry = serde_json::Map::new();
        entry.insert("name".to_string(), serde_json::json!(name));
        entry.insert("url".to_string(), serde_json::json!(url));
        entry.insert("transport".to_string(), serde_json::json!(transport));

        if let Some(true) = p.get("oauth").and_then(|o| o.as_bool()) {
            entry.insert("oauth".to_string(), serde_json::json!(true));
        }

        if let Some(tool_names) = p.get("toolNames").and_then(|t| t.as_array()) {
            let names: Vec<String> = tool_names.iter().filter_map(|t| t.as_str().map(|s| s.to_string())).collect();
            if !names.is_empty() {
                let prefix = format!("{}-", name);
                let mut policy = serde_json::Map::new();
                let mut bare = std::collections::HashSet::new();
                for raw in &names {
                    let mut t = raw.clone();
                    while t.starts_with(&prefix) {
                        t = t[prefix.len()..].to_string();
                    }
                    bare.insert(t);
                }
                for t in &bare {
                    policy.insert(t.clone(), serde_json::json!("allow"));
                    policy.insert(format!("{}{}", prefix, t), serde_json::json!("allow"));
                }
                entry.insert("toolPolicy".to_string(), serde_json::Value::Object(policy));
            }
        }

        out.push(serde_json::Value::Object(entry));
    }
    out
}

/// Build SSE bridge entries pointing at this app's inline /api/mcp/{name}/sse endpoint.
fn build_local_bridge_entries(app_port: u16, local_plugin_names: &[String]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for n in local_plugin_names {
        let def = LOCAL_STDIO_PLUGINS.iter().find(|p| p.name == n.as_str());
        if def.is_none() {
            continue;
        }
        let def = def.unwrap();
        let mut entry = serde_json::Map::new();
        entry.insert("name".to_string(), serde_json::json!(def.name));
        entry.insert(
            "url".to_string(),
            serde_json::json!(format!("http://localhost:{}/api/mcp/{}/sse", app_port, def.name)),
        );
        entry.insert("transport".to_string(), serde_json::json!("sse"));

        if !def.tool_names.is_empty() {
            let prefix = format!("{}-", def.name);
            let mut policy = serde_json::Map::new();
            for t in def.tool_names {
                policy.insert(t.to_string(), serde_json::json!("allow"));
                policy.insert(format!("{}{}", prefix, t), serde_json::json!("allow"));
            }
            entry.insert("toolPolicy".to_string(), serde_json::Value::Object(policy));
        }
        out.push(serde_json::Value::Object(entry));
    }
    out
}

/// Build entries for user-defined custom MCP plugins.
fn build_custom_entries(custom_plugins: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for p in custom_plugins {
        let name = match p.get("name").and_then(|n| n.as_str()) { Some(n) => n, None => continue };
        let url = match p.get("url").and_then(|u| u.as_str()) { Some(u) => u, None => continue };
        let transport = p.get("transport").and_then(|t| t.as_str()).unwrap_or("sse");
        out.push(serde_json::json!({
            "name": name,
            "url": url,
            "transport": transport,
            "custom": true,
        }));
    }
    out
}

/// Ensure _meta.json exists with an appliedId.
async fn ensure_meta() -> serde_json::Value {
    let write_path = write_meta_path();
    let mut meta = common::read_json_file(&write_path).await;

    let need_new = meta.is_none()
        || meta.as_ref().and_then(|m| m.get("appliedId")).is_none();

    if need_new {
        // Try reading from the read path
        let read_meta_path = resolve_app_root_for_read()
            .await
            .join("configLibrary")
            .join("_meta.json");
        let existing = common::read_json_file(&read_meta_path).await;
        if let Some(existing) = existing.as_ref().and_then(|m| {
            if m.get("appliedId").is_some() {
                Some(m.clone())
            } else {
                None
            }
        }) {
            meta = Some(existing);
        } else {
            let new_id = uuid::Uuid::new_v4().to_string();
            meta = Some(serde_json::json!({
                "appliedId": new_id,
                "entries": [{"id": new_id, "name": "Default"}],
            }));
        }
    }

    let meta = meta.unwrap_or_else(|| {
        let new_id = uuid::Uuid::new_v4().to_string();
        serde_json::json!({
            "appliedId": new_id,
            "entries": [{"id": new_id, "name": "Default"}],
        })
    });

    let _ = tokio::fs::create_dir_all(write_config_dir()).await;
    let _ = common::write_json_file(&write_path, &meta).await;

    meta
}

/// Write operonSkipMcpApprovals for managed servers.
async fn write_skip_approvals(managed_servers: &[serde_json::Value]) -> serde_json::Value {
    let cfg_path = write_root().join("config.json");
    let mut cfg = common::read_json_file(&cfg_path).await.unwrap_or(serde_json::json!({}));

    if !cfg.is_object() {
        cfg = serde_json::json!({});
    }

    let mut skip = serde_json::Map::new();
    for srv in managed_servers {
        if let Some(name) = srv.get("name").and_then(|n| n.as_str()) {
            skip.insert(name.to_string(), serde_json::json!(true));
        }
    }

    cfg.as_object_mut().unwrap().insert("operonSkipMcpApprovals".to_string(), serde_json::Value::Object(skip));

    let _ = tokio::fs::create_dir_all(write_root()).await;
    let _ = common::write_json_file(&cfg_path, &cfg).await;

    serde_json::json!({"written": managed_servers.len()})
}

/// Bootstrap deployment mode to "3p" in 1p config.
async fn bootstrap_deployment_mode() -> bool {
    let path = get_1p_config_path();
    let mut cfg = common::read_json_file(&path).await.unwrap_or(serde_json::json!({}));
    if cfg.get("deploymentMode").and_then(|d| d.as_str()) == Some("3p") {
        return false;
    }
    if !cfg.is_object() {
        cfg = serde_json::json!({});
    }
    cfg.as_object_mut().unwrap().insert("deploymentMode".to_string(), serde_json::json!("3p"));

    let _ = tokio::fs::create_dir_all(get_1p_root()).await;
    let _ = common::write_json_file(&path, &cfg).await;
    true
}

/// Remove legacy stdio entries from 1p claude_desktop_config.json.
async fn cleanup_1p_legacy() {
    let path = get_1p_config_path();
    let mut cfg = common::read_json_file(&path).await.unwrap_or(serde_json::json!({}));
    if !cfg.is_object() {
        return;
    }
    let managed_names: std::collections::HashSet<&str> = LOCAL_STDIO_PLUGINS.iter().map(|p| p.name).collect();
    if let Some(obj) = cfg.as_object_mut() {
        if let Some(mcp_servers) = obj.get_mut("mcpServers").and_then(|m| m.as_object_mut()) {
            let keys_to_remove: Vec<String> = mcp_servers
                .keys()
                .filter(|k| managed_names.contains(k.as_str()))
                .cloned()
                .collect();
            for k in keys_to_remove {
                mcp_servers.remove(&k);
            }
            if mcp_servers.is_empty() {
                obj.remove("mcpServers");
            }
        }
    }
    let _ = common::write_json_file(&path, &cfg).await;
}

/// GET — read cowork settings from Claude Desktop 3p config.
pub async fn get() -> Response {
    let installed = check_installed().await;
    if !installed {
        return Json(serde_json::json!({
            "installed": false,
            "config": null,
            "message": "Claude Desktop (Cowork mode) not detected",
        }))
        .into_response();
    }

    let app_root = resolve_app_root_for_read().await;
    let config_dir = app_root.join("configLibrary");
    let meta_path = config_dir.join("_meta.json");
    let meta = common::read_json_file(&meta_path).await;
    let applied_id = meta.as_ref().and_then(|m| m.get("appliedId")).and_then(|a| a.as_str()).map(|s| s.to_string());
    let config_path = applied_id.as_ref().map(|id| config_dir.join(format!("{}.json", id)));
    let config = match &config_path {
        Some(p) => common::read_json_file(p).await,
        None => None,
    };

    let base_url = config.as_ref().and_then(|c| c.get("inferenceGatewayBaseUrl")).and_then(|b| b.as_str()).map(|s| s.to_string());
    let models: Vec<String> = config
        .as_ref()
        .and_then(|c| c.get("inferenceModels"))
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    if let Some(s) = m.as_str() {
                        Some(s.to_string())
                    } else {
                        m.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let managed_mcp = config
        .as_ref()
        .and_then(|c| c.get("managedMcpServers"))
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();

    let has_derouter = config
        .as_ref()
        .and_then(|c| c.get("inferenceProvider"))
        .and_then(|p| p.as_str())
        .map(|p| p == PROVIDER)
        .unwrap_or(false)
        && base_url.is_some();

    // Active local plugins
    let stdio_names: std::collections::HashSet<&str> = LOCAL_STDIO_PLUGINS.iter().map(|p| p.name).collect();
    let active_local_names: Vec<String> = managed_mcp
        .iter()
        .filter(|m| {
            let name = m.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let url = m.get("url").and_then(|u| u.as_str()).unwrap_or("");
            stdio_names.contains(name) && url.contains("/api/mcp/")
        })
        .map(|m| m.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string())
        .collect();

    // Custom plugins
    let active_custom_plugins: Vec<serde_json::Value> = managed_mcp
        .iter()
        .filter(|m| {
            let custom = m.get("custom").and_then(|c| c.as_bool()).unwrap_or(false);
            let name = m.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let url = m.get("url").and_then(|u| u.as_str()).unwrap_or("");
            custom || (!stdio_names.contains(name) && url.contains("/api/mcp/"))
        })
        .map(|m| {
            serde_json::json!({
                "name": m.get("name"),
                "url": m.get("url"),
                "transport": m.get("transport"),
                "custom": true,
            })
        })
        .collect();

    // Build default plugins response
    let default_plugins: Vec<serde_json::Value> = DEFAULT_PLUGINS
        .iter()
        .map(|(name, title, url, tool_names)| {
            serde_json::json!({
                "name": name,
                "title": title,
                "description": "",
                "url": url,
                "transport": "http",
                "oauth": false,
                "toolNames": tool_names,
            })
        })
        .collect();

    let local_stdio_plugins: Vec<serde_json::Value> = LOCAL_STDIO_PLUGINS
        .iter()
        .map(|p| {
            serde_json::json!({
                "name": p.name,
                "title": p.title,
                "description": "",
                "command": p.command,
                "args": p.args,
                "toolNames": p.tool_names,
            })
        })
        .collect();

    // Plugins (non-custom, non-local-bridge)
    let cowork_plugins: Vec<serde_json::Value> = managed_mcp
        .iter()
        .filter(|m| {
            let custom = m.get("custom").and_then(|c| c.as_bool()).unwrap_or(false);
            let name = m.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let url = m.get("url").and_then(|u| u.as_str()).unwrap_or("");
            !custom && !(stdio_names.contains(name) && url.contains("/api/mcp/"))
        })
        .map(|m| {
            let name = m.get("name").and_then(|n| n.as_str()).unwrap_or("");
            // Find default toolNames
            let def = DEFAULT_PLUGINS.iter().find(|(dn, _, _, _)| *dn == name);
            let tool_names: Vec<String> = if let Some((_, _, _, tn)) = def {
                tn.iter().map(|s| s.to_string()).collect()
            } else {
                // Extract from toolPolicy
                m.get("toolPolicy")
                    .and_then(|tp| tp.as_object())
                    .map(|tp| {
                        let prefix = format!("{}-", name);
                        let mut bare = std::collections::HashSet::new();
                        for k in tp.keys() {
                            let mut t = k.clone();
                            while t.starts_with(&prefix) {
                                t = t[prefix.len()..].to_string();
                            }
                            bare.insert(t);
                        }
                        bare.into_iter().collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            };
            serde_json::json!({
                "name": name,
                "url": m.get("url"),
                "transport": m.get("transport"),
                "oauth": m.get("oauth").and_then(|o| o.as_bool()).unwrap_or(false),
                "toolNames": tool_names,
            })
        })
        .collect();

    Json(serde_json::json!({
        "installed": true,
        "config": config,
        "hasderouter": has_derouter,
        "configPath": config_path,
        "cowork": {
            "appliedId": applied_id,
            "baseUrl": base_url,
            "models": models,
            "provider": config.as_ref().and_then(|c| c.get("inferenceProvider")).and_then(|p| p.as_str()),
            "plugins": cowork_plugins,
            "localPlugins": active_local_names,
            "customPlugins": active_custom_plugins,
        },
        "defaultPlugins": default_plugins,
        "localStdioPlugins": local_stdio_plugins,
    }))
    .into_response()
}

/// POST — apply derouter config to Claude Desktop 3p.
pub async fn post(body: Json<serde_json::Value>) -> Response {
    let body = body.0;
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let models = body.get("models").and_then(|v| v.as_array());
    let plugins = body.get("plugins").and_then(|v| v.as_array());
    let local_plugins = body.get("localPlugins").and_then(|v| v.as_array());
    let custom_plugins = body.get("customPlugins").and_then(|v| v.as_array());

    if base_url.is_empty() || api_key.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "baseUrl and apiKey are required"})),
        )
            .into_response();
    }

    let models_array: Vec<String> = models
        .map(|arr| arr.iter().filter_map(|m| m.as_str().filter(|s| !s.trim().is_empty()).map(|s| s.to_string())).collect())
        .unwrap_or_default();
    if models_array.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "At least one model is required"})),
        )
            .into_response();
    }

    let plugins_array: Vec<serde_json::Value> = plugins.map(|p| p.to_vec()).unwrap_or_else(|| {
        DEFAULT_PLUGINS
            .iter()
            .map(|(name, _, url, tool_names)| {
                serde_json::json!({
                    "name": name,
                    "url": url,
                    "transport": "http",
                    "toolNames": tool_names,
                })
            })
            .collect()
    });

    let local_plugin_names: Vec<String> = local_plugins
        .map(|arr| arr.iter().filter_map(|n| n.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    let custom_plugins_array: Vec<serde_json::Value> = custom_plugins
        .map(|arr| arr.iter().filter(|p| p.get("url").is_some()).cloned().collect())
        .unwrap_or_default();

    let app_port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);

    let bridge_entries = build_local_bridge_entries(app_port, &local_plugin_names);
    let custom_entries = build_custom_entries(&custom_plugins_array);
    let managed = build_managed_mcp_servers(&plugins_array);
    let mut managed_mcp_servers = managed;
    managed_mcp_servers.extend(bridge_entries);
    managed_mcp_servers.extend(custom_entries);

    let bootstrapped = bootstrap_deployment_mode().await;
    let meta = ensure_meta().await;
    let applied_id = meta.get("appliedId").and_then(|a| a.as_str()).unwrap_or("").to_string();

    let config_path = write_config_dir().join(format!("{}.json", applied_id));

    let mut new_config = security_relax();
    {
    let obj = new_config.as_object_mut().unwrap();
    obj.insert("inferenceProvider".to_string(), serde_json::json!(PROVIDER));
    obj.insert("inferenceGatewayBaseUrl".to_string(), serde_json::json!(base_url));
    obj.insert("inferenceGatewayApiKey".to_string(), serde_json::json!(api_key));
    obj.insert(
        "inferenceModels".to_string(),
        serde_json::Value::Array(
            models_array.iter().map(|n| serde_json::json!({"name": n})).collect(),
        ),
    );
    if !managed_mcp_servers.is_empty() {
        obj.insert("managedMcpServers".to_string(), serde_json::Value::Array(managed_mcp_servers.clone()));
    }
    }

    if let Err(e) = common::write_json_file(&config_path, &new_config).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to apply cowork settings: {}", e)})),
        )
            .into_response();
    }

    let skip_result = write_skip_approvals(&managed_mcp_servers).await;
    let _ = cleanup_1p_legacy().await;

    Json(serde_json::json!({
        "success": true,
        "bootstrapped": bootstrapped,
        "message": if bootstrapped {
            "Cowork enabled (3p mode set). Quit & reopen Claude Desktop."
        } else {
            "Cowork settings applied. Quit & reopen Claude Desktop."
        },
        "configPath": config_path.to_string_lossy(),
        "skipApprovals": skip_result,
        "localMcp": {
            "applied": local_plugin_names,
            "via": "3p-sse-bridge",
        },
    }))
    .into_response()
}

/// DELETE — reset cowork config.
pub async fn delete() -> Response {
    let app_root = resolve_app_root_for_read().await;
    let config_dir = app_root.join("configLibrary");
    let meta_path = config_dir.join("_meta.json");
    let meta = common::read_json_file(&meta_path).await;

    let applied_id = meta.as_ref().and_then(|m| m.get("appliedId")).and_then(|a| a.as_str()).map(|s| s.to_string());
    if applied_id.is_none() {
        return Json(serde_json::json!({
            "success": true,
            "message": "No active config to reset",
        }))
        .into_response();
    }

    let config_path = config_dir.join(format!("{}.json", applied_id.unwrap()));
    let _ = common::write_json_file(&config_path, &serde_json::json!({})).await;
    let _ = write_skip_approvals(&[]).await;
    let _ = cleanup_1p_legacy().await;

    Json(serde_json::json!({
        "success": true,
        "message": "Cowork config reset",
    }))
    .into_response()
}
