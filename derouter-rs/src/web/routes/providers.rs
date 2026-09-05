//! Provider management routes — Phase 2 full CRUD.
//! HTMX fragment pattern: list page, modal form, row partials.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use crate::db::DbPool;
use crate::db::repos::connections::{self, ProviderConnection};
use crate::templates::{ProviderItem, ProvidersListPage, ProviderForm, ProviderRow};
use crate::web::render::Render;

/// GET /dashboard/providers — list page (full HTML)
pub async fn list(State(pool): State<DbPool>) -> impl IntoResponse {
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<ProviderConnection>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::get_provider_connections(&conn, &connections::ConnectionFilter::default())
    })
    .await;

    match result {
        Ok(Ok(conns)) => {
            let items: Vec<ProviderItem> = conns.iter().map(|c| ProviderItem {
                id: c.id.clone(),
                provider: c.provider.clone(),
                name: c.name.clone().unwrap_or_default(),
                auth_type: c.auth_type.clone(),
                priority: c.priority.unwrap_or(999).to_string(),
                is_active: c.is_active,
            }).collect();
            Render::new(ProvidersListPage { items })
        }
        _ => Render::new(ProvidersListPage { items: vec![] }),
    }
}

/// GET /dashboard/providers/new — return modal form for new provider (HTMX fragment)
pub async fn new() -> impl IntoResponse {
    Render::new(ProviderForm {
        is_edit: "Add".to_string(),
        connection_id: String::new(),
        provider: "openai".to_string(),
        connection_name: String::new(),
        auth_type: "api-key".to_string(),
        base_url: String::new(),
        priority: "100".to_string(),
        is_active: true,
    })
}

/// GET /dashboard/providers/:id — return modal form for editing (HTMX fragment)
pub async fn edit(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ProviderConnection>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::get_provider_connection_by_id(&conn, &id)
    })
    .await;

    match result {
        Ok(Ok(Some(conn))) => {
            let base_url = conn.data.get("BaseUrl")
                .or_else(|| conn.data.get("baseUrl"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Render::new(ProviderForm {
                is_edit: "Edit".to_string(),
                connection_id: conn.id.clone(),
                provider: conn.provider.clone(),
                connection_name: conn.name.clone().unwrap_or_default(),
                auth_type: conn.auth_type.clone(),
                base_url,
                priority: conn.priority.unwrap_or(100).to_string(),
                is_active: conn.is_active,
            })
        }
        _ => Render::new(ProviderForm {
            is_edit: "Add".to_string(),
            connection_id: String::new(),
            provider: "openai".to_string(),
            connection_name: String::new(),
            auth_type: "api-key".to_string(),
            base_url: String::new(),
            priority: "100".to_string(),
            is_active: true,
        }),
    }
}

/// POST /dashboard/providers — create new provider connection
pub async fn create(
    State(pool): State<DbPool>,
    form: axum::Form<ProviderFormData>,
) -> impl IntoResponse {
    let pid = uuid::Uuid::new_v4().to_string();
    let conn = build_connection(&pid, &form.0);
    let item = ProviderItem {
        id: conn.id.clone(),
        provider: conn.provider.clone(),
        name: conn.name.clone().unwrap_or_default(),
        auth_type: conn.auth_type.clone(),
        priority: conn.priority.unwrap_or(999).to_string(),
        is_active: conn.is_active,
    };
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let db = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::create_provider_connection(&db, &conn)
    })
    .await;

    match result {
        Ok(Ok(())) => Render::new(ProviderRow { item }).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Failed to create provider: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// PUT /dashboard/providers/:id — update provider connection
pub async fn update(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
    form: axum::Form<ProviderFormData>,
) -> impl IntoResponse {
    let conn = build_connection(&id, &form.0);
    let item = ProviderItem {
        id: conn.id.clone(),
        provider: conn.provider.clone(),
        name: conn.name.clone().unwrap_or_default(),
        auth_type: conn.auth_type.clone(),
        priority: conn.priority.unwrap_or(999).to_string(),
        is_active: conn.is_active,
    };
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let db = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::update_provider_connection(&db, &conn)
    })
    .await;

    match result {
        Ok(Ok(())) => Render::new(ProviderRow { item }).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Failed to update provider: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// DELETE /dashboard/providers/:id — delete provider connection
pub async fn delete(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let db = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        connections::delete_provider_connection(&db, &id)
    })
    .await;

    match result {
        Ok(Ok(true)) => StatusCode::OK,
        Ok(Ok(false)) => StatusCode::NOT_FOUND,
        Ok(Err(e)) => {
            tracing::error!("Failed to delete provider: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[derive(serde::Deserialize)]
pub struct ProviderFormData {
    pub provider: String,
    pub name: Option<String>,
    #[serde(rename = "authType")]
    pub auth_type: Option<String>,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    pub priority: Option<i64>,
    #[serde(rename = "isActive")]
    pub is_active: Option<String>,
}

fn build_connection(id: &str, data: &ProviderFormData) -> ProviderConnection {
    let now = chrono::Utc::now().to_rfc3339();
    let is_active = data.is_active.as_deref().map(|v| v == "true").unwrap_or(true);

    let mut data_json = serde_json::json!({});
    if let Some(ref key) = data.api_key {
        if !key.is_empty() {
            data_json["apiKey"] = serde_json::json!(key);
        }
    }
    if let Some(ref url) = data.base_url {
        if !url.is_empty() {
            data_json["baseUrl"] = serde_json::json!(url);
        }
    }

    ProviderConnection {
        id: id.to_string(),
        provider: data.provider.clone(),
        auth_type: data.auth_type.clone().unwrap_or_else(|| "api-key".to_string()),
        name: data.name.clone().filter(|s| !s.is_empty()),
        email: None,
        priority: data.priority,
        is_active,
        data: data_json,
        created_at: now.clone(),
        updated_at: now,
    }
}
