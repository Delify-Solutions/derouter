//! Usage repo — port of usageRepo.js. Phase 1.
//! saveRequestUsage, getUsageHistory (requestedModel in meta), getKeyUsageSummary
//! (peak TPM), deleteKeyUsageHistory, maskApiKey, getKeyRateUsage, etc.

use chrono::{Utc, Datelike};
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
pub struct UsageEntry {
    pub timestamp: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub connection_id: Option<String>,
    pub api_key: Option<String>,
    pub endpoint: Option<String>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cost: f64,
    pub status: String,
    pub tokens: serde_json::Value,
    pub meta: serde_json::Value,
    /// Original client model (bare combo name) — threaded through for display
    #[serde(skip_serializing)]
    pub requested_model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageHistoryRow {
    pub timestamp: String,
    pub provider: Option<String>,
    /// Display model: requestedModel (combo name) if known, else resolved model
    pub model: String,
    pub resolved_model: Option<String>,
    pub requested_model: Option<String>,
    pub connection_id: Option<String>,
    pub api_key_masked: Option<String>,
    pub endpoint: Option<String>,
    pub cost: f64,
    pub status: String,
    pub tokens: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct KeyUsageSummary {
    pub items: Vec<ModelSummary>,
    pub totals: Totals,
    pub peak_tpm: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ModelSummary {
    pub model: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
    pub requests: i64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Totals {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
    pub requests: i64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RateUsage {
    pub requests: i64,
    pub tokens: i64,
}

/// Port of saveRequestUsage — writes usageHistory + usageDaily + lifetime counter
/// in one transaction. requestedModel stored in meta JSON.
pub fn save_request_usage(conn: &Connection, entry: &UsageEntry) -> anyhow::Result<bool> {
    let timestamp = if entry.timestamp.is_empty() {
        Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    } else {
        entry.timestamp.clone()
    };

    let tokens_json = serde_json::to_string(&entry.tokens)?;
    let meta = serde_json::json!({ "requestedModel": entry.requested_model });
    let meta_json = serde_json::to_string(&meta)?;

    // rusqlite: transaction() returns a Transaction handle needing .commit()
    let tx = conn.unchecked_transaction()?;

    // Check for duplicate
    let existing: Option<i64> = tx.query_row(
        "SELECT id FROM usageHistory
         WHERE timestamp = ?
           AND COALESCE(provider, '') = COALESCE(?, '')
           AND COALESCE(model, '') = COALESCE(?, '')
           AND COALESCE(connectionId, '') = COALESCE(?, '')
           AND COALESCE(apiKey, '') = COALESCE(?, '')
           AND promptTokens = ?
           AND completionTokens = ?
         ORDER BY id DESC LIMIT 1",
        rusqlite::params![
            &timestamp, entry.provider, entry.model,
            entry.connection_id, entry.api_key,
            entry.prompt_tokens, entry.completion_tokens,
        ],
        |row| row.get(0),
    )
    .ok();

    if existing.is_some() {
        // Duplicate — skip insert
        tx.commit()?;
        return Ok(false);
    }

    // Insert into usageHistory
    tx.execute(
        "INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            &timestamp, entry.provider, entry.model,
            entry.connection_id, entry.api_key, entry.endpoint,
            entry.prompt_tokens, entry.completion_tokens, entry.cost,
            entry.status, &tokens_json, &meta_json,
        ],
    )?;

    // Update usageDaily
    let date_key = get_local_date_key(&timestamp);
    let day = get_or_create_daily(&tx, &date_key, entry)?;
    let day_json = serde_json::to_string(&day)?;
    tx.execute(
        "INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data",
        rusqlite::params![&date_key, &day_json],
    )?;

    // Increment lifetime counter
    let cur: Option<String> = tx
        .query_row("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'", [], |row| row.get(0))
        .ok();
    let next = (cur.and_then(|s| s.parse::<i64>().ok()).unwrap_or(0)) + 1;
    tx.execute(
        "INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![next.to_string()],
    )?;

    tx.commit()?;
    Ok(true)
}

/// Port of getUsageHistory — returns requestedModel from meta, display model = requestedModel || model
pub fn get_usage_history(conn: &Connection, filter: &UsageFilter) -> anyhow::Result<Vec<UsageHistoryRow>> {
    let mut conds: Vec<String> = Vec::new();
    let mut params: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(ref provider) = filter.provider {
        conds.push("provider = ?".into());
        params.push(provider.clone().into());
    }
    if let Some(ref model) = filter.model {
        conds.push("model = ?".into());
        params.push(model.clone().into());
    }
    if let Some(ref api_key) = filter.api_key {
        conds.push("apiKey = ?".into());
        params.push(api_key.clone().into());
    }
    if let Some(ref start_date) = filter.start_date {
        conds.push("timestamp >= ?".into());
        params.push(start_date.clone().into());
    }
    if let Some(ref end_date) = filter.end_date {
        conds.push("timestamp <= ?".into());
        params.push(end_date.clone().into());
    }

    let where_clause = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    let sql = format!(
        "SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens, meta FROM usageHistory {} ORDER BY id ASC",
        where_clause
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        let meta_str: String = row.get(9)?;
        let meta: serde_json::Value = serde_json::from_str(&meta_str).unwrap_or(serde_json::json!({}));
        let tokens_str: String = row.get(8)?;
        let tokens: serde_json::Value = serde_json::from_str(&tokens_str).unwrap_or(serde_json::json!({}));

        let requested_model = meta
            .get("requestedModel")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let model: String = row.get(2).unwrap_or_default();
        let display_model = requested_model.clone().unwrap_or(model.clone());

        Ok(UsageHistoryRow {
            timestamp: row.get(0)?,
            provider: row.get(1)?,
            model: display_model,
            resolved_model: Some(model),
            requested_model,
            connection_id: row.get(3)?,
            api_key_masked: Some(mask_api_key(row.get::<_, Option<String>>(4)?)),
            endpoint: row.get(5)?,
            cost: row.get(6).unwrap_or(0.0),
            status: row.get(7).unwrap_or("ok".into()),
            tokens,
        })
    })?;
    let mut results = Vec::new();
    for r in rows {
        results.push(r?);
    }
    Ok(results)
}

#[derive(Default, Clone)]
pub struct UsageFilter {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// Port of maskApiKey — >=10 chars → prefix(8)***, else first_char***
/// (This is the usageRepo version: key.slice(0,8) + "***")
pub fn mask_api_key(key: Option<String>) -> String {
    match key {
        Some(k) if k.len() > 8 => format!("{}***", &k[..8]),
        Some(k) if k.is_empty() => "****".to_string(),
        Some(k) => format!("{}***", &k[..1]),
        None => "****".to_string(),
    }
}

/// Port of getKeyUsageSummary — per-model aggregation + peak TPM
pub fn get_key_usage_summary(
    conn: &Connection,
    api_key: &str,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> anyhow::Result<KeyUsageSummary> {
    let mut conds = vec!["apiKey = ?".to_string()];
    let mut params: Vec<rusqlite::types::Value> = vec![api_key.to_string().into()];

    if let Some(s) = start_date {
        conds.push("timestamp >= ?".into());
        params.push(s.to_string().into());
    }
    if let Some(e) = end_date {
        conds.push("timestamp <= ?".into());
        params.push(e.to_string().into());
    }

    let where_clause = conds.join(" AND ");
    let sql = format!(
        "SELECT model, timestamp, promptTokens, completionTokens, cost, tokens, meta FROM usageHistory WHERE {} ORDER BY timestamp ASC",
        where_clause
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        let meta_str: String = row.get(6).unwrap_or_default();
        let meta: serde_json::Value = serde_json::from_str(&meta_str).unwrap_or(serde_json::json!({}));
        let tokens_str: String = row.get(5).unwrap_or_default();
        let tokens: serde_json::Value = serde_json::from_str(&tokens_str).unwrap_or(serde_json::json!({}));

        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2).unwrap_or(0),
            row.get::<_, i64>(3).unwrap_or(0),
            row.get::<_, f64>(4).unwrap_or(0.0),
            tokens,
            meta,
        ))
    })?;

    let mut by_model: std::collections::HashMap<String, ModelSummary> = std::collections::HashMap::new();
    let mut totals = Totals::default();
    let mut per_minute: std::collections::HashMap<String, i64> = std::collections::HashMap::new();

    for row in rows {
        let (model, timestamp, prompt, completion, cost, tokens, meta) = row?;

        let cache_read = tokens
            .get("cached_tokens")
            .or_else(|| tokens.get("cache_read_input_tokens"))
            .or_else(|| tokens.get("prompt_tokens_details"))
            .and_then(|v| {
                if let Some(s) = v.get("cached_tokens").and_then(|v| v.as_i64()) {
                    return Some(s);
                }
                v.as_i64()
            })
            .unwrap_or(0);

        let cache_creation = tokens
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        let display_model = meta
            .get("requestedModel")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or(model)
            .unwrap_or("unknown".to_string());

        let entry = by_model.entry(display_model.clone()).or_insert_with(|| ModelSummary {
            model: display_model.clone(),
            ..Default::default()
        });

        entry.input += prompt;
        entry.output += completion;
        entry.cache_read += cache_read;
        entry.cache_creation += cache_creation;
        entry.requests += 1;
        entry.cost += cost;

        totals.input += prompt;
        totals.output += completion;
        totals.cache_read += cache_read;
        totals.cache_creation += cache_creation;
        totals.requests += 1;
        totals.cost += cost;

        let minute = &timestamp[..16]; // YYYY-MM-DDTHH:MM
        *per_minute.entry(minute.to_string()).or_insert(0) += prompt + completion;
    }

    let peak_tpm = per_minute.values().copied().max().unwrap_or(0);

    let mut items: Vec<ModelSummary> = by_model.into_values().collect();
    items.sort_by(|a, b| b.requests.cmp(&a.requests));

    Ok(KeyUsageSummary {
        items,
        totals,
        peak_tpm,
    })
}

/// Port of getKeyRateUsage — count requests and sum tokens in last windowMs
pub fn get_key_rate_usage(conn: &Connection, api_key: &str, window_ms: i64) -> anyhow::Result<RateUsage> {
    let since = Utc::now()
        .checked_sub_signed(chrono::Duration::milliseconds(window_ms))
        .unwrap_or(Utc::now())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let row = conn.query_row(
        "SELECT COUNT(*) as requests, COALESCE(SUM(COALESCE(promptTokens,0) + COALESCE(completionTokens,0)),0) as tokens
         FROM usageHistory WHERE apiKey = ? AND timestamp >= ?",
        rusqlite::params![api_key, &since],
        |row| {
            Ok(RateUsage {
                requests: row.get(0)?,
                tokens: row.get(1)?,
            })
        },
    )?;

    Ok(row)
}

/// Port of getKeyCostSince — sum cost for apiKey since a given ISO timestamp
pub fn get_key_cost_since(conn: &Connection, api_key: &str, since_iso: &str) -> anyhow::Result<f64> {
    let cost: f64 = conn.query_row(
        "SELECT COALESCE(SUM(cost),0) FROM usageHistory WHERE apiKey = ? AND timestamp >= ?",
        rusqlite::params![api_key, since_iso],
        |row| row.get(0),
    )?;
    Ok(cost)
}

/// Port of getKeyRequestCountSince
pub fn get_key_request_count_since(conn: &Connection, api_key: &str, since_iso: &str) -> anyhow::Result<i64> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM usageHistory WHERE apiKey = ? AND timestamp >= ?",
        rusqlite::params![api_key, since_iso],
        |row| row.get(0),
    )?;
    Ok(count)
}

/// Port of deleteKeyUsageHistory — deletes usageHistory + requestDetails for a key
/// in one transaction. Does NOT touch usageDaily.
pub fn delete_key_usage_history(conn: &Connection, api_key: &str) -> anyhow::Result<(i64, i64)> {
    let tx = conn.unchecked_transaction()?;
    let history_changes = tx.execute("DELETE FROM usageHistory WHERE apiKey = ?", [api_key])?;
    let details_changes = tx.execute("DELETE FROM requestDetails WHERE apiKey = ?", [api_key])?;
    tx.commit()?;
    Ok((history_changes as i64, details_changes as i64))
}

fn get_local_date_key(timestamp: &str) -> String {
    let dt = chrono::DateTime::parse_from_rfc3339(timestamp)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());
    format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day())
}

/// Aggregate entry into daily summary — simplified port of aggregateEntryToDay
fn get_or_create_daily(
    tx: &rusqlite::Transaction,
    date_key: &str,
    entry: &UsageEntry,
) -> anyhow::Result<serde_json::Value> {
    let row: Option<String> = tx
        .query_row(
            "SELECT data FROM usageDaily WHERE dateKey = ?",
            [date_key],
            |row| row.get(0),
        )
        .ok();

    let mut day = match row {
        Some(s) => serde_json::from_str::<serde_json::Value>(&s).unwrap_or(serde_json::json!({})),
        None => serde_json::json!({
            "requests": 0i64, "promptTokens": 0i64, "completionTokens": 0i64, "cost": 0.0,
        }),
    };

    let obj = day.as_object_mut().unwrap();
    *obj.entry("requests").or_insert(serde_json::json!(0)) = serde_json::json!(
        obj.get("requests").and_then(|v| v.as_i64()).unwrap_or(0) + 1
    );
    *obj.entry("promptTokens").or_insert(serde_json::json!(0)) = serde_json::json!(
        obj.get("promptTokens").and_then(|v| v.as_i64()).unwrap_or(0) + entry.prompt_tokens
    );
    *obj.entry("completionTokens").or_insert(serde_json::json!(0)) = serde_json::json!(
        obj.get("completionTokens").and_then(|v| v.as_i64()).unwrap_or(0) + entry.completion_tokens
    );
    *obj.entry("cost").or_insert(serde_json::json!(0.0)) = serde_json::json!(
        obj.get("cost").and_then(|v| v.as_f64()).unwrap_or(0.0) + entry.cost
    );

    Ok(day)
}
