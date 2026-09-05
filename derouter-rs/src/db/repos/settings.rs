//! Settings repo — port of settingsRepo.js. Phase 1.

use std::sync::RwLock;
use chrono::Utc;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub combo_strategy: String,
    #[serde(default)]
    pub combo_strategies: serde_json::Value,
    #[serde(default)]
    pub require_login: bool,
    #[serde(default)]
    pub require_api_key: bool,
    #[serde(default)]
    pub auth_mode: String,
    #[serde(default)]
    pub enable_observability: bool,
    #[serde(default = "default_max_records")]
    pub observability_max_records: i64,
    #[serde(default = "default_batch_size")]
    pub observability_batch_size: i64,
    #[serde(default = "default_flush_interval")]
    pub observability_flush_interval_ms: i64,
    #[serde(default = "default_max_json_size")]
    pub observability_max_json_size: i64,
    #[serde(default)]
    pub mitm_router_base_url: String,
    #[serde(default)]
    pub provider_strategies: serde_json::Value,
    #[serde(default)]
    pub quota_visibility: serde_json::Value,
    #[serde(default = "default_sticky_rr")]
    pub sticky_round_robin_limit: i64,
    #[serde(default = "default_combo_sticky_rr")]
    pub combo_sticky_round_robin_limit: i64,
    // Allow extra fields from the JSON
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn default_max_records() -> i64 { 1000 }
fn default_batch_size() -> i64 { 20 }
fn default_flush_interval() -> i64 { 5000 }
fn default_max_json_size() -> i64 { 5 }
fn default_sticky_rr() -> i64 { 3 }
fn default_combo_sticky_rr() -> i64 { 1 }

impl Default for Settings {
    fn default() -> Self {
        serde_json::from_str("{}").unwrap_or_else(|_| Self {
            combo_strategy: "fallback".to_string(),
            combo_strategies: serde_json::json!({}),
            require_login: true,
            require_api_key: true,
            auth_mode: "password".to_string(),
            enable_observability: false,
            observability_max_records: 1000,
            observability_batch_size: 20,
            observability_flush_interval_ms: 5000,
            observability_max_json_size: 5,
            mitm_router_base_url: "http://localhost:20128".to_string(),
            provider_strategies: serde_json::json!({}),
            quota_visibility: serde_json::json!({}),
            sticky_round_robin_limit: 3,
            combo_sticky_round_robin_limit: 1,
            extra: serde_json::Map::new(),
        })
    }
}

/// Observability config — port of getObservabilityConfig from requestDetailsRepo.js
#[derive(Debug, Clone)]
pub struct ObservabilityConfig {
    pub enabled: bool,
    pub max_records: i64,
    pub batch_size: i64,
    pub flush_interval_ms: i64,
    pub max_json_size: i64, // in bytes (after * 1024)
}

impl Default for ObservabilityConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_records: 200,
            batch_size: 20,
            flush_interval_ms: 5000,
            max_json_size: 5 * 1024,
        }
    }
}

pub fn get_settings(conn: &Connection) -> anyhow::Result<serde_json::Value> {
    let result: Option<String> = conn
        .query_row("SELECT data FROM settings WHERE id = 1", [], |row| row.get(0))
        .ok();
    let raw = result
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or(serde_json::json!({}));
    Ok(raw)
}

pub fn update_settings(conn: &Connection, updates: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
    let current = get_settings(conn)?;
    let merged = if let (Some(cur_obj), Some(upd_obj)) = (current.as_object(), updates.as_object()) {
        let mut merged = cur_obj.clone();
        for (k, v) in upd_obj {
            merged.insert(k.clone(), v.clone());
        }
        serde_json::Value::Object(merged)
    } else {
        updates.clone()
    };
    let data_str = serde_json::to_string(&merged)?;
    conn.execute(
        "INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        [&data_str],
    )?;
    Ok(merged)
}

/// Resolve observability config from settings + env, with TTL cache
static OBS_CACHE: once_cell::sync::Lazy<RwLock<Option<(ObservabilityConfig, chrono::DateTime<Utc>)>>> =
    once_cell::sync::Lazy::new(|| RwLock::new(None));

pub fn get_observability_config(conn: &Connection) -> ObservabilityConfig {
    let now = Utc::now();
    if let Ok(cache) = OBS_CACHE.read() {
        if let Some((config, ts)) = cache.as_ref() {
            let ttl = chrono::Duration::milliseconds(5000);
            if now - *ts < ttl {
                return config.clone();
            }
        }
    }

    let settings = get_settings(conn).unwrap_or(serde_json::json!({}));

    // Check ENABLE_REQUEST_LOGS env (overrides everything)
    if let Ok(env_val) = std::env::var("ENABLE_REQUEST_LOGS") {
        let enabled = env_val.to_lowercase() == "true";
        let config = ObservabilityConfig {
            enabled,
            max_records: settings.get("observabilityMaxRecords")
                .and_then(|v| v.as_i64())
                .unwrap_or_else(|| std::env::var("OBSERVABILITY_MAX_RECORDS").ok().and_then(|s| s.parse().ok()).unwrap_or(200)),
            batch_size: settings.get("observabilityBatchSize")
                .and_then(|v| v.as_i64())
                .unwrap_or_else(|| std::env::var("OBSERVABILITY_BATCH_SIZE").ok().and_then(|s| s.parse().ok()).unwrap_or(20)),
            flush_interval_ms: settings.get("observabilityFlushIntervalMs")
                .and_then(|v| v.as_i64())
                .unwrap_or_else(|| std::env::var("OBSERVABILITY_FLUSH_INTERVAL_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(5000)),
            max_json_size: (settings.get("observabilityMaxJsonSize")
                .and_then(|v| v.as_i64())
                .unwrap_or_else(|| std::env::var("OBSERVABILITY_MAX_JSON_SIZE").ok().and_then(|s| s.parse().ok()).unwrap_or(5))) * 1024,
        };
        if let Ok(mut cache) = OBS_CACHE.write() {
            *cache = Some((config.clone(), now));
        }
        return config;
    }

    let env_fallback = std::env::var("OBSERVABILITY_ENABLED").map(|v| v != "false").unwrap_or(true);
    let ui_flag = settings.get("enableObservability").and_then(|v| v.as_bool());
    let enabled = ui_flag.unwrap_or(env_fallback);
    let config = ObservabilityConfig {
        enabled,
        max_records: settings.get("observabilityMaxRecords")
            .and_then(|v| v.as_i64())
            .unwrap_or_else(|| std::env::var("OBSERVABILITY_MAX_RECORDS").ok().and_then(|s| s.parse().ok()).unwrap_or(200)),
        batch_size: settings.get("observabilityBatchSize")
            .and_then(|v| v.as_i64())
            .unwrap_or_else(|| std::env::var("OBSERVABILITY_BATCH_SIZE").ok().and_then(|s| s.parse().ok()).unwrap_or(20)),
        flush_interval_ms: settings.get("observabilityFlushIntervalMs")
            .and_then(|v| v.as_i64())
            .unwrap_or_else(|| std::env::var("OBSERVABILITY_FLUSH_INTERVAL_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(5000)),
        max_json_size: (settings.get("observabilityMaxJsonSize")
            .and_then(|v| v.as_i64())
            .unwrap_or_else(|| std::env::var("OBSERVABILITY_MAX_JSON_SIZE").ok().and_then(|s| s.parse().ok()).unwrap_or(5))) * 1024,
    };

    if let Ok(mut cache) = OBS_CACHE.write() {
        *cache = Some((config.clone(), now));
    }
    config
}
