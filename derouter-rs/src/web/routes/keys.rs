//! API key management routes — JSON API.
//! Ported from src/app/api/keys/route.js.
//! GET/POST /api/keys, PUT/DELETE /api/keys/{id}

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use crate::db::DbPool;
use crate::db::repos::api_keys::{self, ApiKey};
use crate::auth;

/// GET /api/keys — list API keys.
pub async fn list(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<ApiKey>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        api_keys::get_api_keys(&conn)
    })
    .await;

    match result {
        Ok(Ok(keys)) => Json(serde_json::json!({"keys": keys})).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to fetch keys"})),
        )
            .into_response(),
    }
}

/// POST /api/keys — create API key.
pub async fn create(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;

    // Validate name
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("");
    if name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Name is required"})),
        )
            .into_response();
    }

    // Get machineId (simple: use hostname + salt, or just uuid-based)
    let machine_id = get_machine_id();

    let group_id = body.get("groupId").and_then(|v| v.as_str())
        .filter(|s| !s.is_empty()).map(|s| s.to_string());
    let rpm = body.get("rpm").and_then(|v| v.as_i64()).filter(|r| *r > 0);
    let tpm = body.get("tpm").and_then(|v| v.as_i64()).filter(|r| *r > 0);
    let budget_usd = body.get("budgetUsd").and_then(|v| v.as_f64()).filter(|r| *r > 0.0);
    let reset_window = body.get("resetWindow").and_then(|v| v.as_str())
        .filter(|s| !s.is_empty()).map(|s| s.to_string());
    let expires_at = body.get("expiresAt").and_then(|v| v.as_str())
        .filter(|s| !s.is_empty()).map(|s| s.to_string());

    // allowedModels can be array or comma-separated string
    let allowed_models: Option<String> = body.get("allowedModels").and_then(|v| {
        if let Some(arr) = v.as_array() {
            let strs: Vec<String> = arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
            if strs.is_empty() { None } else { serde_json::to_string(&strs).ok() }
        } else if let Some(s) = v.as_str() {
            let parts: Vec<String> = s.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if parts.is_empty() { None } else { serde_json::to_string(&parts).ok() }
        } else {
            None
        }
    });

    let is_active = body.get("isActive").and_then(|v| v.as_bool()).unwrap_or(true);
    let key_string = api_keys::generate_key_string();
    let now = chrono::Utc::now().to_rfc3339();
    let key_id = uuid::Uuid::new_v4().to_string();

    let key = ApiKey {
        id: key_id.clone(),
        key: key_string.clone(),
        name: Some(name.to_string()),
        machine_id: Some(machine_id),
        is_active,
        created_at: now.clone(),
        group_id,
        rpm,
        tpm,
        budget_usd,
        reset_window,
        expires_at,
        allowed_models,
        window_started_at: Some(now.clone()),
        window_cost_usd: 0.0,
        updated_at: Some(now),
    };

    let pool_c = pool.clone();
    let key_c = key.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        api_keys::create_api_key(&conn, &key_c)
    })
    .await;

    match result {
        Ok(Ok(())) => {
            // Return the key with the full key value (only shown once)
            let mut key_json = serde_json::to_value(&key).unwrap_or(serde_json::json!({}));
            if let Some(map) = key_json.as_object_mut() {
                // Parse allowedModels back to array for the response
                if let Some(models_str) = key.allowed_models.as_ref() {
                    if let Ok(arr) = serde_json::from_str::<Vec<String>>(models_str) {
                        map.insert("allowedModels".to_string(), serde_json::json!(arr));
                    }
                }
            }
            (
                StatusCode::CREATED,
                Json(key_json),
            )
                .into_response()
        }
        _ => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Failed to create key"})),
        )
            .into_response(),
    }
}

/// PUT /api/keys/{id} — update key.
pub async fn update(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Get existing key
    let pool_c = pool.clone();
    let id_c = id.clone();
    let existing = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ApiKey>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let all = api_keys::get_api_keys(&conn)?;
        Ok(all.into_iter().find(|k| k.id == id_c))
    })
    .await;

    let existing = match existing {
        Ok(Ok(Some(k))) => k,
        Ok(Ok(None)) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "Key not found"})),
            )
                .into_response();
        }
        _ => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to fetch key"})),
            )
                .into_response();
        }
    };

    let body = body.0;
    let now = chrono::Utc::now().to_rfc3339();

    let name = body.get("name").and_then(|v| v.as_str())
        .map(|s| s.to_string()).or(existing.name);
    let group_id = body.get("groupId").and_then(|v| v.as_str())
        .filter(|s| !s.is_empty()).map(|s| s.to_string())
        .or(existing.group_id);
    let rpm = body.get("rpm").and_then(|v| v.as_i64()).filter(|r| *r > 0).or(existing.rpm);
    let tpm = body.get("tpm").and_then(|v| v.as_i64()).filter(|r| *r > 0).or(existing.tpm);
    let budget_usd = body.get("budgetUsd").and_then(|v| v.as_f64()).filter(|r| *r > 0.0).or(existing.budget_usd);
    let reset_window = body.get("resetWindow").and_then(|v| v.as_str())
        .filter(|s| !s.is_empty()).map(|s| s.to_string())
        .or(existing.reset_window);
    let expires_at = body.get("expiresAt").and_then(|v| v.as_str())
        .filter(|s| !s.is_empty()).map(|s| s.to_string())
        .or(existing.expires_at);
    let is_active = body.get("isActive").and_then(|v| v.as_bool()).unwrap_or(existing.is_active);

    // allowedModels
    let allowed_models = if let Some(v) = body.get("allowedModels") {
        if v.is_null() {
            existing.allowed_models.clone()
        } else if let Some(arr) = v.as_array() {
            let strs: Vec<String> = arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
            if strs.is_empty() { None } else { serde_json::to_string(&strs).ok() }
        } else if let Some(s) = v.as_str() {
            let parts: Vec<String> = s.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if parts.is_empty() { None } else { serde_json::to_string(&parts).ok() }
        } else {
            existing.allowed_models.clone()
        }
    } else {
        existing.allowed_models.clone()
    };

    let key = ApiKey {
        id: existing.id.clone(),
        key: existing.key.clone(),
        name,
        machine_id: existing.machine_id.clone(),
        is_active,
        created_at: existing.created_at.clone(),
        group_id,
        rpm,
        tpm,
        budget_usd,
        reset_window,
        expires_at,
        allowed_models,
        window_started_at: existing.window_started_at.clone(),
        window_cost_usd: existing.window_cost_usd,
        updated_at: Some(now),
    };

    let pool_c = pool.clone();
    let key_c = key.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        api_keys::update_api_key(&conn, &key_c)
    })
    .await;

    match result {
        Ok(Ok(())) => {
            let mut key_json = serde_json::to_value(&key).unwrap_or(serde_json::json!({}));
            if let Some(map) = key_json.as_object_mut() {
                if let Some(models_str) = key.allowed_models.as_ref() {
                    if let Ok(arr) = serde_json::from_str::<Vec<String>>(models_str) {
                        map.insert("allowedModels".to_string(), serde_json::json!(arr));
                    }
                }
            }
            Json(key_json).into_response()
        }
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to update key"})),
        )
            .into_response(),
    }
}

/// DELETE /api/keys/{id} — delete key.
pub async fn delete(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        api_keys::delete_api_key(&conn, &id)
    })
    .await;

    match result {
        Ok(Ok(())) => Json(serde_json::json!({"success": true})).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to delete key"})),
        )
            .into_response(),
    }
}

/// Get a consistent machine ID (simple: hash of hostname).
/// Phase 3 will port the full getConsistentMachineId with MACHINE_ID_SALT.
fn get_machine_id() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hasher, Hash};

    let salt = std::env::var("MACHINE_ID_SALT").unwrap_or_else(|_| "endpoint-proxy-salt".to_string());
    let hostname = std::env::var("HOSTNAME").unwrap_or_else(|_| {
        std::env::var("HOST").unwrap_or_else(|_| "localhost".to_string())
    });
    let combined = format!("{}:{}", hostname, salt);

    let mut hasher = DefaultHasher::new();
    combined.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}
