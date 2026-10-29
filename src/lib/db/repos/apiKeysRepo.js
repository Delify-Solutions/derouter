import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { stringifyJson, parseJson } from "../helpers/jsonCol.js";
import { getKeyGroupById } from "./keyGroupsRepo.js";

// sha256 hex of a raw api key. Keys are high-entropy random strings, so a plain
// unsalted hash cannot be reversed by guessing — no salt/KDF needed here (unlike
// passwords).
export function hashApiKey(key) {
  if (!key || typeof key !== "string") return null;
  return crypto.createHash("sha256").update(key).digest("hex");
}

// First 8 chars of a key, for display/listing without leaking the secret.
function keyPrefixOf(key) {
  if (!key || typeof key !== "string") return null;
  return key.slice(0, 8);
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    // Advanced limits
    groupId: row.groupId ?? null,
    rpm: row.rpm ?? null,
    tpm: row.tpm ?? null,
    budgetUsd: row.budgetUsd ?? null,
    resetWindow: row.resetWindow ?? null,
    expiresAt: row.expiresAt ?? null,
    allowedModels: parseJson(row.allowedModels) ?? null,
    windowStartedAt: row.windowStartedAt ?? null,
    windowCostUsd: row.windowCostUsd ?? 0,
    updatedAt: row.updatedAt ?? null,
    // Tenant ownership + hash-based lookup metadata.
    userId: row.userId ?? null,
    keyPrefix: row.keyPrefix ?? keyPrefixOf(row.key),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Look up an api key by its key string (raw row, includes groupId).
// Dual-read: rows created before the hash migration only have `key`; rows created
// after write both. Try the plaintext column first (indexed), then the hash.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  let row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  if (!row) {
    const hash = hashApiKey(key);
    if (hash) row = db.get(`SELECT * FROM apiKeys WHERE keyHash = ?`, [hash]);
  }
  return rowToKey(row);
}

// Validate that a key's limits narrow its group's limits (rpm ≤ group.rpm, models ⊆ group.models, etc.).
// Returns { ok: true } or { ok: false, error }.
function validateNarrowing(keyData, group) {
  if (!group) return { ok: true };
  if (keyData.rpm != null && group.rpm != null && keyData.rpm > group.rpm) {
    return { ok: false, error: `Key RPM (${keyData.rpm}) cannot exceed group RPM (${group.rpm})` };
  }
  if (keyData.tpm != null && group.tpm != null && keyData.tpm > group.tpm) {
    return { ok: false, error: `Key TPM (${keyData.tpm}) cannot exceed group TPM (${group.tpm})` };
  }
  if (keyData.budgetUsd != null && group.budgetUsd != null && keyData.budgetUsd > group.budgetUsd) {
    return { ok: false, error: `Key budget ($${keyData.budgetUsd}) cannot exceed group budget ($${group.budgetUsd})` };
  }
  if (keyData.allowedModels && group.allowedModels) {
    const outside = keyData.allowedModels.filter((m) => !group.allowedModels.includes(m));
    if (outside.length) {
      return { ok: false, error: `Key allows models not in group: ${outside.join(", ")}` };
    }
  }
  return { ok: true };
}

export async function createApiKey(name, machineId, options = {}) {
  if (!machineId && !options.groupId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId || "custom");

  // If grouped, validate narrowing against the group.
  let group = null;
  if (options.groupId) {
    group = await getKeyGroupById(options.groupId);
    if (!group) throw new Error("Group not found");
    if (group.isActive === false) throw new Error("Group is inactive");
  }
  const narrowing = validateNarrowing(options, group);
  if (!narrowing.ok) throw new Error(narrowing.error);

  const now = new Date().toISOString();
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId: machineId || null,
    isActive: true,
    createdAt: now,
    groupId: options.groupId ?? null,
    rpm: options.rpm ?? null,
    tpm: options.tpm ?? null,
    budgetUsd: options.budgetUsd ?? null,
    resetWindow: options.resetWindow ?? null,
    expiresAt: options.expiresAt ?? null,
    allowedModels: options.allowedModels ?? null,
    windowStartedAt: null,
    windowCostUsd: 0,
    updatedAt: now,
    userId: options.userId ?? null,
    keyPrefix: keyPrefixOf(result.key),
    keyHash: hashApiKey(result.key),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, groupId, rpm, tpm, budgetUsd, resetWindow, expiresAt, allowedModels, windowStartedAt, windowCostUsd, updatedAt, userId, keyHash, keyPrefix) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt,
      apiKey.groupId, apiKey.rpm, apiKey.tpm, apiKey.budgetUsd, apiKey.resetWindow,
      apiKey.expiresAt, stringifyJson(apiKey.allowedModels),
      apiKey.windowStartedAt, apiKey.windowCostUsd, apiKey.updatedAt,
      apiKey.userId, apiKey.keyHash, apiKey.keyPrefix,
    ]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  if (!row) return null;
  const current = rowToKey(row);

  // If updating limits and key is grouped, re-validate narrowing against group.
  // (better-sqlite3 transactions must be synchronous, so resolve the group first.)
  if (current.groupId && (data.rpm != null || data.tpm != null || data.budgetUsd != null || data.allowedModels)) {
    const group = await getKeyGroupById(current.groupId);
    const narrowing = validateNarrowing({ ...current, ...data }, group);
    if (!narrowing.ok) throw new Error(narrowing.error);
  }

  const merged = {
    ...current,
    ...data,
    allowedModels: data.allowedModels !== undefined ? data.allowedModels : current.allowedModels,
    updatedAt: new Date().toISOString(),
  };
  // Keep the hash/prefix derived columns in lockstep with the plaintext key.
  const keyHash = hashApiKey(merged.key);
  const keyPrefix = keyPrefixOf(merged.key);
  db.run(
    `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, groupId = ?, rpm = ?, tpm = ?, budgetUsd = ?, resetWindow = ?, expiresAt = ?, allowedModels = ?, windowStartedAt = ?, windowCostUsd = ?, updatedAt = ?, keyHash = COALESCE(?, keyHash), keyPrefix = COALESCE(?, keyPrefix) WHERE id = ?`,
    [
      merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0,
      merged.groupId, merged.rpm, merged.tpm, merged.budgetUsd, merged.resetWindow,
      merged.expiresAt, stringifyJson(merged.allowedModels),
      merged.windowStartedAt, merged.windowCostUsd ?? 0, merged.updatedAt,
      keyHash, keyPrefix, id,
    ]
  );
  return merged;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  if (!key) return false;
  const db = await getAdapter();
  // Dual-read: plaintext first, then sha256 (see getApiKeyByKey).
  let row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) {
    const hash = hashApiKey(key);
    if (hash) row = db.get(`SELECT isActive FROM apiKeys WHERE keyHash = ?`, [hash]);
  }
  if (!row) return false;
  if (row.isActive !== 1 && row.isActive !== true) return false;
  // Expiry is enforced by the key-enforcement layer (keyEnforcement.js -> 403),
  // not here, so an expired key passes the gate then gets a specific 403 at the handler.
  return true;
}

/**
 * Resolve the effective limits for a request's API key (design D6).
 *
 * Two surfaces, deliberately different:
 *
 *   * CUSTOMER KEY (`userId` set) — the limits belong to the ACCOUNT, not the key.
 *     `users.groupId` is read on every request, so an admin moving the customer to
 *     another group takes effect on the next call without touching any key. Every
 *     limit column stored on the key itself (group, rpm, tpm, budget, reset window,
 *     allowed models) is ignored: key-level limits accumulated from earlier admin
 *     edits are stale by definition, and honoring them would let a customer whose
 *     key once had `rpm = 1` stay throttled forever. Only `isActive` and `expiresAt`
 *     still describe the key itself.
 *     Budget/reset are null because customer spending is governed by the plan queue
 *     (see capability plan-queue-billing), never by a per-key dollar cap.
 *
 *   * ADMIN KEY (no `userId`) — unchanged: the key narrows its own group.
 *
 * @returns {null|{key:object, group:object|null, owner:object|null, resolved:object}}
 */
export async function getApiKeyForAuth(key) {
  const k = await getApiKeyByKey(key);
  if (!k) return null;

  if (k.userId) {
    const db = await getAdapter();
    const user = db.get(`SELECT id, status, groupId FROM users WHERE id = ?`, [k.userId]);
    const owner = user
      ? { id: user.id, status: user.status, groupId: user.groupId ?? null }
      : { id: k.userId, status: "deleted", groupId: null };
    // An inactive group is as good as absent for enforcement: its limits describe
    // a group the admin has retired. Callers deny when `group` is null.
    const group = owner.groupId ? await getKeyGroupById(owner.groupId) : null;
    const liveGroup = group && group.isActive !== false ? group : null;

    return {
      key: k,
      group: liveGroup,
      owner,
      resolved: {
        rpm: liveGroup?.rpm ?? null,
        tpm: liveGroup?.tpm ?? null,
        budgetUsd: null,
        resetWindow: null,
        allowedModels: liveGroup?.allowedModels ?? null,
        expiresAt: k.expiresAt,
      },
    };
  }

  let group = null;
  if (k.groupId) group = await getKeyGroupById(k.groupId);

  // Resolve: take key's value if set, else group's value, else null (unlimited).
  const resolve = (keyVal, groupVal) => (keyVal != null ? keyVal : groupVal ?? null);
  const resolved = {
    rpm: resolve(k.rpm, group?.rpm),
    tpm: resolve(k.tpm, group?.tpm),
    budgetUsd: resolve(k.budgetUsd, group?.budgetUsd),
    resetWindow: resolve(k.resetWindow, group?.resetWindow),
    allowedModels: k.allowedModels ?? group?.allowedModels ?? null,
    expiresAt: k.expiresAt, // expiry is per-key only
  };
  return { key: k, group, owner: null, resolved };
}

// Reset the cost window on a key (set windowStartedAt = now, windowCostUsd = 0).
export async function resetKeyWindow(id) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(`UPDATE apiKeys SET windowStartedAt = ?, windowCostUsd = 0, updatedAt = ? WHERE id = ?`, [now, now, id]);
}

// Update the cached window cost on the key row (cheap write, optional optimization).
export async function setKeyWindowCost(id, cost) {
  const db = await getAdapter();
  db.run(`UPDATE apiKeys SET windowCostUsd = ?, updatedAt = ? WHERE id = ?`, [cost, new Date().toISOString(), id]);
}
