//! Disabled models repo — ported from src/lib/db/repos/disabledModelsRepo.js.
//! Uses the `kv` table with scope="disabledModels".
//! Key=providerAlias, value=JSON array of disabled model IDs.

use rusqlite::Connection;
use std::collections::HashMap;

const SCOPE: &str = "disabledModels";

/// Get all disabled models as a HashMap<providerAlias, Vec<model_id>>.
pub fn get_disabled_models(conn: &Connection) -> anyhow::Result<HashMap<String, Vec<String>>> {
    let mut stmt = conn.prepare("SELECT key, value FROM kv WHERE scope = ?")?;
    let rows = stmt.query_map([SCOPE], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut map = HashMap::new();
    for r in rows {
        let (k, v) = r?;
        let list: Vec<String> = serde_json::from_str(&v).unwrap_or_default();
        map.insert(k, list);
    }
    Ok(map)
}

/// Get disabled models for a specific provider.
pub fn get_disabled_by_provider(conn: &Connection, provider_alias: &str) -> anyhow::Result<Vec<String>> {
    let result = conn.query_row(
        "SELECT value FROM kv WHERE scope = ? AND key = ?",
        rusqlite::params![SCOPE, provider_alias],
        |row| row.get::<_, String>(0),
    );
    match result {
        Ok(v) => {
            let list: Vec<String> = serde_json::from_str(&v).unwrap_or_default();
            Ok(list)
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

/// Add disabled model IDs for a provider (merge with existing).
pub fn disable_models(conn: &Connection, provider_alias: &str, ids: &[String]) -> anyhow::Result<()> {
    if provider_alias.is_empty() || ids.is_empty() {
        return Ok(());
    }

    // Read current
    let current = get_disabled_by_provider(conn, provider_alias).unwrap_or_default();

    // Merge (dedup)
    let mut merged: Vec<String> = current;
    for id in ids {
        if !merged.contains(id) {
            merged.push(id.clone());
        }
    }

    let val_str = serde_json::to_string(&merged)?;
    conn.execute(
        "INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
        rusqlite::params![SCOPE, provider_alias, val_str],
    )?;
    Ok(())
}

/// Enable (remove) disabled model IDs for a provider.
/// If ids is empty, removes the entire entry for that provider.
pub fn enable_models(conn: &Connection, provider_alias: &str, ids: &[String]) -> anyhow::Result<()> {
    if provider_alias.is_empty() {
        return Ok(());
    }

    if ids.is_empty() {
        // Remove the entire entry
        conn.execute(
            "DELETE FROM kv WHERE scope = ? AND key = ?",
            rusqlite::params![SCOPE, provider_alias],
        )?;
        return Ok(());
    }

    // Read current, filter out the ids to enable
    let current = get_disabled_by_provider(conn, provider_alias).unwrap_or_default();
    let remove_set: std::collections::HashSet<&String> = ids.iter().collect();
    let next: Vec<String> = current.into_iter().filter(|id| !remove_set.contains(id)).collect();

    if next.is_empty() {
        conn.execute(
            "DELETE FROM kv WHERE scope = ? AND key = ?",
            rusqlite::params![SCOPE, provider_alias],
        )?;
    } else {
        let val_str = serde_json::to_string(&next)?;
        conn.execute(
            "INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
             ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
            rusqlite::params![SCOPE, provider_alias, val_str],
        )?;
    }
    Ok(())
}
