//! Connections repo — port of connectionsRepo.js. Phase 1.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderConnection {
    pub id: String,
    pub provider: String,
    pub auth_type: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub priority: Option<i64>,
    pub is_active: bool,
    pub data: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

pub fn get_provider_connections(conn: &Connection, filter: &ConnectionFilter) -> anyhow::Result<Vec<ProviderConnection>> {
    let mut sql = String::from("SELECT id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt FROM providerConnections");
    let mut conditions = Vec::new();
    let mut params: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(ref provider) = filter.provider {
        conditions.push("provider = ?");
        params.push(provider.clone().into());
    }
    if let Some(is_active) = filter.is_active {
        conditions.push("isActive = ?");
        params.push((if is_active { 1 } else { 0 }).into());
    }
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }
    sql.push_str(" ORDER BY COALESCE(priority, 999) ASC");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        let data_str: String = row.get(7)?;
        let data: serde_json::Value = serde_json::from_str(&data_str).unwrap_or(serde_json::json!({}));
        Ok(ProviderConnection {
            id: row.get(0)?,
            provider: row.get(1)?,
            auth_type: row.get(2)?,
            name: row.get(3)?,
            email: row.get(4)?,
            priority: row.get(5)?,
            is_active: row.get::<_, i64>(6)? != 0,
            data,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    let mut conns = Vec::new();
    for r in rows {
        conns.push(r?);
    }
    Ok(conns)
}

#[derive(Default, Clone)]
pub struct ConnectionFilter {
    pub provider: Option<String>,
    pub is_active: Option<bool>,
}

pub fn get_provider_connection_by_id(conn: &Connection, id: &str) -> anyhow::Result<Option<ProviderConnection>> {
    let result = conn.query_row(
        "SELECT id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt FROM providerConnections WHERE id = ?",
        [id],
        |row| {
            let data_str: String = row.get(7)?;
            let data: serde_json::Value = serde_json::from_str(&data_str).unwrap_or(serde_json::json!({}));
            Ok(ProviderConnection {
                id: row.get(0)?,
                provider: row.get(1)?,
                auth_type: row.get(2)?,
                name: row.get(3)?,
                email: row.get(4)?,
                priority: row.get(5)?,
                is_active: row.get::<_, i64>(6)? != 0,
                data,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    );
    match result {
        Ok(c) => Ok(Some(c)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn create_provider_connection(conn: &Connection, c: &ProviderConnection) -> anyhow::Result<()> {
    let data_str = serde_json::to_string(&c.data)?;
    conn.execute(
        "INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, authType=excluded.authType, name=excluded.name, email=excluded.email, priority=excluded.priority, isActive=excluded.isActive, data=excluded.data, updatedAt=excluded.updatedAt",
        rusqlite::params![
            c.id, c.provider, c.auth_type, c.name, c.email, c.priority,
            if c.is_active { 1 } else { 0 }, data_str, c.created_at, c.updated_at,
        ],
    )?;
    Ok(())
}

pub fn update_provider_connection(conn: &Connection, c: &ProviderConnection) -> anyhow::Result<()> {
    let data_str = serde_json::to_string(&c.data)?;
    conn.execute(
        "UPDATE providerConnections SET provider=?, authType=?, name=?, email=?, priority=?, isActive=?, data=?, updatedAt=? WHERE id=?",
        rusqlite::params![
            c.provider, c.auth_type, c.name, c.email, c.priority,
            if c.is_active { 1 } else { 0 }, data_str, c.updated_at, c.id,
        ],
    )?;
    Ok(())
}

pub fn delete_provider_connection(conn: &Connection, id: &str) -> anyhow::Result<bool> {
    let changes = conn.execute("DELETE FROM providerConnections WHERE id = ?", [id])?;
    Ok(changes > 0)
}
