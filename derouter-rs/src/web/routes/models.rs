//! Models catalog routes — JSON API.
//! Ported from src/app/api/models/ with full validation parity.
//! GET /api/models (catalog), GET/POST /api/models/alias,
//! GET /api/models/availability, POST /api/models/catalog-sync,
//! GET/POST /api/models/custom, GET/POST /api/models/disabled, POST /api/models/test

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::db::DbPool;
use crate::db::repos::{model_aliases, custom_models, disabled_models};
use crate::providers::capabilities::{self, AI_MODELS};
use crate::providers::config;
use crate::providers::registry;
use crate::auth;

/// GET /api/models — build catalog from AI_MODELS + registry entries, filter disabled, enrich each entry.
pub async fn list(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        // Get model aliases and disabled models
        let aliases = model_aliases::get_model_aliases(&conn).unwrap_or_default();
        let disabled = disabled_models::get_disabled_models(&conn).unwrap_or_default();
        let custom = custom_models::get_custom_models(&conn).unwrap_or_default();

        // Build catalog from AI_MODELS (base) + registry entries (supplemental).
        // AI_MODELS covers passthrough/compatible providers that don't enumerate models
        // in the registry. Registry entries contribute their transport.models[] list.
        // Dedup by (provider, model).
        let mut models: Vec<serde_json::Value> = Vec::new();
        let mut seen_full: std::collections::HashSet<String> = std::collections::HashSet::new();

        // 1. AI_MODELS base
        for (provider, model, name) in AI_MODELS.iter() {
            // Get provider alias (from config ID_TO_ALIAS map)
            let provider_alias = config::id_to_alias(provider).unwrap_or(provider);

            // Check if disabled
            let disabled_list = disabled.get(provider_alias).or_else(|| disabled.get(*provider));
            if let Some(list) = disabled_list {
                if list.contains(&model.to_string()) {
                    continue;
                }
            }

            let full_model = format!("{}/{}", provider, model);
            seen_full.insert(full_model.clone());

            let routed_model = format!("{}/{}", provider_alias, model);
            let alias = aliases.get(&full_model).cloned().unwrap_or_else(|| model.to_string());
            let caps = capabilities::get_capabilities_for_model(provider, model);

            models.push(serde_json::json!({
                "provider": provider,
                "model": model,
                "name": name,
                "fullModel": full_model,
                "routedModel": routed_model,
                "alias": alias,
                "caps": {
                    "vision": caps.vision,
                    "search": caps.search,
                    "reasoning": caps.reasoning,
                    "contextWindow": caps.context_window,
                    "maxOutput": caps.max_output,
                },
            }));
        }

        // 2. Registry entries (non-hidden) — supplement with models from transport.models[]
        for entry in registry::all_entries() {
            if entry.hidden {
                continue;
            }
            // Use alias as the provider key (matching AI_MODELS convention)
            let provider = if !entry.alias.is_empty() { entry.alias } else { entry.id };

            for pm in entry.models {
                let model = pm.id;
                let name = if !pm.name.is_empty() { pm.name } else { pm.id };

                // Dedup by (provider, model)
                let full_model = format!("{}/{}", provider, model);
                if seen_full.contains(&full_model) {
                    continue;
                }
                // Also check dedup by (id, model) in case AI_MODELS used the id
                let full_by_id = format!("{}/{}", entry.id, model);
                if seen_full.contains(&full_by_id) {
                    continue;
                }

                // Get provider alias for disabled check + routing
                let provider_alias = config::id_to_alias(provider).unwrap_or(provider);
                let disabled_list = disabled.get(provider_alias).or_else(|| disabled.get(provider));
                if let Some(list) = disabled_list {
                    if list.contains(&model.to_string()) {
                        continue;
                    }
                }

                seen_full.insert(full_model.clone());

                let routed_model = format!("{}/{}", provider_alias, model);
                let alias = aliases.get(&full_model).cloned().unwrap_or_else(|| model.to_string());
                let caps = capabilities::get_capabilities_for_model(provider, model);

                models.push(serde_json::json!({
                    "provider": provider,
                    "model": model,
                    "name": name,
                    "fullModel": full_model,
                    "routedModel": routed_model,
                    "alias": alias,
                    "caps": {
                        "vision": caps.vision,
                        "search": caps.search,
                        "reasoning": caps.reasoning,
                        "contextWindow": caps.context_window,
                        "maxOutput": caps.max_output,
                    },
                }));
            }
        }

        // Add custom models (llm type only, not already in catalog)
        for cm in &custom {
            let cm_type = &cm.model_type;
            if cm_type != "llm" {
                continue;
            }
            let full_model = format!("{}/{}", cm.provider_alias, cm.id);
            if seen_full.contains(&full_model) {
                continue;
            }
            let caps = capabilities::get_capabilities_for_model(&cm.provider_alias, &cm.id);
            let mut caps_json = serde_json::json!({
                "vision": caps.vision,
                "search": caps.search,
                "reasoning": caps.reasoning,
                "contextWindow": caps.context_window,
                "maxOutput": caps.max_output,
            });
            // Override with stored caps
            if let Some(stored_caps) = &cm.caps {
                if let (Some(target), Some(src)) = (caps_json.as_object_mut(), stored_caps.as_object()) {
                    for (k, v) in src {
                        target.insert(k.clone(), v.clone());
                    }
                }
            }

            models.push(serde_json::json!({
                "provider": cm.provider_alias,
                "model": cm.id,
                "name": cm.name.as_deref().unwrap_or(&cm.id),
                "fullModel": full_model,
                "routedModel": full_model,
                "alias": aliases.get(&full_model).cloned().unwrap_or_else(|| cm.id.clone()),
                "caps": caps_json,
            }));
        }

        Ok(serde_json::json!({"models": models}))
    })
    .await;

    match result {
        Ok(Ok(data)) => Json(data).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch models"}))).into_response(),
    }
}

/// GET /api/models/alias — get all model aliases.
pub async fn get_aliases(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<std::collections::HashMap<String, String>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        model_aliases::get_model_aliases(&conn)
    })
    .await;

    match result {
        Ok(Ok(aliases)) => Json(serde_json::json!({"aliases": aliases})).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch aliases"}))).into_response(),
    }
}

/// POST /api/models/alias — set model alias.
pub async fn set_alias(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let alias = body.get("alias").and_then(|v| v.as_str()).unwrap_or("");

    if model.is_empty() || alias.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Model and alias required"}))).into_response();
    }

    // Check if alias already exists for a different model
    let pool_c = pool.clone();
    let model_c = model.to_string();
    let alias_c = alias.to_string();
    let check = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let aliases = model_aliases::get_model_aliases(&conn)?;
        // Check if any other model has this alias
        let exists = aliases.iter().any(|(k, v)| *v == alias_c && *k != model_c);
        Ok(exists)
    })
    .await;

    if let Ok(Ok(true)) = check {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Alias already in use"}))).into_response();
    }

    let pool_c = pool.clone();
    let model_c = model.to_string();
    let alias_c = alias.to_string();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        model_aliases::set_model_alias(&conn, &model_c, &alias_c)
    })
    .await;

    match result {
        Ok(Ok(())) => Json(serde_json::json!({"success": true, "model": model, "alias": alias})).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to update alias"}))).into_response(),
    }
}

/// GET /api/models/availability — per-model availability heuristic.
/// A model is available if its provider has >=1 active connection in the DB,
/// OR the provider is a free-tier/free category (always available without credentials).
pub async fn availability(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        // Get all active connections to build a set of providers with active creds
        use crate::db::repos::connections::{get_provider_connections, ConnectionFilter};
        let active_filter = ConnectionFilter { is_active: Some(true), ..Default::default() };
        let active_conns = get_provider_connections(&conn, &active_filter).unwrap_or_default();

        // Build a set of provider IDs + aliases that have at least one active connection
        let mut active_providers: std::collections::HashSet<String> = std::collections::HashSet::new();
        for c in &active_conns {
            active_providers.insert(c.provider.clone());
            // Also insert the alias if available
            if let Some(alias) = config::id_to_alias(&c.provider) {
                active_providers.insert(alias.to_string());
            }
        }

        // Build availability catalog from AI_MODELS + registry (same as list endpoint)
        let mut models: Vec<serde_json::Value> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        // Helper: check if a provider key is available (active connection or free-tier/free category)
        let is_available = |provider_key: &str| -> bool {
            // Check if provider has active connection
            if active_providers.contains(provider_key) {
                return true;
            }
            // Check if provider is free-tier or free category (always available)
            if registry::is_free_tier_provider(provider_key) {
                return true;
            }
            // Also check by id (in case provider_key is an alias)
            if let Some(entry) = registry::by_id_or_alias(provider_key) {
                if entry.category == registry::ProviderCategory::FreeTier
                    || entry.category == registry::ProviderCategory::Free
                {
                    return true;
                }
            }
            false
        };

        // AI_MODELS entries
        for (provider, model, _) in AI_MODELS.iter() {
            let key = format!("{}/{}", provider, model);
            if seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            models.push(serde_json::json!({
                "provider": provider,
                "model": model,
                "available": is_available(provider),
            }));
        }

        // Registry entries (non-hidden)
        for entry in registry::all_entries() {
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
                    "available": is_available(provider),
                }));
            }
        }

        Ok(serde_json::json!({"models": models}))
    })
    .await;

    match result {
        Ok(Ok(data)) => Json(data).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch model availability"}))).into_response(),
    }
}

/// POST /api/models/catalog-sync — sync catalog (Phase 2 stub).
pub async fn catalog_sync(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }
    Json(serde_json::json!({"added": 0, "removed": 0, "unchanged": AI_MODELS.len()})).into_response()
}

/// GET /api/models/custom — list custom models.
pub async fn list_custom(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<custom_models::CustomModel>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        custom_models::get_custom_models(&conn)
    })
    .await;

    match result {
        Ok(Ok(models)) => Json(serde_json::json!({"models": models})).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch custom models"}))).into_response(),
    }
}

/// POST /api/models/custom — add custom model.
pub async fn add_custom(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;
    let provider_alias = body.get("providerAlias").and_then(|v| v.as_str()).unwrap_or("");
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let model_type = body.get("type").and_then(|v| v.as_str()).unwrap_or("llm");
    let name = body.get("name").and_then(|v| v.as_str());
    let caps = body.get("caps");

    if provider_alias.is_empty() || id.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "providerAlias and id required"}))).into_response();
    }

    // Sanitize caps — only allow boolean vision/reasoning/search keys
    let clean_caps: Option<serde_json::Value> = caps.and_then(|c| {
        if let Some(obj) = c.as_object() {
            let mut clean = serde_json::Map::new();
            for key in &["vision", "reasoning", "search"] {
                if let Some(v) = obj.get(*key) {
                    if let Some(b) = v.as_bool() {
                        clean.insert(key.to_string(), serde_json::json!(b));
                    }
                }
            }
            if clean.is_empty() { None } else { Some(serde_json::Value::Object(clean)) }
        } else {
            None
        }
    });

    let pool_c = pool.clone();
    let pa = provider_alias.to_string();
    let id_c = id.to_string();
    let mt = model_type.to_string();
    let name_c = name.map(|s| s.to_string());
    let caps_clone = clean_caps.clone();

    // Check for duplicate {providerAlias, id} before creating
    let pool_dup = pool.clone();
    let pa_dup = pa.clone();
    let id_dup = id_c.clone();
    let dup_check = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = pool_dup.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        custom_models::custom_model_exists(&conn, &pa_dup, &id_dup)
    })
    .await;

    if let Ok(Ok(true)) = dup_check {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Custom model already exists"}))).into_response();
    }

    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        custom_models::add_custom_model(&conn, &pa, &id_c, &mt, name_c.as_deref(), caps_clone.as_ref())
    })
    .await;

    match result {
        Ok(Ok(added)) => {
            let custom = custom_models::CustomModel {
                provider_alias: provider_alias.to_string(),
                id: id.to_string(),
                model_type: model_type.to_string(),
                name: name.map(|s| s.to_string()),
                caps: clean_caps,
            };
            (StatusCode::CREATED, Json(serde_json::json!({"success": true, "added": added, "model": custom}))).into_response()
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to add custom model"}))).into_response(),
    }
}

/// GET /api/models/disabled — list disabled models.
pub async fn list_disabled(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Query(q): Query<DisabledQuery>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let provider_alias = q.provider_alias.clone();
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let all = disabled_models::get_disabled_models(&conn)?;
        if let Some(pa) = &provider_alias {
            let ids = all.get(pa).cloned().unwrap_or_default();
            Ok(serde_json::json!({"ids": ids}))
        } else {
            Ok(serde_json::json!({"disabled": all}))
        }
    })
    .await;

    match result {
        Ok(Ok(data)) => Json(data).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch disabled models"}))).into_response(),
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct DisabledQuery {
    pub provider_alias: Option<String>,
}

/// POST /api/models/disabled — disable models for a provider.
pub async fn disable_models(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;
    let provider_alias = body.get("providerAlias").and_then(|v| v.as_str()).unwrap_or("");
    let ids: Vec<String> = body.get("ids").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|i| i.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    if provider_alias.is_empty() || ids.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "providerAlias and ids[] required"}))).into_response();
    }

    let pool_c = pool.clone();
    let pa = provider_alias.to_string();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        disabled_models::disable_models(&conn, &pa, &ids)
    })
    .await;

    match result {
        Ok(Ok(())) => Json(serde_json::json!({"success": true})).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to disable models"}))).into_response(),
    }
}

/// POST /api/models/test — test a model.
pub async fn test_model(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;
    let provider = body.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");

    if provider.is_empty() || model.is_empty() || api_key.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "provider, model, and apiKey required"}))).into_response();
    }

    let url = if base_url.is_empty() {
        "https://api.openai.com/v1/chat/completions".to_string()
    } else {
        format!("{}/chat/completions", base_url.trim_end_matches('/'))
    };

    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().unwrap_or_default();

    let res = client.post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({"model": model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1}).to_string())
        .send().await;

    match res {
        Ok(r) => {
            let status = r.status().as_u16();
            let ok = r.status().is_success();
            let error = if ok { None } else { Some(format!("HTTP {}", status)) };
            Json(serde_json::json!({
                "ok": ok,
                "status": status,
                "latencyMs": start.elapsed().as_millis() as u64,
                "error": error,
            })).into_response()
        }
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "status": 500,
            "latencyMs": start.elapsed().as_millis() as u64,
            "error": e.to_string(),
        })).into_response(),
    }
}
