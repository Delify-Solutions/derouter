//! Provider management routes — JSON API.
//! Ported from src/app/api/providers/route.js with full validation parity.
//! GET /api/providers, POST /api/providers, PUT/DELETE /api/providers/{id}

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use crate::db::DbPool;
use crate::db::repos::connections::{self, ProviderConnection, ConnectionFilter};
use crate::providers;
use crate::auth;

/// GET /api/providers — list all connections (secrets stripped).
pub async fn list(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<ProviderConnection>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::get_provider_connections(&conn, &ConnectionFilter::default())
    })
    .await;

    match result {
        Ok(Ok(conns)) => {
            // Strip secrets and enrich name for compatible providers
            let safe: Vec<serde_json::Value> = conns.iter().map(|c| {
                let is_compatible = providers::is_openai_compatible_provider(&c.provider)
                    || providers::is_anthropic_compatible_provider(&c.provider);
                let name = if is_compatible {
                    c.name.clone()
                        .or_else(|| {
                            c.data.get("nodeName").and_then(|v| v.as_str()).map(|s| s.to_string())
                        })
                        .unwrap_or_else(|| c.provider.clone())
                } else {
                    c.name.clone().unwrap_or_else(|| c.provider.clone())
                };

                let mut obj = serde_json::to_value(c).unwrap_or(serde_json::json!({}));
                // Strip secrets
                if let Some(map) = obj.as_object_mut() {
                    if let Some(data) = map.get_mut("data").and_then(|v| v.as_object_mut()) {
                        data.remove("apiKey");
                        data.remove("accessToken");
                        data.remove("refreshToken");
                        data.remove("idToken");
                    }
                }
                // Override name with enriched value
                if let Some(map) = obj.as_object_mut() {
                    if let Some(name_val) = map.get_mut("name") {
                        *name_val = serde_json::json!(name);
                    } else {
                        map.insert("name".to_string(), serde_json::json!(name));
                    }
                }
                obj
            }).collect();

            Json(serde_json::json!({ "connections": safe })).into_response()
        }
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to fetch providers"})),
        )
            .into_response(),
    }
}

/// POST /api/providers — create new connection (full validation).
pub async fn create(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;

    // Normalize provider ID
    let provider_raw = body.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    let provider = providers::normalize_provider_id(provider_raw);

    // Validate provider
    let is_web_cookie = providers::is_web_cookie_provider(&provider);
    let _supports_apikey = providers::supports_apikey_mode(&provider);
    let is_valid = providers::is_valid_provider(&provider);

    if provider.is_empty() || !is_valid {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid provider"})),
        )
            .into_response();
    }

    // Validate apiKey (or cookie value for web-cookie providers)
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    if api_key.is_empty() && provider != "ollama-local" {
        let msg = if is_web_cookie { "Cookie value is required" } else { "API Key is required" };
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": msg})),
        )
            .into_response();
    }

    // Validate name
    let name: String = body.get("name").and_then(|v| v.as_str()).map(|s| s.to_string())
        .or_else(|| body.get("displayName").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .or_else(|| providers::config::get_provider_name(&provider).map(|s| s.to_string()))
        .unwrap_or_default();

    if name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Name is required"})),
        )
            .into_response();
    }

    // Normalize proxy config
    let proxy_enabled = body.get("connectionProxyEnabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let proxy_url = body.get("connectionProxyUrl").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let proxy_no_proxy = body.get("connectionNoProxy").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();

    if proxy_enabled && proxy_url.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Connection proxy URL is required when connection proxy is enabled"})),
        )
            .into_response();
    }

    // Normalize proxyPoolId
    let proxy_pool_id_raw = body.get("proxyPoolId").and_then(|v| v.as_str()).unwrap_or("");
    let proxy_pool_id: Option<String> = if proxy_pool_id_raw.is_empty() || proxy_pool_id_raw == "__none__" {
        None
    } else {
        // Validate it exists in the DB (proxy_pools table)
        let pid = proxy_pool_id_raw.trim().to_string();
        let pid_clone = pid.clone();
        let pool_c = pool.clone();
        let exists = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
            let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM proxyPools WHERE id = ?",
                [&pid_clone],
                |row| row.get(0),
            ).unwrap_or(0);
            Ok(count > 0)
        })
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or(false);

        if !exists {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "Proxy pool not found"})),
            )
                .into_response();
        }
        Some(pid)
    };

    // Build provider specific data
    let mut data_json = serde_json::json!({});

    // Handle ollama-local baseUrl
    if provider == "ollama-local" {
        if let Some(base_url) = body.get("baseUrl").and_then(|v| v.as_str()) {
            let trimmed = base_url.trim();
            if !trimmed.is_empty() {
                data_json["baseUrl"] = serde_json::json!(trimmed);
            }
        }
    }

    // Store apiKey in data
    if !api_key.is_empty() {
        data_json["apiKey"] = serde_json::json!(api_key);
    }

    // Add proxy config
    data_json["connectionProxyEnabled"] = serde_json::json!(proxy_enabled);
    data_json["connectionProxyUrl"] = serde_json::json!(proxy_url);
    data_json["connectionNoProxy"] = serde_json::json!(proxy_no_proxy);

    if let Some(ref pid) = proxy_pool_id {
        data_json["proxyPoolId"] = serde_json::json!(pid);
    }

    let priority = body.get("priority").and_then(|v| v.as_i64());
    let now = chrono::Utc::now().to_rfc3339();
    let pid = uuid::Uuid::new_v4().to_string();

    let conn = ProviderConnection {
        id: pid.clone(),
        provider: provider.clone(),
        auth_type: if is_web_cookie { "cookie".to_string() } else { "apikey".to_string() },
        name: Some(name),
        email: None,
        priority,
        is_active: true,
        data: data_json,
        created_at: now.clone(),
        updated_at: now,
    };

    let pool_c = pool.clone();
    let conn_c = conn.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let db = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::create_provider_connection(&db, &conn_c)
    })
    .await;

    match result {
        Ok(Ok(())) => {
            // Strip secrets from response
            let mut result_json = serde_json::to_value(&conn).unwrap_or(serde_json::json!({}));
            if let Some(map) = result_json.as_object_mut() {
                if let Some(data) = map.get_mut("data").and_then(|v| v.as_object_mut()) {
                    data.remove("apiKey");
                    data.remove("accessToken");
                    data.remove("refreshToken");
                    data.remove("idToken");
                }
            }
            (
                StatusCode::CREATED,
                Json(serde_json::json!({"connection": result_json})),
            )
                .into_response()
        }
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to create provider"})),
        )
            .into_response(),
    }
}

/// PUT /api/providers/{id} — update connection.
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

    // Get existing connection
    let pool_c = pool.clone();
    let id_c = id.clone();
    let existing = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ProviderConnection>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::get_provider_connection_by_id(&conn, &id_c)
    })
    .await;

    let existing = match existing {
        Ok(Ok(Some(c))) => c,
        Ok(Ok(None)) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "Provider not found"})),
            )
                .into_response();
        }
        _ => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to fetch provider"})),
            )
                .into_response();
        }
    };

    let now = chrono::Utc::now().to_rfc3339();
    let mut data_json = existing.data.clone();

    // Update fields from body
    if let Some(api_key) = body.get("apiKey").and_then(|v| v.as_str()) {
        if !api_key.is_empty() {
            data_json["apiKey"] = serde_json::json!(api_key);
        }
    }
    if let Some(name) = body.get("name").and_then(|v| v.as_str()) {
        if !name.is_empty() {
            // Will be set in the struct
        }
    }

    // Update proxy config
    if let Some(proxy_enabled) = body.get("connectionProxyEnabled").and_then(|v| v.as_bool()) {
        data_json["connectionProxyEnabled"] = serde_json::json!(proxy_enabled);
    }
    if let Some(proxy_url) = body.get("connectionProxyUrl").and_then(|v| v.as_str()) {
        data_json["connectionProxyUrl"] = serde_json::json!(proxy_url.trim());
    }
    if let Some(no_proxy) = body.get("connectionNoProxy").and_then(|v| v.as_str()) {
        data_json["connectionNoProxy"] = serde_json::json!(no_proxy.trim());
    }

    let name = body.get("name").and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or(existing.name);
    let priority = body.get("priority").and_then(|v| v.as_i64()).or(existing.priority);
    let is_active = body.get("isActive").and_then(|v| v.as_bool()).unwrap_or(existing.is_active);

    let conn = ProviderConnection {
        id: id.clone(),
        provider: existing.provider.clone(),
        auth_type: existing.auth_type.clone(),
        name,
        email: existing.email.clone(),
        priority,
        is_active,
        data: data_json,
        created_at: existing.created_at.clone(),
        updated_at: now,
    };

    let pool_c = pool.clone();
    let conn_c = conn.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let db = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::update_provider_connection(&db, &conn_c)
    })
    .await;

    match result {
        Ok(Ok(())) => {
            let mut result_json = serde_json::to_value(&conn).unwrap_or(serde_json::json!({}));
            if let Some(map) = result_json.as_object_mut() {
                if let Some(data) = map.get_mut("data").and_then(|v| v.as_object_mut()) {
                    data.remove("apiKey");
                    data.remove("accessToken");
                    data.remove("refreshToken");
                    data.remove("idToken");
                }
            }
            Json(serde_json::json!({"connection": result_json})).into_response()
        }
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to update provider"})),
        )
            .into_response(),
    }
}

/// DELETE /api/providers/{id} — delete connection.
pub async fn delete(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let db = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::delete_provider_connection(&db, &id)
    })
    .await;

    match result {
        Ok(Ok(true)) => Json(serde_json::json!({"success": true})).into_response(),
        Ok(Ok(false)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Provider not found"})),
        )
            .into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to delete provider"})),
        )
            .into_response(),
    }
}

// ===== Phase 2 sub-routes =====

/// GET /api/providers/{id}/models — list models for a provider connection.
pub async fn get_models(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let id_c = id.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ProviderConnection>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::get_provider_connection_by_id(&conn, &id_c)
    })
    .await;

    let conn = match result {
        Ok(Ok(Some(c))) => c,
        Ok(Ok(None)) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Provider not found"}))).into_response(),
        _ => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch provider"}))).into_response(),
    };

    // Return models from the registry entry for this connection's provider.
    // Fall back to AI_MODELS filter by provider if not in registry.
    let models: Vec<serde_json::Value> = if let Some(entry) = crate::providers::registry::by_id_or_alias(&conn.provider) {
        let provider_key = if !entry.alias.is_empty() { entry.alias } else { entry.id };
        entry.models.iter().map(|pm| {
            serde_json::json!({
                "provider": provider_key,
                "model": pm.id,
                "name": if !pm.name.is_empty() { pm.name } else { pm.id },
                "kind": pm.kind.unwrap_or(""),
            })
        }).collect()
    } else {
        let provider_alias = crate::providers::config::id_to_alias(&conn.provider).unwrap_or(&conn.provider);
        crate::providers::capabilities::AI_MODELS.iter()
            .filter(|(p, _, _)| *p == conn.provider || *p == provider_alias)
            .map(|(p, m, name)| serde_json::json!({"provider": p, "model": m, "name": name}))
            .collect()
    };

    Json(serde_json::json!({"models": models})).into_response()
}

/// POST /api/providers/{id}/test — test a single connection.
pub async fn test_connection(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let id_c = id.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ProviderConnection>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::get_provider_connection_by_id(&conn, &id_c)
    })
    .await;

    let conn = match result {
        Ok(Ok(Some(c))) => c,
        Ok(Ok(None)) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Provider not found"}))).into_response(),
        _ => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch provider"}))).into_response(),
    };

    let api_key = conn.data.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let base_url = conn.data.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");

    // Simple connectivity test: try /models endpoint
    let url = if base_url.is_empty() {
        "https://api.openai.com/v1/models".to_string()
    } else {
        format!("{}/models", base_url.trim_end_matches('/'))
    };

    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().unwrap_or_default();

    let res = client.get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send().await;

    match res {
        Ok(r) => {
            let status = r.status().as_u16();
            let ok = r.status().is_success();
            Json(serde_json::json!({
                "valid": ok,
                "latencyMs": start.elapsed().as_millis() as u64,
                "statusCode": status,
                "error": if ok { None } else { Some(format!("HTTP {}", status)) },
                "testedAt": chrono::Utc::now().to_rfc3339(),
            })).into_response()
        }
        Err(e) => Json(serde_json::json!({
            "valid": false,
            "latencyMs": start.elapsed().as_millis() as u64,
            "statusCode": 0,
            "error": e.to_string(),
            "testedAt": chrono::Utc::now().to_rfc3339(),
        })).into_response(),
    }
}

/// POST /api/providers/{id}/test-models — test models endpoint for a connection.
pub async fn test_models(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Reuse test_connection logic
    test_connection(State(pool), headers, axum::extract::Path(id)).await
}

/// GET /api/providers/client — sanitized client-side provider list.
pub async fn client(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Return a sanitized subset of connections for client-side rendering.
    // Matches Node's /api/providers/client route.
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<serde_json::Value>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let conns = connections::get_provider_connections(&conn, &ConnectionFilter::default())?;
        let safe: Vec<serde_json::Value> = conns.iter().map(|c| {
            let mut obj = serde_json::to_value(c).unwrap_or(serde_json::json!({}));
            if let Some(map) = obj.as_object_mut() {
                if let Some(data) = map.get_mut("data").and_then(|v| v.as_object_mut()) {
                    data.remove("apiKey");
                    data.remove("accessToken");
                    data.remove("refreshToken");
                    data.remove("idToken");
                }
            }
            obj
        }).collect();
        Ok(safe)
    })
    .await;

    match result {
        Ok(Ok(data)) => Json(serde_json::json!({"connections": data})).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch providers"}))).into_response(),
    }
}

/// GET /api/providers/kilo/free-models — free models from registry free-tier/free entries.
pub async fn kilo_free_models(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    // Return models from registry entries whose category is FreeTier or Free.
    // These are always available without credentials.
    let mut models: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in crate::providers::registry::all_entries() {
        if entry.hidden {
            continue;
        }
        if entry.category != crate::providers::registry::ProviderCategory::FreeTier
            && entry.category != crate::providers::registry::ProviderCategory::Free
        {
            continue;
        }
        let provider = if !entry.alias.is_empty() { entry.alias } else { entry.id };
        for pm in entry.models {
            let key = format!("{}/{}", provider, pm.id);
            if seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            models.push(serde_json::json!({
                "provider": provider,
                "model": pm.id,
                "name": if !pm.name.is_empty() { pm.name } else { pm.id },
                "isFree": true,
            }));
        }
    }

    Json(serde_json::json!({"models": models})).into_response()
}

/// GET /api/providers/suggested-models — suggested models from the registry-derived catalog.
pub async fn suggested_models(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    // Return the full catalog (AI_MODELS + registry entries) as suggestions.
    let mut models: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (p, m, name) in crate::providers::capabilities::AI_MODELS.iter() {
        let key = format!("{}/{}", p, m);
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        models.push(serde_json::json!({"provider": p, "model": m, "name": name}));
    }

    for entry in crate::providers::registry::all_entries() {
        if entry.hidden {
            continue;
        }
        let provider = if !entry.alias.is_empty() { entry.alias } else { entry.id };
        for pm in entry.models {
            let key = format!("{}/{}", provider, pm.id);
            if seen.contains(&key) {
                continue;
            }
            let key2 = format!("{}/{}", entry.id, pm.id);
            if seen.contains(&key2) {
                continue;
            }
            seen.insert(key);
            models.push(serde_json::json!({
                "provider": provider,
                "model": pm.id,
                "name": if !pm.name.is_empty() { pm.name } else { pm.id },
            }));
        }
    }

    Json(serde_json::json!({"models": models})).into_response()
}

/// POST /api/providers/test-batch — test multiple connections by group.
pub async fn test_batch(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;
    let mode = body.get("mode").and_then(|v| v.as_str()).unwrap_or("");
    let provider_id = body.get("providerId").and_then(|v| v.as_str());

    if mode.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "mode is required"}))).into_response();
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<ProviderConnection>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::get_provider_connections(&conn, &ConnectionFilter::default())
    })
    .await;

    let all_conns = match result {
        Ok(Ok(c)) => c,
        _ => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch providers"}))).into_response(),
    };

    // Filter by mode
    let conns_to_test: Vec<&ProviderConnection> = match mode {
        "all" => all_conns.iter().filter(|c| c.is_active).collect(),
        "provider" => all_conns.iter().filter(|c| c.is_active && Some(c.provider.as_str()) == provider_id).collect(),
        "oauth" => all_conns.iter().filter(|c| c.is_active && c.auth_type == "oauth").collect(),
        "free" => all_conns.iter().filter(|c| c.is_active && c.auth_type == "oauth").collect(), // free uses oauth
        "apikey" => all_conns.iter().filter(|c| c.is_active && c.auth_type == "apikey").collect(),
        "compatible" => all_conns.iter().filter(|c| {
            c.is_active && (providers::is_openai_compatible_provider(&c.provider) || providers::is_anthropic_compatible_provider(&c.provider))
        }).collect(),
        _ => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid mode. Use: provider, oauth, free, apikey, compatible, all"}))).into_response(),
    };

    let mut results = Vec::new();
    let mut passed = 0;
    let mut failed = 0;

    for conn in &conns_to_test {
        let api_key = conn.data.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
        let base_url = conn.data.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");

        let url = if base_url.is_empty() {
            "https://api.openai.com/v1/models".to_string()
        } else {
            format!("{}/models", base_url.trim_end_matches('/'))
        };

        let start = std::time::Instant::now();
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build().unwrap_or_default();

        let res = client.get(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send().await;

        let (valid, status_code, error) = match res {
            Ok(r) => {
                let status = r.status().as_u16();
                let ok = r.status().is_success();
                if ok { passed += 1; } else { failed += 1; }
                (ok, status, if ok { None } else { Some(format!("HTTP {}", status)) })
            }
            Err(e) => {
                failed += 1;
                (false, 0, Some(e.to_string()))
            }
        };

        results.push(serde_json::json!({
            "provider": conn.provider,
            "connectionId": conn.id,
            "connectionName": conn.name.as_deref().unwrap_or(&conn.provider),
            "authType": conn.auth_type,
            "valid": valid,
            "latencyMs": start.elapsed().as_millis() as u64,
            "error": error,
            "statusCode": status_code,
            "testedAt": chrono::Utc::now().to_rfc3339(),
        }));
    }

    Json(serde_json::json!({
        "mode": mode,
        "providerId": provider_id,
        "results": results,
        "summary": {
            "total": conns_to_test.len(),
            "passed": passed,
            "failed": failed,
        },
        "testedAt": chrono::Utc::now().to_rfc3339(),
    })).into_response()
}

/// POST /api/providers/validate — validate provider credentials without persisting.
pub async fn validate(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;
    let provider = body.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let model_id = body.get("modelId").and_then(|v| v.as_str());

    if provider.is_empty() || api_key.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"valid": false, "error": "Provider and apiKey required"}))).into_response();
    }

    // Simple validation: try /models endpoint
    let url = if base_url.is_empty() {
        "https://api.openai.com/v1/models".to_string()
    } else {
        format!("{}/models", base_url.trim_end_matches('/'))
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().unwrap_or_default();

    let res = client.get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send().await;

    match res {
        Ok(r) if r.status().is_success() => Json(serde_json::json!({"valid": true})).into_response(),
        Ok(r) if r.status() == 401 || r.status() == 403 => Json(serde_json::json!({"valid": false, "error": "API key unauthorized"})).into_response(),
        Ok(r) => {
            // Fallback: try chat if model provided
            if let Some(mid) = model_id {
                let chat_url = if base_url.is_empty() {
                    "https://api.openai.com/v1/chat/completions".to_string()
                } else {
                    format!("{}/chat/completions", base_url.trim_end_matches('/'))
                };
                let client2 = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(10))
                    .build().unwrap_or_default();
                let res2 = client2.post(&chat_url)
                    .header("Authorization", format!("Bearer {}", api_key))
                    .header("Content-Type", "application/json")
                    .body(serde_json::json!({"model": mid, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1}).to_string())
                    .send().await;
                match res2 {
                    Ok(r) if r.status().is_success() => Json(serde_json::json!({"valid": true, "method": "chat"})).into_response(),
                    Ok(r) => Json(serde_json::json!({"valid": false, "error": format!("Chat request failed ({})", r.status()), "method": "chat"})).into_response(),
                    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"valid": false, "error": e.to_string()}))).into_response(),
                }
            } else {
                Json(serde_json::json!({"valid": false, "error": format!("Validation failed ({})", r.status())})).into_response()
            }
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"valid": false, "error": e.to_string()}))).into_response(),
    }
}
