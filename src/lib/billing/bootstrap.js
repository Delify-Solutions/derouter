// Post-sync start-up tasks: cheap repairs that must run after the schema exists.
//
// Called from initAdapter (src/lib/db/driver.js) immediately after
// runMigrationOnce, NOT from inside it: runMigrationOnce returns early on the
// legacy-JSON import path, which would skip these. Each step runs in its own
// transaction and catches its own errors, so a data repair can never stop the
// server from starting; a one-time marker is written only after its step
// succeeded, so a failed step is retried on the next boot.
//
// SYNCHRONOUS + DRIVER-FREE (design D8): the adapter is passed in. Nothing here
// may import ../db/driver.js or a repo that does.
import { v4 as uuidv4 } from "uuid";
import { getMetaSync, setMetaSync } from "../db/helpers/metaStore.js";
import { parseJson, stringifyJson } from "../db/helpers/jsonCol.js";
import { insertAuditSync } from "./audit.js";
import { closeUserPlanSync } from "./grants.js";
import { runBackfillSync } from "./planQueue.js";

function nowIso() {
  return new Date().toISOString();
}

// Same upsert updateSettings uses, so a bootstrap write cannot resurrect a stale
// settings document or fight a concurrent PATCH for the row.
const SETTINGS_UPSERT_SQL =
  `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`;

function readRawSettings(db) {
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  const parsed = row ? parseJson(row.data, {}) : {};
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function writeRawSettings(db, data) {
  db.run(SETTINGS_UPSERT_SQL, [stringifyJson(data)]);
}

function activeGroups(db) {
  return db.all(`SELECT id FROM keyGroups WHERE isActive = 1 ORDER BY createdAt ASC, rowid ASC`);
}

/**
 * Guarantee the customer-group invariants (design D10 step 1):
 *  1. at least one active group exists (seed `Mặc định` — no limits at all, so it
 *     never narrows what a customer could already call);
 *  2. `settings.defaultUserGroupId` names an active group (repaired when empty,
 *     unknown or inactive);
 *  3. every user belongs to an active group, with one `group_auto_assigned` audit
 *     entry per repaired user.
 *
 * Idempotent: a second call on a healthy database writes nothing.
 */
export function ensureCustomerGroupsSync(db) {
  if (!db) throw new Error("ensureCustomerGroupsSync requires the db adapter");

  let groups = activeGroups(db);
  let seeded = false;
  if (groups.length === 0) {
    const now = nowIso();
    const id = uuidv4();
    db.run(
      `INSERT INTO keyGroups(id, name, isActive, allowedModels, priceOverrides, createdAt, updatedAt)
       VALUES(?, ?, 1, NULL, NULL, ?, ?)`,
      [id, "Mặc định", now, now]
    );
    groups = [{ id }];
    seeded = true;
  }

  const activeIds = new Set(groups.map((g) => g.id));

  // The DEFAULT group is what both registration (resolveDefaultGroupId) and this
  // repair must use — they would otherwise disagree, and a repaired user would land
  // in a different group than a newly registered one. The configured value wins when
  // it names an active group; the oldest active group is only the fallback.
  const settings = readRawSettings(db);
  const configured = typeof settings.defaultUserGroupId === "string" ? settings.defaultUserGroupId.trim() : "";
  const defaultGroupId = configured && activeIds.has(configured) ? configured : groups[0].id;

  if (!configured || !activeIds.has(configured)) {
    writeRawSettings(db, { ...settings, defaultUserGroupId: defaultGroupId });
  }

  // Repair users. The query is written to match "not an active group" in SQL, so
  // a large users table is filtered by SQLite rather than by JS.
  const placeholders = [...activeIds].map(() => "?").join(", ");
  const orphans = db.all(
    `SELECT id, groupId FROM users
      WHERE groupId IS NULL OR groupId = '' OR groupId NOT IN (${placeholders})`,
    [...activeIds]
  );

  let repaired = 0;
  for (const user of orphans) {
    db.run(`UPDATE users SET groupId = ?, updatedAt = ? WHERE id = ?`, [defaultGroupId, nowIso(), user.id]);
    insertAuditSync(db, {
      userId: user.id,
      actor: "system",
      action: "group_auto_assigned",
      details: { before: user.groupId ?? null, after: defaultGroupId },
      now: nowIso(),
    });
    repaired += 1;
  }

  return { defaultGroupId, seeded, repaired };
}

/**
 * One-time: customer keys must not carry key-level limits (design D6 — their
 * limits come from the owner's group on every request). Clearing the columns
 * once makes the "stale `rpm = 1` is ignored" rule visible in the data too, and
 * keeps an admin from being confused by values that no longer do anything.
 */
function bootstrapCustomerKeysSync(db) {
  db.run(
    `UPDATE apiKeys
        SET groupId = NULL, rpm = NULL, tpm = NULL, budgetUsd = NULL,
            resetWindow = NULL, allowedModels = NULL
      WHERE userId IS NOT NULL`
  );
}

/**
 * One-time: admin keys no longer belong to a group (a group decides models and
 * plan access for CUSTOMERS). A key that inherited its model list from a group
 * keeps that restriction by copying the list onto the key itself; without this,
 * dropping the group would silently widen what the key may call.
 */
function bootstrapAdminKeyGroupsSync(db) {
  db.run(
    `UPDATE apiKeys
        SET allowedModels = (SELECT g.allowedModels FROM keyGroups g WHERE g.id = apiKeys.groupId)
      WHERE userId IS NULL
        AND groupId IS NOT NULL
        AND allowedModels IS NULL
        AND (SELECT g.allowedModels FROM keyGroups g WHERE g.id = apiKeys.groupId) IS NOT NULL`
  );
  db.run(`UPDATE apiKeys SET groupId = NULL WHERE userId IS NULL AND groupId IS NOT NULL`);
}

/**
 * One-time: copy each buyer's email onto their orders, so an order stays readable
 * after the account is deleted (design D10 step 3).
 */
function bootstrapOrderEmailsSync(db) {
  db.run(
    `UPDATE orders
        SET emailSnapshot = (SELECT u.email FROM users u WHERE u.id = orders.userId)
      WHERE emailSnapshot IS NULL
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = orders.userId)`
  );
}

/**
 * One-time: refunds used to GRANT the order's credit again instead of taking it
 * back, so a refunded order left its original plan active and added a second
 * "refund" plan. Close every still-active plan that belongs to a refunded order,
 * the original and the compensation alike, as `refunded`.
 */
function bootstrapRefundedPlansSync(db) {
  const at = nowIso();
  const plans = db.all(
    `SELECT up.* FROM userPlans up
       JOIN orders o ON o.id = up.orderId
      WHERE o.status = 'refunded' AND up.status = 'active'`
  );
  let removed = 0;
  for (const plan of plans) {
    removed += closeUserPlanSync(db, plan, {
      status: "refunded",
      reason: "order_refunded",
      meta: { bootstrap: "refundedPlans.v1", orderId: plan.orderId },
      now: at,
    });
  }
  if (plans.length) {
    console.log(`[bootstrap] refundedPlans: closed ${plans.length} plan(s), removed ${removed} nanoUSD of credit`);
  }
}

// Usage rows from before the plan queue existed were never charged (the old
// per-model ceiling skipped the wallet). This cut-off is the first minute the
// customer-key billing change shipped, so rows at or after it are ours to bill.
const BACKFILL_SINCE = "2026-10-28T19:22:58.000Z";

/**
 * Charge usage that predates the plan queue (design D10 step 4). Reports what it
 * did so the operator can see it in the boot log — a silent back-charge would be
 * indistinguishable from a billing bug.
 */
function backfillUsage(db) {
  const result = runBackfillSync(db, { sinceIso: BACKFILL_SINCE, nowIso: nowIso() });
  console.log(
    `[bootstrap] backfill since ${BACKFILL_SINCE}: ${result.rows} row(s), ` +
    `charged ${result.chargedNanoUsd} nanoUSD, debt ${result.debtNanoUsd} nanoUSD`
  );
  return result;
}

/**
 * Run one guarded one-time step: transaction + marker only on success.
 * A thrown error is logged and swallowed — the server must still start.
 */
function runOnce(db, marker, label, fn) {
  if (getMetaSync(db, marker, null)) return false;
  try {
    db.transaction(() => {
      fn();
      setMetaSync(db, marker, nowIso());
    });
    return true;
  } catch (error) {
    console.error(`[bootstrap] ${label} failed: ${error?.message || error}`);
    return false;
  }
}

/**
 * Entry point called by initAdapter after migrations. Never throws.
 *
 * @returns {{ groups: object|null, ran: string[] }}
 */
export function runPostSyncTasksSync(db) {
  const ran = [];
  if (!db) return { groups: null, ran };

  // 1. Every start: group invariants. Cheap on a healthy DB (three indexed reads
  // and one settings read); the UPDATE only touches users that need it.
  let groups = null;
  try {
    db.transaction(() => {
      groups = ensureCustomerGroupsSync(db);
    });
  } catch (error) {
    console.error(`[bootstrap] ensureCustomerGroups failed: ${error?.message || error}`);
  }

  // 2-4. One-time data repairs.
  if (runOnce(db, "bootstrap.customerKeys.v1", "customerKeys", () => bootstrapCustomerKeysSync(db))) {
    ran.push("customerKeys");
  }
  if (runOnce(db, "bootstrap.adminKeyGroups.v1", "adminKeyGroups", () => bootstrapAdminKeyGroupsSync(db))) {
    ran.push("adminKeyGroups");
  }
  if (runOnce(db, "bootstrap.orderEmails.v1", "orderEmails", () => bootstrapOrderEmailsSync(db))) {
    ran.push("orderEmails");
  }
  if (runOnce(db, "bootstrap.refundedPlans.v1", "refundedPlans", () => bootstrapRefundedPlansSync(db))) {
    ran.push("refundedPlans");
  }
  if (runOnce(db, "bootstrap.backfill.v1", "backfill", () => backfillUsage(db))) {
    ran.push("backfill");
  }

  return { groups, ran };
}
