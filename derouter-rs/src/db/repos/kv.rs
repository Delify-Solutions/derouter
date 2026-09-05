//! KV repo — port of aliasRepo.js kv scopes. Phase 1.

use rusqlite::Connection;
use serde_json::Value;

/// Get a value from a kv scope
pub fn kv_get(conn: &Connection, scope: &str, key: &str) -> anyhow::Result<Option<Value>> {
    let result = conn.query_row(
        "SELECT value FROM kv WHERE scope = ? AND key = ?",
        [scope, key],
        |row| row.get::<_, String>(0),
    );
    match result {
        Ok(s) => Ok(serde_json::from_str(&s).ok()),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Get all key-value pairs from a kv scope
pub fn kv_get_all(conn: &Connection, scope: &str) -> anyhow::Result<serde_json::Map<String, Value>> {
    let mut stmt = conn.prepare("SELECT key, value FROM kv WHERE scope = ?")?;
    let rows = stmt.query_map([scope], |row| {
        let key: String = row.get(0)?;
        let value: String = row.get(1)?;
        Ok((key, value))
    })?;
    let mut map = serde_json::Map::new();
    for r in rows {
        let (key, value_str) = r?;
        let value: Value = serde_json::from_str(&value_str).unwrap_or(Value::Null);
        map.insert(key, value);
    }
    Ok(map)
}

/// Set a value in a kv scope
pub fn kv_set(conn: &Connection, scope: &str, key: &str, value: &Value) -> anyhow::Result<()> {
    let value_str = serde_json::to_string(value)?;
    conn.execute(
        "INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
        rusqlite::params![scope, key, value_str],
    )?;
    Ok(())
}

/// Delete a value from a kv scope
pub fn kv_delete(conn: &Connection, scope: &str, key: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM kv WHERE scope = ? AND key = ?", [scope, key])?;
    Ok(())
}

// Convenience scope helpers

pub fn get_model_aliases(conn: &Connection) -> anyhow::Result<Value> {
    Ok(Value::Object(kv_get_all(conn, "modelAliases")?))
}

pub fn set_model_alias(conn: &Connection, alias: &str, model: &str) -> anyhow::Result<()> {
    kv_set(conn, "modelAliases", alias, &Value::String(model.to_string()))
}

pub fn get_custom_models(conn: &Connection) -> anyhow::Result<Vec<Value>> {
    let all = kv_get_all(conn, "customModels")?;
    Ok(all.into_values().collect())
}
