//! Public usage routes — JSON API.
//! Key-holder can view their own usage by entering their API key.
//! Returns 404 for unknown keys (not 401) — security: no info leakage.
//! All responses use masked keys — full key never returned.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::db::DbPool;
use crate::db::repos::{api_keys, key_groups, usage};

/// Query params for public usage
#[derive(Debug, Deserialize, Default)]
#[allow(dead_code)]
pub struct UsageQuery {
    pub key: Option<String>,
    pub period: Option<String>,
    pub id: Option<String>,
}

// ===== JSON API endpoints (Phase 1) =====

/// GET /api/usage/key?key=<apikey> — public key usage JSON.
/// Returns 404 for unknown/inactive keys (no existence leak).
/// Ported from src/app/api/usage/key/route.js.
pub async fn key_usage_json(
    State(pool): State<DbPool>,
    Query(q): Query<UsageQuery>,
) -> Response {
    let key = match q.key {
        Some(ref k) if !k.is_empty() => k.clone(),
        _ => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(serde_json::json!({"error": "Not Found"})),
            )
                .into_response();
        }
    };

    let pool_c = pool.clone();
    let key_c = key.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<serde_json::Value>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        let api_key = match api_keys::get_api_key_by_key(&conn, &key_c)? {
            Some(k) => k,
            None => return Ok(None),
        };

        // Resolve group
        let group_name = if let Some(ref gid) = api_key.group_id {
            key_groups::get_key_group_by_id(&conn, gid)
                .ok()
                .flatten()
                .map(|g| g.name)
                .unwrap_or_default()
        } else {
            String::new()
        };

        // Resolve group-level limits (key wins over group)
        let rpm = api_key.rpm;
        let tpm = api_key.tpm;
        let budget_usd = api_key.budget_usd;
        let reset_window = api_key.reset_window.clone();

        // Window calculations
        let window_ms = reset_window.as_deref().and_then(|w| match w {
            "5h" => Some(5 * 3_600_000i64),
            "day" => Some(86_400_000i64),
            "week" => Some(604_800_000i64),
            _ => None,
        });

        let window_started_at = api_key.window_started_at.clone()
            .unwrap_or_else(|| api_key.created_at.clone());

        let (display_window_start, display_cost, display_requests, reset_at) = if let Some(ms) = window_ms {
            let now_ms = chrono::Utc::now().timestamp_millis();
            let start_ms = chrono::DateTime::parse_from_rfc3339(&window_started_at)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(now_ms);
            let elapsed = now_ms - start_ms;

            if elapsed >= ms {
                // Window has rolled
                let rolled_start = now_ms - (now_ms % ms);
                let rolled_iso = chrono::DateTime::from_timestamp_millis(rolled_start)
                    .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                    .unwrap_or_else(|| window_started_at.clone());
                let cost = usage::get_key_cost_since(&conn, &key_c, &rolled_iso).unwrap_or(0.0);
                let reqs = usage::get_key_request_count_since(&conn, &key_c, &rolled_iso).unwrap_or(0);
                let reset = chrono::DateTime::from_timestamp_millis(rolled_start + ms)
                    .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                    .unwrap_or_default();
                (rolled_iso, cost, reqs, Some(reset))
            } else {
                let cost = usage::get_key_cost_since(&conn, &key_c, &window_started_at).unwrap_or(0.0);
                let reqs = usage::get_key_request_count_since(&conn, &key_c, &window_started_at).unwrap_or(0);
                let reset = chrono::DateTime::from_timestamp_millis(start_ms + ms)
                    .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                    .unwrap_or_default();
                (window_started_at.clone(), cost, reqs, Some(reset))
            }
        } else {
            // No reset window — all-time
            let epoch = "1970-01-01T00:00:00.000Z".to_string();
            let cost = usage::get_key_cost_since(&conn, &key_c, &epoch).unwrap_or(0.0);
            let reqs = usage::get_key_request_count_since(&conn, &key_c, &epoch).unwrap_or(0);
            (window_started_at.clone(), cost, reqs, None)
        };

        // Live RPM/tpm (last 60s)
        let limit_count = usage::get_key_rate_usage(&conn, &key_c, 60_000).unwrap_or_default();

        let remaining_budget = budget_usd.map(|b| (b - display_cost).max(0.0));

        // Parse allowedModels
        let allowed_models: Option<Vec<String>> = api_key.allowed_models
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        Ok(Some(serde_json::json!({
            "name": api_key.name,
            "active": api_key.is_active,
            "groupId": api_key.group_id,
            "groupName": group_name,
            "allowedModels": allowed_models,
            "rpm": rpm,
            "tpm": tpm,
            "budgetUsd": budget_usd,
            "resetWindow": reset_window,
            "windowStartedAt": display_window_start,
            "windowCostUsd": display_cost,
            "windowRequests": display_requests,
            "remainingBudgetUsd": remaining_budget,
            "resetAt": reset_at,
            "expiresAt": api_key.expires_at,
            "limitCount": {
                "requests": limit_count.requests,
                "tokens": limit_count.tokens,
            }
        })))
    })
    .await;

    match result {
        Ok(Ok(Some(data))) => axum::Json(data).into_response(),
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"error": "Not Found"})),
        )
            .into_response(),
        _ => (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"error": "Not Found"})),
        )
            .into_response(),
    }
}

/// DELETE /api/usage/key/history?key=<apikey> — clear request history for a key.
/// Returns 404 if key not found (not 401 — no info leakage).
pub async fn clear_history_json(
    State(pool): State<DbPool>,
    Query(q): Query<UsageQuery>,
) -> Response {
    let key = match q.key {
        Some(ref k) if !k.is_empty() => k.clone(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": "Key is required"})),
            )
                .into_response();
        }
    };

    let pool_c = pool.clone();
    let key_c = key.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<bool> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        // Verify key exists
        if api_keys::get_api_key_by_key(&conn, &key_c)?.is_none() {
            return Ok(false);
        }

        usage::delete_key_usage_history(&conn, &key_c)?;
        Ok(true)
    })
    .await;

    match result {
        Ok(Ok(true)) => axum::Json(serde_json::json!({"success": true})).into_response(),
        Ok(Ok(false)) => (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"error": "Not Found"})),
        )
            .into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({"error": "Failed to clear history"})),
        )
            .into_response(),
    }
}
