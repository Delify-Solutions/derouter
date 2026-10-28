import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    // meta is a JSON blob for additive one-off fields (capabilities, ...). Older
    // rows (pre-schema v3) have no meta column → null → defaults to {}.
    meta: parseJson(row.meta, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

// Combo members must be "provider/model" strings. Bare names are how a combo
// ends up referencing another combo (or itself), which is what the runtime cycle
// guard has to clean up after — reject it at the data layer instead.
export function isComboMemberModel(entry) {
  return typeof entry === "string" && entry.length > 0 && entry.includes("/");
}

function assertValidComboModels(models) {
  if (!Array.isArray(models)) {
    throw new Error("Combo members must be provider/model");
  }
  if (!models.every(isComboMemberModel)) {
    throw new Error("Combo members must be provider/model");
  }
}

export async function createCombo(data) {
  if (data.models !== undefined) assertValidComboModels(data.models);
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    meta: data.meta || {},
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, meta, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), stringifyJson(combo.meta), combo.createdAt, combo.updatedAt]
  );
  return combo;
}

export async function updateCombo(id, data) {
  if (data.models !== undefined) assertValidComboModels(data.models);
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, meta = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), stringifyJson(merged.meta || {}), merged.updatedAt, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}
