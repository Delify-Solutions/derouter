//! Model aliases repo — ported from src/lib/db/repos/aliasRepo.js.
//! Uses the `kv` table with scope="modelAliases".
//! Key=alias string, value=model string (fullModel format: "provider/model").

use rusqlite::Connection;
use std::collections::HashMap;

const SCOPE: &str = "modelAliases";

/// Get all model aliases as a HashMap<fullModel, alias>.
/// Note: in the Node code, key=alias, value=model. But the /api/models route
/// reads it as modelAliases[fullModel] which expects key=model, value=alias.
/// Looking at the Node alias route.js: setModelAlias(alias, model) — the first
/// param is the alias string, second is the model.
/// But the /api/models route does: modelAliases[fullModel] || m.model
/// which means it looks up by fullModel. So the kv stores key=fullModel, value=alias.
/// The alias route PUT does: setModelAlias(alias, model) where body has { model, alias }.
/// Wait — looking more carefully: alias/route.js PUT calls setModelAlias(alias, model)
/// but the /api/models route does modelAliases[fullModel] || m.model — looking up by fullModel.
/// This is inconsistent — looking at the actual call: `setModelAlias(alias, model)` with
/// alias first, model second. But the kv helper makeKv has set(key, value), so aliasKv.set(alias, model)
/// stores key=alias, value=model. Then getModelAliases() returns {alias: model}.
/// But /api/models reads modelAliases[fullModel] — that would look up by fullModel as key,
/// which wouldn't match alias keys.
///
/// Actually re-reading: in models/route.js: `alias: modelAliases[fullModel] || m.model`
/// And the alias route calls `setModelAlias(alias, model)` — makeKv.set(key=alias, value=model).
/// So modelAliases is {alias: model}. And modelAliases[fullModel] would be checking if fullModel
/// matches any alias — which gives the model mapped to that alias.
///
/// Hmm, this seems like it's actually {fullModel: alias}. Let me re-check:
/// alias/route.js PUT: `const { model, alias } = body; await setModelAlias(alias, model)`
/// But the top-level models/route.js PUT: `const { model, alias } = body; await setModelAlias(model, alias)`
/// The top-level one does setModelAlias(model, alias) — so it's key=model(fullModel), value=alias.
/// The /alias route does setModelAlias(alias, model) — swapped! That's a bug in Node, but we need
/// to match the behavior of the /api/models GET route which reads modelAliases[fullModel].
///
/// For Rust parity, we store key=fullModel, value=alias (matching the top-level PUT behavior
/// since that's what /api/models reads). The /alias PUT route in Node swaps them, but we'll
/// implement it to match the /api/models reading pattern (key=model, value=alias).

pub fn get_model_aliases(conn: &Connection) -> anyhow::Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM kv WHERE scope = ?")?;
    let rows = stmt.query_map([SCOPE], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut map = HashMap::new();
    for r in rows {
        let (k, v) = r?;
        map.insert(k, v);
    }
    Ok(map)
}

/// Set a model alias. key=fullModel (provider/model), value=alias.
pub fn set_model_alias(conn: &Connection, full_model: &str, alias: &str) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
        rusqlite::params![SCOPE, full_model, alias],
    )?;
    Ok(())
}

/// Delete a model alias by key (fullModel).
pub fn delete_model_alias(conn: &Connection, full_model: &str) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM kv WHERE scope = ? AND key = ?",
        rusqlite::params![SCOPE, full_model],
    )?;
    Ok(())
}
