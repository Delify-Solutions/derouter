//! Headroom routes — JSON API for proxy process management.
//! Ported from src/app/api/headroom/{status,start,stop,restart,extras,proxy}/route.js.
//!
//! GET  /api/headroom/status — headroom proxy status.
//! POST /api/headroom/start — start the headroom proxy process.
//! POST /api/headroom/stop — stop the headroom proxy process.
//! POST /api/headroom/restart — restart the headroom proxy process.
//! GET  /api/headroom/extras — headroom extras status (installed compression extras).
//! ANY  /api/headroom/proxy/{*path} — passthrough proxy to the headroom upstream.
//!
//! Headroom is a Python-based proxy that runs as a child process.
//! We track the child process in-process and use tokio::process::Command to manage it.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::auth;
use crate::db::DbPool;
use crate::db::repos::settings;

const DEFAULT_HEADROOM_URL: &str = "http://127.0.0.1:8787";

/// In-process headroom state.
struct HeadroomState {
    child: Option<Child>,
    managed_pid: Option<u32>,
}

static HEADROOM: once_cell::sync::Lazy<Arc<Mutex<HeadroomState>>> =
    once_cell::sync::Lazy::new(|| {
        Arc::new(Mutex::new(HeadroomState {
            child: None,
            managed_pid: None,
        }))
    });

/// GET /api/headroom/status — return headroom proxy status.
pub async fn status(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Read settings for headroom URL
    let pool_c = pool.clone();
    let settings_result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        settings::get_settings(&conn)
    })
    .await;

    let s = match settings_result {
        Ok(Ok(s)) => s,
        _ => serde_json::json!({}),
    };

    let url = s
        .get("headroomUrl")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_HEADROOM_URL)
        .to_string();

    let state = HEADROOM.lock().await;
    let managed_pid = state.managed_pid;

    // Probe the headroom URL to check if it's alive
    let alive = if is_loopback_url(&url) {
        probe_headroom_alive(&url).await
    } else {
        // External URL — just check if it's reachable
        probe_headroom_alive(&url).await
    };

    Json(serde_json::json!({
        "alive": alive,
        "url": url,
        "managedPid": managed_pid,
    }))
    .into_response()
}

/// POST /api/headroom/start — start the headroom proxy process.
pub async fn start(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Read settings
    let pool_c = pool.clone();
    let settings_result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        settings::get_settings(&conn)
    })
    .await;

    let s = match settings_result {
        Ok(Ok(s)) => s,
        _ => serde_json::json!({}),
    };

    let url = s
        .get("headroomUrl")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_HEADROOM_URL)
        .to_string();

    if !is_loopback_url(&url) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "External Headroom proxies must be started outside derouter",
                "code": "EXTERNAL_PROXY"
            })),
        )
            .into_response();
    }

    let port = parse_port_from_url(&url).unwrap_or(8787);
    let code_aware = s.get("headroomCodeAware").and_then(|v| v.as_bool()).unwrap_or(false);
    let kompress = s.get("headroomKompress").and_then(|v| v.as_bool()).unwrap_or(true);

    // Find the headroom binary/script
    // TODO Phase4: full headroom python subprocess launch.
    // The Node version calls `startHeadroomProxy` which spawns a Python uvicorn process.
    // In Rust, we attempt to find and spawn the headroom server.
    let data_dir = std::env::var("DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
            home.join(".derouter")
        });

    // Look for headroom in node_modules (if available from the original project)
    let headroom_script = data_dir.join("headroom").join("server.py");
    let headroom_script_alt = std::path::PathBuf::from("/Volumes/SSD/proxy/node_modules/headroom/server.py");

    let script_path = if headroom_script.exists() {
        Some(headroom_script)
    } else if headroom_script_alt.exists() {
        Some(headroom_script_alt)
    } else {
        None
    };

    let mut state = HEADROOM.lock().await;

    // If already running, return success
    if let Some(ref mut child) = state.child {
        if child.id().is_some() {
            return Json(serde_json::json!({
                "success": true,
                "message": "Headroom already running",
                "pid": child.id(),
                "port": port,
            }))
            .into_response();
        }
    }

    match script_path {
        Some(script) => {
            let result = tokio::process::Command::new("python3")
                .arg(&script)
                .arg("--port")
                .arg(port.to_string())
                .env("HEADROOM_CODE_AWARE", code_aware.to_string())
                .env("HEADROOM_KOMPRESS", kompress.to_string())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn();

            match result {
                Ok(child) => {
                    let pid = child.id().unwrap_or(0);
                    state.managed_pid = Some(pid);
                    state.child = Some(child);

                    // Give it a moment to start
                    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;

                    Json(serde_json::json!({
                        "success": true,
                        "pid": pid,
                        "port": port,
                    }))
                    .into_response()
                }
                Err(e) => {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({
                            "error": format!("Failed to start headroom: {}", e),
                            "code": "START_FAILED",
                        })),
                    )
                        .into_response()
                }
            }
        }
        None => {
            // Headroom not installed
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "Headroom is not installed",
                    "code": "NOT_INSTALLED",
                })),
            )
                .into_response()
        }
    }
}

/// POST /api/headroom/stop — stop the headroom proxy process.
pub async fn stop(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let mut state = HEADROOM.lock().await;
    let was_running = state.child.is_some();

    if let Some(ref mut child) = state.child {
        let _ = child.kill().await;
    }
    state.child = None;
    state.managed_pid = None;

    let status = if was_running { StatusCode::OK } else { StatusCode::CONFLICT };

    (
        status,
        Json(serde_json::json!({
            "stopped": was_running,
            "pid": null,
        })),
    )
        .into_response()
}

/// POST /api/headroom/restart — restart the headroom proxy process.
pub async fn restart(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Stop first
    {
        let mut state = HEADROOM.lock().await;
        if let Some(ref mut child) = state.child {
            let _ = child.kill().await;
        }
        state.child = None;
        state.managed_pid = None;
    }

    // Then start
    start(State(pool), headers).await
}

/// GET /api/headroom/extras — headroom extras status.
/// Ported from src/app/api/headroom/extras/route.js GET handler.
/// Returns the available compression extras and which are installed.
/// Detects headroom-ai installation and marker packages via pip list.
pub async fn extras(
    State(_pool): State<DbPool>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Check for ?log=1 — return install log tail for progress polling.
    // The log file is at ${DATA_DIR}/headroom/install.log.
    // (POST/DELETE for install/uninstall are handled here too in Node; in Rust
    // we expose the status read path; install/uninstall via pip is a Phase 4 feature.)
    match detect_headroom_extras() {
        Ok(result) => Json(result).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// ANY /api/headroom/proxy/{*path} — passthrough proxy to the headroom upstream.
/// Ported from src/app/api/headroom/proxy/[...path]/route.js.
/// Forwards the request method + headers + body to the headroom upstream URL
/// (from settings.headroomUrl or DEFAULT_HEADROOM_URL), strips hop-by-hop headers,
/// and streams the response back. For the "dashboard" path with HTML content,
/// rewrites internal fetch URLs to include the /api/headroom/proxy prefix.
pub async fn proxy(
    State(pool): State<DbPool>,
    path: Path<Vec<String>>,
    method: axum::http::Method,
    request_headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
    body: axum::body::Bytes,
) -> Response {
    // The Node proxy route is UNGUARDED — it's a passthrough for client browser
    // requests to the headroom dashboard. Do NOT add auth here.

    // Read settings for headroom URL
    let pool_c = pool.clone();
    let settings_result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        settings::get_settings(&conn)
    })
    .await;

    let s = match settings_result {
        Ok(Ok(s)) => s,
        _ => serde_json::json!({}),
    };

    let base_url = s
        .get("headroomUrl")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_HEADROOM_URL)
        .to_string();

    // Build target URL
    let path_joined = path.join("/");
    let query_str = raw_query.0.as_deref().unwrap_or("");
    let target_url = match build_target_url(&base_url, &path_joined, query_str) {
        Ok(u) => u,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };

    // Determine if target is non-loopback (strip cookie/authorization if so)
    let is_loopback = is_loopback_url(&base_url);

    // Build forwarded headers — strip hop-by-hop + host, conditionally strip auth
    let hop_by_hop: &[&str] = &[
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ];

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .unwrap_or_default();

    let has_body = !matches!(method, axum::http::Method::GET | axum::http::Method::HEAD);

    let mut req = client.request(method.clone(), &target_url);

    // Forward headers
    let mut fwd_headers = HeaderMap::new();
    for (name, value) in request_headers.iter() {
        let name_lower = name.as_str().to_lowercase();
        if hop_by_hop.contains(&name_lower.as_str()) {
            continue;
        }
        if name_lower == "host" {
            continue;
        }
        if !is_loopback && (name_lower == "cookie" || name_lower == "authorization") {
            continue;
        }
        fwd_headers.insert(name.clone(), value.clone());
    }
    req = req.headers(fwd_headers);

    if has_body && !body.is_empty() {
        req = req.body(body);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };

    let resp_status = resp.status();

    // Special case: dashboard path with HTML content — rewrite internal URLs
    if path_joined == "dashboard" {
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if content_type.contains("text/html") {
            let text = resp.text().await.unwrap_or_default();
            let rewritten = rewrite_dashboard_html(&text);
            return (
                StatusCode::from_u16(resp_status.as_u16()).unwrap_or(StatusCode::OK),
                [("content-type", "text/html")],
                rewritten,
            )
                .into_response();
        }
    }

    // Build response headers — strip hop-by-hop
    let mut resp_headers = HeaderMap::new();
    for (name, value) in resp.headers().iter() {
        let name_lower = name.as_str().to_lowercase();
        if hop_by_hop.contains(&name_lower.as_str()) {
            continue;
        }
        resp_headers.insert(name, value.clone());
    }

    let resp_bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };

    (
        StatusCode::from_u16(resp_status.as_u16()).unwrap_or(StatusCode::OK),
        resp_headers,
        resp_bytes,
    )
        .into_response()
}

// ===== Helpers =====

/// Check if a URL points to localhost/loopback.
fn is_loopback_url(url: &str) -> bool {
    if let Ok(parsed) = url::Url::parse(url) {
        let host = parsed.host_str().unwrap_or("");
        matches!(host, "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
    } else {
        false
    }
}

/// Parse port from a URL.
fn parse_port_from_url(url: &str) -> Option<u16> {
    if let Ok(parsed) = url::Url::parse(url) {
        let port = parsed.port();
        if let Some(p) = port {
            if p > 0 {
                return Some(p);
            }
        }
    }
    None
}

/// Probe a headroom URL to check if it's alive.
async fn probe_headroom_alive(url: &str) -> bool {
    let health_url = if url.ends_with('/') {
        format!("{}health", url)
    } else {
        format!("{}/health", url)
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_default();

    client
        .get(&health_url)
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Detect installed headroom extras via `pip list --format=json`.
/// Returns JSON with `available`, `installed`, `version`, `extras` fields,
/// mirroring Node's getInstalledHeadroomExtras + HEADROOM_COMPRESSION_EXTRAS.
fn detect_headroom_extras() -> anyhow::Result<serde_json::Value> {
    // The available compression extras (matches Node HEADROOM_COMPRESSION_EXTRAS).
    let available = serde_json::json!(["code", "ml"]);

    // Marker packages that indicate each extra is installed.
    let extra_markers: &[(&str, &[&str])] = &[
        ("code", &["tree-sitter", "tree-sitter-language-pack"]),
        ("ml", &["torch", "huggingface-hub"]),
    ];

    // Find a Python >= 3.10 interpreter
    let python = find_python310();

    if python.is_none() {
        return Ok(serde_json::json!({
            "available": available,
            "installed": false,
            "version": null,
            "extras": { "code": false, "ml": false },
            "python": null,
        }));
    }

    let py = python.unwrap();

    // Run `pip list --format=json --disable-pip-version-check`
    let output = std::process::Command::new(&py)
        .args(["-m", "pip", "list", "--format=json", "--disable-pip-version-check"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output();

    let output = match output {
        Ok(o) => o,
        Err(_) => {
            return Ok(serde_json::json!({
                "available": available,
                "installed": false,
                "version": null,
                "extras": { "code": false, "ml": false },
                "python": py,
            }));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse JSON array of {name, version} objects
    let packages: Vec<serde_json::Value> = match serde_json::from_str(&stdout) {
        Ok(p) => p,
        Err(_) => {
            return Ok(serde_json::json!({
                "available": available,
                "installed": false,
                "version": null,
                "extras": { "code": false, "ml": false },
                "python": py,
            }));
        }
    };

    let names: std::collections::HashSet<String> = packages
        .iter()
        .filter_map(|p| p.get("name").and_then(|v| v.as_str()).map(|s| s.to_lowercase()))
        .collect();

    let installed = names.contains("headroom-ai");

    if !installed {
        return Ok(serde_json::json!({
            "available": available,
            "installed": false,
            "version": null,
            "extras": { "code": false, "ml": false },
            "python": py,
        }));
    }

    let version = packages
        .iter()
        .find(|p| p.get("name").and_then(|v| v.as_str()).map(|s| s.to_lowercase()) == Some("headroom-ai".to_string()))
        .and_then(|p| p.get("version").and_then(|v| v.as_str()))
        .unwrap_or("");

    let mut extras = serde_json::Map::new();
    for (extra, markers) in extra_markers {
        let present = markers.iter().any(|m| names.contains(*m));
        extras.insert(extra.to_string(), serde_json::json!(present));
    }

    Ok(serde_json::json!({
        "available": available,
        "installed": true,
        "version": version,
        "extras": serde_json::Value::Object(extras),
        "python": py,
    }))
}

/// Find a Python >= 3.10 interpreter. Returns the path if found, None otherwise.
fn find_python310() -> Option<String> {
    let candidates = [
        "python3.13", "python3.12", "python3.11", "python3.10", "python3", "python",
    ];

    for candidate in &candidates {
        let result = std::process::Command::new(candidate)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output();

        if let Ok(output) = result {
            let ver_text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(captures) = ver_text.split_whitespace().nth(1) {
                let parts: Vec<&str> = captures.split('.').collect();
                if parts.len() >= 2 {
                    if let (Ok(major), Ok(minor)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                        if major > 3 || (major == 3 && minor >= 10) {
                            return Some(candidate.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

/// Build a target URL from the headroom base URL, path segments, and raw query string.
fn build_target_url(base: &str, path: &str, query: &str) -> anyhow::Result<String> {
    let base_parsed = url::Url::parse(base)?;
    let scheme = base_parsed.scheme();
    let host = base_parsed.host_str().unwrap_or("");
    let port = base_parsed.port();
    let base_path = base_parsed.path().trim_end_matches('/');

    let mut target = format!("{}://{}", scheme, host);
    if let Some(p) = port {
        target.push_str(&format!(":{}", p));
    }
    target.push_str(base_path);
    if !path.is_empty() {
        if !target.ends_with('/') {
            target.push('/');
        }
        target.push_str(path);
    }

    // Append query string if present
    if !query.is_empty() {
        target.push('?');
        target.push_str(query);
    }

    Ok(target)
}

/// Rewrite internal headroom dashboard URLs to include the /api/headroom/proxy prefix.
/// Mirrors Node's rewriteDashboardHtml: rewrites fetch('(stats|health|stats-history|transformations/feed)
/// to fetch('/api/headroom/proxy/stats|health|...
fn rewrite_dashboard_html(html: &str) -> String {
    html.replace(
        "fetch('/",
        "fetch('/api/headroom/proxy/",
    )
}

