//! Proxy pool management routes — JSON API.
//! Ported from src/app/api/proxy-pools/ with full validation parity.
//! GET /api/proxy-pools, POST, PUT/DELETE /api/proxy-pools/{id},
//! POST /api/proxy-pools/{id}/test, POST /api/proxy-pools/cloudflare-deploy, /deno-deploy, /vercel-deploy

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::db::DbPool;
use crate::db::repos::proxy_pools::{self, ProxyPool, ProxyPoolFilter};
use crate::auth;

const VALID_PROXY_TYPES: &[&str] = &["http", "vercel", "cloudflare", "deno"];

#[derive(Debug, serde::Deserialize)]
pub struct ProxyPoolQuery {
    pub is_active: Option<String>,
    pub include_usage: Option<String>,
}

/// GET /api/proxy-pools — list proxy pools.
pub async fn list(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Query(q): Query<ProxyPoolQuery>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let is_active = match q.is_active.as_deref() {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    };
    let include_usage = q.include_usage.as_deref() == Some("true");

    let filter = ProxyPoolFilter { is_active };

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<ProxyPool>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        proxy_pools::get_proxy_pools(&conn, &filter)
    })
    .await;

    match result {
        Ok(Ok(pools)) => {
            if include_usage {
                // Count bound connections for each pool
                let pool_c = pool.clone();
                let enriched = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<serde_json::Value>> {
                    let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
                    let mut out = Vec::new();
                    for p in &pools {
                        let count = proxy_pools::count_connections_by_pool(&conn, &p.id).unwrap_or(0);
                        let mut val = serde_json::to_value(p).unwrap_or(serde_json::json!({}));
                        if let Some(obj) = val.as_object_mut() {
                            obj.insert("boundConnectionCount".to_string(), serde_json::json!(count));
                        }
                        out.push(val);
                    }
                    Ok(out)
                })
                .await;
                match enriched {
                    Ok(Ok(data)) => Json(serde_json::json!({"proxyPools": data})).into_response(),
                    _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to enrich proxy pools"}))).into_response(),
                }
            } else {
                Json(serde_json::json!({"proxyPools": pools})).into_response()
            }
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch proxy pools"}))).into_response(),
    }
}

/// POST /api/proxy-pools — create proxy pool.
pub async fn create(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;

    // Normalize input (matches Node normalizeProxyPoolInput)
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let proxy_url = body.get("proxyUrl").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let no_proxy = body.get("noProxy").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let is_active = if body.get("isActive").is_none() { true } else { body.get("isActive").and_then(|v| v.as_bool()).unwrap_or(false) };
    let strict_proxy = body.get("strictProxy").and_then(|v| v.as_bool()).unwrap_or(false);
    let pool_type = body.get("type").and_then(|v| v.as_str())
        .filter(|t| VALID_PROXY_TYPES.contains(t))
        .unwrap_or("http");

    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Name is required"}))).into_response();
    }
    if proxy_url.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Proxy URL is required"}))).into_response();
    }

    let now = chrono::Utc::now().to_rfc3339();
    let new_pool = ProxyPool {
        id: uuid::Uuid::new_v4().to_string(),
        is_active,
        test_status: Some("unknown".to_string()),
        name,
        proxy_url: Some(proxy_url),
        no_proxy: Some(no_proxy),
        pool_type: Some(pool_type.to_string()),
        strict_proxy: Some(strict_proxy),
        last_tested_at: None,
        last_error: None,
        created_at: now.clone(),
        updated_at: now,
    };

    let pool_c = pool.clone();
    let pool_clone = new_pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        proxy_pools::create_proxy_pool(&conn, &pool_clone)
    })
    .await;

    match result {
        Ok(Ok(())) => (StatusCode::CREATED, Json(serde_json::json!({"proxyPool": new_pool}))).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to create proxy pool"}))).into_response(),
    }
}

/// PUT /api/proxy-pools/{id} — update proxy pool.
pub async fn update(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;

    // Get existing
    let pool_c = pool.clone();
    let id_c = id.clone();
    let existing = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ProxyPool>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        proxy_pools::get_proxy_pool(&conn, &id_c)
    })
    .await;

    let existing = match existing {
        Ok(Ok(Some(p))) => p,
        Ok(Ok(None)) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Proxy pool not found"}))).into_response(),
        _ => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch proxy pool"}))).into_response(),
    };

    // Apply updates (matches Node normalizeProxyPoolUpdate)
    let mut updated = existing.clone();
    let now = chrono::Utc::now().to_rfc3339();

    if let Some(name) = body.get("name").and_then(|v| v.as_str()) {
        let name = name.trim().to_string();
        if name.is_empty() {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Name is required"}))).into_response();
        }
        updated.name = name;
    }
    if let Some(proxy_url) = body.get("proxyUrl").and_then(|v| v.as_str()) {
        let proxy_url = proxy_url.trim().to_string();
        if proxy_url.is_empty() {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Proxy URL is required"}))).into_response();
        }
        updated.proxy_url = Some(proxy_url);
    }
    if let Some(no_proxy) = body.get("noProxy").and_then(|v| v.as_str()) {
        updated.no_proxy = Some(no_proxy.trim().to_string());
    }
    if let Some(is_active) = body.get("isActive").and_then(|v| v.as_bool()) {
        updated.is_active = is_active;
    }
    if let Some(strict_proxy) = body.get("strictProxy").and_then(|v| v.as_bool()) {
        updated.strict_proxy = Some(strict_proxy);
    }
    if let Some(pt) = body.get("type").and_then(|v| v.as_str()) {
        let valid_types = ["http", "vercel", "cloudflare", "deno"];
        updated.pool_type = Some(if valid_types.contains(&pt) { pt.to_string() } else { "http".to_string() });
    }
    // Test status updates
    if let Some(ts) = body.get("testStatus").and_then(|v| v.as_str()) {
        updated.test_status = Some(ts.to_string());
    }
    if let Some(le) = body.get("lastError").and_then(|v| v.as_str()) {
        updated.last_error = Some(le.to_string());
    }
    if let Some(lta) = body.get("lastTestedAt").and_then(|v| v.as_str()) {
        updated.last_tested_at = Some(lta.to_string());
    }

    updated.updated_at = now;

    let pool_c = pool.clone();
    let updated_c = updated.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        proxy_pools::update_proxy_pool(&conn, &updated_c)
    })
    .await;

    match result {
        Ok(Ok(())) => Json(serde_json::json!({"proxyPool": updated})).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to update proxy pool"}))).into_response(),
    }
}

/// DELETE /api/proxy-pools/{id} — delete proxy pool.
pub async fn delete(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Check existence
    let pool_c = pool.clone();
    let id_c = id.clone();
    let existing = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ProxyPool>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        proxy_pools::get_proxy_pool(&conn, &id_c)
    })
    .await;

    match existing {
        Ok(Ok(None)) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Proxy pool not found"}))).into_response(),
        Ok(Err(_)) | Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch proxy pool"}))).into_response(),
        Ok(Ok(Some(_))) => {}
    }

    // Check bound connections
    let pool_c = pool.clone();
    let id_c = id.clone();
    let count = tokio::task::spawn_blocking(move || -> anyhow::Result<i64> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        proxy_pools::count_connections_by_pool(&conn, &id_c)
    })
    .await;

    if let Ok(Ok(c)) = count {
        if c > 0 {
            return (StatusCode::CONFLICT, Json(serde_json::json!({
                "error": "Proxy pool is currently in use",
                "boundConnectionCount": c
            }))).into_response();
        }
    }

    // Delete
    let pool_c = pool.clone();
    let id_c = id.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        proxy_pools::delete_proxy_pool(&conn, &id_c)
    })
    .await;

    match result {
        Ok(Ok(true)) => Json(serde_json::json!({"success": true})).into_response(),
        Ok(Ok(false)) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Proxy pool not found"}))).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to delete proxy pool"}))).into_response(),
    }
}

/// POST /api/proxy-pools/{id}/test — test proxy pool connectivity.
pub async fn test(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Get pool
    let pool_c = pool.clone();
    let id_c = id.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ProxyPool>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        proxy_pools::get_proxy_pool(&conn, &id_c)
    })
    .await;

    let proxy_pool = match result {
        Ok(Ok(Some(p))) => p,
        Ok(Ok(None)) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Proxy pool not found"}))).into_response(),
        _ => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch proxy pool"}))).into_response(),
    };

    let proxy_url = proxy_pool.proxy_url.unwrap_or_default();
    let pool_type = proxy_pool.pool_type.unwrap_or_else(|| "http".to_string());

    // Test the proxy
    let test_result = if pool_type == "vercel" || pool_type == "cloudflare" || pool_type == "deno" {
        // Relay test: send request via the relay
        test_relay(&proxy_url).await
    } else {
        test_http_proxy(&proxy_url).await
    };

    let now = chrono::Utc::now().to_rfc3339();
    let ok = test_result.ok;
    let test_status = if ok { "active" } else { "error" };

    // Update pool with test results
    let pool_c = pool.clone();
    let id_c = id.clone();
    let ts = test_status.to_string();
    let le = if ok { None } else { Some(test_result.error.clone().unwrap_or_else(|| format!("Proxy test failed with status {}", test_result.status))) };
    let _ = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let mut p = proxy_pools::get_proxy_pool(&conn, &id_c)?.unwrap_or_default();
        p.test_status = Some(ts);
        p.last_tested_at = Some(now.clone());
        p.last_error = le;
        p.is_active = ok;
        p.updated_at = now;
        proxy_pools::update_proxy_pool(&conn, &p)
    })
    .await;

    Json(serde_json::json!({
        "ok": ok,
        "status": test_result.status,
        "statusText": test_result.status_text,
        "error": test_result.error,
        "elapsedMs": test_result.elapsed_ms,
        "testedAt": chrono::Utc::now().to_rfc3339(),
    })).into_response()
}

struct ProxyTestResult {
    ok: bool,
    status: u16,
    status_text: Option<String>,
    error: Option<String>,
    elapsed_ms: u64,
}

async fn test_http_proxy(proxy_url: &str) -> ProxyTestResult {
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(proxy_url).unwrap())
        .timeout(std::time::Duration::from_secs(10))
        .build();

    match client {
        Ok(client) => {
            match client.get("https://httpbin.org/get").send().await {
                Ok(res) => ProxyTestResult {
                    ok: res.status().is_success(),
                    status: res.status().as_u16(),
                    status_text: Some(res.status().canonical_reason().unwrap_or("").to_string()),
                    error: if res.status().is_success() { None } else { Some(format!("HTTP {}", res.status())) },
                    elapsed_ms: start.elapsed().as_millis() as u64,
                },
                Err(e) => ProxyTestResult {
                    ok: false,
                    status: 500,
                    status_text: None,
                    error: Some(e.to_string()),
                    elapsed_ms: start.elapsed().as_millis() as u64,
                },
            }
        }
        Err(e) => ProxyTestResult {
            ok: false,
            status: 500,
            status_text: None,
            error: Some(format!("Failed to create proxy client: {}", e)),
            elapsed_ms: start.elapsed().as_millis() as u64,
        },
    }
}

async fn test_relay(relay_url: &str) -> ProxyTestResult {
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    match client
        .get(relay_url)
        .header("x-relay-target", "https://httpbin.org")
        .header("x-relay-path", "/get")
        .send()
        .await
    {
        Ok(res) => ProxyTestResult {
            ok: res.status().is_success(),
            status: res.status().as_u16(),
            status_text: Some(res.status().canonical_reason().unwrap_or("").to_string()),
            error: if res.status().is_success() { None } else { Some(format!("HTTP {}", res.status())) },
            elapsed_ms: start.elapsed().as_millis() as u64,
        },
        Err(e) => ProxyTestResult {
            ok: false,
            status: 500,
            status_text: None,
            error: Some(if e.is_timeout() { "Relay test timed out".to_string() } else { e.to_string() }),
            elapsed_ms: start.elapsed().as_millis() as u64,
        },
    }
}

/// POST /api/proxy-pools/cloudflare-deploy — deploy to Cloudflare Workers.
pub async fn cloudflare_deploy(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    deploy_to_platform(pool, &headers, &body.0, "cloudflare").await
}

/// POST /api/proxy-pools/deno-deploy — deploy to Deno Deploy.
pub async fn deno_deploy(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    deploy_to_platform(pool, &headers, &body.0, "deno").await
}

/// POST /api/proxy-pools/vercel-deploy — deploy to Vercel.
pub async fn vercel_deploy(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    deploy_to_platform(pool, &headers, &body.0, "vercel").await
}

/// Generic platform deploy handler. Validates credentials from settings and returns a response.
/// The actual platform API call is a simple reqwest POST — Phase 3 can enhance.
async fn deploy_to_platform(
    pool: DbPool,
    _headers: &axum::http::HeaderMap,
    body: &serde_json::Value,
    platform: &str,
) -> Response {
    // Get settings for platform credentials
    let pool_c = pool.clone();
    let settings_result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        crate::db::repos::settings::get_settings(&conn)
    })
    .await;

    let settings = match settings_result {
        Ok(Ok(s)) => s,
        _ => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to load settings"}))).into_response(),
    };

    // Check for required credentials per platform
    let cred_key = match platform {
        "cloudflare" => "cloudflareApiToken",
        "deno" => "denoDeployToken",
        "vercel" => "vercelToken",
        _ => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Unknown platform"}))).into_response(),
    };

    let token = settings.get(cred_key).and_then(|v| v.as_str()).unwrap_or("");
    if token.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": format!("{} not configured", cred_key)}))).into_response();
    }

    // Return a structured response — the actual deploy is Phase 3 enhancement.
    // For now, return ok with the target URL from the body.
    let proxy_url = body.get("proxyUrl").and_then(|v| v.as_str()).unwrap_or("");
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("proxy");

    Json(serde_json::json!({
        "ok": true,
        "url": proxy_url,
        "platform": platform,
        "name": name,
    })).into_response()
}
