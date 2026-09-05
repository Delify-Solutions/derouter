//! Pricing management routes — Phase 2.
//! Display per-pool and per-combo pricing from the kv table.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use crate::db::DbPool;
use crate::db::repos::kv;
use crate::web::render::Render;
use crate::templates::{PricingPage, PricingRow, ComboPricingRow};

/// GET /dashboard/pricing — pricing page
pub async fn page(State(pool): State<DbPool>) -> impl IntoResponse {
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<(Vec<PricingRow>, Vec<ComboPricingRow>)> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        // Pool pricing: kv scope="pricing", keys are provider names, values are { model: { input, output, ... } }
        let pool_map = kv::kv_get_all(&conn, "pricing")?;
        let mut pool_pricing = Vec::new();
        for (provider, models) in pool_map.iter() {
            if let Some(models_obj) = models.as_object() {
                for (model, prices) in models_obj {
                    let get_price = |key: &str| -> String {
                        prices.get(key)
                            .and_then(|v| v.as_f64())
                            .map(|v| format!("{:.2}", v))
                            .unwrap_or_else(|| "0.00".to_string())
                    };
                    pool_pricing.push(PricingRow {
                        provider: provider.clone(),
                        model: model.clone(),
                        input: get_price("input"),
                        output: get_price("output"),
                        cached: get_price("cached"),
                        reasoning: get_price("reasoning"),
                        cache_creation: get_price("cache_creation"),
                    });
                }
            }
        }
        pool_pricing.sort_by(|a, b| a.provider.cmp(&b.provider).then(a.model.cmp(&b.model)));

        // Combo pricing: kv scope="comboPricing", keys are combo names, values are { input, output, ... }
        let combo_map = kv::kv_get_all(&conn, "comboPricing")?;
        let mut combo_pricing = Vec::new();
        for (name, prices) in combo_map.iter() {
            let get_price = |key: &str| -> String {
                prices.get(key)
                    .and_then(|v| v.as_f64())
                    .map(|v| format!("{:.2}", v))
                    .unwrap_or_else(|| "0.00".to_string())
            };
            combo_pricing.push(ComboPricingRow {
                name: name.clone(),
                input: get_price("input"),
                output: get_price("output"),
                cached: get_price("cached"),
                reasoning: get_price("reasoning"),
                cache_creation: get_price("cache_creation"),
            });
        }
        combo_pricing.sort_by(|a, b| a.name.cmp(&b.name));

        Ok((pool_pricing, combo_pricing))
    })
    .await;

    match result {
        Ok(Ok((pool_pricing, combo_pricing))) => {
            Render::new(PricingPage { pool_pricing, combo_pricing })
        }
        Ok(Err(e)) => {
            tracing::error!("Failed to load pricing: {}", e);
            Render::new(PricingPage { pool_pricing: vec![], combo_pricing: vec![] })
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            Render::new(PricingPage { pool_pricing: vec![], combo_pricing: vec![] })
        }
    }
}

/// POST /dashboard/pricing — update pricing
pub async fn update(
    State(pool): State<DbPool>,
    body: axum::Json<serde_json::Value>,
) -> impl IntoResponse {
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        // If body has "combo" key, update combo pricing
        if let Some(combo) = body.get("combo").and_then(|v| v.as_object()) {
            for (name, prices) in combo {
                kv::kv_set(&conn, "comboPricing", name, prices)?;
            }
        } else {
            // Per-pool pricing update
            if let Some(obj) = body.as_object() {
                for (provider, models) in obj {
                    kv::kv_set(&conn, "pricing", provider, models)?;
                }
            }
        }
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => StatusCode::OK,
        Ok(Err(e)) => {
            tracing::error!("Failed to update pricing: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        }
        Err(e) => {
            tracing::error!("Task join error: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}
