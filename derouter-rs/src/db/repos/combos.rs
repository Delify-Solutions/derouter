//! Combos repo — port of combosRepo.js. Phase 1.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Combo {
    pub id: String,
    pub name: String,
    pub kind: Option<String>,
    pub models: Vec<String>,  // JSON array of "providerName/modelId" strings
    pub created_at: String,
    pub updated_at: String,
}

pub fn get_combos(conn: &Connection) -> anyhow::Result<Vec<Combo>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, kind, models, createdAt, updatedAt FROM combos ORDER BY createdAt DESC"
    )?;
    let rows = stmt.query_map([], |row| {
        let models_json: String = row.get(3)?;
        let models: Vec<String> = serde_json::from_str(&models_json).unwrap_or_default();
        Ok(Combo {
            id: row.get(0)?,
            name: row.get(1)?,
            kind: row.get(2)?,
            models,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    let mut combos = Vec::new();
    for r in rows {
        combos.push(r?);
    }
    Ok(combos)
}

pub fn get_combo_by_name(conn: &Connection, name: &str) -> anyhow::Result<Option<Combo>> {
    let result = conn.query_row(
        "SELECT id, name, kind, models, createdAt, updatedAt FROM combos WHERE name = ?",
        [name],
        |row| {
            let models_json: String = row.get(3)?;
            let models: Vec<String> = serde_json::from_str(&models_json).unwrap_or_default();
            Ok(Combo {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                models,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    );
    match result {
        Ok(c) => Ok(Some(c)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn create_combo(conn: &Connection, combo: &Combo) -> anyhow::Result<()> {
    let models_json = serde_json::to_string(&combo.models)?;
    conn.execute(
        "INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)",
        rusqlite::params![combo.id, combo.name, combo.kind, models_json, combo.created_at, combo.updated_at],
    )?;
    Ok(())
}

pub fn update_combo(conn: &Connection, combo: &Combo) -> anyhow::Result<()> {
    let models_json = serde_json::to_string(&combo.models)?;
    conn.execute(
        "UPDATE combos SET name=?, kind=?, models=?, updatedAt=? WHERE id=?",
        rusqlite::params![combo.name, combo.kind, models_json, combo.updated_at, combo.id],
    )?;
    Ok(())
}

pub fn delete_combo(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM combos WHERE id = ?", [id])?;
    Ok(())
}
