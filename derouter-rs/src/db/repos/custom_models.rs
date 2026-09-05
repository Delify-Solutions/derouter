//! Custom models repo — ported from src/lib/db/repos/aliasRepo.js (customModels section).
//! Uses the `kv` table with scope="customModels".
//! Key=`${providerAlias}|${id}|${type}`, value=JSON model object.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

const SCOPE: &str = "customModels";

/// Custom model entry — stored as JSON in the kv value column.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomModel {
    #[serde(rename = "providerAlias")]
    pub provider_alias: String,
    pub id: String,
    #[serde(rename = "type")]
    pub model_type: String,
    pub name: Option<String>,
    pub caps: Option<serde_json::Value>,
}

fn custom_key(provider_alias: &str, id: &str, model_type: &str) -> String {
    format!("{}|{}|{}", provider_alias, id, model_type)
}

/// Get all custom models (all types).
pub fn get_custom_models(conn: &Connection) -> anyhow::Result<Vec<CustomModel>> {
    let mut stmt = conn.prepare("SELECT value FROM kv WHERE scope = ?")?;
    let rows = stmt.query_map([SCOPE], |row| {
        let v: String = row.get(0)?;
        Ok(v)
    })?;
    let mut models = Vec::new();
    for r in rows {
        let v = r?;
        if let Ok(m) = serde_json::from_str::<CustomModel>(&v) {
            models.push(m);
        }
    }
    Ok(models)
}

/// Check if a custom model exists for the given {provider_alias, id} pair (any type).
pub fn custom_model_exists(
    conn: &Connection,
    provider_alias: &str,
    id: &str,
) -> anyhow::Result<bool> {
    let prefix = format!("{}|{}|", provider_alias, id);
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM kv WHERE scope = ? AND key LIKE ?",
        rusqlite::params![SCOPE, format!("{}%", prefix)],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Add a custom model. Returns true if newly added, false if updated existing.
pub fn add_custom_model(
    conn: &Connection,
    provider_alias: &str,
    id: &str,
    model_type: &str,
    name: Option<&str>,
    caps: Option<&serde_json::Value>,
) -> anyhow::Result<bool> {
    let key = custom_key(provider_alias, id, model_type);

    // Check if already exists
    let existing: Option<String> = conn
        .query_row(
            "SELECT value FROM kv WHERE scope = ? AND key = ?",
            rusqlite::params![SCOPE, key],
            |row| row.get(0),
        )
        .ok();

    if let Some(existing_str) = existing {
        // Update existing — merge name and caps
        let mut prev: serde_json::Value =
            serde_json::from_str(&existing_str).unwrap_or(serde_json::json!({}));
        if let Some(n) = name {
            if let Some(obj) = prev.as_object_mut() {
                obj.insert("name".to_string(), serde_json::json!(n));
            }
        }
        if let Some(c) = caps {
            if let Some(obj) = prev.as_object_mut() {
                obj.insert("caps".to_string(), c.clone());
            }
        }
        let new_val = serde_json::to_string(&prev)?;
        conn.execute(
            "UPDATE kv SET value = ? WHERE scope = ? AND key = ?",
            rusqlite::params![new_val, SCOPE, key],
        )?;
        Ok(false)
    } else {
        let mut val = serde_json::json!({
            "providerAlias": provider_alias,
            "id": id,
            "type": model_type,
            "name": name.unwrap_or(id),
        });
        if let Some(c) = caps {
            if let Some(obj) = val.as_object_mut() {
                obj.insert("caps".to_string(), c.clone());
            }
        }
        let val_str = serde_json::to_string(&val)?;
        conn.execute(
            "INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)",
            rusqlite::params![SCOPE, key, val_str],
        )?;
        Ok(true)
    }
}

/// Delete a custom model.
pub fn delete_custom_model(
    conn: &Connection,
    provider_alias: &str,
    id: &str,
    model_type: &str,
) -> anyhow::Result<()> {
    let key = custom_key(provider_alias, id, model_type);
    conn.execute(
        "DELETE FROM kv WHERE scope = ? AND key = ?",
        rusqlite::params![SCOPE, key],
    )?;
    Ok(())
}
