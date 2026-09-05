//! Usage dashboard routes — JSON API.
//! Ported from src/app/api/usage/* route.js files.
//! GET /api/usage/stats — aggregate overview stats.
//! GET /api/usage/request-details — paginated request details with includeRaw toggle.
//! GET /api/usage/request-logs — usage history rows.
//! GET /api/usage/stream — SSE stream of live usage updates.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::IntervalStream;

use crate::db::DbPool;
use crate::db::repos::{api_keys, key_groups, request_details, usage};
use crate::auth;

/// GET /api/usage/stats — aggregate overview stats.
pub async fn stats(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        // Aggregate usage totals
        let (total_requests, total_input, total_output, total_cost): (i64, i64, i64, f64) =
            conn.query_row(
                "SELECT COUNT(*), \
                 COALESCE(SUM(promptTokens), 0), \
                 COALESCE(SUM(completionTokens), 0), \
                 COALESCE(SUM(cost), 0) \
                 FROM usageHistory",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap_or((0, 0, 0, 0.0));

        let active_keys: i64 = conn
            .query_row("SELECT COUNT(*) FROM apiKeys WHERE isActive = 1", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);

        let active_combos: i64 = conn
            .query_row("SELECT COUNT(*) FROM combos", [], |row| row.get(0))
            .unwrap_or(0);

        let active_providers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM providerConnections WHERE isActive = 1",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        Ok(serde_json::json!({
            "totalRequests": total_requests,
            "totalInput": total_input,
            "totalOutput": total_output,
            "totalCost": total_cost,
            "activeKeys": active_keys,
            "activeCombos": active_combos,
            "activeProviders": active_providers,
        }))
    })
    .await;

    match result {
        Ok(Ok(stats)) => Json(stats).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to fetch usage stats"})),
        )
            .into_response(),
    }
}

/// Query params for request details
#[derive(Debug, Deserialize, Default)]
pub struct RequestDetailsQuery {
    pub page: Option<i64>,
    pub page_size: Option<i64>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub connection_id: Option<String>,
    pub api_key: Option<String>,
    pub status: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub include_raw: Option<String>,
}

/// GET /api/usage/request-details — paginated request details with includeRaw toggle.
pub async fn request_details(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Query(q): Query<RequestDetailsQuery>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let page = q.page.unwrap_or(1);
    let page_size = q.page_size.unwrap_or(20);

    if page < 1 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Page must be >= 1"})),
        )
            .into_response();
    }

    if !(1..=100).contains(&page_size) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "PageSize must be between 1 and 100"})),
        )
            .into_response();
    }

    let include_raw = q.include_raw.as_deref() == Some("1") || q.include_raw.as_deref() == Some("true");

    let mut filter = request_details::DetailFilter::default();
    filter.page = Some(page);
    filter.page_size = Some(page_size);
    filter.provider = q.provider.clone().filter(|s| !s.is_empty());
    filter.model = q.model.clone().filter(|s| !s.is_empty());
    filter.connection_id = q.connection_id.clone().filter(|s| !s.is_empty());
    filter.api_key = q.api_key.clone().filter(|s| !s.is_empty());
    filter.status = q.status.clone().filter(|s| !s.is_empty());
    filter.start_date = q.start_date.clone().filter(|s| !s.is_empty()).map(|s| request_details::parse_date_to_iso(&s));
    filter.end_date = q.end_date.clone().filter(|s| !s.is_empty()).map(|s| request_details::parse_date_to_iso(&s));

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<(Vec<serde_json::Value>, request_details::Pagination)> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        request_details::get_request_details(&conn, &filter)
    })
    .await;

    match result {
        Ok(Ok((details, pagination))) => {
            // Redact conversation payloads unless includeRaw is set
            let redacted: Vec<serde_json::Value> = details.iter().map(|d| {
                if include_raw {
                    return d.clone();
                }
                let mut redacted = d.clone();
                for key in &["request", "providerRequest", "providerResponse", "response"] {
                    if let Some(obj) = redacted.as_object_mut() {
                        if obj.contains_key(*key) {
                            obj.insert(key.to_string(), serde_json::json!({"redacted": true}));
                        }
                    }
                }
                redacted
            }).collect();

            Json(serde_json::json!({
                "details": redacted,
                "pagination": pagination,
            }))
            .into_response()
        }
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to fetch request details"})),
        )
            .into_response(),
    }
}

/// Query params for request logs (usage history)
#[derive(Debug, Deserialize, Default, Clone)]
pub struct RequestLogsQuery {
    pub api_key: Option<String>,
    pub key_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

/// GET /api/usage/request-logs — usage history rows (paginated).
pub async fn request_logs(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Query(q): Query<RequestLogsQuery>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let query_c = q.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        // Map key_id to api_key value if provided
        let api_key_filter = if let Some(ref key_id) = query_c.key_id {
            if !key_id.is_empty() {
                let keys = api_keys::get_api_keys(&conn)?;
                keys.into_iter().find(|k| k.id == *key_id).map(|k| k.key)
            } else {
                query_c.api_key.clone()
            }
        } else {
            query_c.api_key.clone()
        };

        let filter = usage::UsageFilter {
            api_key: api_key_filter,
            provider: query_c.provider.clone().filter(|s| !s.is_empty()),
            model: query_c.model.clone().filter(|s| !s.is_empty()),
            start_date: query_c.start_date.clone().filter(|s| !s.is_empty()),
            end_date: query_c.end_date.clone().filter(|s| !s.is_empty()),
        };

        let history = usage::get_usage_history(&conn, &filter)?;

        // Paginate
        let page = query_c.page.unwrap_or(1).max(1);
        let page_size = query_c.page_size.unwrap_or(50).clamp(1, 100) as usize;
        let total = history.len();
        let start = (page as usize - 1) * page_size;
        let end = (start + page_size).min(total);
        let paged: Vec<_> = if start < total {
            history[start..end].to_vec()
        } else {
            vec![]
        };

        let total_pages = ((total as f64) / (page_size as f64)).ceil() as i64;

        Ok(serde_json::json!({
            "logs": paged,
            "pagination": {
                "page": page,
                "pageSize": page_size as i64,
                "totalItems": total as i64,
                "totalPages": total_pages,
                "hasNext": (end as i64) < total as i64,
                "hasPrev": page > 1,
            }
        }))
    })
    .await;

    match result {
        Ok(Ok(data)) => Json(data).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to fetch request logs"})),
        )
            .into_response(),
    }
}

/// GET /api/usage/keys — per-key usage summary table.
pub async fn keys_table(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Query(q): Query<KeysTableQuery>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<serde_json::Value>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let mut keys = api_keys::get_api_keys(&conn)?;

        // Filter by search query
        if let Some(ref search) = q.q {
            let lower = search.to_lowercase();
            keys.retain(|k| {
                k.name.as_deref().unwrap_or("").to_lowercase().contains(&lower)
                    || k.key.to_lowercase().contains(&lower)
            });
        }

        // Filter by group
        if let Some(ref gid) = q.group {
            if !gid.is_empty() {
                keys.retain(|k| k.group_id.as_deref() == Some(gid.as_str()));
            }
        }

        let mut rows = Vec::new();
        for key in &keys {
            let group_name = if let Some(ref gid) = key.group_id {
                key_groups::get_key_group_by_id(&conn, gid)
                    .ok()
                    .flatten()
                    .map(|g| g.name)
                    .unwrap_or_else(|| "—".to_string())
            } else {
                "—".to_string()
            };

            let summary = usage::get_key_usage_summary(
                &conn,
                &key.key,
                q.start_date.as_deref(),
                q.end_date.as_deref(),
            )
            .unwrap_or_default();

            let rate = usage::get_key_rate_usage(&conn, &key.key, 60_000).unwrap_or_default();

            rows.push(serde_json::json!({
                "id": key.id,
                "name": key.name.clone().unwrap_or_else(|| "Unnamed".to_string()),
                "maskedKey": api_keys::mask_key(&key.key),
                "group": group_name,
                "rpmLimit": key.rpm,
                "rpmLive": rate.requests,
                "tpmLimit": key.tpm,
                "tpmLive": rate.tokens,
                "budgetLimit": key.budget_usd,
                "budgetSpent": key.window_cost_usd,
                "budgetPct": key.budget_usd.map(|b| if b > 0.0 { ((key.window_cost_usd / b) * 100.0).min(100.0) as i64 } else { 0 }).unwrap_or(0),
                "budgetOver": key.budget_usd.map(|b| key.window_cost_usd >= b).unwrap_or(false),
                "peakTpm": summary.peak_tpm,
                "requests": summary.totals.requests,
                "inputTokens": summary.totals.input,
                "outputTokens": summary.totals.output,
                "cacheTokens": summary.totals.cache_read,
                "cost": summary.totals.cost,
                "modelsCount": summary.items.len(),
                "isActive": key.is_active,
                "expiresAt": key.expires_at.clone(),
                "models": summary.items,
            }));
        }
        Ok(rows)
    })
    .await;

    match result {
        Ok(Ok(rows)) => Json(serde_json::json!({"keys": rows})).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to fetch keys usage"})),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct KeysTableQuery {
    pub q: Option<String>,
    pub group: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// GET /api/usage/groups — list key groups for filter dropdown.
pub async fn groups_list(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<serde_json::Value>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let groups = key_groups::get_key_groups(&conn)?;
        Ok(groups.into_iter().map(|g| serde_json::json!({
            "id": g.id,
            "name": g.name,
        })).collect())
    })
    .await;

    match result {
        Ok(Ok(groups)) => Json(serde_json::json!({"groups": groups})).into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to fetch groups"})),
        )
            .into_response(),
    }
}

/// GET /api/usage/stream — SSE stream of live usage updates.
/// Phase 1 implementation: polls the database every 5 seconds and emits
/// a `usage` event with current aggregate stats. The connection stays open
/// until the client disconnects. Requires auth (same as other /api/usage/* routes).
pub async fn stream(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Build a polling stream: every 5 seconds, query the DB for current stats
    // and emit an SSE event.
    let interval = tokio::time::interval(Duration::from_secs(5));
    let stream = IntervalStream::new(interval).then(move |_| {
        let pool_c = pool.clone();
        async move {
            let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
                let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

                let (total_requests, total_input, total_output, total_cost): (i64, i64, i64, f64) =
                    conn.query_row(
                        "SELECT COUNT(*), \
                         COALESCE(SUM(promptTokens), 0), \
                         COALESCE(SUM(completionTokens), 0), \
                         COALESCE(SUM(cost), 0) \
                         FROM usageHistory",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .unwrap_or((0, 0, 0, 0.0));

                let active_keys: i64 = conn
                    .query_row("SELECT COUNT(*) FROM apiKeys WHERE isActive = 1", [], |row| row.get(0))
                    .unwrap_or(0);

                let active_combos: i64 = conn
                    .query_row("SELECT COUNT(*) FROM combos", [], |row| row.get(0))
                    .unwrap_or(0);

                let active_providers: i64 = conn
                    .query_row("SELECT COUNT(*) FROM providerConnections WHERE isActive = 1", [], |row| row.get(0))
                    .unwrap_or(0);

                Ok(serde_json::json!({
                    "totalRequests": total_requests,
                    "totalInput": total_input,
                    "totalOutput": total_output,
                    "totalCost": total_cost,
                    "activeKeys": active_keys,
                    "activeCombos": active_combos,
                    "activeProviders": active_providers,
                }))
            })
            .await;

            match result {
                Ok(Ok(stats)) => Ok::<Event, Infallible>(Event::default().event("usage").data(stats.to_string())),
                _ => Ok(Event::default().event("error").data(r#"{"error":"Failed to fetch stats"}"#)),
            }
        }
    });

    let sse = Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(25)));

    sse.into_response()
}

// ===== Phase 2 usage sub-routes =====

/// GET /api/usage/chart — time-series chart data.
pub async fn chart(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Query(q): Query<ChartQuery>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let period = q.period.as_deref().unwrap_or("7d");
    let valid_periods = ["today", "24h", "7d", "30d", "60d"];
    if !valid_periods.contains(&period) {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid period"}))).into_response();
    }

    let pool_c = pool.clone();
    let period_c = period.to_string();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        // Compute time range based on period
        let now = chrono::Utc::now();
        let (start, _bucket_secs) = match period_c.as_str() {
            "today" => {
                let start = now.date_naive().and_hms_opt(0, 0, 1).unwrap();
                (start.and_utc().to_rfc3339(), 3600)
            }
            "24h" => {
                ((now - chrono::Duration::hours(24)).to_rfc3339(), 3600)
            }
            "7d" => {
                ((now - chrono::Duration::days(7)).to_rfc3339(), 86400)
            }
            "30d" => {
                ((now - chrono::Duration::days(30)).to_rfc3339(), 86400)
            }
            "60d" => {
                ((now - chrono::Duration::days(60)).to_rfc3339(), 86400)
            }
            _ => {
                ((now - chrono::Duration::days(7)).to_rfc3339(), 86400)
            }
        };

        // Query usage history bucketed by time
        let mut stmt = conn.prepare(
            "SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? ORDER BY timestamp DESC"
        )?;

        let rows: Vec<(String, i64, i64, f64)> = stmt.query_map([&start], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?.filter_map(|r| r.ok()).collect();

        // Bucket the data
        let total_requests = rows.len() as i64;
        let total_input: i64 = rows.iter().map(|r| r.1).sum();
        let total_output: i64 = rows.iter().map(|r| r.2).sum();
        let total_cost: f64 = rows.iter().map(|r| r.3).sum();

        Ok(serde_json::json!({
            "total": {
                "requests": total_requests,
                "input": total_input,
                "output": total_output,
                "cost": total_cost,
            },
            "buckets": rows.iter().map(|(ts, inp, out, cost)| serde_json::json!({
                "timestamp": ts,
                "input": inp,
                "output": out,
                "cost": cost,
            })).collect::<Vec<_>>(),
        }))
    })
    .await;

    match result {
        Ok(Ok(data)) => Json(data).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch chart data"}))).into_response(),
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct ChartQuery {
    pub period: Option<String>,
}

/// GET /api/usage/history — aggregate usage stats (alias for stats).
pub async fn history(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        let (total_requests, total_input, total_output, total_cost): (i64, i64, i64, f64) =
            conn.query_row(
                "SELECT COUNT(*), COALESCE(SUM(promptTokens), 0), COALESCE(SUM(completionTokens), 0), COALESCE(SUM(cost), 0) FROM usageHistory",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).unwrap_or((0, 0, 0, 0.0));

        Ok(serde_json::json!({
            "totalRequests": total_requests,
            "totalInput": total_input,
            "totalOutput": total_output,
            "totalCost": total_cost,
        }))
    })
    .await;

    match result {
        Ok(Ok(data)) => Json(data).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch usage stats"}))).into_response(),
    }
}

/// GET /api/usage/key-summary — per-key usage summary (admin).
pub async fn key_summary(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Query(q): Query<KeySummaryQuery>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let key_param = q.key.clone();
    let start_date = q.start_date.clone();
    let end_date = q.end_date.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let keys = api_keys::get_api_keys(&conn)?;

        let items: Vec<serde_json::Value> = keys.iter().filter(|k| {
            if let Some(ref key) = key_param {
                k.key == *key
            } else {
                true
            }
        }).map(|k| {
            let summary = usage::get_key_usage_summary(
                &conn,
                &k.key,
                start_date.as_deref(),
                end_date.as_deref(),
            ).unwrap_or_default();

            let rate = usage::get_key_rate_usage(&conn, &k.key, 60_000).unwrap_or_default();

            serde_json::json!({
                "id": k.id,
                "name": k.name.clone().unwrap_or_else(|| "Unnamed".to_string()),
                "maskedKey": api_keys::mask_key(&k.key),
                "active": k.is_active,
                "rpm": k.rpm,
                "tpm": k.tpm,
                "budgetUsd": k.budget_usd,
                "resetWindow": k.reset_window.clone(),
                "windowStartedAt": k.window_started_at.clone(),
                "windowCostUsd": k.window_cost_usd,
                "windowRequests": 0,
                "remainingBudgetUsd": k.budget_usd.map(|b| (b - k.window_cost_usd).max(0.0)),
                "resetAt": serde_json::Value::Null,
                "expiresAt": k.expires_at.clone(),
                "allowedModels": k.allowed_models.clone(),
                "liveRpm": rate.requests,
                "liveTpm": rate.tokens,
                "peakTpm": summary.peak_tpm,
                "byModel": summary.items,
                "totals": summary.totals,
            })
        }).collect();

        if key_param.is_some() {
            Ok(serde_json::json!({"item": items.first().cloned().unwrap_or(serde_json::Value::Null)}))
        } else {
            Ok(serde_json::json!({"items": items}))
        }
    })
    .await;

    match result {
        Ok(Ok(data)) => Json(data).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch key usage summary"}))).into_response(),
    }
}

#[derive(Debug, serde::Deserialize, Default)]
pub struct KeySummaryQuery {
    pub key: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// GET /api/usage/logs — recent usage logs.
pub async fn logs(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<serde_json::Value>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        let mut stmt = conn.prepare(
            "SELECT id, timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status FROM usageHistory ORDER BY timestamp DESC LIMIT 200"
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "timestamp": row.get::<_, String>(1)?,
                "provider": row.get::<_, Option<String>>(2)?,
                "model": row.get::<_, Option<String>>(3)?,
                "connectionId": row.get::<_, Option<String>>(4)?,
                "apiKey": row.get::<_, Option<String>>(5)?,
                "endpoint": row.get::<_, Option<String>>(6)?,
                "promptTokens": row.get::<_, i64>(7)?,
                "completionTokens": row.get::<_, i64>(8)?,
                "cost": row.get::<_, f64>(9)?,
                "status": row.get::<_, Option<String>>(10)?,
            }))
        })?;

        let mut logs = Vec::new();
        for r in rows {
            if let Ok(log) = r {
                logs.push(log);
            }
        }
        Ok(logs)
    })
    .await;

    match result {
        Ok(Ok(data)) => Json(serde_json::json!({"logs": data})).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch logs"}))).into_response(),
    }
}

/// GET /api/usage/providers — unique providers from usage history.
pub async fn providers(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<serde_json::Value>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        // Get distinct providers from usage history
        let mut stmt = conn.prepare("SELECT DISTINCT provider FROM usageHistory WHERE provider IS NOT NULL")?;
        let provider_ids: Vec<String> = stmt.query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        // Also get distinct providers from request details
        let mut stmt2 = conn.prepare("SELECT DISTINCT provider FROM requestDetails WHERE provider IS NOT NULL")?;
        let detail_providers: Vec<String> = stmt2.query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        // Merge unique
        let mut seen = std::collections::HashSet::new();
        let mut all_providers = Vec::new();
        for p in provider_ids.iter().chain(detail_providers.iter()) {
            if seen.insert(p.clone()) {
                all_providers.push(p.clone());
            }
        }

        // Enrich with name from provider nodes or provider config
        let nodes = crate::db::repos::provider_nodes::get_provider_nodes(&conn, &crate::db::repos::provider_nodes::ProviderNodeFilter::default()).unwrap_or_default();
        let node_map: std::collections::HashMap<String, String> = nodes.iter()
            .filter_map(|n| n.name.as_ref().map(|name| (n.id.clone(), name.clone())))
            .collect();

        let providers: Vec<serde_json::Value> = all_providers.iter().map(|pid| {
            let name = node_map.get(pid)
                .cloned()
                .or_else(|| crate::providers::config::get_provider_name(pid).map(|s| s.to_string()))
                .unwrap_or_else(|| pid.clone());
            serde_json::json!({"id": pid, "name": name})
        }).collect();

        Ok(providers)
    })
    .await;

    match result {
        Ok(Ok(data)) => Json(serde_json::json!({"providers": data})).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch providers"}))).into_response(),
    }
}

/// GET /api/usage/{connectionId} — usage for a specific connection.
pub async fn connection_usage(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(connection_id): axum::extract::Path<String>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let cid = connection_id.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<serde_json::Value>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        // Check connection exists
        let exists = connections_repo::get_provider_connection_by_id(&conn, &cid)?;
        if exists.is_none() {
            return Ok(None);
        }

        // Get usage for this connection
        let (total_requests, total_input, total_output, total_cost): (i64, i64, i64, f64) =
            conn.query_row(
                "SELECT COUNT(*), COALESCE(SUM(promptTokens), 0), COALESCE(SUM(completionTokens), 0), COALESCE(SUM(cost), 0) FROM usageHistory WHERE connectionId = ?",
                [&cid],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).unwrap_or((0, 0, 0, 0.0));

        Ok(Some(serde_json::json!({
            "connectionId": cid,
            "totalRequests": total_requests,
            "totalInput": total_input,
            "totalOutput": total_output,
            "totalCost": total_cost,
        })))
    })
    .await;

    match result {
        Ok(Ok(Some(data))) => Json(data).into_response(),
        Ok(Ok(None)) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Connection not found"}))).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to fetch connection usage"}))).into_response(),
    }
}

/// POST /api/usage/{connectionId}/codex-reset-credits — reset codex credits.
/// Phase 2: stub that returns success (full codex credit reset is Phase 3).
pub async fn codex_reset_credits(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(connection_id): axum::extract::Path<String>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    // Verify connection exists
    let pool_c = pool.clone();
    let cid = connection_id.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let exists = connections_repo::get_provider_connection_by_id(&conn, &cid)?;
        Ok(exists.is_some())
    })
    .await;

    match result {
        Ok(Ok(false)) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Connection not found"}))).into_response(),
        Ok(Ok(true)) => Json(serde_json::json!({"success": true, "reset": true})).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to reset credits"}))).into_response(),
    }
}

// Use the connections repo for connection lookups in usage sub-routes.
use crate::db::repos::connections as connections_repo;
