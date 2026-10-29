import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { stringifyJson, parseJson } from "../helpers/jsonCol.js";
import { resolveDefaultGroupId } from "./userRepo.js";

/**
 * Coerce an `isActive` value from a request body, a form field or a row into a real
 * boolean. Only an explicit "off" is off: `false`, `0`, `"false"`, `"0"`, `"off"`
 * and `null` deactivate; everything else (including `undefined`, meaning "not
 * provided") keeps the group on.
 *
 * `"false"` matters: an admin form that serialises a checkbox as a string sends the
 * literal word, and writing that as truthy would silently re-activate a retired
 * group instead of deactivating it.
 */
export function toBool(value) {
  if (value === undefined) return true; // not provided → keep the group on
  if (value === false || value === 0) return false;
  if (value === null) return false;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    return !(lowered === "" || lowered === "0" || lowered === "false" || lowered === "off" || lowered === "no");
  }
  return Boolean(value);
}

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

/**
 * How many customers depend on each group, and whether a group is the default.
 * Returns a Map<groupId, { memberCount, isDefault }> — one grouped COUNT plus one
 * settings read, never one query per group.
 */
export async function getGroupMemberCounts() {
  const db = await getAdapter();
  const defaultGroupId = await resolveDefaultGroupId();
  const counts = new Map();
  const rows = db.all(`SELECT groupId, COUNT(*) AS n FROM users WHERE groupId IS NOT NULL GROUP BY groupId`);
  for (const row of rows) {
    counts.set(row.groupId, { memberCount: Number(row.n) || 0, isDefault: row.groupId === defaultGroupId });
  }
  // The default group is usually also the newest (zero members) on a fresh install,
  // so it would otherwise have no Map entry at all and the page would hide its
  // `Mặc định` badge — the one group the operator must not delete.
  if (defaultGroupId && !counts.has(defaultGroupId)) {
    counts.set(defaultGroupId, { memberCount: 0, isDefault: true });
  }
  return { counts, defaultGroupId };
}

/**
 * Why a group may not be removed or deactivated, or null when it may.
 *
 * Three independent blockers, all of them data-loss risks:
 *   * members     — those customers would lose their model access and limits.
 *   * isDefault   — new signups would have nowhere to land.
 *   * isLastActive— deactivating it leaves zero active groups, which breaks the
 *                   "every customer has exactly one active group" invariant.
 */
export async function getGroupGuard(groupId) {
  const db = await getAdapter();
  if (!groupId) return { memberCount: 0, isDefault: false, isLastActive: false };
  return guardSync(db, groupId);
}

/** Vietnamese explanation for a guard failure — shown by the groups page. */
export function describeGroupGuard(guard) {
  if (guard.memberCount > 0) {
    return `Nhóm còn ${guard.memberCount} người dùng — chuyển họ sang nhóm khác trước`;
  }
  if (guard.isDefault) return "Đây là nhóm mặc định — chọn nhóm mặc định khác trước";
  if (guard.isLastActive) return "Đây là nhóm đang hoạt động cuối cùng";
  return "Nhóm đang được sử dụng";
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

/**
 * Update a group.
 *
 * Deactivating a group that customers still depend on is refused with the same
 * shape `deleteKeyGroup` uses (`{ ok: false, guard }`) so the route can answer 409
 * without a generic thrown error. Other field edits are never blocked: renaming
 * or changing limits takes effect immediately for every member.
 *
 * The guard is evaluated INSIDE the transaction, so a user created between the
 * check and the write cannot slip into a group that is about to disappear.
 *
 * @returns {null|{ok:false, guard:object}|object} the updated group
 */
export async function updateKeyGroup(id, data) {
  const db = await getAdapter();
  let result = null;
  let blocked = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM keyGroups WHERE id = ?`, [id]);
    if (!row) return;
    const current = rowToGroup(row);
    const merged = { ...current, ...data, updatedAt: new Date().toISOString() };

    // Normalise ONCE and use the same value for the guard and the write. A raw
    // falsy value (`0`, `null`, `""`, `"false"`) written as 0 without a guard would
    // be a one-request way to leave zero active groups — every customer key then
    // resolves no group and is denied until the next boot repairs it.
    const nextIsActive = toBool(merged.isActive);
    merged.isActive = nextIsActive;

    if (current.isActive && !nextIsActive) {
      const guard = guardSync(db, id);
      if (guard.memberCount > 0 || guard.isDefault || guard.isLastActive) {
        blocked = guard;
        return;
      }
    }

    db.run(
      `UPDATE keyGroups SET name = ?, isActive = ?, rpm = ?, tpm = ?, budgetUsd = ?, resetWindow = ?, allowedModels = ?, priceOverrides = ?, updatedAt = ? WHERE id = ?`,
      [
        merged.name, nextIsActive ? 1 : 0,
        merged.rpm, merged.tpm, merged.budgetUsd, merged.resetWindow,
        stringifyJson(merged.allowedModels), stringifyJson(merged.priceOverrides),
        merged.updatedAt, id,
      ]
    );
    result = merged;
  });
  if (blocked) return { ok: false, guard: blocked };
  return result;
}

/** Synchronous body of getGroupGuard, usable inside a transaction. */
function guardSync(db, groupId) {
  const memberCount = Number(db.get(`SELECT COUNT(*) AS n FROM users WHERE groupId = ?`, [groupId])?.n ?? 0);
  const settingRow = db.get(`SELECT data FROM settings WHERE id = 1`);
  const settings = settingRow ? parseJson(settingRow.data, {}) : {};
  const configured = typeof settings?.defaultUserGroupId === "string" ? settings.defaultUserGroupId.trim() : "";

  const activeRows = db.all(`SELECT id FROM keyGroups WHERE isActive = 1 ORDER BY createdAt ASC, rowid ASC`);
  const activeIds = activeRows.map((r) => r.id);
  const defaultGroupId = configured && activeIds.includes(configured) ? configured : activeIds[0] ?? null;

  const row = db.get(`SELECT isActive FROM keyGroups WHERE id = ?`, [groupId]);
  const isActive = row ? row.isActive === 1 || row.isActive === true : false;

  return {
    memberCount,
    isDefault: defaultGroupId === groupId,
    isLastActive: isActive && activeIds.length <= 1,
  };
}

/**
 * Delete a group, refusing when customers still depend on it.
 *
 * An empty non-default group is removed and admin keys that pointed at it are
 * detached, as before. The guard is inside the transaction for the same reason as
 * in updateKeyGroup.
 *
 * @returns {{ok:false, guard:object}|boolean} false when the group did not exist
 */
export async function deleteKeyGroup(id) {
  const db = await getAdapter();
  let outcome = "missing";
  db.transaction(() => {
    const row = db.get(`SELECT * FROM keyGroups WHERE id = ?`, [id]);
    if (!row) return;
    const guard = guardSync(db, id);
    if (guard.memberCount > 0 || guard.isDefault || guard.isLastActive) {
      outcome = { ok: false, guard };
      return;
    }
    // Detach admin keys from this group rather than blocking deletion: a key's
    // group is a narrowing of its own limits, and losing it only widens what the
    // key may do, never what the customer can.
    db.run(`UPDATE apiKeys SET groupId = NULL WHERE groupId = ?`, [id]);
    db.run(`DELETE FROM keyGroups WHERE id = ?`, [id]);
    outcome = "deleted";
  });
  if (outcome === "deleted") return true;
  if (outcome === "missing") return false;
  return outcome;
}
