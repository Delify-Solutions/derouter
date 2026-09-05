//! Pricing management routes — JSON API.
//! Ported from src/app/api/pricing/route.js.
//! GET /api/pricing, PATCH /api/pricing, DELETE /api/pricing

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::db::DbPool;
use crate::db::repos::kv;
use crate::auth;

const VALID_FIELDS: &[&str] = &["input", "output", "cached", "reasoning", "cache_creation"];

/// Validate pricing fields — returns Err(message) if invalid.
fn validate_pricing_fields(pricing: &serde_json::Value, label: &str) -> Result<(), String> {
    let obj = match pricing.as_object() {
        Some(o) => o,
        None => return Err(format!("Invalid pricing for {}", label)),
    };

    for (key, value) in obj {
        if !VALID_FIELDS.contains(&key.as_str()) {
            return Err(format!("Invalid pricing field: {} for {}", key, label));
        }
        let num = match value.as_f64() {
            Some(n) => n,
            None => return Err(format!(
                "Invalid pricing value for {} in {}: must be non-negative number",
                key, label
            )),
        };
        if num < 0.0 || num.is_nan() {
            return Err(format!(
                "Invalid pricing value for {} in {}: must be non-negative number",
                key, label
            ));
        }
    }
    Ok(())
}

/// GET /api/pricing — get pricing. ?combo=1 returns combo-level pricing.
pub async fn list(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Query(q): Query<PricingQuery>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        if q.combo.unwrap_or(false) {
            let combo_map = kv::kv_get_all(&conn, "comboPricing")?;
            Ok(serde_json::Value::Object(combo_map))
        } else {
            let pool_map = kv::kv_get_all(&conn, "pricing")?;
            Ok(serde_json::Value::Object(pool_map))
        }
    })
    .await;

    match result {
        Ok(Ok(pricing)) => Json(pricing).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to fetch pricing"})),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct PricingQuery {
    pub combo: Option<bool>,
}

/// PATCH /api/pricing — update pricing (combo or per-pool).
pub async fn update(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;

    if !body.is_object() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid pricing data format"})),
        )
            .into_response();
    }

    // Combo-level pricing
    if let Some(combo) = body.get("combo").and_then(|v| v.as_object()) {
        let pool_c = pool.clone();
        let combo_c = combo.clone();
        let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
            let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
            for (name, pricing) in &combo_c {
                if let Err(e) = validate_pricing_fields(pricing, &format!("combo {}", name)) {
                    return Err(anyhow::anyhow!("{}", e));
                }
                kv::kv_set(&conn, "comboPricing", name, pricing)?;
            }
            let updated = kv::kv_get_all(&conn, "comboPricing")?;
            Ok(serde_json::Value::Object(updated))
        })
        .await;

        match result {
            Ok(Ok(updated)) => return Json(updated).into_response(),
            Ok(Err(e)) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": e.to_string()})),
                )
                    .into_response();
            }
            _ => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "Failed to update pricing"})),
                )
                    .into_response();
            }
        }
    }

    // Per-pool pricing (legacy path)
    let pool_c = pool.clone();
    let body_c = body.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        if let Some(obj) = body_c.as_object() {
            for (provider, models) in obj {
                if !models.is_object() {
                    return Err(anyhow::anyhow!(
                        "Invalid pricing for provider: {}",
                        provider
                    ));
                }
                if let Some(models_obj) = models.as_object() {
                    for (model, pricing) in models_obj {
                        if let Err(e) = validate_pricing_fields(pricing, &format!("{}/{}", provider, model)) {
                            return Err(anyhow::anyhow!("{}", e));
                        }
                    }
                }
                kv::kv_set(&conn, "pricing", provider, models)?;
            }
        }
        let updated = kv::kv_get_all(&conn, "pricing")?;
        Ok(serde_json::Value::Object(updated))
    })
    .await;

    match result {
        Ok(Ok(updated)) => Json(updated).into_response(),
        Ok(Err(e)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to update pricing"})),
        )
            .into_response(),
    }
}

/// DELETE /api/pricing — reset pricing.
/// ?combo=<name> resets one combo; ?combo=all resets all combo pricing.
/// ?provider=xxx&model=yyy resets a pooled model; no params resets all per-pool.
pub async fn delete(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Query(q): Query<DeletePricingQuery>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        if let Some(ref combo) = q.combo {
            if combo == "all" {
                // Delete all combo pricing
                let all = kv::kv_get_all(&conn, "comboPricing")?;
                for (name, _) in &all {
                    kv::kv_delete(&conn, "comboPricing", name)?;
                }
            } else {
                kv::kv_delete(&conn, "comboPricing", combo)?;
            }
            let updated = kv::kv_get_all(&conn, "comboPricing")?;
            return Ok(serde_json::Value::Object(updated));
        }

        if let Some(ref provider) = q.provider {
            if let Some(ref model) = q.model {
                // Delete specific model from provider's pricing
                if let Ok(Some(existing)) = kv::kv_get(&conn, "pricing", provider) {
                    if let Ok(mut pricing) = serde_json::from_str::<serde_json::Value>(&existing.to_string()) {
                        if let Some(obj) = pricing.as_object_mut() {
                            obj.remove(model);
                            kv::kv_set(&conn, "pricing", provider, &pricing)?;
                        }
                    }
                }
            } else {
                kv::kv_delete(&conn, "pricing", provider)?;
            }
            let updated = kv::kv_get_all(&conn, "pricing")?;
            return Ok(serde_json::Value::Object(updated));
        }

        // Reset all per-pool pricing
        let all = kv::kv_get_all(&conn, "pricing")?;
        for (name, _) in &all {
            kv::kv_delete(&conn, "pricing", name)?;
        }
        let updated = kv::kv_get_all(&conn, "pricing")?;
        Ok(serde_json::Value::Object(updated))
    })
    .await;

    match result {
        Ok(Ok(updated)) => Json(updated).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to reset pricing"})),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct DeletePricingQuery {
    pub combo: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
}
