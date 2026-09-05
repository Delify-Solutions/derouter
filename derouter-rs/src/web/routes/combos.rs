//! Combo management routes — Phase 2 full CRUD + combo test.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use crate::db::DbPool;
use crate::db::repos::combos::{self, Combo};
use crate::templates::{ComboItem, CombosListPage, ComboForm, ComboRow, ComboTestResult};
use crate::web::render::Render;

/// GET /dashboard/combos — list page
pub async fn list(State(pool): State<DbPool>) -> impl IntoResponse {
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<Combo>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        combos::get_combos(&conn)
    })
    .await;

    match result {
        Ok(Ok(c)) => {
            let items: Vec<ComboItem> = c.iter().map(|c| ComboItem {
                id: c.id.clone(),
                name: c.name.clone(),
                kind: c.kind.clone().unwrap_or_else(|| "default".to_string()),
                models_count: c.models.len(),
            }).collect();
            Render::new(CombosListPage { items })
        }
        _ => Render::new(CombosListPage { items: vec![] }),
    }
}

/// GET /dashboard/combos/new — modal form
pub async fn new() -> impl IntoResponse {
    Render::new(ComboForm {
        is_edit: "Add".to_string(),
        combo_id: String::new(),
        name: String::new(),
        kind: String::new(),
        models_text: String::new(),
    })
}

/// GET /dashboard/combos/:id — modal form for editing
pub async fn edit(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<Combo>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        if let Some(c) = combos::get_combo_by_name(&conn, &id)? {
            return Ok(Some(c));
        }
        let all = combos::get_combos(&conn)?;
        Ok(all.into_iter().find(|c| c.id == id))
    })
    .await;

    match result {
        Ok(Ok(Some(c))) => {
            Render::new(ComboForm {
                is_edit: "Edit".to_string(),
                combo_id: c.id.clone(),
                name: c.name.clone(),
                kind: c.kind.clone().unwrap_or_default(),
                models_text: c.models.join("\n"),
            })
        }
        _ => Render::new(ComboForm {
            is_edit: "Add".to_string(),
            combo_id: String::new(),
            name: String::new(),
            kind: String::new(),
            models_text: String::new(),
        }),
    }
}

/// POST /dashboard/combos — create
pub async fn create(
    State(pool): State<DbPool>,
    form: axum::Form<ComboFormData>,
) -> impl IntoResponse {
    let combo = build_combo(None, &form.0);
    let item = ComboItem {
        id: combo.id.clone(),
        name: combo.name.clone(),
        kind: combo.kind.clone().unwrap_or_else(|| "default".to_string()),
        models_count: combo.models.len(),
    };
    let pool_c = pool.clone();
    let combo_c = combo.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        combos::create_combo(&conn, &combo_c)
    })
    .await;

    match result {
        Ok(Ok(())) => Render::new(ComboRow { item }).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Failed to create combo: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// PUT /dashboard/combos/:id — update
pub async fn update(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
    form: axum::Form<ComboFormData>,
) -> impl IntoResponse {
    let mut combo = build_combo(Some(&id), &form.0);
    let pool_c = pool.clone();
    let id_c = id.clone();
    let existing = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<Combo>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let all = combos::get_combos(&conn)?;
        Ok(all.into_iter().find(|c| c.id == id_c))
    })
    .await;
    if let Ok(Ok(Some(ref existing_combo))) = existing {
        combo.created_at = existing_combo.created_at.clone();
    }

    let item = ComboItem {
        id: combo.id.clone(),
        name: combo.name.clone(),
        kind: combo.kind.clone().unwrap_or_else(|| "default".to_string()),
        models_count: combo.models.len(),
    };
    let pool_c = pool.clone();
    let combo_c = combo.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        combos::update_combo(&conn, &combo_c)
    })
    .await;

    match result {
        Ok(Ok(())) => Render::new(ComboRow { item }).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Failed to update combo: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// DELETE /dashboard/combos/:id — delete
pub async fn delete(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let all = combos::get_combos(&conn)?;
        let target = all.into_iter().find(|c| c.id == id || c.name == id);
        if let Some(c) = target {
            combos::delete_combo(&conn, &c.id)?;
        }
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => StatusCode::OK,
        Ok(Err(e)) => {
            tracing::error!("Failed to delete combo: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

/// POST /dashboard/combos/:name/test — test combo
pub async fn test(
    State(_pool): State<DbPool>,
    Path(name): Path<String>,
) -> impl IntoResponse {
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
            let status = resp.status();
            if status.is_success() {
                match resp.json::<serde_json::Value>().await {
                    Ok(json) => {
                        let reply = json.get("choices")
                            .and_then(|c| c.get(0))
                            .and_then(|c| c.get("message"))
                            .and_then(|m| m.get("content"))
                            .and_then(|c| c.as_str())
                            .unwrap_or("").to_string();
                        Render::new(ComboTestResult {
                            success: true,
                            reply,
                            error: String::new(),
                            latency_ms,
                        })
                    }
                    Err(_) => Render::new(ComboTestResult {
                        success: false,
                        reply: String::new(),
                        error: "Failed to parse response".to_string(),
                        latency_ms,
                    }),
                }
            } else {
                let err_text = resp.text().await.unwrap_or_default();
                Render::new(ComboTestResult {
                    success: false,
                    reply: String::new(),
                    error: format!("HTTP {}: {}", status.as_u16(), err_text),
                    latency_ms,
                })
            }
        }
        Err(e) => Render::new(ComboTestResult {
            success: false,
            reply: String::new(),
            error: format!("Connection failed: {}", e),
            latency_ms,
        }),
    }
}

#[derive(serde::Deserialize)]
pub struct ComboFormData {
    pub name: String,
    pub kind: Option<String>,
    pub models: String,
}

fn build_combo(id: Option<&str>, data: &ComboFormData) -> Combo {
    let now = chrono::Utc::now().to_rfc3339();
    let combo_id = id.map(|s| s.to_string()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let models: Vec<String> = data.models
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let kind = data.kind.as_deref().filter(|s| !s.is_empty()).map(|s| s.to_string());

    Combo {
        id: combo_id,
        name: data.name.clone(),
        kind,
        models,
        created_at: now.clone(),
        updated_at: now,
    }
}
