//! Group management routes — JSON API.
//! Ported from src/app/api/groups/route.js.
//! GET/POST /api/groups, PUT/DELETE /api/groups/{id}

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use crate::db::DbPool;
use crate::db::repos::key_groups::{self, KeyGroup};
use crate::auth;

/// GET /api/groups — list key groups.
pub async fn list(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<KeyGroup>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        key_groups::get_key_groups(&conn)
    })
    .await;

    match result {
        Ok(Ok(groups)) => Json(serde_json::json!({"groups": groups})).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to fetch groups"})),
        )
            .into_response(),
    }
}

/// POST /api/groups — create key group.
pub async fn create(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("");
    if name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "name is required"})),
        )
            .into_response();
    }

    let is_active = body.get("isActive").and_then(|v| v.as_bool()).unwrap_or(true);
    let rpm = body.get("rpm").and_then(|v| v.as_i64()).filter(|r| *r > 0);
    let tpm = body.get("tpm").and_then(|v| v.as_i64()).filter(|r| *r > 0);
    let budget_usd = body.get("budgetUsd").and_then(|v| v.as_f64()).filter(|r| *r > 0.0);
    let reset_window = body.get("resetWindow").and_then(|v| v.as_str())
        .filter(|s| !s.is_empty()).map(|s| s.to_string());

    // allowedModels
    let allowed_models = body.get("allowedModels").and_then(|v| {
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

    // priceOverrides
    let price_overrides = body.get("priceOverrides")
        .filter(|v| !v.is_null())
        .map(|v| serde_json::to_string(v).unwrap_or_default());

    let now = chrono::Utc::now().to_rfc3339();
    let group = KeyGroup {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        is_active,
        rpm,
        tpm,
        budget_usd,
        reset_window,
        allowed_models,
        price_overrides,
        created_at: now.clone(),
        updated_at: now,
    };

    let pool_c = pool.clone();
    let group_c = group.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        key_groups::create_key_group(&conn, &group_c)
    })
    .await;

    match result {
        Ok(Ok(())) => (
            StatusCode::CREATED,
            Json(serde_json::json!({"group": group})),
        )
            .into_response(),
        _ => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Failed to create group"})),
        )
            .into_response(),
    }
}

/// PUT /api/groups/{id} — update group.
pub async fn update(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let id_c = id.clone();
    let existing = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<KeyGroup>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        key_groups::get_key_group_by_id(&conn, &id_c)
    })
    .await;

    let existing = match existing {
        Ok(Ok(Some(g))) => g,
        Ok(Ok(None)) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "Group not found"})),
            )
                .into_response();
        }
        _ => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to fetch group"})),
            )
                .into_response();
        }
    };

    let body = body.0;
    let now = chrono::Utc::now().to_rfc3339();

    let name = body.get("name").and_then(|v| v.as_str())
        .map(|s| s.to_string()).unwrap_or_else(|| existing.name.clone());
    let is_active = body.get("isActive").and_then(|v| v.as_bool()).unwrap_or(existing.is_active);
    let rpm = body.get("rpm").and_then(|v| v.as_i64()).filter(|r| *r > 0).or(existing.rpm);
    let tpm = body.get("tpm").and_then(|v| v.as_i64()).filter(|r| *r > 0).or(existing.tpm);
    let budget_usd = body.get("budgetUsd").and_then(|v| v.as_f64()).filter(|r| *r > 0.0).or(existing.budget_usd);
    let reset_window = body.get("resetWindow").and_then(|v| v.as_str())
        .filter(|s| !s.is_empty()).map(|s| s.to_string())
        .or(existing.reset_window);

    let allowed_models = if let Some(v) = body.get("allowedModels") {
        if v.is_null() { existing.allowed_models.clone() }
        else if let Some(arr) = v.as_array() {
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
        } else { existing.allowed_models.clone() }
    } else { existing.allowed_models.clone() };

    let group = KeyGroup {
        id: existing.id.clone(),
        name,
        is_active,
        rpm,
        tpm,
        budget_usd,
        reset_window,
        allowed_models,
        price_overrides: existing.price_overrides.clone(),
        created_at: existing.created_at.clone(),
        updated_at: now,
    };

    let pool_c = pool.clone();
    let group_c = group.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        key_groups::update_key_group(&conn, &group_c)
    })
    .await;

    match result {
        Ok(Ok(())) => Json(group).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to update group"})),
        )
            .into_response(),
    }
}

/// DELETE /api/groups/{id} — delete group (detaches keys).
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
        let mut conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let tx = conn.transaction()?;
        tx.execute("UPDATE apiKeys SET groupId = NULL WHERE groupId = ?", [&id])?;
        tx.execute("DELETE FROM keyGroups WHERE id = ?", [&id])?;
        tx.commit()?;
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => Json(serde_json::json!({"success": true})).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to delete group"})),
        )
            .into_response(),
    }
}
