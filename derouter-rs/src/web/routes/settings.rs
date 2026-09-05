//! Settings management routes — JSON API.
//! Ported from src/app/api/settings/route.js.
//! GET /api/settings — strip secrets, add hasPassword/oidcConfigured flags.
//! PATCH /api/settings — merge updates, password change with currentPassword verify.

use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::db::DbPool;
use crate::db::repos::settings;
use crate::auth;

/// Secrets that must never be mass-assigned from request body (CWE-915).
const PROTECTED_SETTING_KEYS: &[&str] = &["password", "mitmSudoEncrypted"];

/// GET /api/settings — return settings with secrets stripped.
pub async fn list(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let s = settings::get_settings(&conn)?;
        Ok(s)
    })
    .await;

    match result {
        Ok(Ok(mut s)) => {
            // Compute derived flags from the ORIGINAL settings BEFORE stripping secrets.
            let has_password = s.get("password").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
            let oidc_configured = s.get("oidcIssuerUrl").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
                && s.get("oidcClientId").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
                && s.get("oidcClientSecret").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);

            // Strip secrets (password, oidcClientSecret, mitmSudoEncrypted)
            if let Some(obj) = s.as_object_mut() {
                obj.remove("password");
                obj.remove("oidcClientSecret");
                obj.remove("mitmSudoEncrypted");
            }

            // Add derived flags (computed from original values above)
            if let Some(obj) = s.as_object_mut() {
                obj.insert("hasPassword".to_string(), serde_json::json!(has_password));
                obj.insert("oidcConfigured".to_string(), serde_json::json!(oidc_configured));
            }

            // Add env-based flags
            let enable_request_logs = std::env::var("ENABLE_REQUEST_LOGS").map(|v| v == "true").unwrap_or(false);
            let enable_translator = std::env::var("ENABLE_TRANSLATOR").map(|v| v == "true").unwrap_or(false);

            // Re-acquire mutable reference
            if let Some(obj) = s.as_object_mut() {
                obj.insert("enableRequestLogs".to_string(), serde_json::json!(enable_request_logs));
                obj.insert("enableTranslator".to_string(), serde_json::json!(enable_translator));
            }

            (
                StatusCode::OK,
                [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
                Json(s),
            )
                .into_response()
        }
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to fetch settings"})),
        )
            .into_response(),
    }
}

/// PATCH /api/settings — update settings.
/// Password change: body.newPassword + body.currentPassword (verified against stored hash).
pub async fn update(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let mut body = body.0;

    // Strip protected secrets before any handling
    if let Some(obj) = body.as_object_mut() {
        for key in PROTECTED_SETTING_KEYS {
            obj.remove(*key);
        }
    }

    // Handle password change
    if let Some(new_password) = body.get("newPassword").and_then(|v| v.as_str()) {
        if !new_password.is_empty() {
            let pool_c = pool.clone();
            let settings_result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
                let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
                settings::get_settings(&conn)
            })
            .await;

            let current_settings = match settings_result {
                Ok(Ok(s)) => s,
                _ => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"error": "Failed to load settings"})),
                    )
                        .into_response();
                }
            };

            let current_hash = current_settings.get("password").and_then(|v| v.as_str()).map(|s| s.to_string());
            let current_password = body.get("currentPassword").and_then(|v| v.as_str()).unwrap_or("");

            // Verify current password if it exists
            if let Some(ref hash) = current_hash {
                if !hash.is_empty() {
                    if current_password.is_empty() {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({"error": "Current password required"})),
                        )
                            .into_response();
                    }
                    // Verify using argon2 (Rust uses argon2, not bcrypt — but Node stored bcrypt hashes)
                    // For Phase 1, we support verification via auth::verify_password
                    let is_valid = crate::auth::verify_password(current_password, hash);
                    if !is_valid {
                        // Try bcrypt-compatible verification as fallback
                        // (Node uses bcryptjs, Rust uses argon2 — cross-compat needed in Phase 3)
                        // For now, if argon2 fails, try bcrypt
                        let bcrypt_valid = bcrypt::verify(current_password, hash).unwrap_or(false);
                        if !bcrypt_valid {
                            return (
                                StatusCode::UNAUTHORIZED,
                                Json(serde_json::json!({"error": "Invalid current password"})),
                            )
                                .into_response();
                        }
                    }
                } else {
                    // First time setting password, no current password needed
                    if !current_password.is_empty() && current_password != "123456" {
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(serde_json::json!({"error": "Invalid current password"})),
                        )
                            .into_response();
                    }
                }
            } else {
                // No password set yet — first time
                if !current_password.is_empty() && current_password != "123456" {
                    return (
                        StatusCode::UNAUTHORIZED,
                        Json(serde_json::json!({"error": "Invalid current password"})),
                    )
                        .into_response();
                }
            }

            // Hash the new password
            let new_hash = match crate::auth::hash_password(new_password) {
                Ok(h) => h,
                Err(_) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"error": "Failed to hash password"})),
                    )
                        .into_response();
                }
            };

            // Set password in body, remove newPassword and currentPassword
            if let Some(obj) = body.as_object_mut() {
                obj.insert("password".to_string(), serde_json::json!(new_hash));
                obj.remove("newPassword");
                obj.remove("currentPassword");
            }
        }
    }

    // Handle oidcClientSecret — only set if non-empty
    if let Some(obj) = body.as_object_mut() {
        if let Some(secret) = obj.get("oidcClientSecret") {
            if let Some(s) = secret.as_str() {
                if s.trim().is_empty() {
                    obj.remove("oidcClientSecret");
                }
            } else if secret.is_null() {
                obj.remove("oidcClientSecret");
            }
        }
    }

    let pool_c = pool.clone();
    let body_c = body.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        settings::update_settings(&conn, &body_c)
    })
    .await;

    match result {
        Ok(Ok(mut updated)) => {
            // Compute derived flags from the ORIGINAL updated settings BEFORE stripping secrets.
            let has_password = updated.get("password").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
            let oidc_configured = updated.get("oidcIssuerUrl").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
                && updated.get("oidcClientId").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
                && updated.get("oidcClientSecret").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);

            // Strip secrets from response (password, oidcClientSecret, mitmSudoEncrypted)
            if let Some(obj) = updated.as_object_mut() {
                obj.remove("password");
                obj.remove("oidcClientSecret");
                obj.remove("mitmSudoEncrypted");
            }

            // Add derived flags (computed from original values above)
            if let Some(obj) = updated.as_object_mut() {
                obj.insert("hasPassword".to_string(), serde_json::json!(has_password));
                obj.insert("oidcConfigured".to_string(), serde_json::json!(oidc_configured));
            }

            (
                [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
                Json(updated),
            )
                .into_response()
        }
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Failed to update settings"})),
        )
            .into_response(),
    }
}

// ===== Phase 2 sub-routes =====

/// GET /api/settings/database — export entire database as JSON.
pub async fn database_export(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;

        // Export key tables
        let mut export = serde_json::Map::new();

        // Settings
        let settings = settings::get_settings(&conn).unwrap_or(serde_json::json!({}));
        export.insert("settings".to_string(), settings);

        // Helper: query a table's data column as JSON array
        fn export_data_col(conn: &rusqlite::Connection, table: &str) -> Vec<serde_json::Value> {
            let sql = format!("SELECT data FROM {}", table);
            match conn.prepare(&sql) {
                Ok(mut stmt) => {
                    let rows = stmt.query_map([], |row| row.get::<_, String>(0));
                    match rows {
                        Ok(rows) => rows.filter_map(|r| r.ok().and_then(|s| serde_json::from_str(&s).ok())).collect(),
                        Err(_) => Vec::new(),
                    }
                }
                Err(_) => Vec::new(),
            }
        }

        // Tables with a `data` JSON column
        export.insert("providerConnections".to_string(), serde_json::json!(export_data_col(&conn, "providerConnections")));
        export.insert("proxyPools".to_string(), serde_json::json!(export_data_col(&conn, "proxyPools")));
        export.insert("providerNodes".to_string(), serde_json::json!(export_data_col(&conn, "providerNodes")));

        // API keys — individual columns (no `data` column)
        let keys: Vec<serde_json::Value> = match conn.prepare(
            "SELECT id, key, name, machineId, isActive, createdAt, groupId, rpm, tpm, budgetUsd, resetWindow, expiresAt, allowedModels, windowStartedAt, windowCostUsd, updatedAt FROM apiKeys"
        ) {
            Ok(mut stmt) => stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "key": row.get::<_, String>(1)?,
                    "name": row.get::<_, Option<String>>(2)?,
                    "machineId": row.get::<_, Option<String>>(3)?,
                    "isActive": row.get::<_, i64>(4)? != 0,
                    "createdAt": row.get::<_, String>(5)?,
                    "groupId": row.get::<_, Option<String>>(6)?,
                    "rpm": row.get::<_, Option<i64>>(7)?,
                    "tpm": row.get::<_, Option<i64>>(8)?,
                    "budgetUsd": row.get::<_, Option<f64>>(9)?,
                    "resetWindow": row.get::<_, Option<String>>(10)?,
                    "expiresAt": row.get::<_, Option<String>>(11)?,
                    "allowedModels": row.get::<_, Option<String>>(12)?,
                    "windowStartedAt": row.get::<_, Option<String>>(13)?,
                    "windowCostUsd": row.get::<_, Option<f64>>(14)?,
                    "updatedAt": row.get::<_, Option<String>>(15)?,
                }))
            }).ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        export.insert("apiKeys".to_string(), serde_json::json!(keys));

        // Combos — individual columns
        let combos: Vec<serde_json::Value> = match conn.prepare(
            "SELECT id, name, kind, models, createdAt, updatedAt FROM combos"
        ) {
            Ok(mut stmt) => stmt.query_map([], |row| {
                let models_str: String = row.get(3)?;
                let models: serde_json::Value = serde_json::from_str(&models_str).unwrap_or(serde_json::json!([]));
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "kind": row.get::<_, Option<String>>(2)?,
                    "models": models,
                    "createdAt": row.get::<_, String>(4)?,
                    "updatedAt": row.get::<_, String>(5)?,
                }))
            }).ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        export.insert("combos".to_string(), serde_json::json!(combos));

        // Key groups — individual columns
        let groups: Vec<serde_json::Value> = match conn.prepare(
            "SELECT id, name, isActive, rpm, tpm, budgetUsd, resetWindow, allowedModels, priceOverrides, createdAt, updatedAt FROM keyGroups"
        ) {
            Ok(mut stmt) => stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "isActive": row.get::<_, i64>(2)? != 0,
                    "rpm": row.get::<_, Option<i64>>(3)?,
                    "tpm": row.get::<_, Option<i64>>(4)?,
                    "budgetUsd": row.get::<_, Option<f64>>(5)?,
                    "resetWindow": row.get::<_, Option<String>>(6)?,
                    "allowedModels": row.get::<_, Option<String>>(7)?,
                    "priceOverrides": row.get::<_, Option<String>>(8)?,
                    "createdAt": row.get::<_, String>(9)?,
                    "updatedAt": row.get::<_, String>(10)?,
                }))
            }).ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        export.insert("keyGroups".to_string(), serde_json::json!(groups));

        // KV (aliases, custom models, disabled models)
        let kv: Vec<serde_json::Value> = match conn.prepare("SELECT scope, key, value FROM kv") {
            Ok(mut stmt) => stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "scope": row.get::<_, String>(0)?,
                    "key": row.get::<_, String>(1)?,
                    "value": row.get::<_, String>(2)?,
                }))
            }).ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        export.insert("kv".to_string(), serde_json::json!(kv));

        Ok(serde_json::Value::Object(export))
    })
    .await;

    match result {
        Ok(Ok(data)) => Json(data).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to export database"}))).into_response(),
    }
}

/// POST /api/settings/database — import database from JSON.
/// Validates shape (must be object with expected keys) before writing.
/// Transaction-wrapped.
pub async fn database_import(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;

    // Validate shape: must be an object
    if !body.is_object() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid import format: expected object"}))).into_response();
    }

    // Check for expected keys
    let obj = body.as_object().unwrap();
    let expected_keys = ["settings", "providerConnections", "apiKeys", "combos", "keyGroups", "kv", "proxyPools", "providerNodes"];
    for key in &expected_keys {
        if obj.contains_key(*key) {
            // Key is present — validate it's an array or object as appropriate
            if key == &"settings" && !obj.get(*key).map(|v| v.is_object()).unwrap_or(false) {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": format!("Invalid '{}' format: expected object", key)}))).into_response();
            }
            if key != &"settings" && !obj.get(*key).map(|v| v.is_array()).unwrap_or(false) {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": format!("Invalid '{}' format: expected array", key)}))).into_response();
            }
        }
    }

    let pool_c = pool.clone();
    let body_c = body.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let mut conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let tx = conn.transaction()?;

        // Import settings
        if let Some(settings) = body_c.get("settings").and_then(|v| v.as_object()) {
            let data_str = serde_json::to_string(&serde_json::Value::Object(settings.clone()))?;
            tx.execute("INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [&data_str])?;
        }

        // Import KV entries
        if let Some(kv) = body_c.get("kv").and_then(|v| v.as_array()) {
            for entry in kv {
                let scope = entry.get("scope").and_then(|v| v.as_str()).unwrap_or("");
                let key = entry.get("key").and_then(|v| v.as_str()).unwrap_or("");
                let value = entry.get("value").and_then(|v| v.as_str()).unwrap_or("");
                if !scope.is_empty() && !key.is_empty() {
                    tx.execute(
                        "INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
                        rusqlite::params![scope, key, value],
                    )?;
                }
            }
        }

        // Import provider connections (upsert)
        if let Some(conns) = body_c.get("providerConnections").and_then(|v| v.as_array()) {
            for c in conns {
                let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if id.is_empty() { continue; }
                let data_str = serde_json::to_string(c)?;
                tx.execute(
                    "INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
                     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, authType=excluded.authType, name=excluded.name, email=excluded.email, priority=excluded.priority, isActive=excluded.isActive, data=excluded.data, updatedAt=excluded.updatedAt",
                    rusqlite::params![
                        id,
                        c.get("provider").and_then(|v| v.as_str()).unwrap_or(""),
                        c.get("authType").and_then(|v| v.as_str()).unwrap_or("apikey"),
                        c.get("name").and_then(|v| v.as_str()),
                        c.get("email").and_then(|v| v.as_str()),
                        c.get("priority").and_then(|v| v.as_i64()),
                        if c.get("isActive").and_then(|v| v.as_bool()).unwrap_or(true) { 1 } else { 0 },
                        data_str,
                        c.get("createdAt").and_then(|v| v.as_str()).unwrap_or(""),
                        c.get("updatedAt").and_then(|v| v.as_str()).unwrap_or(""),
                    ],
                )?;
            }
        }

        // Import API keys (upsert)
        if let Some(keys) = body_c.get("apiKeys").and_then(|v| v.as_array()) {
            for k in keys {
                let id = k.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if id.is_empty() { continue; }
                tx.execute(
                    "INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, groupId, rpm, tpm, budgetUsd, resetWindow, expiresAt, allowedModels, windowStartedAt, windowCostUsd, updatedAt)
                     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET key=excluded.key, name=excluded.name, isActive=excluded.isActive, groupId=excluded.groupId, rpm=excluded.rpm, tpm=excluded.tpm, budgetUsd=excluded.budgetUsd, resetWindow=excluded.resetWindow, expiresAt=excluded.expiresAt, allowedModels=excluded.allowedModels, windowStartedAt=excluded.windowStartedAt, windowCostUsd=excluded.windowCostUsd, updatedAt=excluded.updatedAt",
                    rusqlite::params![
                        id,
                        k.get("key").and_then(|v| v.as_str()).unwrap_or(""),
                        k.get("name").and_then(|v| v.as_str()),
                        k.get("machineId").and_then(|v| v.as_str()),
                        if k.get("isActive").and_then(|v| v.as_bool()).unwrap_or(true) { 1 } else { 0 },
                        k.get("createdAt").and_then(|v| v.as_str()).unwrap_or(""),
                        k.get("groupId").and_then(|v| v.as_str()),
                        k.get("rpm").and_then(|v| v.as_i64()),
                        k.get("tpm").and_then(|v| v.as_i64()),
                        k.get("budgetUsd").and_then(|v| v.as_f64()),
                        k.get("resetWindow").and_then(|v| v.as_str()),
                        k.get("expiresAt").and_then(|v| v.as_str()),
                        k.get("allowedModels").and_then(|v| v.as_str()),
                        k.get("windowStartedAt").and_then(|v| v.as_str()),
                        k.get("windowCostUsd").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        k.get("updatedAt").and_then(|v| v.as_str()),
                    ],
                )?;
            }
        }

        // Import combos (upsert)
        if let Some(combos) = body_c.get("combos").and_then(|v| v.as_array()) {
            for c in combos {
                let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if id.is_empty() { continue; }
                tx.execute(
                    "INSERT INTO combos(id, name, kind, models, createdAt, updatedAt)
                     VALUES(?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, models=excluded.models, updatedAt=excluded.updatedAt",
                    rusqlite::params![
                        id,
                        c.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                        c.get("kind").and_then(|v| v.as_str()),
                        c.get("models").map(|v| v.to_string()).unwrap_or_else(|| "[]".to_string()),
                        c.get("createdAt").and_then(|v| v.as_str()).unwrap_or(""),
                        c.get("updatedAt").and_then(|v| v.as_str()).unwrap_or(""),
                    ],
                )?;
            }
        }

        // Import key groups (upsert)
        if let Some(groups) = body_c.get("keyGroups").and_then(|v| v.as_array()) {
            for g in groups {
                let id = g.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if id.is_empty() { continue; }
                tx.execute(
                    "INSERT INTO keyGroups(id, name, isActive, rpm, tpm, budgetUsd, resetWindow, allowedModels, priceOverrides, createdAt, updatedAt)
                     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET name=excluded.name, isActive=excluded.isActive, rpm=excluded.rpm, tpm=excluded.tpm, budgetUsd=excluded.budgetUsd, resetWindow=excluded.resetWindow, allowedModels=excluded.allowedModels, priceOverrides=excluded.priceOverrides, updatedAt=excluded.updatedAt",
                    rusqlite::params![
                        id,
                        g.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                        if g.get("isActive").and_then(|v| v.as_bool()).unwrap_or(true) { 1 } else { 0 },
                        g.get("rpm").and_then(|v| v.as_i64()),
                        g.get("tpm").and_then(|v| v.as_i64()),
                        g.get("budgetUsd").and_then(|v| v.as_f64()),
                        g.get("resetWindow").and_then(|v| v.as_str()),
                        g.get("allowedModels").and_then(|v| v.as_str()),
                        g.get("priceOverrides").and_then(|v| v.as_str()),
                        g.get("createdAt").and_then(|v| v.as_str()).unwrap_or(""),
                        g.get("updatedAt").and_then(|v| v.as_str()).unwrap_or(""),
                    ],
                )?;
            }
        }

        // Import proxy pools (upsert)
        if let Some(pools) = body_c.get("proxyPools").and_then(|v| v.as_array()) {
            for p in pools {
                let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if id.is_empty() { continue; }
                tx.execute(
                    "INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
                     VALUES(?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET isActive=excluded.isActive, testStatus=excluded.testStatus, data=excluded.data, updatedAt=excluded.updatedAt",
                    rusqlite::params![
                        id,
                        if p.get("isActive").and_then(|v| v.as_bool()).unwrap_or(true) { 1 } else { 0 },
                        p.get("testStatus").and_then(|v| v.as_str()),
                        p.get("data").map(|v| v.to_string()).unwrap_or_else(|| "{}".to_string()),
                        p.get("createdAt").and_then(|v| v.as_str()).unwrap_or(""),
                        p.get("updatedAt").and_then(|v| v.as_str()).unwrap_or(""),
                    ],
                )?;
            }
        }

        // Import provider nodes (upsert)
        if let Some(nodes) = body_c.get("providerNodes").and_then(|v| v.as_array()) {
            for n in nodes {
                let id = n.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if id.is_empty() { continue; }
                tx.execute(
                    "INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
                     VALUES(?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt",
                    rusqlite::params![
                        id,
                        n.get("type").and_then(|v| v.as_str()),
                        n.get("name").and_then(|v| v.as_str()),
                        n.get("data").map(|v| v.to_string()).unwrap_or_else(|| "{}".to_string()),
                        n.get("createdAt").and_then(|v| v.as_str()).unwrap_or(""),
                        n.get("updatedAt").and_then(|v| v.as_str()).unwrap_or(""),
                    ],
                )?;
            }
        }

        tx.commit()?;
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => Json(serde_json::json!({"success": true})).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

/// POST /api/settings/proxy-test — test a proxy URL.
pub async fn proxy_test(
    State(_pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    body: Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let body = body.0;
    let proxy_url = body.get("proxyUrl").and_then(|v| v.as_str()).unwrap_or("");

    if proxy_url.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"ok": false, "error": "proxyUrl required"}))).into_response();
    }

    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(proxy_url).unwrap())
        .timeout(std::time::Duration::from_secs(10))
        .build();

    match client {
        Ok(client) => {
            match client.get("https://httpbin.org/get").send().await {
                Ok(res) => {
                    let status = res.status().as_u16();
                    let ok = res.status().is_success();
                    Json(serde_json::json!({
                        "ok": ok,
                        "status": status,
                        "latencyMs": start.elapsed().as_millis() as u64,
                    })).into_response()
                }
                Err(e) => {
                    let err_msg = if e.is_timeout() { "Proxy test timed out".to_string() } else { e.to_string() };
                    Json(serde_json::json!({
                    "ok": false,
                    "error": err_msg,
                })).into_response()
                }
            }
        }
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "error": format!("Failed to create proxy client: {}", e),
        })).into_response(),
    }
}

/// GET /api/settings/require-login — return require-login status.
pub async fn require_login(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        let s = settings::get_settings(&conn)?;
        let require = s.get("requireLogin").and_then(|v| v.as_bool()).unwrap_or(true);
        let tunnel_access = s.get("tunnelDashboardAccess").and_then(|v| v.as_bool()).unwrap_or(false);
        let tunnel_url = s.get("tunnelUrl").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let tailscale_url = s.get("tailscaleUrl").and_then(|v| v.as_str()).unwrap_or("").to_string();
        Ok(serde_json::json!({
            "requireLogin": require,
            "tunnelDashboardAccess": tunnel_access,
            "tunnelUrl": tunnel_url,
            "tailscaleUrl": tailscale_url,
        }))
    })
    .await;

    match result {
        Ok(Ok(data)) => Json(data).into_response(),
        _ => Json(serde_json::json!({"requireLogin": true})).into_response(),
    }
}
