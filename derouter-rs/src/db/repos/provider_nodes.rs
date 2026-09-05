//! Provider nodes repo — ported from src/lib/db/repos/nodesRepo.js.
//! providerNodes table: id, type, name, data (JSON), createdAt, updatedAt.
//! The `data` column stores prefix, apiType, baseUrl, and other fields.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Provider node — merged from data JSON + top-level columns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: Option<String>,
    pub name: Option<String>,
    // From data JSON:
    pub prefix: Option<String>,
    #[serde(rename = "apiType")]
    pub api_type: Option<String>,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Default, Clone)]
pub struct ProviderNodeFilter {
    pub node_type: Option<String>,
}

fn row_to_node(row: &rusqlite::Row) -> rusqlite::Result<ProviderNode> {
    let id: String = row.get(0)?;
    let node_type: Option<String> = row.get(1)?;
    let name: Option<String> = row.get(2)?;
    let data_str: String = row.get(3)?;
    let created_at: String = row.get(4)?;
    let updated_at: String = row.get(5)?;

    let data: serde_json::Value = serde_json::from_str(&data_str).unwrap_or(serde_json::json!({}));

    Ok(ProviderNode {
        id,
        node_type,
        name,
        prefix: data.get("prefix").and_then(|v| v.as_str()).map(|s| s.to_string()),
        api_type: data.get("apiType").and_then(|v| v.as_str()).map(|s| s.to_string()),
        base_url: data.get("baseUrl").and_then(|v| v.as_str()).map(|s| s.to_string()),
        created_at,
        updated_at,
    })
}

const SELECT_COLS: &str = "id, type, name, data, createdAt, updatedAt";

pub fn get_provider_nodes(conn: &Connection, filter: &ProviderNodeFilter) -> anyhow::Result<Vec<ProviderNode>> {
    let mut sql = format!("SELECT {} FROM providerNodes", SELECT_COLS);
    let mut conditions = Vec::new();
    let mut params: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(ref nt) = filter.node_type {
        conditions.push("type = ?");
        params.push(nt.clone().into());
    }

    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), row_to_node)?;
    let mut nodes = Vec::new();
    for r in rows {
        nodes.push(r?);
    }
    Ok(nodes)
}

pub fn get_provider_node(conn: &Connection, id: &str) -> anyhow::Result<Option<ProviderNode>> {
    let result = conn.query_row(
        &format!("SELECT {} FROM providerNodes WHERE id = ?", SELECT_COLS),
        [id],
        row_to_node,
    );
    match result {
        Ok(n) => Ok(Some(n)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn create_provider_node(conn: &Connection, node: &ProviderNode) -> anyhow::Result<()> {
    let data = serde_json::json!({
        "prefix": node.prefix,
        "apiType": node.api_type,
        "baseUrl": node.base_url,
    });
    let data_str = serde_json::to_string(&data)?;
    conn.execute(
        "INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt",
        rusqlite::params![
            node.id,
            node.node_type,
            node.name,
            data_str,
            node.created_at,
            node.updated_at,
        ],
    )?;
    Ok(())
}

pub fn update_provider_node(conn: &Connection, node: &ProviderNode) -> anyhow::Result<()> {
    let data = serde_json::json!({
        "prefix": node.prefix,
        "apiType": node.api_type,
        "baseUrl": node.base_url,
    });
    let data_str = serde_json::to_string(&data)?;
    conn.execute(
        "UPDATE providerNodes SET type=?, name=?, data=?, updatedAt=? WHERE id=?",
        rusqlite::params![
            node.node_type,
            node.name,
            data_str,
            node.updated_at,
            node.id,
        ],
    )?;
    Ok(())
}

pub fn delete_provider_node(conn: &Connection, id: &str) -> anyhow::Result<bool> {
    let changes = conn.execute("DELETE FROM providerNodes WHERE id = ?", [id])?;
    Ok(changes > 0)
}
