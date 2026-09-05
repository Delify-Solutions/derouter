//! Provider node management routes — JSON API.
//! Ported from src/app/api/provider-nodes/ with full validation parity.
//! GET /api/provider-nodes, POST, PUT/DELETE /api/provider-nodes/{id},
//! POST /api/provider-nodes/validate

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::db::DbPool;
use crate::db::repos::provider_nodes::{self, ProviderNode, ProviderNodeFilter};
use crate::providers::config;
use crate::auth;

const OPENAI_COMPATIBLE_DEFAULT_BASE: &str = "https://api.openai.com/v1";
const ANTHROPIC_COMPATIBLE_DEFAULT_BASE: &str = "https://api.anthropic.com/v1";
const CUSTOM_EMBEDDING_DEFAULT_BASE: &str = "https://api.openai.com/v1";

/// GET /api/provider-nodes — list all provider nodes.
pub async fn list(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<ProviderNode>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        provider_nodes::get_provider_nodes(&conn, &ProviderNodeFilter::default())
    })
    .await;

    match result {
        Ok(Ok(nodes)) => Json(serde_json::json!({"nodes": nodes})).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch provider nodes"}))).into_response(),
    }
}

/// POST /api/provider-nodes — create provider node.
pub async fn create(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;

    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let prefix = body.get("prefix").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let base_url_input = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let api_type = body.get("apiType").and_then(|v| v.as_str());
    let node_type = body.get("type").and_then(|v| v.as_str()).unwrap_or("openai-compatible");

    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Name is required"}))).into_response();
    }
    if prefix.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Prefix is required"}))).into_response();
    }

    let now = chrono::Utc::now().to_rfc3339();
    let id;
    let final_base_url;
    let final_type;

    match node_type {
        "openai-compatible" => {
            let at = match api_type {
                Some("chat") => "chat",
                Some("responses") => "responses",
                _ => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid OpenAI compatible API type"}))).into_response(),
            };
            id = format!("{}{}-{}", config::OPENAI_COMPATIBLE_PREFIX, at, uuid::Uuid::new_v4().simple());
            final_base_url = if base_url_input.is_empty() {
                OPENAI_COMPATIBLE_DEFAULT_BASE.to_string()
            } else {
                base_url_input
            };
            final_type = "openai-compatible".to_string();
        }
        "custom-embedding" => {
            id = format!("{}{}", config::CUSTOM_EMBEDDING_PREFIX, uuid::Uuid::new_v4().simple());
            // Strip trailing slash and /embeddings
            let mut sanitized = if base_url_input.is_empty() {
                CUSTOM_EMBEDDING_DEFAULT_BASE.to_string()
            } else {
                base_url_input
            };
            while sanitized.ends_with('/') {
                sanitized.pop();
            }
            if sanitized.ends_with("/embeddings") {
                sanitized = sanitized[..sanitized.len() - "/embeddings".len()].to_string();
            }
            final_base_url = sanitized;
            final_type = "custom-embedding".to_string();
        }
        "anthropic-compatible" => {
            id = format!("{}{}", config::ANTHROPIC_COMPATIBLE_PREFIX, uuid::Uuid::new_v4().simple());
            // Strip trailing slash and /messages
            let mut sanitized = if base_url_input.is_empty() {
                ANTHROPIC_COMPATIBLE_DEFAULT_BASE.to_string()
            } else {
                base_url_input
            };
            while sanitized.ends_with('/') {
                sanitized.pop();
            }
            if sanitized.ends_with("/messages") {
                sanitized = sanitized[..sanitized.len() - 9].to_string();
            }
            final_base_url = sanitized;
            final_type = "anthropic-compatible".to_string();
        }
        _ => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid provider node type"}))).into_response(),
    }

    let node = ProviderNode {
        id: id.clone(),
        node_type: Some(final_type),
        name: Some(name),
        prefix: Some(prefix),
        api_type: api_type.map(|s| s.to_string()),
        base_url: Some(final_base_url),
        created_at: now.clone(),
        updated_at: now,
    };

    let pool_c = pool.clone();
    let node_c = node.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        provider_nodes::create_provider_node(&conn, &node_c)
    })
    .await;

    match result {
        Ok(Ok(())) => (StatusCode::CREATED, Json(serde_json::json!({"node": node}))).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to create provider node"}))).into_response(),
    }
}

/// PUT /api/provider-nodes/{id} — update provider node.
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

    let pool_c = pool.clone();
    let id_c = id.clone();
    let existing = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<ProviderNode>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        provider_nodes::get_provider_node(&conn, &id_c)
    })
    .await;

    let mut existing = match existing {
        Ok(Ok(Some(n))) => n,
        Ok(Ok(None)) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Provider node not found"}))).into_response(),
        _ => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch provider node"}))).into_response(),
    };

    let now = chrono::Utc::now().to_rfc3339();
    if let Some(name) = body.get("name").and_then(|v| v.as_str()) {
        existing.name = Some(name.trim().to_string());
    }
    if let Some(prefix) = body.get("prefix").and_then(|v| v.as_str()) {
        existing.prefix = Some(prefix.trim().to_string());
    }
    if let Some(base_url) = body.get("baseUrl").and_then(|v| v.as_str()) {
        existing.base_url = Some(base_url.trim().to_string());
    }
    if let Some(api_type) = body.get("apiType").and_then(|v| v.as_str()) {
        existing.api_type = Some(api_type.to_string());
    }
    existing.updated_at = now;

    let pool_c = pool.clone();
    let node_c = existing.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        provider_nodes::update_provider_node(&conn, &node_c)
    })
    .await;

    match result {
        Ok(Ok(())) => Json(serde_json::json!({"node": existing})).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to update provider node"}))).into_response(),
    }
}

/// DELETE /api/provider-nodes/{id} — delete provider node.
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
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        provider_nodes::delete_provider_node(&conn, &id)
    })
    .await;

    match result {
        Ok(Ok(true)) => Json(serde_json::json!({"success": true})).into_response(),
        Ok(Ok(false)) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Provider node not found"}))).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to delete provider node"}))).into_response(),
    }
}

/// POST /api/provider-nodes/validate — validate a provider node's API key against base URL.
pub async fn validate(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;
    let base_url = body.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let node_type = body.get("type").and_then(|v| v.as_str()).unwrap_or("openai-compatible");
    let model_id = body.get("modelId").and_then(|v| v.as_str());

    if base_url.is_empty() || api_key.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Base URL and API key required"}))).into_response();
    }

    // Validate URL format
    if url::Url::parse(base_url).is_err() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid URL format"}))).into_response();
    }

    let normalized_base = base_url.trim().trim_end_matches('/');

    // Custom embedding validation
    if node_type == "custom-embedding" {
        if model_id.map(|s| s.trim().is_empty()).unwrap_or(true) {
            return Json(serde_json::json!({"valid": false, "error": "Model ID required for embedding validation"})).into_response();
        }
        let url = format!("{}/embeddings", normalized_base);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build().unwrap_or_default();
        let res = client.post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .body(serde_json::json!({"model": model_id.unwrap(), "input": "ping"}).to_string())
            .send().await;

        match res {
            Ok(r) if r.status().is_success() => {
                let data: serde_json::Value = r.json().await.unwrap_or(serde_json::json!({}));
                let dims = data.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()).and_then(|f| f.get("embedding")).and_then(|e| e.as_array()).map(|a| a.len());
                Json(serde_json::json!({"valid": true, "method": "embeddings", "dimensions": dims})).into_response()
            }
            Ok(r) if r.status() == 401 || r.status() == 403 => Json(serde_json::json!({"valid": false, "error": "API key unauthorized"})).into_response(),
            Ok(r) => Json(serde_json::json!({"valid": false, "error": format!("Embeddings request failed ({})", r.status()), "method": "embeddings"})).into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"valid": false, "error": e.to_string()}))).into_response(),
        }
    } else if node_type == "anthropic-compatible" {
        let mut nb = normalized_base.to_string();
        if nb.ends_with("/messages") {
            nb = nb[..nb.len() - 9].to_string();
        }
        let url = format!("{}/models", nb);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build().unwrap_or_default();
        let res = client.get(&url)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Authorization", format!("Bearer {}", api_key))
            .send().await;

        match res {
            Ok(r) if r.status().is_success() => Json(serde_json::json!({"valid": true})).into_response(),
            Ok(r) if r.status() == 401 || r.status() == 403 => Json(serde_json::json!({"valid": false, "error": "API key unauthorized"})).into_response(),
            _ => {
                // Fallback: try chat/completions if modelId provided
                if let Some(mid) = model_id {
                    let chat_url = format!("{}/chat/completions", nb);
                    let client2 = reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(10))
                        .build().unwrap_or_default();
                    let res2 = client2.post(&chat_url)
                        .header("Authorization", format!("Bearer {}", api_key))
                        .header("Content-Type", "application/json")
                        .header("x-api-key", api_key)
                        .header("anthropic-version", "2023-06-01")
                        .body(serde_json::json!({"model": mid, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1}).to_string())
                        .send().await;
                    match res2 {
                        Ok(r) if r.status().is_success() => Json(serde_json::json!({"valid": true, "method": "chat"})).into_response(),
                        Ok(r) => Json(serde_json::json!({"valid": false, "error": format!("Chat request failed ({})", r.status()), "method": "chat"})).into_response(),
                        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"valid": false, "error": e.to_string()}))).into_response(),
                    }
                } else {
                    Json(serde_json::json!({"valid": false, "error": "Validation failed"})).into_response()
                }
            }
        }
    } else {
        // OpenAI compatible (default)
        let url = format!("{}/models", normalized_base);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build().unwrap_or_default();
        let res = client.get(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send().await;

        match res {
            Ok(r) if r.status().is_success() => Json(serde_json::json!({"valid": true})).into_response(),
            Ok(r) if r.status() == 401 || r.status() == 403 => Json(serde_json::json!({"valid": false, "error": "API key unauthorized"})).into_response(),
            _ => {
                if let Some(mid) = model_id {
                    let chat_url = format!("{}/chat/completions", normalized_base);
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
                    Json(serde_json::json!({"valid": false, "error": "Validation failed"})).into_response()
                }
            }
        }
    }
}
