import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { stringifyJson, parseJson } from "../helpers/jsonCol.js";

function rowToGroup(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive === 1 || row.isActive === true,
    rpm: row.rpm ?? null,
    tpm: row.tpm ?? null,
    budgetUsd: row.budgetUsd ?? null,
    resetWindow: row.resetWindow ?? null,
    allowedModels: parseJson(row.allowedModels) ?? null,
    priceOverrides: parseJson(row.priceOverrides) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getKeyGroups() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM keyGroups ORDER BY createdAt ASC`);
  return rows.map(rowToGroup);
}

export async function getKeyGroupById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM keyGroups WHERE id = ?`, [id]);
  return rowToGroup(row);
}

export async function getKeyGroupByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM keyGroups WHERE name = ?`, [name]);
  return rowToGroup(row);
}

export async function createKeyGroup(input) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const group = {
    id: uuidv4(),
    name: input.name,
    isActive: input.isActive !== false,
    rpm: input.rpm ?? null,
    tpm: input.tpm ?? null,
    budgetUsd: input.budgetUsd ?? null,
    resetWindow: input.resetWindow ?? null,
    allowedModels: input.allowedModels ?? null,
    priceOverrides: input.priceOverrides ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO keyGroups(id, name, isActive, rpm, tpm, budgetUsd, resetWindow, allowedModels, priceOverrides, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      group.id, group.name, group.isActive ? 1 : 0,
      group.rpm, group.tpm, group.budgetUsd, group.resetWindow,
      stringifyJson(group.allowedModels), stringifyJson(group.priceOverrides),
      group.createdAt, group.updatedAt,
    ]
  );
  return group;
}

export async function updateKeyGroup(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM keyGroups WHERE id = ?`, [id]);
    if (!row) return;
    const current = rowToGroup(row);
    const merged = { ...current, ...data, updatedAt: new Date().toISOString() };
    db.run(
      `UPDATE keyGroups SET name = ?, isActive = ?, rpm = ?, tpm = ?, budgetUsd = ?, resetWindow = ?, allowedModels = ?, priceOverrides = ?, updatedAt = ? WHERE id = ?`,
      [
        merged.name, merged.isActive ? 1 : 0,
        merged.rpm, merged.tpm, merged.budgetUsd, merged.resetWindow,
        stringifyJson(merged.allowedModels), stringifyJson(merged.priceOverrides),
        merged.updatedAt, id,
      ]
    );
    result = merged;
  });
  return result;
}

export async function deleteKeyGroup(id) {
  const db = await getAdapter();
  // Detach keys from this group rather than blocking deletion.
  db.run(`UPDATE apiKeys SET groupId = NULL WHERE groupId = ?`, [id]);
  const res = db.run(`DELETE FROM keyGroups WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}
