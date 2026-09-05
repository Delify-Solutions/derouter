//! API key management routes — Phase 2 full CRUD.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use crate::db::DbPool;
use crate::db::repos::api_keys::{self, ApiKey};
use crate::db::repos::key_groups;
use crate::templates::{KeyItem, KeysListPage, KeyForm, KeyRow, GroupOption};
use crate::web::render::Render;

/// GET /dashboard/keys — list page
pub async fn list(State(pool): State<DbPool>) -> impl IntoResponse {
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<ApiKey>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        api_keys::get_api_keys(&conn)
    })
    .await;

    match result {
        Ok(Ok(keys)) => {
            let items: Vec<KeyItem> = keys.iter().map(|k| KeyItem {
                id: k.id.clone(),
                name: k.name.clone().unwrap_or_else(|| "(unnamed)".to_string()),
                masked_key: api_keys::mask_key(&k.key),
                group: k.group_id.clone().unwrap_or_else(|| "—".to_string()),
                rpm: k.rpm.map(|r| r.to_string()).unwrap_or_else(|| "—".to_string()),
                tpm: k.tpm.map(|r| r.to_string()).unwrap_or_else(|| "—".to_string()),
                budget: k.budget_usd.map(|r| format!("${:.2}", r)).unwrap_or_else(|| "—".to_string()),
                is_active: k.is_active,
            }).collect();
            Render::new(KeysListPage { items })
        }
        _ => Render::new(KeysListPage { items: vec![] }),
    }
}

/// GET /dashboard/keys/new — modal form
pub async fn new(State(pool): State<DbPool>) -> impl IntoResponse {
    let groups = get_group_options(&pool).await;
    Render::new(KeyForm {
        is_edit: "Add".to_string(),
        key_id: String::new(),
        name: String::new(),
        group_id: String::new(),
        groups,
        rpm: String::new(),
        tpm: String::new(),
        budget_usd: String::new(),
        reset_window: String::new(),
        expires_at: String::new(),
        allowed_models: String::new(),
        is_active: true,
        new_key: String::new(),
        show_key: false,
    })
}

/// GET /dashboard/keys/:id — modal form for editing
pub async fn edit(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let pool_c = pool.clone();
    let id_c = id.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ApiKey>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let all = api_keys::get_api_keys(&conn)?;
        Ok(all.into_iter().find(|k| k.id == id_c))
    })
    .await;

    let groups = get_group_options(&pool).await;

    match result {
        Ok(Ok(Some(k))) => {
            let allowed_models = k.allowed_models
                .as_deref()
                .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                .map(|v| v.join(", "))
                .unwrap_or_default();
            Render::new(KeyForm {
                is_edit: "Edit".to_string(),
                key_id: k.id.clone(),
                name: k.name.unwrap_or_default(),
                group_id: k.group_id.unwrap_or_default(),
                groups,
                rpm: k.rpm.map(|r| r.to_string()).unwrap_or_default(),
                tpm: k.tpm.map(|r| r.to_string()).unwrap_or_default(),
                budget_usd: k.budget_usd.map(|r| r.to_string()).unwrap_or_default(),
                reset_window: k.reset_window.unwrap_or_default(),
                expires_at: k.expires_at.unwrap_or_default(),
                allowed_models,
                is_active: k.is_active,
                new_key: String::new(),
                show_key: false,
            })
        }
        _ => Render::new(KeyForm {
            is_edit: "Add".to_string(),
            key_id: String::new(),
            name: String::new(),
            group_id: String::new(),
            groups,
            rpm: String::new(),
            tpm: String::new(),
            budget_usd: String::new(),
            reset_window: String::new(),
            expires_at: String::new(),
            allowed_models: String::new(),
            is_active: true,
            new_key: String::new(),
            show_key: false,
        }),
    }
}

/// POST /dashboard/keys — create key
pub async fn create(
    State(pool): State<DbPool>,
    form: axum::Form<KeyFormData>,
) -> impl IntoResponse {
    let key_string = api_keys::generate_key_string();
    let key = build_key(None, &form.0, &key_string);
    let pool_c = pool.clone();
    let key_c = key.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        api_keys::create_api_key(&conn, &key_c)
    })
    .await;

    match result {
        Ok(Ok(())) => {
            let groups = get_group_options(&pool).await;
            Render::new(KeyForm {
                is_edit: "Edit".to_string(),
                key_id: key.id.clone(),
                name: key.name.clone().unwrap_or_default(),
                group_id: key.group_id.clone().unwrap_or_default(),
                groups,
                rpm: key.rpm.map(|r| r.to_string()).unwrap_or_default(),
                tpm: key.tpm.map(|r| r.to_string()).unwrap_or_default(),
                budget_usd: key.budget_usd.map(|r| r.to_string()).unwrap_or_default(),
                reset_window: key.reset_window.clone().unwrap_or_default(),
                expires_at: key.expires_at.clone().unwrap_or_default(),
                allowed_models: form.0.allowed_models.clone(),
                is_active: key.is_active,
                new_key: key_string,
                show_key: true,
            }).into_response()
        }
        Ok(Err(e)) => {
            tracing::error!("Failed to create key: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// PUT /dashboard/keys/:id — update key
pub async fn update(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
    form: axum::Form<KeyFormData>,
) -> impl IntoResponse {
    let mut key = build_key(Some(&id), &form.0, "");
    let pool_c = pool.clone();
    let id_c = id.clone();
    let existing = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ApiKey>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let all = api_keys::get_api_keys(&conn)?;
        Ok(all.into_iter().find(|k| k.id == id_c))
    })
    .await;
    if let Ok(Ok(Some(ref existing_key))) = existing {
        key.key = existing_key.key.clone();
        key.created_at = existing_key.created_at.clone();
        key.window_started_at = existing_key.window_started_at.clone();
        key.window_cost_usd = existing_key.window_cost_usd;
    }

    let masked = api_keys::mask_key(&key.key);
    let item = KeyItem {
        id: key.id.clone(),
        name: key.name.clone().unwrap_or_else(|| "(unnamed)".to_string()),
        masked_key: masked,
        group: key.group_id.clone().unwrap_or_else(|| "—".to_string()),
        rpm: key.rpm.map(|r| r.to_string()).unwrap_or_else(|| "—".to_string()),
        tpm: key.tpm.map(|r| r.to_string()).unwrap_or_else(|| "—".to_string()),
        budget: key.budget_usd.map(|r| format!("${:.2}", r)).unwrap_or_else(|| "—".to_string()),
        is_active: key.is_active,
    };

    let pool_c = pool.clone();
    let key_c = key.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        api_keys::update_api_key(&conn, &key_c)
    })
    .await;

    match result {
        Ok(Ok(())) => Render::new(KeyRow { item }).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Failed to update key: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// DELETE /dashboard/keys/:id — delete
pub async fn delete(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        api_keys::delete_api_key(&conn, &id)
    })
    .await;

    match result {
        Ok(Ok(())) => StatusCode::OK,
        Ok(Err(e)) => {
            tracing::error!("Failed to delete key: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

async fn get_group_options(pool: &DbPool) -> Vec<GroupOption> {
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<GroupOption>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let groups = key_groups::get_key_groups(&conn)?;
        Ok(groups.iter().map(|g| GroupOption {
            id: g.id.clone(),
            name: g.name.clone(),
        }).collect())
    })
    .await;
    result.ok().and_then(|r| r.ok()).unwrap_or_default()
}

#[derive(serde::Deserialize)]
pub struct KeyFormData {
    pub name: String,
    pub group_id: Option<String>,
    pub rpm: Option<i64>,
    pub tpm: Option<i64>,
    #[serde(rename = "budgetUsd")]
    pub budget_usd: Option<f64>,
    #[serde(rename = "resetWindow")]
    pub reset_window: Option<String>,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<String>,
    #[serde(rename = "allowedModels")]
    pub allowed_models: String,
    #[serde(rename = "isActive")]
    pub is_active: Option<String>,
}

fn build_key(id: Option<&str>, data: &KeyFormData, key_str: &str) -> ApiKey {
    let now = chrono::Utc::now().to_rfc3339();
    let key_id = id.map(|s| s.to_string()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let is_active = data.is_active.as_deref().map(|v| v == "true").unwrap_or(true);

    let group_id = data.group_id.as_deref().filter(|s| !s.is_empty()).map(|s| s.to_string());
    let rpm = data.rpm.filter(|r| *r > 0);
    let tpm = data.tpm.filter(|r| *r > 0);
    let budget_usd = data.budget_usd.filter(|r| *r > 0.0);
    let reset_window = data.reset_window.clone().filter(|s| !s.is_empty());
    let expires_at = data.expires_at.clone().filter(|s| !s.is_empty());

    let allowed_models_vec: Vec<String> = data.allowed_models
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let allowed_models = if allowed_models_vec.is_empty() {
        None
    } else {
        serde_json::to_string(&allowed_models_vec).ok()
    };

    ApiKey {
        id: key_id,
        key: if key_str.is_empty() { String::new() } else { key_str.to_string() },
        name: Some(data.name.clone()),
        machine_id: None,
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
    }
}
