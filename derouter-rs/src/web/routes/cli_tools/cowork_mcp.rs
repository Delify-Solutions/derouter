//! Cowork MCP registry + tools routes — external API proxy with caching.
//! Ported from src/app/api/cli-tools/cowork-mcp-registry/route.js + cowork-mcp-tools/route.js.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use once_cell::sync::Lazy;

const REGISTRY_URL: &str = "https://api.anthropic.com/mcp-registry/v0/servers";
const VISIBILITY: &str = "commercial,gsuite,gsuite-google";
const CACHE_TTL: Duration = Duration::from_secs(3600); // 1 hour
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

struct RegistryCache {
    ts: Option<Instant>,
    data: Option<serde_json::Value>,
}

static REGISTRY_CACHE: Lazy<Mutex<RegistryCache>> = Lazy::new(|| {
    Mutex::new(RegistryCache {
        ts: None,
        data: None,
    })
});

/// Check if a URL is a direct-connect HTTPS URL (not claude.ai-mediated, no tenant-required).
fn is_direct_connect(url: &str) -> bool {
    if url.is_empty() {
        return false;
    }
    // Reject claude.ai-mediated servers
    if url.contains("mcp.claude.com") {
        return false;
    }
    if url.contains("api.anthropic.com/mcp") {
        return false;
    }
    // Reject URLs with template placeholders
    if url.contains('{') || url.contains('<') {
        return false;
    }
    // Must be HTTPS
    url.starts_with("https://")
}

/// Fetch all servers from the registry with pagination.
async fn fetch_all() -> Result<Vec<serde_json::Value>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    let mut cursor: Option<String> = None;

    for _ in 0..20 {
        let mut url = format!("{}?limit=500&visibility={}", REGISTRY_URL, VISIBILITY);
        if let Some(c) = &cursor {
            url.push_str(&format!("&cursor={}", urlencode(c)));
        }

        let resp = client
            .get(&url)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            break;
        }

        let j: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

        if let Some(servers) = j.get("servers").and_then(|s| s.as_array()) {
            for item in servers {
                let empty = serde_json::json!({});
                let s = item.get("server").unwrap_or(&empty);
                let empty2 = serde_json::json!({});
                let meta = item
                    .get("_meta")
                    .and_then(|m| m.get("com.anthropic.api/mcp-registry"))
                    .unwrap_or(&empty2);

                let remotes = s.get("remotes").and_then(|r| r.as_array());
                let remote = remotes.and_then(|arr| arr.first());
                let remote_url = remote.and_then(|r| r.get("url")).and_then(|u| u.as_str()).unwrap_or("");

                if !is_direct_connect(remote_url) {
                    continue;
                }

                // Skip entries with required fields
                if let Some(req_fields) = meta.get("requiredFields").and_then(|f| f.as_array()) {
                    if !req_fields.is_empty() {
                        continue;
                    }
                }

                let transport = if remote.and_then(|r| r.get("type")).and_then(|t| t.as_str()) == Some("sse") {
                    "sse"
                } else {
                    "http"
                };

                let tool_names: Vec<String> = meta
                    .get("toolNames")
                    .and_then(|t| t.as_array())
                    .map(|arr| arr.iter().filter_map(|t| t.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();

                let name = s.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                let slug = meta.get("slug").and_then(|s| s.as_str()).unwrap_or(&name).to_string();
                let title = s
                    .get("title")
                    .and_then(|t| t.as_str())
                    .or_else(|| meta.get("displayName").and_then(|d| d.as_str()))
                    .unwrap_or(&name)
                    .to_string();
                let description = s
                    .get("description")
                    .and_then(|d| d.as_str())
                    .or_else(|| meta.get("oneLiner").and_then(|o| o.as_str()))
                    .unwrap_or("")
                    .to_string();
                let oauth = !meta.get("isAuthless").and_then(|a| a.as_bool()).unwrap_or(false);
                let icon_url = meta.get("iconUrl").and_then(|i| i.as_str()).map(|s| s.to_string());

                out.push(serde_json::json!({
                    "name": name,
                    "slug": slug,
                    "title": title,
                    "description": description,
                    "url": remote_url,
                    "transport": transport,
                    "oauth": oauth,
                    "toolNames": tool_names.clone(),
                    "toolCount": tool_names.len(),
                    "iconUrl": icon_url,
                }));
            }
        }

        cursor = j
            .get("metadata")
            .and_then(|m| m.get("nextCursor"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());

        if cursor.is_none() {
            break;
        }
    }

    // Dedupe by URL
    let mut seen = std::collections::HashSet::new();
    let deduped: Vec<serde_json::Value> = out
        .into_iter()
        .filter(|s| {
            let url = s.get("url").and_then(|u| u.as_str()).unwrap_or("");
            if seen.contains(url) {
                false
            } else {
                seen.insert(url.to_string());
                true
            }
        })
        .collect();

    Ok(deduped)
}

/// GET /api/cli-tools/cowork-mcp-registry — list MCP servers from Anthropic registry (1h cache).
pub async fn registry_get(query: axum::extract::Query<std::collections::HashMap<String, String>>) -> Response {
    let force = query.get("refresh").map(|r| r == "1").unwrap_or(false);

    {
        let cache = REGISTRY_CACHE.lock().unwrap();
        if !force {
            if let (Some(ts), Some(data)) = (cache.ts, &cache.data) {
                if ts.elapsed() < CACHE_TTL {
                    let mut response = serde_json::Map::new();
                    response.insert("cached".to_string(), serde_json::json!(true));
                    if let Some(d) = data.as_object() {
                        for (k, v) in d {
                            response.insert(k.clone(), v.clone());
                        }
                    }
                    return Json(serde_json::Value::Object(response)).into_response();
                }
            }
        }
    }

    match fetch_all().await {
        Ok(servers) => {
            let data = serde_json::json!({
                "servers": servers,
                "total": servers.len(),
            });

            let mut cache = REGISTRY_CACHE.lock().unwrap();
            cache.ts = Some(Instant::now());
            cache.data = Some(data.clone());

            let mut response = serde_json::Map::new();
            response.insert("cached".to_string(), serde_json::json!(false));
            response.insert("servers".to_string(), serde_json::json!(servers.clone()));
            response.insert("total".to_string(), serde_json::json!(servers.len()));
            Json(serde_json::Value::Object(response)).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e, "servers": [], "total": 0})),
        )
            .into_response(),
    }
}

/// POST /api/cli-tools/cowork-mcp-tools — probe an MCP server for tool listing.
pub async fn tools_post(body: Json<serde_json::Value>) -> Response {
    let url = body.get("url").and_then(|u| u.as_str());
    let url = match url {
        Some(u) if !u.is_empty() => u.to_string(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "url required"})),
            )
                .into_response();
        }
    };

    let result = probe_mcp(&url).await;
    Json(result).into_response()
}

/// Probe an MCP server: initialize + tools/list.
async fn probe_mcp(url: &str) -> serde_json::Value {
    let client = match reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => return serde_json::json!({"error": e.to_string(), "tools": []}),
    };

    let headers = reqwest::header::HeaderMap::from_iter([
        (reqwest::header::CONTENT_TYPE, "application/json".parse().unwrap()),
        (reqwest::header::ACCEPT, "application/json, text/event-stream".parse().unwrap()),
        ("MCP-Protocol-Version".parse().unwrap(), "2025-06-18".parse().unwrap()),
    ]);

    // Step 1: initialize
    let init_body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "derouter", "version": "1"}
        }
    });

    let init_res = match client.post(url).headers(headers.clone()).json(&init_body).send().await {
        Ok(r) => r,
        Err(e) => {
            if e.is_timeout() {
                return serde_json::json!({"error": "timeout", "tools": []});
            }
            return serde_json::json!({"error": e.to_string(), "tools": []});
        }
    };

    let status = init_res.status().as_u16();
    if status == 401 || status == 403 {
        return serde_json::json!({"requiresAuth": true, "tools": []});
    }
    if status != 200 {
        return serde_json::json!({"error": format!("init {}", status), "tools": []});
    }

    let session_id = init_res
        .headers()
        .get("mcp-session-id")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Consume the init response body
    let _ = init_res.text().await;

    // Build headers for subsequent requests
    let mut list_headers = headers.clone();
    if !session_id.is_empty() {
        if let Ok(val) = reqwest::header::HeaderName::from_bytes(b"mcp-session-id") {
            if let Ok(session_val) = reqwest::header::HeaderValue::from_str(&session_id) {
                list_headers.insert(val, session_val);
            }
        }
    }

    // Step 2: notifications/initialized (required before tools/list)
    let notif_body = serde_json::json!({
        "jsonrpc": "2.0", "method": "notifications/initialized", "params": {}
    });
    let _ = client.post(url).headers(list_headers.clone()).json(&notif_body).send().await;

    // Step 3: tools/list
    let list_body = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/list"
    });

    let list_res = match client.post(url).headers(list_headers).json(&list_body).send().await {
        Ok(r) => r,
        Err(e) => {
            if e.is_timeout() {
                return serde_json::json!({"error": "timeout", "tools": []});
            }
            return serde_json::json!({"error": e.to_string(), "tools": []});
        }
    };

    let list_status = list_res.status().as_u16();
    if list_status == 401 || list_status == 403 {
        return serde_json::json!({"requiresAuth": true, "tools": []});
    }

    let content_type = list_res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_string();

    let parsed: Option<serde_json::Value> = if content_type.contains("text/event-stream") {
        // Parse SSE
        let text = list_res.text().await.unwrap_or_default();
        for line in text.lines() {
            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(obj) = serde_json::from_str::<serde_json::Value>(data) {
                    if obj.get("id").and_then(|i| i.as_i64()) == Some(2) && obj.get("result").is_some() {
                        return parse_tools(&obj);
                    }
                }
            }
        }
        None
    } else {
        list_res.json().await.ok()
    };

    parse_tools(&parsed.unwrap_or(serde_json::json!({})))
}

fn parse_tools(parsed: &serde_json::Value) -> serde_json::Value {
    let tools = parsed
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .map(|t| {
                    serde_json::json!({
                        "name": t.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                        "description": t.get("description").and_then(|d| d.as_str()).unwrap_or(""),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    serde_json::json!({"tools": tools})
}

fn urlencode(s: &str) -> String {
    let mut result = String::new();
    for c in s.chars() {
        if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' {
            result.push(c);
        } else {
            let bytes = c.to_string().into_bytes();
            for b in bytes {
                result.push_str(&format!("%{:02X}", b));
            }
        }
    }
    result
}
