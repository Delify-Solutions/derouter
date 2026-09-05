//! Public usage routes — Phase 4.
//! Key-holder can view their own usage by entering their API key.
//! Returns 404 for unknown keys (not 401) — security: no info leakage.
//! All responses use masked keys — full key never returned.

use askama::Template;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use serde::Deserialize;

use crate::db::DbPool;
use crate::db::repos::{api_keys, key_groups, usage};
use crate::templates::{
    ModelBreakdownRow, PeriodPreset, PublicHistoryRow, PublicReceiptDetail,
    PublicReceipts, PublicUsagePage,
};

/// Query params for public usage
#[derive(Debug, Deserialize, Default)]
pub struct UsageQuery {
    pub key: Option<String>,
    pub period: Option<String>,
    pub id: Option<String>,
}

/// Render the public usage page (key entry form)
///
/// - No `key` param (or empty) → 200 entry form (blank page).
/// - `key` present and non-empty → look up the key:
///   - Not found OR inactive → 404 (no existence leak).
///   - Found and active → 200 entry form (HTMX will load receipts).
/// D7: existence must not leak — unknown and inactive keys both return 404.
pub async fn page(
    State(pool): State<DbPool>,
    Query(q): Query<UsageQuery>,
) -> Response {
    // No key param → render the blank entry form
    let key = match q.key {
        Some(ref k) if !k.is_empty() => k.clone(),
        _ => {
            let tmpl = PublicUsagePage;
            return Html(tmpl.render().unwrap_or_default()).into_response();
        }
    };

    // Key param present → validate it exists and is active
    let pool_clone = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = pool_clone.get()?;
        match api_keys::get_api_key_by_key(&conn, &key)? {
            Some(api_key) => Ok(api_key.is_active),
            None => Ok(false),
        }
    })
    .await;

    match result {
        Ok(Ok(true)) => {
            // Valid + active key → render entry form (HTMX loads receipts)
            let tmpl = PublicUsagePage;
            Html(tmpl.render().unwrap_or_default()).into_response()
        }
        Ok(Ok(false)) => StatusCode::NOT_FOUND.into_response(),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Render receipts (usage summary + request history) for a given key
/// Returns 404 if key not found — D7: no info leakage
pub async fn receipts(
    State(pool): State<DbPool>,
    Query(q): Query<UsageQuery>,
) -> Response {
    let key = match q.key {
        Some(ref k) if !k.is_empty() => k.clone(),
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };

    let period = q.period.unwrap_or_else(|| "7d".to_string());

    let pool_clone = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<PublicReceipts>> {
        let conn = pool_clone.get()?;

        // Look up the key — 404 if not found
        let api_key = match api_keys::get_api_key_by_key(&conn, &key)? {
            Some(k) => k,
            None => return Ok(None),
        };

        // Compute period range
        let (start_iso, end_iso) = period_to_range(&period);

        // Get usage summary
        let summary = usage::get_key_usage_summary(
            &conn,
            &key,
            Some(&start_iso),
            end_iso.as_deref(),
        )
        .unwrap_or_default();

        // Get live rate (last 60s)
        let rate = usage::get_key_rate_usage(&conn, &key, 60_000).unwrap_or_default();

        // Get usage history rows
        let filter = usage::UsageFilter {
            api_key: Some(key.clone()),
            start_date: Some(start_iso.clone()),
            end_date: end_iso.clone(),
            ..Default::default()
        };
        let history = usage::get_usage_history(&conn, &filter).unwrap_or_default();

        // Resolve group name
        let group_name = if let Some(ref gid) = api_key.group_id {
            key_groups::get_key_group_by_id(&conn, gid)
                .ok()
                .flatten()
                .map(|g| g.name)
                .unwrap_or_default()
        } else {
            String::new()
        };

        // Budget
        let budget_unlimited = api_key.budget_usd.is_none();
        let budget_spent = format!("{:.2}", api_key.window_cost_usd);
        let budget_limit = api_key
            .budget_usd
            .map(|b| format!("{:.2}", b))
            .unwrap_or_default();
        let budget_pct = if let Some(b) = api_key.budget_usd {
            if b > 0.0 {
                ((api_key.window_cost_usd / b) * 100.0).min(100.0) as i64
            } else {
                0
            }
        } else {
            0
        };
        let reset_window = api_key.reset_window.unwrap_or_default();

        // Rate limits
        let rpm_limit = api_key.rpm.map(|r| r.to_string()).unwrap_or_default();
        let tpm_limit = api_key.tpm.map(|t| t.to_string()).unwrap_or_default();

        // Period presets
        let periods = build_periods(&period);

        // Models
        let models: Vec<ModelBreakdownRow> = summary
            .items
            .into_iter()
            .map(|m| ModelBreakdownRow {
                model: m.model,
                requests: m.requests,
                input: m.input,
                output: m.output,
                cache_read: m.cache_read,
                cost: format!("{:.4}", m.cost),
            })
            .collect();

        // History rows
        let rows: Vec<PublicHistoryRow> = history
            .into_iter()
            .map(|h| {
                let is_error = h.status != "ok" && h.status != "success" && !h.status.starts_with("2");
                let cost = format!("{:.4}", h.cost);
                let latency = h
                    .tokens
                    .get("latencyMs")
                    .and_then(|v| v.as_f64())
                    .map(|ms| format!("{:.0}ms", ms))
                    .unwrap_or_else(|| "—".to_string());
                PublicHistoryRow {
                    id: h.timestamp.clone(),
                    timestamp: h.timestamp,
                    requested_model: h.model,
                    status: h.status,
                    is_error,
                    latency,
                    input_tokens: h
                        .tokens
                        .get("prompt_tokens")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    output_tokens: h
                        .tokens
                        .get("completion_tokens")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    cost,
                }
            })
            .collect();

        let has_data = !rows.is_empty() || !models.is_empty();

        Ok(Some(PublicReceipts {
            key: key.clone(),
            masked_key: api_keys::mask_key(&key),
            name: api_key.name.unwrap_or_else(|| "Unnamed".to_string()),
            group_name,
            is_active: api_key.is_active,
            expires_at: api_key.expires_at.unwrap_or_default(),
            budget_unlimited,
            budget_spent,
            budget_limit,
            budget_pct,
            reset_window,
            rpm_limit,
            rpm_live: rate.requests.to_string(),
            tpm_limit,
            tpm_live: rate.tokens.to_string(),
            peak_tpm: summary.peak_tpm,
            total_requests: summary.totals.requests,
            total_cost: format!("{:.4}", summary.totals.cost),
            total_tokens: summary.totals.input + summary.totals.output,
            period: period.clone(),
            periods,
            models,
            rows,
            has_data,
        }))
    })
    .await;

    match result {
        Ok(Ok(Some(receipts))) => {
            Html(receipts.render().unwrap_or_default()).into_response()
        }
        Ok(Ok(None)) => StatusCode::NOT_FOUND.into_response(),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Query params for receipt detail
#[derive(Debug, Deserialize, Default)]
pub struct DetailQuery {
    pub key: Option<String>,
    pub id: Option<String>,
}

/// Render single request detail for public usage
/// Returns 404 if key not found or detail not found
pub async fn receipt_detail(
    State(pool): State<DbPool>,
    Query(q): Query<DetailQuery>,
) -> Response {
    let key = match q.key {
        Some(ref k) if !k.is_empty() => k.clone(),
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    let id = match q.id {
        Some(ref i) if !i.is_empty() => i.clone(),
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };

    let pool_clone = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<PublicReceiptDetail>> {
        let conn = pool_clone.get()?;

        // Verify key exists — 404 if not found
        let _api_key = match api_keys::get_api_key_by_key(&conn, &key)? {
            Some(k) => k,
            None => return Ok(None),
        };

        // Get usage history row by timestamp (id is the timestamp in our public model)
        let filter = usage::UsageFilter {
            api_key: Some(key.clone()),
            ..Default::default()
        };
        let history = usage::get_usage_history(&conn, &filter)?;

        // Find the matching record
        let row = history.into_iter().find(|h| h.timestamp == id);
        if row.is_none() {
            return Ok(None);
        }
        let row = row.unwrap();

        let requested_model = row.model.clone();
        let status = row.status.clone();
        let is_error = status != "ok" && status != "success" && !status.starts_with("2");

        let latency = row
            .tokens
            .get("latencyMs")
            .and_then(|v| v.as_f64())
            .map(|ms| format!("{:.0}ms", ms))
            .unwrap_or_else(|| "—".to_string());

        let input_tokens = row
            .tokens
            .get("prompt_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let output_tokens = row
            .tokens
            .get("completion_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let cache_tokens = row
            .tokens
            .get("cached_tokens")
            .or_else(|| row.tokens.get("cache_read_input_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        // Request/response bodies from tokens/meta
        let request_json = serde_json::to_string_pretty(&row.tokens).unwrap_or_default();
        let response_json = String::new();
        let provider_request_json = String::new();
        let provider_response_json = String::new();

        Ok(Some(PublicReceiptDetail {
            timestamp: row.timestamp,
            requested_model,
            status,
            is_error,
            latency,
            input_tokens,
            output_tokens,
            cache_tokens,
            request_json,
            provider_request_json,
            provider_response_json,
            response_json,
        }))
    })
    .await;

    match result {
        Ok(Ok(Some(detail))) => {
            Html(detail.render().unwrap_or_default()).into_response()
        }
        Ok(Ok(None)) => StatusCode::NOT_FOUND.into_response(),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Clear request history for a key
/// Returns 404 if key not found (not 401)
pub async fn clear_history(
    State(pool): State<DbPool>,
    Query(q): Query<UsageQuery>,
) -> Response {
    let key = match q.key {
        Some(ref k) if !k.is_empty() => k.clone(),
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };

    let pool_clone = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = pool_clone.get()?;

        // Verify key exists
        if api_keys::get_api_key_by_key(&conn, &key)?.is_none() {
            return Ok(false);
        }

        // Delete usage history + request details for this key
        usage::delete_key_usage_history(&conn, &key)?;
        Ok(true)
    })
    .await;

    match result {
        Ok(Ok(true)) => StatusCode::OK.into_response(),
        Ok(Ok(false)) => StatusCode::NOT_FOUND.into_response(),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Convert a period preset to an ISO date range
fn period_to_range(period: &str) -> (String, Option<String>) {
    use chrono::{Utc, Duration};
    let now = Utc::now();
    let end = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let start = match period {
        "today" => {
            let dt = now.date_naive().and_hms_opt(0, 0, 0).unwrap();
            chrono::TimeZone::from_local_datetime(&Utc, &dt)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        }
        "24h" => (now - Duration::hours(24))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "7d" => (now - Duration::days(7))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "30d" => (now - Duration::days(30))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "60d" => (now - Duration::days(60))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        _ => (now - Duration::days(7))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };

    (start, Some(end))
}

/// Build the period preset buttons
fn build_periods(active: &str) -> Vec<PeriodPreset> {
    let presets = [
        ("today", "Today"),
        ("24h", "24h"),
        ("7d", "7d"),
        ("30d", "30d"),
        ("60d", "60d"),
    ];
    presets
        .iter()
        .map(|(id, label)| PeriodPreset {
            id: id.to_string(),
            label: label.to_string(),
            active: id == &active,
        })
        .collect()
}
