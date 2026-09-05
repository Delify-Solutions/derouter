//! Proxy models — /v1/models endpoint. Phase 1.
//! Returns list of available models (combos + provider models).

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::db::DbPool;
use crate::db::repos::{combos, connections, kv, settings};
use crate::proxy::chat;

/// GET /v1/models — list available models
pub async fn handle_models_list(pool: DbPool, headers: HeaderMap) -> Response {
    // Optionally filter by API key's allowed models
    let api_key = chat::extract_api_key(&headers);

    let pool_clone = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_clone.get()?;

        // Get all combos
        let all_combos = combos::get_combos(&conn)?;

        // Get model aliases and custom models
        let aliases = kv::get_model_aliases(&conn).unwrap_or(json!({}));
        let custom_models = kv::get_custom_models(&conn).unwrap_or_default();

        // Get all active connections to build provider/model list
        let all_conns = connections::get_provider_connections(&conn, &connections::ConnectionFilter {
            provider: None,
            is_active: Some(true),
        })?;

        // Build model list
        let mut models: Vec<serde_json::Value> = Vec::new();

        // Add combos as models
        for combo in &all_combos {
            models.push(json!({
                "id": combo.name,
                "object": "model",
                "created": 0,
                "owned_by": "combo",
            }));
        }

        // Add provider models from connections
        for conn_record in &all_conns {
            // Extract models from connection data if available
            if let Some(models_arr) = conn_record.data.get("models").and_then(|v| v.as_array()) {
                for model in models_arr {
                    let model_id = model.get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let full_id = format!("{}/{}", conn_record.provider, model_id);
                    models.push(json!({
                        "id": full_id,
                        "object": "model",
                        "created": 0,
                        "owned_by": conn_record.provider,
                    }));
                }
            }
        }

        // Add custom models
        for cm in &custom_models {
            if let Some(id) = cm.get("id").and_then(|v| v.as_str()) {
                models.push(json!({
                    "id": id,
                    "object": "model",
                    "created": 0,
                    "owned_by": "custom",
                }));
            }
        }

        // Add aliases
        if let Some(obj) = aliases.as_object() {
            for (alias, _target) in obj {
                models.push(json!({
                    "id": alias,
                    "object": "model",
                    "created": 0,
                    "owned_by": "alias",
                }));
            }
        }

        // Filter by allowed models if API key has restrictions
        if let Some(key_str) = &api_key {
            if let Ok(Some(key_auth)) = crate::db::repos::api_keys::get_api_key_for_auth(&conn, key_str) {
                if let Some(ref allowed) = key_auth.allowed_models {
                    if !allowed.is_empty() {
                        models.retain(|m| {
                            let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            allowed.iter().any(|a| a == id || id.starts_with(&format!("{}/", a)))
                        });
                    }
                }
            }
        }

        Ok(json!({ "object": "list", "data": models }))
    })
    .await;

    match result {
        Ok(Ok(data)) => (StatusCode::OK, axum::Json(data)).into_response(),
        Ok(Err(e)) => {
            tracing::error!("Models list error: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(json!({
                "error": { "message": e.to_string(), "type": "server_error" }
            }))).into_response()
        }
        Err(e) => {
            tracing::error!("Models list task error: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(json!({
                "error": { "message": "Internal error", "type": "server_error" }
            }))).into_response()
        }
    }
}
