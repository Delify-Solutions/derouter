//! API keys repo — port of apiKeysRepo.js. Phase 1.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ApiKey {
    pub id: String,
    pub key: String,
    pub name: Option<String>,
    pub machine_id: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub group_id: Option<String>,
    pub rpm: Option<i64>,
    pub tpm: Option<i64>,
    pub budget_usd: Option<f64>,
    pub reset_window: Option<String>,
    pub expires_at: Option<String>,
    pub allowed_models: Option<String>,
    pub window_started_at: Option<String>,
    pub window_cost_usd: f64,
    pub updated_at: Option<String>,
}

/// Auth info merged from key + group — port of getApiKeyForAuth return shape
#[derive(Debug, Clone, Default)]
pub struct ApiKeyForAuth {
    pub id: String,
    pub key: String,
    pub name: Option<String>,
    pub is_active: bool,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub rpm: Option<i64>,
    pub tpm: Option<i64>,
    pub budget_usd: Option<f64>,
    pub reset_window: Option<String>,
    pub expires_at: Option<String>,
    pub allowed_models: Option<Vec<String>>,
    pub window_started_at: Option<String>,
    pub window_cost_usd: f64,
}

pub fn get_api_key_by_key(conn: &Connection, key: &str) -> anyhow::Result<Option<ApiKey>> {
    let mut stmt = conn.prepare(
        "SELECT id, key, name, machineId, isActive, createdAt, groupId, rpm, tpm, budgetUsd, resetWindow, expiresAt, allowedModels, windowStartedAt, windowCostUsd, updatedAt
         FROM apiKeys WHERE key = ?"
    )?;
    let result = stmt.query_row([key], |row| {
        Ok(ApiKey {
            id: row.get(0)?,
            key: row.get(1)?,
            name: row.get(2)?,
            machine_id: row.get(3)?,
            is_active: row.get::<_, i64>(4)? != 0,
            created_at: row.get(5)?,
            group_id: row.get(6)?,
            rpm: row.get(7)?,
            tpm: row.get(8)?,
            budget_usd: row.get(9)?,
            reset_window: row.get(10)?,
            expires_at: row.get(11)?,
            allowed_models: row.get(12)?,
            window_started_at: row.get(13)?,
            window_cost_usd: row.get(14).unwrap_or(0.0),
            updated_at: row.get(15)?,
        })
    });
    match result {
        Ok(key) => Ok(Some(key)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Port of getApiKeyForAuth: merge key limits with group defaults
pub fn get_api_key_for_auth(conn: &Connection, key: &str) -> anyhow::Result<Option<ApiKeyForAuth>> {
    let api_key = match get_api_key_by_key(conn, key)? {
        Some(k) => k,
        None => return Ok(None),
    };

    if !api_key.is_active {
        return Ok(Some(ApiKeyForAuth {
            id: api_key.id,
            key: api_key.key,
            name: api_key.name,
            is_active: false,
            ..Default::default()
        }));
    }

    // Merge with group defaults
    let group = if let Some(ref gid) = api_key.group_id {
        super::key_groups::get_key_group_by_id(conn, gid)?
    } else {
        None
    };

    let rpm = api_key.rpm.or_else(|| group.as_ref().and_then(|g| g.rpm));
    let tpm = api_key.tpm.or_else(|| group.as_ref().and_then(|g| g.tpm));
    let budget_usd = api_key.budget_usd.or_else(|| group.as_ref().and_then(|g| g.budget_usd));
    let reset_window = api_key.reset_window.clone().or_else(|| group.as_ref().and_then(|g| g.reset_window.clone()));
    let allowed_models_str = api_key.allowed_models.clone().or_else(|| group.as_ref().and_then(|g| g.allowed_models.clone()));
    let allowed_models = allowed_models_str
        .as_deref()
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok());

    Ok(Some(ApiKeyForAuth {
        id: api_key.id,
        key: api_key.key,
        name: api_key.name,
        is_active: true,
        group_id: api_key.group_id,
        group_name: group.as_ref().map(|g| g.name.clone()),
        rpm,
        tpm,
        budget_usd,
        reset_window,
        expires_at: api_key.expires_at,
        allowed_models,
        window_started_at: api_key.window_started_at,
        window_cost_usd: api_key.window_cost_usd,
    }))
}

pub fn get_api_keys(conn: &Connection) -> anyhow::Result<Vec<ApiKey>> {
    let mut stmt = conn.prepare(
        "SELECT id, key, name, machineId, isActive, createdAt, groupId, rpm, tpm, budgetUsd, resetWindow, expiresAt, allowedModels, windowStartedAt, windowCostUsd, updatedAt
         FROM apiKeys ORDER BY createdAt DESC"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ApiKey {
            id: row.get(0)?,
            key: row.get(1)?,
            name: row.get(2)?,
            machine_id: row.get(3)?,
            is_active: row.get::<_, i64>(4)? != 0,
            created_at: row.get(5)?,
            group_id: row.get(6)?,
            rpm: row.get(7)?,
            tpm: row.get(8)?,
            budget_usd: row.get(9)?,
            reset_window: row.get(10)?,
            expires_at: row.get(11)?,
            allowed_models: row.get(12)?,
            window_started_at: row.get(13)?,
            window_cost_usd: row.get(14).unwrap_or(0.0),
            updated_at: row.get(15)?,
        })
    })?;
    let mut keys = Vec::new();
    for r in rows {
        keys.push(r?);
    }
    Ok(keys)
}

pub fn create_api_key(conn: &Connection, key: &ApiKey) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, groupId, rpm, tpm, budgetUsd, resetWindow, expiresAt, allowedModels, windowStartedAt, windowCostUsd, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            key.id, key.key, key.name, key.machine_id,
            if key.is_active { 1 } else { 0 },
            key.created_at, key.group_id, key.rpm, key.tpm, key.budget_usd,
            key.reset_window, key.expires_at, key.allowed_models,
            key.window_started_at, key.window_cost_usd, key.updated_at,
        ],
    )?;
    Ok(())
}

pub fn update_api_key(conn: &Connection, key: &ApiKey) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE apiKeys SET name=?, machineId=?, isActive=?, groupId=?, rpm=?, tpm=?, budgetUsd=?, resetWindow=?, expiresAt=?, allowedModels=?, windowStartedAt=?, windowCostUsd=?, updatedAt=? WHERE id=?",
        rusqlite::params![
            key.name, key.machine_id, if key.is_active { 1 } else { 0 },
            key.group_id, key.rpm, key.tpm, key.budget_usd,
            key.reset_window, key.expires_at, key.allowed_models,
            key.window_started_at, key.window_cost_usd, key.updated_at,
            key.id,
        ],
    )?;
    Ok(())
}

pub fn delete_api_key(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM apiKeys WHERE id = ?", [id])?;
    Ok(())
}

pub fn reset_key_window(conn: &Connection, id: &str, started_at: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE apiKeys SET windowStartedAt = ?, windowCostUsd = 0 WHERE id = ?",
        rusqlite::params![started_at, id],
    )?;
    Ok(())
}

pub fn set_key_window_cost(conn: &Connection, id: &str, cost: f64) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE apiKeys SET windowCostUsd = ? WHERE id = ?",
        rusqlite::params![cost, id],
    )?;
    Ok(())
}

/// Generate a new sk- style API key
pub fn generate_key_string() -> String {
    format!("sk-derouter-{}", uuid::Uuid::new_v4().simple())
}

/// Key masking: >=10 chars → sk-…**** + last 4, else ****
pub fn mask_key(key: &str) -> String {
    if key.len() >= 10 {
        let prefix = &key[..6];
        let suffix = &key[key.len()-4..];
        format!("{}…****{}", prefix, suffix)
    } else {
        "****".to_string()
    }
}
