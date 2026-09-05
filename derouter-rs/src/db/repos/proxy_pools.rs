//! Proxy pools repo — ported from src/lib/db/repos/proxyPoolsRepo.js.
//! proxyPools table: id, isActive, testStatus, data (JSON), createdAt, updatedAt.
//! The `data` column stores name, proxyUrl, noProxy, type, strictProxy, lastTestedAt, lastError.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Proxy pool — merged from the data JSON column + top-level columns.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProxyPool {
    pub id: String,
    #[serde(rename = "isActive")]
    pub is_active: bool,
    pub test_status: Option<String>,
    // From data JSON:
    pub name: String,
    pub proxy_url: Option<String>,
    pub no_proxy: Option<String>,
    #[serde(rename = "type")]
    pub pool_type: Option<String>,
    pub strict_proxy: Option<bool>,
    pub last_tested_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Filter for listing proxy pools.
#[derive(Default, Clone)]
pub struct ProxyPoolFilter {
    pub is_active: Option<bool>,
}

fn row_to_pool(row: &rusqlite::Row) -> rusqlite::Result<ProxyPool> {
    let id: String = row.get(0)?;
    let is_active_i: i64 = row.get(1)?;
    let test_status: Option<String> = row.get(2)?;
    let data_str: String = row.get(3)?;
    let created_at: String = row.get(4)?;
    let updated_at: String = row.get(5)?;

    let data: serde_json::Value = serde_json::from_str(&data_str).unwrap_or(serde_json::json!({}));

    Ok(ProxyPool {
        id,
        is_active: is_active_i != 0,
        test_status,
        name: data.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        proxy_url: data.get("proxyUrl").and_then(|v| v.as_str()).map(|s| s.to_string()),
        no_proxy: data.get("noProxy").and_then(|v| v.as_str()).map(|s| s.to_string()),
        pool_type: data.get("type").and_then(|v| v.as_str()).map(|s| s.to_string()),
        strict_proxy: data.get("strictProxy").and_then(|v| v.as_bool()),
        last_tested_at: data.get("lastTestedAt").and_then(|v| v.as_str()).map(|s| s.to_string()),
        last_error: data.get("lastError").and_then(|v| v.as_str()).map(|s| s.to_string()),
        created_at,
        updated_at,
    })
}

const SELECT_COLS: &str = "id, isActive, testStatus, data, createdAt, updatedAt";

pub fn get_proxy_pools(conn: &Connection, filter: &ProxyPoolFilter) -> anyhow::Result<Vec<ProxyPool>> {
    let mut sql = format!("SELECT {} FROM proxyPools", SELECT_COLS);
    let mut conditions = Vec::new();
    let mut params: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(is_active) = filter.is_active {
        conditions.push("isActive = ?");
        params.push((if is_active { 1 } else { 0 }).into());
    }

    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), row_to_pool)?;
    let mut pools = Vec::new();
    for r in rows {
        pools.push(r?);
    }
    // Sort by updatedAt desc (matches Node)
    pools.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(pools)
}

pub fn get_proxy_pool(conn: &Connection, id: &str) -> anyhow::Result<Option<ProxyPool>> {
    let result = conn.query_row(
        &format!("SELECT {} FROM proxyPools WHERE id = ?", SELECT_COLS),
        [id],
        row_to_pool,
    );
    match result {
        Ok(p) => Ok(Some(p)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn create_proxy_pool(conn: &Connection, pool: &ProxyPool) -> anyhow::Result<()> {
    let data = serde_json::json!({
        "name": pool.name,
        "proxyUrl": pool.proxy_url,
        "noProxy": pool.no_proxy,
        "type": pool.pool_type,
        "strictProxy": pool.strict_proxy,
        "lastTestedAt": pool.last_tested_at,
        "lastError": pool.last_error,
    });
    let data_str = serde_json::to_string(&data)?;
    conn.execute(
        "INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           isActive=excluded.isActive, testStatus=excluded.testStatus,
           data=excluded.data, updatedAt=excluded.updatedAt",
        rusqlite::params![
            pool.id,
            if pool.is_active { 1 } else { 0 },
            pool.test_status,
            data_str,
            pool.created_at,
            pool.updated_at,
        ],
    )?;
    Ok(())
}

pub fn update_proxy_pool(conn: &Connection, pool: &ProxyPool) -> anyhow::Result<()> {
    let data = serde_json::json!({
        "name": pool.name,
        "proxyUrl": pool.proxy_url,
        "noProxy": pool.no_proxy,
        "type": pool.pool_type,
        "strictProxy": pool.strict_proxy,
        "lastTestedAt": pool.last_tested_at,
        "lastError": pool.last_error,
    });
    let data_str = serde_json::to_string(&data)?;
    conn.execute(
        "UPDATE proxyPools SET isActive=?, testStatus=?, data=?, updatedAt=? WHERE id=?",
        rusqlite::params![
            if pool.is_active { 1 } else { 0 },
            pool.test_status,
            data_str,
            pool.updated_at,
            pool.id,
        ],
    )?;
    Ok(())
}

pub fn delete_proxy_pool(conn: &Connection, id: &str) -> anyhow::Result<bool> {
    let changes = conn.execute("DELETE FROM proxyPools WHERE id = ?", [id])?;
    Ok(changes > 0)
}

/// Count connections referencing this pool via providerSpecificData.proxyPoolId in the data JSON.
pub fn count_connections_by_pool(conn: &Connection, pool_id: &str) -> anyhow::Result<i64> {
    // The data column in providerConnections stores JSON with proxyPoolId field.
    // Use LIKE for a quick scan since we can't use JSON functions portably.
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM providerConnections WHERE data LIKE ?",
        [format!("%\"proxyPoolId\":\"{}\"%", pool_id)],
        |row| row.get(0),
    ).unwrap_or(0);
    Ok(count)
}

/// Clear proxyPoolId references from connections when a pool is deleted.
pub fn clear_pool_references(conn: &Connection, pool_id: &str) -> anyhow::Result<()> {
    // Get all connections that reference this pool
    let mut stmt = conn.prepare(
        "SELECT id, data FROM providerConnections WHERE data LIKE ?"
    )?;
    let pattern = format!("%\"proxyPoolId\":\"{}\"%", pool_id);
    let rows: Vec<(String, String)> = stmt.query_map([&pattern], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?.filter_map(|r| r.ok()).collect();

    for (id, data_str) in rows {
        if let Ok(mut data) = serde_json::from_str::<serde_json::Value>(&data_str) {
            if let Some(obj) = data.as_object_mut() {
                if obj.remove("proxyPoolId").is_some() {
                    let new_data = serde_json::to_string(&data)?;
                    conn.execute(
                        "UPDATE providerConnections SET data=? WHERE id=?",
                        rusqlite::params![new_data, id],
                    )?;
                }
            }
        }
    }
    Ok(())
}
