//! Request details repo — port of requestDetailsRepo.js. Phase 1.
//! Buffered flush: Mutex<Vec<DetailItem>> write buffer + background interval
//! flush + immediate flush at batch threshold.

use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::settings;

const DEFAULT_MAX_RECORDS: i64 = 200;
const DEFAULT_BATCH_SIZE: i64 = 20;
const DEFAULT_FLUSH_INTERVAL_MS: i64 = 5000;
const DEFAULT_MAX_JSON_SIZE: i64 = 5 * 1024;

/// One buffered request-detail record — the explicit field list from D7
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DetailItem {
    pub id: String,
    #[serde(rename = "provider")]
    pub provider: Option<String>,
    #[serde(rename = "model")]
    pub model: Option<String>,
    /// Preserve the original client model string (bare combo name) — D7 level 2
    #[serde(rename = "requestedModel")]
    pub requested_model: Option<String>,
    #[serde(rename = "connectionId")]
    pub connection_id: Option<String>,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    pub timestamp: String,
    pub status: Option<String>,
    pub latency: serde_json::Value,
    pub tokens: serde_json::Value,
    pub request: serde_json::Value,
    #[serde(rename = "providerRequest")]
    pub provider_request: serde_json::Value,
    #[serde(rename = "providerResponse")]
    pub provider_response: serde_json::Value,
    pub response: serde_json::Value,
    pub pxpipe: Option<serde_json::Value>,
}

impl DetailItem {
    /// Build with defaults, mirroring buildRequestDetail in requestDetail.js
    pub fn build(
        provider: Option<String>,
        model: Option<String>,
        requested_model: Option<String>,
        connection_id: Option<String>,
        api_key: Option<String>,
        status: Option<String>,
        mut latency: serde_json::Value,
        mut tokens: serde_json::Value,
        request: serde_json::Value,
        provider_request: serde_json::Value,
        provider_response: serde_json::Value,
        response: serde_json::Value,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        Self {
            id: generate_detail_id(model.as_deref()),
            provider,
            model,
            requested_model,
            connection_id,
            api_key,
            timestamp: now,
            status: status.or_else(|| Some("success".to_string())),
            latency: latency.take_or_empty(),
            tokens: tokens.take_or_empty(),
            request,
            provider_request,
            provider_response,
            response,
            pxpipe: None,
        }
    }
}

trait TakeOrEmpty {
    fn take_or_empty(&mut self) -> serde_json::Value;
}

impl TakeOrEmpty for serde_json::Value {
    fn take_or_empty(&mut self) -> serde_json::Value {
        if self.is_null() {
            serde_json::json!({})
        } else {
            self.clone()
        }
    }
}

/// Global write buffer
static WRITE_BUFFER: OnceLock<Arc<Mutex<Vec<DetailItem>>>> = OnceLock::new();

fn write_buffer() -> Arc<Mutex<Vec<DetailItem>>> {
    WRITE_BUFFER
        .get_or_init(|| Arc::new(Mutex::new(Vec::new())))
        .clone()
}

/// sanitizeHeaders — redacts authorization/x-api-key/cookie/token/api-key
/// (case-insensitive contains) from stored request headers. Port of sanitizeHeaders.
pub fn sanitize_headers(headers: &serde_json::Value) -> serde_json::Value {
    if !headers.is_object() {
        return serde_json::json!({});
    }
    let sensitive_keys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
    let mut sanitized = serde_json::Map::new();
    if let Some(obj) = headers.as_object() {
        for (key, value) in obj {
            let lower = key.to_lowercase();
            if !sensitive_keys.iter().any(|s| lower.contains(s)) {
                sanitized.insert(key.clone(), value.clone());
            }
        }
    }
    serde_json::Value::Object(sanitized)
}

/// truncateField — truncates oversize JSON to {_truncated, _originalSize, _preview}
pub fn truncate_field(obj: &serde_json::Value, max_size: i64) -> serde_json::Value {
    let value = if obj.is_null() {
        serde_json::json!({})
    } else {
        obj.clone()
    };
    let str_len = serde_json::to_string(&value)
        .map(|s| s.len() as i64)
        .unwrap_or(0);
    if str_len > max_size {
        let preview: String = serde_json::to_string(&value)
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        serde_json::json!({
            "_truncated": true,
            "_originalSize": str_len,
            "_preview": preview,
        })
    } else {
        value
    }
}

fn generate_detail_id(model: Option<&str>) -> String {
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let random: String = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
    let model_part = model
        .map(|m| {
            let cleaned: String = m
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
                .collect();
            cleaned
        })
        .unwrap_or_else(|| "unknown".to_string());
    format!("{}-{}-{}", timestamp, random, model_part)
}

/// Queue a detail item for buffered write. Drains when batch threshold reached.
pub async fn save_request_detail(pool: crate::db::DbPool, detail: DetailItem) {
    let config = {
        let conn = match pool.get() {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("save_request_detail: pool error: {}", e);
                return;
            }
        };
        settings::get_observability_config(&conn)
    };

    if !config.enabled {
        return;
    }

    let buffer = write_buffer();
    let should_flush = {
        let mut buf = buffer.lock().unwrap();
        buf.push(detail);
        buf.len() as i64 >= config.batch_size
    };

    if should_flush {
        // Flush immediately (batch threshold)
        let pool_clone = pool.clone();
        tokio::spawn(async move {
            if let Err(e) = flush_to_database(&pool_clone).await {
                tracing::error!("requestDetails flush err: {}", e);
            }
        });
    }
}

/// flushToDatabase — drain the entire buffer in one transaction, trim to maxRecords.
/// Explicitly lists requestedModel in the record (D7 level 2).
pub async fn flush_to_database(pool: &crate::db::DbPool) -> anyhow::Result<()> {
    loop {
        let items = {
            let buffer = write_buffer();
            let mut buf = buffer.lock().unwrap();
            if buf.is_empty() {
                return Ok(());
            }
            std::mem::take(&mut *buf)
        };

        let pool = pool.clone();
        // Drain inside one transaction
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let conn = pool.get()?;
            let config = settings::get_observability_config(&conn);

            // rusqlite transaction() returns a Transaction handle needing .commit()
            let tx = conn.unchecked_transaction()?;

            for item in &items {
                let mut item = item.clone();
                if item.id.is_empty() {
                    item.id = generate_detail_id(item.model.as_deref());
                }
                // Sanitize headers inside request
                if let Some(req_obj) = item.request.as_object_mut() {
                    if let Some(headers) = req_obj.get_mut("headers") {
                        *headers = sanitize_headers(headers);
                    }
                }

                let record = serde_json::json!({
                    "id": item.id,
                    "provider": item.provider,
                    "model": item.model,
                    "requestedModel": item.requested_model,
                    "connectionId": item.connection_id,
                    "apiKey": item.api_key,
                    "timestamp": item.timestamp,
                    "status": item.status,
                    "latency": item.latency,
                    "tokens": item.tokens,
                    "request": truncate_field(&item.request, config.max_json_size),
                    "providerRequest": truncate_field(&item.provider_request, config.max_json_size),
                    "providerResponse": truncate_field(&item.provider_response, config.max_json_size),
                    "response": truncate_field(&item.response, config.max_json_size),
                });

                let data_str = serde_json::to_string(&record)?;
                let record_id = record["id"].as_str().unwrap_or("").to_string();
                let record_ts = record["timestamp"].as_str().unwrap_or("").to_string();
                let record_provider = record["provider"].as_str().map(|s| s.to_string());
                let record_model = record["model"].as_str().map(|s| s.to_string());
                let record_conn = record["connectionId"].as_str().map(|s| s.to_string());
                let record_key = record["apiKey"].as_str().map(|s| s.to_string());
                let record_status = record["status"].as_str().map(|s| s.to_string());
                tx.execute(
                    "INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, apiKey, status, data)
                     VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp, provider=excluded.provider, model=excluded.model, connectionId=excluded.connectionId, apiKey=excluded.apiKey, status=excluded.status, data=excluded.data",
                    rusqlite::params![
                        &record_id, &record_ts, &record_provider,
                        &record_model, &record_conn, &record_key,
                        &record_status, &data_str,
                    ],
                )?;
            }

            // Trim to maxRecords
            let count: i64 = tx.query_row("SELECT COUNT(*) FROM requestDetails", [], |row| row.get(0))?;
            if count > config.max_records {
                let excess = count - config.max_records;
                tx.execute(
                    "DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)",
                    [excess],
                )?;
            }

            tx.commit()?;
            Ok(())
        })
        .await??;
    }
}

/// Background flush task — tokio interval timer
pub fn start_flush_task(pool: crate::db::DbPool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(5000));
        loop {
            interval.tick().await;
            if let Err(e) = flush_to_database(&pool).await {
                tracing::error!("Background flush failed: {}", e);
            }
        }
    });
}

/// Shutdown flush — drain remaining buffer
pub async fn shutdown_flush(pool: &crate::db::DbPool) {
    if let Err(e) = flush_to_database(pool).await {
        tracing::error!("Shutdown flush failed: {}", e);
    }
}

/// getRequestDetails — filtered, paginated
pub fn get_request_details(
    conn: &Connection,
    filter: &DetailFilter,
) -> anyhow::Result<(Vec<serde_json::Value>, Pagination)> {
    let mut conds: Vec<String> = Vec::new();
    let mut params: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(ref provider) = filter.provider {
        conds.push("provider = ?".to_string());
        params.push(provider.clone().into());
    }
    if let Some(ref model) = filter.model {
        conds.push("model = ?".to_string());
        params.push(model.clone().into());
    }
    if let Some(ref connection_id) = filter.connection_id {
        conds.push("connectionId = ?".to_string());
        params.push(connection_id.clone().into());
    }
    if let Some(ref api_key) = filter.api_key {
        conds.push("apiKey = ?".to_string());
        params.push(api_key.clone().into());
    }
    if let Some(ref status) = filter.status {
        conds.push("status = ?".to_string());
        params.push(status.clone().into());
    }
    if let Some(ref start_date) = filter.start_date {
        conds.push("timestamp >= ?".to_string());
        params.push(parse_date_to_iso(start_date).into());
    }
    if let Some(ref end_date) = filter.end_date {
        conds.push("timestamp <= ?".to_string());
        params.push(parse_date_to_iso(end_date).into());
    }

    let where_clause = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };

    let count_sql = format!("SELECT COUNT(*) FROM requestDetails {}", where_clause);
    let total_items: i64 = conn.query_row(
        &count_sql,
        rusqlite::params_from_iter(params.iter()),
        |row| row.get(0),
    )?;

    let page = filter.page.unwrap_or(1).max(1);
    let page_size = filter.page_size.unwrap_or(50).clamp(1, 100);
    let total_pages = (total_items as f64 / page_size as f64).ceil() as i64;
    let offset = (page - 1) * page_size;

    let sql = format!(
        "SELECT data FROM requestDetails {} ORDER BY timestamp DESC LIMIT ? OFFSET ?",
        where_clause
    );
    let mut all_params = params;
    all_params.push(page_size.into());
    all_params.push(offset.into());

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(all_params.iter()), |row| {
        let data: String = row.get(0)?;
        Ok(serde_json::from_str::<serde_json::Value>(&data).unwrap_or(serde_json::json!({})))
    })?;
    let mut details = Vec::new();
    for r in rows {
        details.push(r?);
    }

    Ok((
        details,
        Pagination {
            page,
            page_size,
            total_items,
            total_pages,
            has_next: page < total_pages,
            has_prev: page > 1,
        },
    ))
}

pub fn parse_date_to_iso(date_str: &str) -> String {
    // Try to parse as RFC3339 or fallback
    chrono::DateTime::parse_from_rfc3339(date_str)
        .map(|dt| dt.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|_| date_str.to_string())
}

#[derive(Default, Clone)]
pub struct DetailFilter {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub connection_id: Option<String>,
    pub api_key: Option<String>,
    pub status: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Pagination {
    pub page: i64,
    pub page_size: i64,
    pub total_items: i64,
    pub total_pages: i64,
    pub has_next: bool,
    pub has_prev: bool,
}
