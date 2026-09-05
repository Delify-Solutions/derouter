//! Combo management routes — JSON API.
//! Ported from src/app/api/combos/route.js.
//! GET/POST /api/combos, PUT/DELETE /api/combos/{id}, POST /api/combos/{name}/test

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use crate::db::DbPool;
use crate::db::repos::combos::{self, Combo};
use crate::auth;

/// GET /api/combos — list all combos.
pub async fn list(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<Combo>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        combos::get_combos(&conn)
    })
    .await;

    match result {
        Ok(Ok(c)) => Json(serde_json::json!({"combos": c})).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to fetch combos"})),
        )
            .into_response(),
    }
}

/// POST /api/combos — create combo.
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
            Json(serde_json::json!({"error": "Name is required"})),
        )
            .into_response();
    }

    // Validate name format: a-zA-Z0-9_.-
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-') {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Name can only contain letters, numbers, -, _ and ."})),
        )
            .into_response();
    }

    // Check if name already exists
    let pool_c = pool.clone();
    let name_c = name.to_string();
    let existing = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<Combo>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        combos::get_combo_by_name(&conn, &name_c)
    })
    .await;

    if matches!(existing, Ok(Ok(Some(_))) ) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Combo name already exists"})),
        )
            .into_response();
    }

    // Parse models (array or newline-separated string)
    let models: Vec<String> = if let Some(arr) = body.get("models").and_then(|v| v.as_array()) {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect()
    } else if let Some(s) = body.get("models").and_then(|v| v.as_str()) {
        s.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    } else {
        vec![]
    };

    let kind = body.get("kind").and_then(|v| v.as_str())
        .filter(|s| !s.is_empty()).map(|s| s.to_string());

    let now = chrono::Utc::now().to_rfc3339();
    let combo = Combo {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        kind,
        models,
        created_at: now.clone(),
        updated_at: now,
    };

    // Optional combo-level pricing
    if let Some(pricing) = body.get("pricing").and_then(|v| v.as_object()) {
        if !pricing.is_empty() {
            let pool_c = pool.clone();
            let name_c = name.to_string();
            let pricing_val = serde_json::Value::Object(pricing.clone());
            let _ = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
                crate::db::repos::kv::kv_set(&conn, "comboPricing", &name_c, &pricing_val)
            })
            .await;
        }
    }

    let pool_c = pool.clone();
    let combo_c = combo.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        combos::create_combo(&conn, &combo_c)
    })
    .await;

    match result {
        Ok(Ok(())) => (StatusCode::CREATED, Json(combo)).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to create combo"})),
        )
            .into_response(),
    }
}

/// PUT /api/combos/{id} — update combo.
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

    // Get existing combo
    let pool_c = pool.clone();
    let id_c = id.clone();
    let existing = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<Combo>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let all = combos::get_combos(&conn)?;
        Ok(all.into_iter().find(|c| c.id == id_c))
    })
    .await;

    let existing = match existing {
        Ok(Ok(Some(c))) => c,
        Ok(Ok(None)) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "Combo not found"})),
            )
                .into_response();
        }
        _ => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to fetch combo"})),
            )
                .into_response();
        }
    };

    let models: Vec<String> = if let Some(arr) = body.get("models").and_then(|v| v.as_array()) {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect()
    } else if let Some(s) = body.get("models").and_then(|v| v.as_str()) {
        s.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    } else {
        existing.models.clone()
    };

    let kind = body.get("kind").and_then(|v| v.as_str())
        .filter(|s| !s.is_empty()).map(|s| s.to_string())
        .or(existing.kind);

    let now = chrono::Utc::now().to_rfc3339();
    let combo = Combo {
        id: existing.id.clone(),
        name: existing.name.clone(),
        kind,
        models,
        created_at: existing.created_at.clone(),
        updated_at: now,
    };

    let pool_c = pool.clone();
    let combo_c = combo.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        combos::update_combo(&conn, &combo_c)
    })
    .await;

    match result {
        Ok(Ok(())) => Json(combo).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to update combo"})),
        )
            .into_response(),
    }
}

/// DELETE /api/combos/{id} — delete combo.
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
        let all = combos::get_combos(&conn)?;
        if let Some(c) = all.into_iter().find(|c| c.id == id || c.name == id) {
            combos::delete_combo(&conn, &c.id)?;
        }
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => Json(serde_json::json!({"success": true})).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to delete combo"})),
        )
            .into_response(),
    }
}

/// POST /api/combos/{name}/test — test combo via internal ping.
pub async fn test(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(name): Path<String>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let start = std::time::Instant::now();
    let port: u16 = std::env::var("DEROUTER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(20128);

    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/v1/chat/completions", port);
    let body = serde_json::json!({
        "model": name,
        "messages": [{"role": "user", "content": "Hi"}],
        "stream": false
    });

    let result = client.post(&url).json(&body).send().await;
    let latency_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if resp.status().is_success() {
                match resp.json::<serde_json::Value>().await {
                    Ok(json) => {
                        let content = json.get("choices")
                            .and_then(|c| c.get(0))
                            .and_then(|c| c.get("message"))
                            .and_then(|m| m.get("content"))
                            .and_then(|c| c.as_str())
                            .unwrap_or("").to_string();
                        Json(serde_json::json!({
                            "ok": true,
                            "latencyMs": latency_ms,
                            "status": status,
                            "content": content
                        })).into_response()
                    }
                    Err(_) => (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({
                            "ok": false,
                            "latencyMs": latency_ms,
                            "status": status,
                            "content": "",
                            "error": "Failed to parse response"
                        })),
                    )
                        .into_response(),
                }
            } else {
                let err_text = resp.text().await.unwrap_or_default();
                (
                    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                    Json(serde_json::json!({
                        "ok": false,
                        "latencyMs": latency_ms,
                        "status": status,
                        "content": "",
                        "error": format!("HTTP {}: {}", status, err_text)
                    })),
                )
                    .into_response()
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "ok": false,
                "latencyMs": latency_ms,
                "status": 0,
                "content": "",
                "error": format!("Connection failed: {}", e)
            })),
        )
            .into_response(),
    }
}
