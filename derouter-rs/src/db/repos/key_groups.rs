//! Key groups repo — port of keyGroupsRepo.js. Phase 1.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeyGroup {
    pub id: String,
    pub name: String,
    pub is_active: bool,
    pub rpm: Option<i64>,
    pub tpm: Option<i64>,
    pub budget_usd: Option<f64>,
    pub reset_window: Option<String>,
    pub allowed_models: Option<String>,
    pub price_overrides: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn get_key_groups(conn: &Connection) -> anyhow::Result<Vec<KeyGroup>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, isActive, rpm, tpm, budgetUsd, resetWindow, allowedModels, priceOverrides, createdAt, updatedAt
         FROM keyGroups ORDER BY createdAt DESC"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(KeyGroup {
            id: row.get(0)?,
            name: row.get(1)?,
            is_active: row.get::<_, i64>(2)? != 0,
            rpm: row.get(3)?,
            tpm: row.get(4)?,
            budget_usd: row.get(5)?,
            reset_window: row.get(6)?,
            allowed_models: row.get(7)?,
            price_overrides: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    })?;
    let mut groups = Vec::new();
    for r in rows {
        groups.push(r?);
    }
    Ok(groups)
}

pub fn get_key_group_by_id(conn: &Connection, id: &str) -> anyhow::Result<Option<KeyGroup>> {
    let result = conn.query_row(
        "SELECT id, name, isActive, rpm, tpm, budgetUsd, resetWindow, allowedModels, priceOverrides, createdAt, updatedAt
         FROM keyGroups WHERE id = ?",
        [id],
        |row| {
            Ok(KeyGroup {
                id: row.get(0)?,
                name: row.get(1)?,
                is_active: row.get::<_, i64>(2)? != 0,
                rpm: row.get(3)?,
                tpm: row.get(4)?,
                budget_usd: row.get(5)?,
                reset_window: row.get(6)?,
                allowed_models: row.get(7)?,
                price_overrides: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        },
    );
    match result {
        Ok(g) => Ok(Some(g)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn get_key_group_by_name(conn: &Connection, name: &str) -> anyhow::Result<Option<KeyGroup>> {
    let result = conn.query_row(
        "SELECT id, name, isActive, rpm, tpm, budgetUsd, resetWindow, allowedModels, priceOverrides, createdAt, updatedAt
         FROM keyGroups WHERE name = ?",
        [name],
        |row| {
            Ok(KeyGroup {
                id: row.get(0)?,
                name: row.get(1)?,
                is_active: row.get::<_, i64>(2)? != 0,
                rpm: row.get(3)?,
                tpm: row.get(4)?,
                budget_usd: row.get(5)?,
                reset_window: row.get(6)?,
                allowed_models: row.get(7)?,
                price_overrides: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        },
    );
    match result {
        Ok(g) => Ok(Some(g)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn create_key_group(conn: &Connection, group: &KeyGroup) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO keyGroups(id, name, isActive, rpm, tpm, budgetUsd, resetWindow, allowedModels, priceOverrides, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            group.id, group.name, if group.is_active { 1 } else { 0 },
            group.rpm, group.tpm, group.budget_usd, group.reset_window,
            group.allowed_models, group.price_overrides,
            group.created_at, group.updated_at,
        ],
    )?;
    Ok(())
}

pub fn update_key_group(conn: &Connection, group: &KeyGroup) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE keyGroups SET name=?, isActive=?, rpm=?, tpm=?, budgetUsd=?, resetWindow=?, allowedModels=?, priceOverrides=?, updatedAt=? WHERE id=?",
        rusqlite::params![
            group.name, if group.is_active { 1 } else { 0 },
            group.rpm, group.tpm, group.budget_usd, group.reset_window,
            group.allowed_models, group.price_overrides,
            group.updated_at, group.id,
        ],
    )?;
    Ok(())
}

pub fn delete_key_group(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM keyGroups WHERE id = ?", [id])?;
    Ok(())
}
