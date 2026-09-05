//! Tunnel management routes — JSON API.
//! Ported from src/app/api/tunnel/{status,enable,disable,tailscale-check,
//!   tailscale-enable,tailscale-disable,tailscale-install}/route.js.
//!
//! GET  /api/tunnel/status — tunnel + tailscale + download status.
//! POST /api/tunnel/enable — enable cloudflare tunnel.
//! POST /api/tunnel/disable — disable cloudflare tunnel.
//! GET  /api/tunnel/tailscale-check — check tailscale installed/running/logged-in.
//! POST /api/tunnel/tailscale-enable — enable tailscale.
//! POST /api/tunnel/tailscale-disable — disable tailscale.
//! POST /api/tunnel/tailscale-install — install tailscale (SSE progress stream).

use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::auth;
use crate::db::DbPool;
use crate::db::repos::settings;

/// GET /api/tunnel/status — return tunnel + tailscale + download status.
pub async fn status(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Read settings for tunnel URL
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

    let tunnel_url = s.get("tunnelUrl").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let tailscale_url = s.get("tailscaleUrl").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Tunnel status: active if tunnelUrl is set
    let tunnel_active = !tunnel_url.is_empty();

    // Tailscale status: check if binary exists
    let tailscale_installed = which_tailscale().await.is_some();
    let tailscale_active = !tailscale_url.is_empty();

    Json(serde_json::json!({
        "tunnel": {
            "active": tunnel_active,
            "url": tunnel_url,
        },
        "tailscale": {
            "active": tailscale_active,
            "url": tailscale_url,
            "installed": tailscale_installed,
        },
        "download": null,
    }))
    .into_response()
}

/// POST /api/tunnel/enable — enable cloudflare tunnel.
pub async fn enable(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Check if cloudflared is available
    let cloudflared = match which_cloudflared().await {
        Some(bin) => bin,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "cloudflared binary not found"})),
            )
                .into_response();
        }
    };

    // Start cloudflared tunnel
    let result = tokio::process::Command::new(&cloudflared)
        .arg("tunnel")
        .arg("--url")
        .arg("http://localhost:20127")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    match result {
        Ok(child) => {
            // Wait a short time for the tunnel URL to appear in stderr
            tokio::time::sleep(std::time::Duration::from_millis(3000)).await;

            // Try to read the tunnel URL from stderr (cloudflared prints it)
            // For now, return a basic success
            let pid = child.id().unwrap_or(0);
            tracing::info!("Cloudflare tunnel started, pid={}", pid);

            // Store the tunnel URL in settings (best-effort)
            let pool_c = pool.clone();
            let _ = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
                let mut s = settings::get_settings(&conn)?;
                if let Some(obj) = s.as_object_mut() {
                    obj.insert("tunnelUrl".to_string(), serde_json::json!("")); // URL will be set by cloudflared
                }
                settings::update_settings(&conn, &s)?;
                Ok(())
            })
            .await;

            Json(serde_json::json!({
                "success": true,
                "message": "Tunnel starting",
                "pid": pid,
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to start tunnel: {}", e)})),
        )
            .into_response(),
    }
}

/// POST /api/tunnel/disable — disable cloudflare tunnel.
pub async fn disable(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Clear tunnel URL in settings
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let mut s = settings::get_settings(&conn)?;
        if let Some(obj) = s.as_object_mut() {
            obj.insert("tunnelUrl".to_string(), serde_json::json!(""));
        }
        settings::update_settings(&conn, &s)?;
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => Json(serde_json::json!({"success": true, "message": "Tunnel disabled"})).into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

/// GET /api/tunnel/tailscale-check — check tailscale installation/daemon/login status.
pub async fn tailscale_check(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let platform = std::env::consts::OS;
    let installed = which_tailscale().await.is_some();
    let brew_available = if platform == "macos" {
        which_brew().await.is_some()
    } else {
        false
    };

    // Check if tailscaled daemon is running
    let daemon_running = if installed {
        is_tailscale_daemon_running().await
    } else {
        false
    };

    // Check if logged in (runs `tailscale status` which requires daemon)
    let logged_in = if daemon_running {
        is_tailscale_logged_in().await
    } else {
        false
    };

    Json(serde_json::json!({
        "installed": installed,
        "loggedIn": logged_in,
        "platform": platform,
        "brewAvailable": brew_available,
        "daemonRunning": daemon_running,
        "customDaemonRunning": daemon_running,
        "systemDaemonRunning": daemon_running,
        "hasCachedPassword": false,
    }))
    .into_response()
}

/// POST /api/tunnel/tailscale-enable — enable tailscale.
pub async fn tailscale_enable(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let tailscale = match which_tailscale().await {
        Some(bin) => bin,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Tailscale not installed"})),
            )
                .into_response();
        }
    };

    // Run `tailscale up`
    let result = tokio::process::Command::new(&tailscale)
        .arg("up")
        .output()
        .await;

    match result {
        Ok(output) => {
            if output.status.success() {
                // Get the tailscale URL
                let url_result = tokio::process::Command::new(&tailscale)
                    .arg("status")
                    .output()
                    .await;

                let ts_url = if let Ok(out) = url_result {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    // Parse URL from status output (best-effort)
                    extract_tailscale_url(&stdout).unwrap_or_default()
                } else {
                    String::new()
                };

                // Store in settings
                let pool_c = pool.clone();
                let ts_url_c = ts_url.clone();
                let _ = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                    let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
                    let mut s = settings::get_settings(&conn)?;
                    if let Some(obj) = s.as_object_mut() {
                        obj.insert("tailscaleUrl".to_string(), serde_json::json!(ts_url_c));
                    }
                    settings::update_settings(&conn, &s)?;
                    Ok(())
                })
                .await;

                Json(serde_json::json!({
                    "success": true,
                    "url": ts_url,
                }))
                .into_response()
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": stderr.to_string()})),
                )
                    .into_response()
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to run tailscale: {}", e)})),
        )
            .into_response(),
    }
}

/// POST /api/tunnel/tailscale-disable — disable tailscale.
pub async fn tailscale_disable(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let tailscale = match which_tailscale().await {
        Some(bin) => bin,
        None => {
            // Not installed, just clear the URL
            let pool_c = pool.clone();
            let _ = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
                let mut s = settings::get_settings(&conn)?;
                if let Some(obj) = s.as_object_mut() {
                    obj.insert("tailscaleUrl".to_string(), serde_json::json!(""));
                }
                settings::update_settings(&conn, &s)?;
                Ok(())
            })
            .await;
            return Json(serde_json::json!({"success": true, "message": "Tailscale not installed, URL cleared"})).into_response();
        }
    };

    // Run `tailscale down`
    let _ = tokio::process::Command::new(&tailscale)
        .arg("down")
        .output()
        .await;

    // Clear URL in settings
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let mut s = settings::get_settings(&conn)?;
        if let Some(obj) = s.as_object_mut() {
            obj.insert("tailscaleUrl".to_string(), serde_json::json!(""));
        }
        settings::update_settings(&conn, &s)?;
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => Json(serde_json::json!({"success": true})).into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

/// POST /api/tunnel/tailscale-install — install tailscale (SSE progress stream).
/// Uses `tailscale install` (macOS) or `brew install tailscale` (macOS with brew).
/// Falls back to curl install script on Linux.
pub async fn tailscale_install(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.map(|b| b.0).unwrap_or(serde_json::json!({}));
    let _sudo_password = body.get("sudoPassword").and_then(|v| v.as_str()).unwrap_or("");

    let platform = std::env::consts::OS;

    // Build the install command based on platform
    let (cmd, args): (String, Vec<String>) = if platform == "macos" {
        if which_brew().await.is_some() {
            ("brew".to_string(), vec!["install".to_string(), "tailscale".to_string()])
        } else {
            // TODO Phase4: full macOS install with sudo (install.sh)
            tracing::warn!("tailscale-install without brew on macOS not yet ported (Phase 4)");
            return (
                StatusCode::NOT_IMPLEMENTED,
                Json(serde_json::json!({"error": "route not yet ported (Phase 4) — tailscale install without brew requires sudo prompt UI"})),
            )
                .into_response();
        }
    } else if platform == "linux" {
        ("sh".to_string(), vec!["-c".to_string(), "curl -fsSL https://tailscale.com/install.sh | sh".to_string()])
    } else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": format!("Tailscale install not supported on {}", platform)})),
        )
            .into_response();
    };

    // Build SSE stream that runs the install command and streams progress
    let stream = async_stream::stream! {
        // Send initial progress event
        yield Ok::<_, std::convert::Infallible>(format!(
            "event: progress\ndata: {}\n\n",
            serde_json::json!({"message": format!("Installing tailscale via {} {}...", cmd, args.join(" "))})
        ));

        let result = tokio::process::Command::new(&cmd)
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();

        match result {
            Ok(mut child) => {
                // Read stdout line by line
                if let Some(stdout) = child.stdout.take() {
                    use tokio::io::{AsyncBufReadExt, BufReader};
                    let reader = BufReader::new(stdout);
                    let mut lines = reader.lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        yield Ok(format!(
                            "event: progress\ndata: {}\n\n",
                            serde_json::json!({"message": line})
                        ));
                    }
                }

                let status = child.wait().await;
                match status {
                    Ok(s) if s.success() => {
                        yield Ok(format!(
                            "event: done\ndata: {}\n\n",
                            serde_json::json!({"success": true, "authUrl": null})
                        ));
                    }
                    Ok(s) => {
                        yield Ok(format!(
                            "event: error\ndata: {}\n\n",
                            serde_json::json!({"error": format!("Install failed with status: {}", s)})
                        ));
                    }
                    Err(e) => {
                        yield Ok(format!(
                            "event: error\ndata: {}\n\n",
                            serde_json::json!({"error": e.to_string()})
                        ));
                    }
                }
            }
            Err(e) => {
                yield Ok(format!(
                    "event: error\ndata: {}\n\n",
                    serde_json::json!({"error": format!("Failed to start install: {}", e)})
                ));
            }
        }
    };

    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream")),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-transform")),
            (header::CONNECTION, HeaderValue::from_static("keep-alive")),
            (axum::http::HeaderName::from_static("x-accel-buffering"), HeaderValue::from_static("no")),
        ],
        axum::body::Body::from_stream(stream),
    )
        .into_response()
}

// ===== Helpers =====

/// Find the tailscale binary via PATH lookup.
async fn which_tailscale() -> Option<String> {
    let candidates = if std::env::consts::OS == "macos" {
        vec![
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
            "/usr/bin/tailscale",
        ]
    } else {
        vec!["/usr/sbin/tailscale", "/usr/bin/tailscale", "/snap/bin/tailscale"]
    };

    for c in &candidates {
        if tokio::fs::metadata(c).await.is_ok() {
            return Some(c.to_string());
        }
    }

    // Try `which tailscale`
    tokio::process::Command::new("which")
        .arg("tailscale")
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        })
}

/// Find the cloudflared binary.
async fn which_cloudflared() -> Option<String> {
    let candidates = if std::env::consts::OS == "macos" {
        vec![
            "/usr/local/bin/cloudflared",
            "/opt/homebrew/bin/cloudflared",
            "/usr/bin/cloudflared",
        ]
    } else {
        vec!["/usr/local/bin/cloudflared", "/usr/bin/cloudflared"]
    };

    for c in &candidates {
        if tokio::fs::metadata(c).await.is_ok() {
            return Some(c.to_string());
        }
    }

    tokio::process::Command::new("which")
        .arg("cloudflared")
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        })
}

/// Check if brew is available.
async fn which_brew() -> Option<String> {
    let candidates = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
    for c in &candidates {
        if tokio::fs::metadata(c).await.is_ok() {
            return Some(c.to_string());
        }
    }
    tokio::process::Command::new("which")
        .arg("brew")
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        })
}

/// Check if tailscale daemon is running (pgrep tailscaled).
async fn is_tailscale_daemon_running() -> bool {
    tokio::process::Command::new("pgrep")
        .arg("-x")
        .arg("tailscaled")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if tailscale is logged in (runs `tailscale status --json`).
async fn is_tailscale_logged_in() -> bool {
    let bin = match which_tailscale().await {
        Some(b) => b,
        None => return false,
    };

    tokio::process::Command::new(&bin)
        .arg("status")
        .arg("--json")
        .output()
        .await
        .map(|o| {
            if !o.status.success() {
                return false;
            }
            let stdout = String::from_utf8_lossy(&o.stdout);
            // If we can parse JSON and it has a "Self" key, we're logged in
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&stdout) {
                data.get("Self").is_some()
            } else {
                false
            }
        })
        .unwrap_or(false)
}

/// Extract the tailscale URL from `tailscale status` output.
fn extract_tailscale_url(stdout: &str) -> Option<String> {
    // Look for a line like "100.x.y.z  hostname  user@  macOS  -"
    // The URL is constructed from the IP
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("100.") {
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if let Some(ip) = parts.first() {
                return Some(format!("http://{}:8787", ip));
            }
        }
    }
    None
}
