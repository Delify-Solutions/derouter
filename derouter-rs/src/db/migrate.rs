//! Auto-migration — ports syncSchemaFromTables from migrate.js
//! CREATE TABLE IF NOT EXISTS from schema.rs, then PRAGMA table_info
//! → ALTER TABLE ADD COLUMN for any missing columns.

use rusqlite::Connection;
use tracing::{info, warn};

use super::schema::{self, TableDef};

/// Run the full additive auto-migration: create missing tables, add missing
/// columns, recreate missing indexes. Idempotent.
pub fn run_migrations(conn: &Connection) -> anyhow::Result<()> {
    // Bootstrap _meta table first
    let meta_def = TableDef {
        columns: &[
            ("key", "TEXT PRIMARY KEY"),
            ("value", "TEXT NOT NULL"),
        ],
        primary_key: None,
        indexes: &[],
    };
    conn.execute(&schema::build_create_table_sql("_meta", &meta_def), [])?;

    // For each declared table, create it if absent and sync columns
    for (table_name, def) in schema::tables() {
        // Create table if absent
        conn.execute(&schema::build_create_table_sql(table_name, &def), [])?;

        // Diff columns: get existing columns via PRAGMA table_info
        let existing_cols: Vec<String> = {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table_name))?;
            let col_iter = stmt.query_map([], |row| {
                let name: String = row.get(1)?;
                Ok(name)
            })?;
            let mut cols = Vec::new();
            for c in col_iter {
                cols.push(c?);
            }
            cols
        };
        let existing_set: std::collections::HashSet<&str> = existing_cols.iter().map(|s| s.as_str()).collect();

        for (col_name, col_def) in def.columns {
            if !existing_set.contains(*col_name) {
                // SQLite ADD COLUMN restrictions: strip PRIMARY KEY / UNIQUE
                // since those are only valid at create time
                let safe_def = strip_pk_unique(col_def);
                let sql = format!("ALTER TABLE {} ADD COLUMN {} {}", table_name, col_name, safe_def);
                match conn.execute(&sql, []) {
                    Ok(_) => info!("[DB][sync] +column {}.{}", table_name, col_name),
                    Err(e) => warn!("[DB][sync] add column {}.{} failed: {}", table_name, col_name, e),
                }
            }
        }

        // Indexes (idempotent — CREATE INDEX IF NOT EXISTS)
        for idx_sql in def.indexes {
            let _ = conn.execute(idx_sql, []);
        }
    }

    // Stamp schema version
    set_meta(conn, "backupSchemaVersion", &schema::SCHEMA_VERSION.to_string())?;

    Ok(())
}

/// Strip PRIMARY KEY / UNIQUE from a column def for ALTER TABLE ADD COLUMN
fn strip_pk_unique(def: &str) -> String {
    let mut s = String::from(def);
    // Remove "PRIMARY KEY" and optional "AUTOINCREMENT"
    if let Some(idx) = s.to_uppercase().find("PRIMARY KEY") {
        // Find the extent of "PRIMARY KEY AUTOINCREMENT" or just "PRIMARY KEY"
        let end = if s[idx..].to_uppercase().contains("AUTOINCREMENT") {
            idx + "PRIMARY KEY AUTOINCREMENT".len()
        } else {
            idx + "PRIMARY KEY".len()
        };
        s.replace_range(idx..end, "");
    }
    // Remove "UNIQUE"
    if let Some(idx) = s.to_uppercase().find("UNIQUE") {
        s.replace_range(idx..idx + "UNIQUE".len(), "");
    }
    s.trim().to_string()
}

pub fn get_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM _meta WHERE key = ?",
        [key],
        |row| row.get(0),
    )
    .ok()
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}
