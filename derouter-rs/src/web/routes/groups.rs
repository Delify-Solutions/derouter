//! Group management routes — Phase 2 full CRUD.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use crate::db::DbPool;
use crate::db::repos::key_groups::{self, KeyGroup};
use crate::templates::{GroupItem, GroupsListPage, GroupForm, GroupRow};
use crate::web::render::Render;

/// GET /dashboard/groups — list page
pub async fn list(State(pool): State<DbPool>) -> impl IntoResponse {
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<KeyGroup>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        key_groups::get_key_groups(&conn)
    })
    .await;

    match result {
        Ok(Ok(groups)) => {
            let items: Vec<GroupItem> = groups.iter().map(|g| GroupItem {
                id: g.id.clone(),
                name: g.name.clone(),
                rpm: g.rpm.map(|r| r.to_string()).unwrap_or_else(|| "—".to_string()),
                tpm: g.tpm.map(|r| r.to_string()).unwrap_or_else(|| "—".to_string()),
                budget: g.budget_usd.map(|r| format!("${:.2}", r)).unwrap_or_else(|| "—".to_string()),
                reset_window: g.reset_window.clone().unwrap_or_else(|| "—".to_string()),
                is_active: g.is_active,
            }).collect();
            Render::new(GroupsListPage { items })
        }
        _ => Render::new(GroupsListPage { items: vec![] }),
    }
}

/// GET /dashboard/groups/new — modal form
pub async fn new() -> impl IntoResponse {
    Render::new(GroupForm {
        is_edit: "Add".to_string(),
        group_id: String::new(),
        name: String::new(),
        rpm: String::new(),
        tpm: String::new(),
        budget_usd: String::new(),
        reset_window: String::new(),
        allowed_models: String::new(),
        is_active: true,
    })
}

/// GET /dashboard/groups/:id — modal form for editing
pub async fn edit(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<KeyGroup>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        key_groups::get_key_group_by_id(&conn, &id)
    })
    .await;

    match result {
        Ok(Ok(Some(g))) => {
            let allowed_models = g.allowed_models
                .as_deref()
                .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                .map(|v| v.join(", "))
                .unwrap_or_default();
            Render::new(GroupForm {
                is_edit: "Edit".to_string(),
                group_id: g.id.clone(),
                name: g.name.clone(),
                rpm: g.rpm.map(|r| r.to_string()).unwrap_or_default(),
                tpm: g.tpm.map(|r| r.to_string()).unwrap_or_default(),
                budget_usd: g.budget_usd.map(|r| r.to_string()).unwrap_or_default(),
                reset_window: g.reset_window.unwrap_or_default(),
                allowed_models,
                is_active: g.is_active,
            })
        }
        _ => Render::new(GroupForm {
            is_edit: "Add".to_string(),
            group_id: String::new(),
            name: String::new(),
            rpm: String::new(),
            tpm: String::new(),
            budget_usd: String::new(),
            reset_window: String::new(),
            allowed_models: String::new(),
            is_active: true,
        }),
    }
}

/// POST /dashboard/groups — create
pub async fn create(
    State(pool): State<DbPool>,
    form: axum::Form<GroupFormData>,
) -> impl IntoResponse {
    let group = build_group(None, &form.0);
    let item = GroupItem {
        id: group.id.clone(),
        name: group.name.clone(),
        rpm: group.rpm.map(|r| r.to_string()).unwrap_or_else(|| "—".to_string()),
        tpm: group.tpm.map(|r| r.to_string()).unwrap_or_else(|| "—".to_string()),
        budget: group.budget_usd.map(|r| format!("${:.2}", r)).unwrap_or_else(|| "—".to_string()),
        reset_window: group.reset_window.clone().unwrap_or_else(|| "—".to_string()),
        is_active: group.is_active,
    };
    let pool_c = pool.clone();
    let group_c = group.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        key_groups::create_key_group(&conn, &group_c)
    })
    .await;

    match result {
        Ok(Ok(())) => Render::new(GroupRow { item }).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Failed to create group: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// PUT /dashboard/groups/:id — update
pub async fn update(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
    form: axum::Form<GroupFormData>,
) -> impl IntoResponse {
    let mut group = build_group(Some(&id), &form.0);
    let pool_c = pool.clone();
    let id_c = id.clone();
    let existing = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<KeyGroup>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        key_groups::get_key_group_by_id(&conn, &id_c)
    })
    .await;
    if let Ok(Ok(Some(ref existing_group))) = existing {
        group.created_at = existing_group.created_at.clone();
        group.price_overrides = existing_group.price_overrides.clone();
    }

    let item = GroupItem {
        id: group.id.clone(),
        name: group.name.clone(),
        rpm: group.rpm.map(|r| r.to_string()).unwrap_or_else(|| "—".to_string()),
        tpm: group.tpm.map(|r| r.to_string()).unwrap_or_else(|| "—".to_string()),
        budget: group.budget_usd.map(|r| format!("${:.2}", r)).unwrap_or_else(|| "—".to_string()),
        reset_window: group.reset_window.clone().unwrap_or_else(|| "—".to_string()),
        is_active: group.is_active,
    };
    let pool_c = pool.clone();
    let group_c = group.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        key_groups::update_key_group(&conn, &group_c)
    })
    .await;

    match result {
        Ok(Ok(())) => Render::new(GroupRow { item }).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Failed to update group: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// DELETE /dashboard/groups/:id — delete (detaches keys)
pub async fn delete(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
) -> impl IntoResponse {
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
        Ok(Ok(())) => StatusCode::OK,
        Ok(Err(e)) => {
            tracing::error!("Failed to delete group: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[derive(serde::Deserialize)]
pub struct GroupFormData {
    pub name: String,
    pub rpm: Option<i64>,
    pub tpm: Option<i64>,
    #[serde(rename = "budgetUsd")]
    pub budget_usd: Option<f64>,
    #[serde(rename = "resetWindow")]
    pub reset_window: Option<String>,
    #[serde(rename = "allowedModels")]
    pub allowed_models: String,
    #[serde(rename = "isActive")]
    pub is_active: Option<String>,
}

fn build_group(id: Option<&str>, data: &GroupFormData) -> KeyGroup {
    let now = chrono::Utc::now().to_rfc3339();
    let group_id = id.map(|s| s.to_string()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let is_active = data.is_active.as_deref().map(|v| v == "true").unwrap_or(true);

    let rpm = data.rpm.filter(|r| *r > 0);
    let tpm = data.tpm.filter(|r| *r > 0);
    let budget_usd = data.budget_usd.filter(|r| *r > 0.0);
    let reset_window = data.reset_window.clone().filter(|s| !s.is_empty());

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

    KeyGroup {
        id: group_id,
        name: data.name.clone(),
        is_active,
        rpm,
        tpm,
        budget_usd,
        reset_window,
        allowed_models,
        price_overrides: None,
        created_at: now.clone(),
        updated_at: now,
    }
}
