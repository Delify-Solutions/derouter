//! Usage dashboard routes — Phase 3.
//! All 8 route handlers: page, overview_tab, keys_tab, keys_table,
//! key_models, details_tab, details_table, detail_drawer.

use askama::Template;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use serde::Deserialize;

use crate::db::DbPool;
use crate::db::repos::{
    api_keys, combos, connections, key_groups, request_details, usage,
};
use crate::templates::{
    DetailDrawer, DetailRow, DetailsTab, DetailsTable, GroupOption, KeyModels,
    KeysTab, KeysTable, ModelBreakdownRow, OverviewTab, UsageKeyRow,
};

/// Usage page shell — renders the tab container
pub async fn page(State(_pool): State<DbPool>) -> impl IntoResponse {
    let tmpl = crate::templates::UsagePage;
    Html(tmpl.render().unwrap_or_default())
}

/// Overview tab — aggregate stats
pub async fn overview_tab(State(pool): State<DbPool>) -> Response {
    let pool_clone = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let conn = pool_clone.get()?;

        // Aggregate usage totals from usageHistory
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

        // Count active keys, combos, providers
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

        Ok((
            total_requests,
            total_input,
            total_output,
            total_cost,
            active_keys,
            active_combos,
            active_providers,
        ))
    })
    .await;

    match result {
        Ok(Ok((tr, ti, to, tc, ak, ac, ap))) => {
            let tmpl = OverviewTab {
                total_requests: tr,
                total_input: ti,
                total_output: to,
                total_cost: format!("{:.4}", tc),
                active_keys: ak,
                active_combos: ac,
                active_providers: ap,
            };
            Html(tmpl.render().unwrap_or_default()).into_response()
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Keys tab — filter form + table container
pub async fn keys_tab(State(pool): State<DbPool>) -> Response {
    let pool_clone = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<GroupOption>> {
        let conn = pool_clone.get()?;
        let groups = key_groups::get_key_groups(&conn)?;
        Ok(groups
            .into_iter()
            .map(|g| GroupOption {
                id: g.id,
                name: g.name,
            })
            .collect())
    })
    .await;

    match result {
        Ok(Ok(groups)) => {
            let tmpl = KeysTab { groups };
            Html(tmpl.render().unwrap_or_default()).into_response()
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Query params for keys table filter
#[derive(Debug, Deserialize, Default)]
pub struct KeysTableQuery {
    pub q: Option<String>,
    pub group: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// Keys table tbody — per-key usage with limits, budget, peak TPM
pub async fn keys_table(State(pool): State<DbPool>, Query(q): Query<KeysTableQuery>) -> Response {
    let pool_clone = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<UsageKeyRow>> {
        let conn = pool_clone.get()?;
        let mut keys = api_keys::get_api_keys(&conn)?;

        // Filter by search query
        if let Some(ref search) = q.q {
            let lower = search.to_lowercase();
            keys.retain(|k| {
                k.name
                    .as_deref()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&lower)
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
            // Resolve group name
            let group_name = if let Some(ref gid) = key.group_id {
                key_groups::get_key_group_by_id(&conn, gid)
                    .ok()
                    .flatten()
                    .map(|g| g.name)
                    .unwrap_or_else(|| "—".to_string())
            } else {
                "—".to_string()
            };

            // Get usage summary (includes peak TPM)
            let summary = usage::get_key_usage_summary(
                &conn,
                &key.key,
                q.start_date.as_deref(),
                q.end_date.as_deref(),
            )
            .unwrap_or_default();

            // Get live RPM/TPM (last 60 seconds)
            let rate = usage::get_key_rate_usage(&conn, &key.key, 60_000).unwrap_or_default();

            // Models count = distinct models in summary
            let models_count = summary.items.len() as i64;

            // Budget tracking
            let budget_limit = key.budget_usd.map(|b| format!("${:.2}", b)).unwrap_or_else(|| "—".to_string());
            let budget_spent = format!("${:.2}", key.window_cost_usd);
            let budget_pct = if let Some(b) = key.budget_usd {
                if b > 0.0 {
                    ((key.window_cost_usd / b) * 100.0).min(100.0) as i64
                } else {
                    0
                }
            } else {
                0
            };
            let budget_over = key.budget_usd.map(|b| key.window_cost_usd >= b).unwrap_or(false);

            rows.push(UsageKeyRow {
                id: key.id.clone(),
                name: key.name.clone().unwrap_or_else(|| "Unnamed".to_string()),
                masked_key: api_keys::mask_key(&key.key),
                group: group_name,
                rpm_limit: key.rpm.map(|r| r.to_string()).unwrap_or_else(|| "—".to_string()),
                rpm_live: rate.requests.to_string(),
                tpm_limit: key.tpm.map(|t| t.to_string()).unwrap_or_else(|| "—".to_string()),
                tpm_live: rate.tokens.to_string(),
                budget_limit,
                budget_spent,
                budget_pct,
                budget_over,
                peak_tpm: summary.peak_tpm,
                requests: summary.totals.requests,
                input_tokens: summary.totals.input,
                output_tokens: summary.totals.output,
                cache_tokens: summary.totals.cache_read,
                cost: format!("{:.4}", summary.totals.cost),
                models_count,
                is_active: key.is_active,
                expires_at: key.expires_at.clone().unwrap_or_default(),
            });
        }
        Ok(rows)
    })
    .await;

    match result {
        Ok(Ok(rows)) => {
            let tmpl = KeysTable { rows };
            Html(tmpl.render().unwrap_or_default()).into_response()
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Per-key model breakdown expand row
pub async fn key_models(State(pool): State<DbPool>, Path(id): Path<String>) -> Response {
    let pool_clone = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<KeyModels> {
        let conn = pool_clone.get()?;

        // Find the key by id
        let keys = api_keys::get_api_keys(&conn)?;
        let key = keys
            .into_iter()
            .find(|k| k.id == id)
            .ok_or_else(|| anyhow::anyhow!("key not found"))?;

        let summary = usage::get_key_usage_summary(&conn, &key.key, None, None)?;

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

        Ok(KeyModels {
            models,
            total_requests: summary.totals.requests,
            total_input: summary.totals.input,
            total_output: summary.totals.output,
            total_cost: format!("{:.4}", summary.totals.cost),
        })
    })
    .await;

    match result {
        Ok(Ok(models)) => {
            Html(models.render().unwrap_or_default()).into_response()
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Details tab — filter form + table container
pub async fn details_tab(State(pool): State<DbPool>) -> Response {
    let pool_clone = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<GroupOption>> {
        let conn = pool_clone.get()?;
        let keys = api_keys::get_api_keys(&conn)?;
        Ok(keys
            .into_iter()
            .map(|k| {
                let id = k.id.clone();
                GroupOption {
                    id: k.id,
                    name: k.name.unwrap_or_else(|| id),
                }
            })
            .collect())
    })
    .await;

    match result {
        Ok(Ok(keys)) => {
            let tmpl = DetailsTab { keys };
            Html(tmpl.render().unwrap_or_default()).into_response()
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Query params for details table filter
#[derive(Debug, Deserialize, Default)]
pub struct DetailsTableQuery {
    pub q: Option<String>,
    pub key_id: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub status: Option<String>,
    pub page: Option<i64>,
}

/// Details table tbody — paginated request details
pub async fn details_table(State(pool): State<DbPool>, Query(q): Query<DetailsTableQuery>) -> Response {
    let pool_clone = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<DetailRow>> {
        let conn = pool_clone.get()?;

        // Build filter
        let mut filter = request_details::DetailFilter::default();
        filter.page = q.page;
        filter.page_size = Some(50);

        // Map key_id to api_key value
        if let Some(ref key_id) = q.key_id {
            if !key_id.is_empty() {
                let keys = api_keys::get_api_keys(&conn)?;
                if let Some(k) = keys.into_iter().find(|k| k.id == *key_id) {
                    filter.api_key = Some(k.key);
                }
            }
        }

        if let Some(ref status) = q.status {
            if !status.is_empty() {
                filter.status = Some(status.clone());
            }
        }

        // Parse dates to ISO format
        if let Some(ref sd) = q.start_date {
            if !sd.is_empty() {
                filter.start_date = Some(request_details::parse_date_to_iso(sd));
            }
        }
        if let Some(ref ed) = q.end_date {
            if !ed.is_empty() {
                filter.end_date = Some(request_details::parse_date_to_iso(ed));
            }
        }

        let (details, _pagination) = request_details::get_request_details(&conn, &filter)?;

        let mut rows = Vec::new();
        for detail in &details {
            let id = detail
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let timestamp = detail
                .get("timestamp")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let provider = detail
                .get("provider")
                .and_then(|v| v.as_str())
                .unwrap_or("—")
                .to_string();
            let resolved_model = detail
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("—")
                .to_string();
            let requested_model = detail
                .get("requestedModel")
                .and_then(|v| v.as_str())
                .unwrap_or(&resolved_model)
                .to_string();
            let status_val = detail
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("success")
                .to_string();
            let is_error = status_val == "error" || status_val.contains("error");

            // Latency
            let latency_val = detail.get("latency").cloned().unwrap_or(serde_json::json!({}));
            let latency = if let Some(ms) = latency_val.get("totalMs").and_then(|v| v.as_f64()) {
                format!("{:.0}ms", ms)
            } else if let Some(ms) = latency_val.as_f64() {
                format!("{:.0}ms", ms)
            } else {
                "—".to_string()
            };

            // Tokens
            let tokens = detail.get("tokens").cloned().unwrap_or(serde_json::json!({}));
            let input_tokens = tokens
                .get("prompt_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let output_tokens = tokens
                .get("completion_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);

            // Cost
            let cost_val = detail
                .get("cost")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);

            // Key name — masked
            let key_name = detail
                .get("apiKey")
                .and_then(|v| v.as_str())
                .map(|k| {
                    if k.len() >= 10 {
                        format!("{}…****{}", &k[..6], &k[k.len()-4..])
                    } else {
                        "****".to_string()
                    }
                })
                .unwrap_or_else(|| "—".to_string());

            // Apply search filter
            if let Some(ref search) = q.q {
                let lower = search.to_lowercase();
                let haystack = format!("{} {} {} {} {}", id, timestamp, key_name, requested_model, provider).to_lowercase();
                if !haystack.contains(&lower) {
                    continue;
                }
            }

            rows.push(DetailRow {
                id,
                timestamp,
                key_name,
                requested_model,
                resolved_model,
                provider,
                input_tokens,
                output_tokens,
                cost: format!("{:.4}", cost_val),
                is_error,
                latency,
            });
        }

        Ok(rows)
    })
    .await;

    match result {
        Ok(Ok(rows)) => {
            let tmpl = DetailsTable { rows };
            Html(tmpl.render().unwrap_or_default()).into_response()
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Detail drawer — single request detail
pub async fn detail_drawer(State(pool): State<DbPool>, Path(id): Path<String>) -> Response {
    let pool_clone = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<DetailDrawer> {
        let conn = pool_clone.get()?;

        // Get single request detail by id
        let filter = request_details::DetailFilter::default();
        let (details, _) = request_details::get_request_details(&conn, &filter)?;

        let detail = details
            .into_iter()
            .find(|d| d.get("id").and_then(|v| v.as_str()) == Some(&id))
            .ok_or_else(|| anyhow::anyhow!("detail not found"))?;

        let timestamp = detail
            .get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let provider = detail
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("—")
            .to_string();
        let resolved_model = detail
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("—")
            .to_string();
        let requested_model = detail
            .get("requestedModel")
            .and_then(|v| v.as_str())
            .unwrap_or(&resolved_model)
            .to_string();
        let status_val = detail
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("success")
            .to_string();
        let is_error = status_val == "error" || status_val.contains("error");

        // Latency
        let latency_val = detail.get("latency").cloned().unwrap_or(serde_json::json!({}));
        let latency = if let Some(ms) = latency_val.get("totalMs").and_then(|v| v.as_f64()) {
            format!("{:.0}ms", ms)
        } else if let Some(ms) = latency_val.as_f64() {
            format!("{:.0}ms", ms)
        } else {
            "—".to_string()
        };

        // Tokens
        let tokens = detail.get("tokens").cloned().unwrap_or(serde_json::json!({}));
        let input_tokens = tokens
            .get("prompt_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let output_tokens = tokens
            .get("completion_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let cache_read = tokens
            .get("cached_tokens")
            .or_else(|| tokens.get("cache_read_input_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let cache_tokens = if cache_read > 0 {
            format!("{}", cache_read)
        } else {
            "0".to_string()
        };

        // Cost
        let cost_val = detail
            .get("cost")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);

        // Key name — masked
        let key_name = detail
            .get("apiKey")
            .and_then(|v| v.as_str())
            .map(|k| {
                if k.len() >= 10 {
                    format!("{}…****{}", &k[..6], &k[k.len()-4..])
                } else {
                    "****".to_string()
                }
            })
            .unwrap_or_else(|| "—".to_string());

        // Request data (already sanitized + truncated at save time)
        let request = detail.get("request").cloned().unwrap_or(serde_json::json!({}));
        let redacted_request_headers = request
            .get("headers")
            .map(|h| serde_json::to_string_pretty(h).unwrap_or_default())
            .unwrap_or_else(|| "{}".to_string());
        let raw_request_headers_json = request
            .get("headers")
            .map(|h| serde_json::to_string(h).unwrap_or_default())
            .unwrap_or_else(|| "{}".to_string());
        let request_body = request
            .get("body")
            .map(|b| serde_json::to_string_pretty(b).unwrap_or_default())
            .unwrap_or_else(|| "{}".to_string());

        // Response data
        let response = detail.get("response").cloned().unwrap_or(serde_json::json!({}));
        let redacted_response_headers = response
            .get("headers")
            .map(|h| serde_json::to_string_pretty(h).unwrap_or_default())
            .unwrap_or_else(|| "{}".to_string());
        let raw_response_headers_json = response
            .get("headers")
            .map(|h| serde_json::to_string(h).unwrap_or_default())
            .unwrap_or_else(|| "{}".to_string());
        let response_body = response
            .get("body")
            .map(|b| serde_json::to_string_pretty(b).unwrap_or_default())
            .unwrap_or_else(|| "{}".to_string());

        // Error message
        let error_message = if is_error {
            response
                .get("body")
                .and_then(|b| b.get("error"))
                .and_then(|e| e.as_str())
                .or_else(|| {
                    response
                        .get("body")
                        .and_then(|b| b.as_str())
                })
                .unwrap_or("Request failed")
                .to_string()
        } else {
            String::new()
        };

        Ok(DetailDrawer {
            timestamp,
            key_name,
            requested_model,
            resolved_model,
            provider,
            is_error,
            latency,
            input_tokens,
            output_tokens,
            cache_tokens,
            cost: format!("{:.4}", cost_val),
            redacted_request_headers,
            raw_request_headers_json,
            request_body,
            redacted_response_headers,
            raw_response_headers_json,
            response_body,
            error_message,
        })
    })
    .await;

    match result {
        Ok(Ok(drawer)) => {
            Html(drawer.render().unwrap_or_default()).into_response()
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
