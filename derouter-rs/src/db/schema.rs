//! SQLite schema definitions — ported 1:1 from src/lib/db/schema.js
//! Same table names, column names, types, CHECK constraints, and indexes.

/// Column definition: (name, SQL type+constraints)
pub type ColumnDef = (&'static str, &'static str);

/// Table definition
pub struct TableDef {
    pub columns: &'static [ColumnDef],
    pub primary_key: Option<&'static str>,
    pub indexes: &'static [&'static str],
}

pub const PRAGMA_SQL: &[&str] = &[
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA temp_store = MEMORY",
    "PRAGMA mmap_size = 30000000",
    "PRAGMA cache_size = -64000",
    "PRAGMA foreign_keys = ON",
    "PRAGMA busy_timeout = 5000",
];

pub const SCHEMA_VERSION: u32 = 2;

pub fn tables() -> Vec<(&'static str, TableDef)> {
    vec![
        ("_meta", TableDef {
            columns: &[
                ("key", "TEXT PRIMARY KEY"),
                ("value", "TEXT NOT NULL"),
            ],
            primary_key: None,
            indexes: &[],
        }),
        ("settings", TableDef {
            columns: &[
                ("id", "INTEGER PRIMARY KEY CHECK (id = 1)"),
                ("data", "TEXT NOT NULL"),
            ],
            primary_key: None,
            indexes: &[],
        }),
        ("providerConnections", TableDef {
            columns: &[
                ("id", "TEXT PRIMARY KEY"),
                ("provider", "TEXT NOT NULL"),
                ("authType", "TEXT NOT NULL"),
                ("name", "TEXT"),
                ("email", "TEXT"),
                ("priority", "INTEGER"),
                ("isActive", "INTEGER DEFAULT 1"),
                ("data", "TEXT NOT NULL"),
                ("createdAt", "TEXT NOT NULL"),
                ("updatedAt", "TEXT NOT NULL"),
            ],
            primary_key: None,
            indexes: &[
                "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
                "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
                "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(priority)",
            ],
        }),
        ("providerNodes", TableDef {
            columns: &[
                ("id", "TEXT PRIMARY KEY"),
                ("type", "TEXT"),
                ("name", "TEXT"),
                ("data", "TEXT NOT NULL"),
                ("createdAt", "TEXT NOT NULL"),
                ("updatedAt", "TEXT NOT NULL"),
            ],
            primary_key: None,
            indexes: &[
                "CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)",
            ],
        }),
        ("proxyPools", TableDef {
            columns: &[
                ("id", "TEXT PRIMARY KEY"),
                ("isActive", "INTEGER DEFAULT 1"),
                ("testStatus", "TEXT"),
                ("data", "TEXT NOT NULL"),
                ("createdAt", "TEXT NOT NULL"),
                ("updatedAt", "TEXT NOT NULL"),
            ],
            primary_key: None,
            indexes: &[
                "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
                "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
            ],
        }),
        ("apiKeys", TableDef {
            columns: &[
                ("id", "TEXT PRIMARY KEY"),
                ("key", "TEXT UNIQUE NOT NULL"),
                ("name", "TEXT"),
                ("machineId", "TEXT"),
                ("isActive", "INTEGER DEFAULT 1"),
                ("createdAt", "TEXT NOT NULL"),
                ("groupId", "TEXT"),
                ("rpm", "INTEGER"),
                ("tpm", "INTEGER"),
                ("budgetUsd", "REAL"),
                ("resetWindow", "TEXT"),
                ("expiresAt", "TEXT"),
                ("allowedModels", "TEXT"),
                ("windowStartedAt", "TEXT"),
                ("windowCostUsd", "REAL DEFAULT 0"),
                ("updatedAt", "TEXT"),
            ],
            primary_key: None,
            indexes: &[
                "CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)",
                "CREATE INDEX IF NOT EXISTS idx_ak_group ON apiKeys(groupId)",
            ],
        }),
        ("keyGroups", TableDef {
            columns: &[
                ("id", "TEXT PRIMARY KEY"),
                ("name", "TEXT UNIQUE NOT NULL"),
                ("isActive", "INTEGER DEFAULT 1"),
                ("rpm", "INTEGER"),
                ("tpm", "INTEGER"),
                ("budgetUsd", "REAL"),
                ("resetWindow", "TEXT"),
                ("allowedModels", "TEXT"),
                ("priceOverrides", "TEXT"),
                ("createdAt", "TEXT NOT NULL"),
                ("updatedAt", "TEXT NOT NULL"),
            ],
            primary_key: None,
            indexes: &[
                "CREATE INDEX IF NOT EXISTS idx_kg_name ON keyGroups(name)",
            ],
        }),
        ("combos", TableDef {
            columns: &[
                ("id", "TEXT PRIMARY KEY"),
                ("name", "TEXT UNIQUE NOT NULL"),
                ("kind", "TEXT"),
                ("models", "TEXT NOT NULL"),
                ("createdAt", "TEXT NOT NULL"),
                ("updatedAt", "TEXT NOT NULL"),
            ],
            primary_key: None,
            indexes: &[
                "CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)",
            ],
        }),
        ("kv", TableDef {
            columns: &[
                ("scope", "TEXT NOT NULL"),
                ("key", "TEXT NOT NULL"),
                ("value", "TEXT NOT NULL"),
            ],
            primary_key: Some("PRIMARY KEY (scope, key)"),
            indexes: &[
                "CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)",
            ],
        }),
        ("usageHistory", TableDef {
            columns: &[
                ("id", "INTEGER PRIMARY KEY AUTOINCREMENT"),
                ("timestamp", "TEXT NOT NULL"),
                ("provider", "TEXT"),
                ("model", "TEXT"),
                ("connectionId", "TEXT"),
                ("apiKey", "TEXT"),
                ("endpoint", "TEXT"),
                ("promptTokens", "INTEGER DEFAULT 0"),
                ("completionTokens", "INTEGER DEFAULT 0"),
                ("cost", "REAL DEFAULT 0"),
                ("status", "TEXT"),
                ("tokens", "TEXT"),
                ("meta", "TEXT"),
            ],
            primary_key: None,
            indexes: &[
                "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
                "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
                "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
                "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
                "CREATE INDEX IF NOT EXISTS idx_uh_apikey_ts ON usageHistory(apiKey, timestamp DESC)",
            ],
        }),
        ("usageDaily", TableDef {
            columns: &[
                ("dateKey", "TEXT PRIMARY KEY"),
                ("data", "TEXT NOT NULL"),
            ],
            primary_key: None,
            indexes: &[],
        }),
        ("requestDetails", TableDef {
            columns: &[
                ("id", "TEXT PRIMARY KEY"),
                ("timestamp", "TEXT NOT NULL"),
                ("provider", "TEXT"),
                ("model", "TEXT"),
                ("connectionId", "TEXT"),
                ("apiKey", "TEXT"),
                ("status", "TEXT"),
                ("data", "TEXT NOT NULL"),
            ],
            primary_key: None,
            indexes: &[
                "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
                "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
                "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
                "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
                "CREATE INDEX IF NOT EXISTS idx_rd_apikey_ts ON requestDetails(apiKey, timestamp DESC)",
            ],
        }),
    ]
}

/// Build a CREATE TABLE IF NOT EXISTS statement from a TableDef
pub fn build_create_table_sql(name: &str, def: &TableDef) -> String {
    let mut cols: Vec<String> = def.columns.iter().map(|(k, v)| format!("{} {}", k, v)).collect();
    if let Some(pk) = def.primary_key {
        cols.push(pk.to_string());
    }
    format!("CREATE TABLE IF NOT EXISTS {} ({})", name, cols.join(", "))
}
