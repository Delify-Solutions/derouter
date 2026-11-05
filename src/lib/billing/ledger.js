// Ledger primitives: the only writers of `creditLedger` and of the debt column.
//
// Moved out of billingRepo.js so the driver-free billing engine (planQueue,
// grants, adminActions) can record money without importing a module that resolves
// the adapter itself (design D8). Behaviour is unchanged — the same arithmetic,
// the same running-balance rule.
//
// Ledger semantics (unchanged):
//   deltaNanoUsd          signed change to the customer's credit on book
//   balanceAfterNanoUsd   credit on book AFTER the entry:
//                         SUM(creditRemainingNanoUsd over status='active')
//                         minus users.overdraftNanoUsd. It can be negative while
//                         the account is in overdraft.
// "Available" (the number that gates requests) is a narrower figure — active AND
// unexpired credit minus debt, floored at zero; see billingRepo.getAvailableNanoUsd.
import { stringifyJson } from "../db/helpers/jsonCol.js";

function nowIso() {
  return new Date().toISOString();
}

/** Integer nanoUSD from anything numeric. Never returns NaN, never a float. */
export function nano(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Credit on book: the ledger's running balance.
 * One round trip — the two sub-selects share a single statement.
 */
export function bookBalanceNanoSync(db, userId) {
  const row = db.get(
    `SELECT
       COALESCE((SELECT SUM(creditRemainingNanoUsd) FROM userPlans
                  WHERE userId = ? AND status = 'active'), 0) AS credit,
       COALESCE((SELECT overdraftNanoUsd FROM users WHERE id = ?), 0) AS overdraft`,
    [userId, userId]
  );
  return nano(row?.credit) - nano(row?.overdraft);
}

/** Current debt (users.overdraftNanoUsd), floored at 0. */
export function getDebtNanoSync(db, userId) {
  const row = db.get(`SELECT COALESCE(overdraftNanoUsd, 0) AS o FROM users WHERE id = ?`, [userId]);
  return nano(row?.o);
}

/** Set the debt. Always non-negative: a negative debt is a credit, which belongs in userPlans. */
export function setDebtNanoSync(db, userId, value) {
  db.run(`UPDATE users SET overdraftNanoUsd = ? WHERE id = ?`, [Math.max(0, nano(value)), userId]);
}

/**
 * Write the account's whole debt off (change debt-clear): the debt goes to 0 and
 * one `adjust` row of +debt records it, with `meta.reason` saying why
 * ("overdraft_absorbed" by an unlimited plan, "debt_cleared" by an admin).
 * Synchronous; run inside the caller's transaction.
 * @returns {number} the amount written off (0 when there was no debt)
 */
export function writeOffDebtSync(db, userId, { userPlanId = null, meta = {}, createdAt = null } = {}) {
  const debt = getDebtNanoSync(db, userId);
  if (debt <= 0) return 0;
  setDebtNanoSync(db, userId, 0);
  insertLedgerSync(db, {
    userId,
    userPlanId,
    deltaNanoUsd: debt,
    kind: "adjust",
    meta: { ...meta, writtenOffNanoUsd: debt },
    createdAt,
  });
  return debt;
}

/**
 * Insert one ledger row. `requestKey` stays NULL unless the caller passes one;
 * SQLite allows many NULLs under a UNIQUE index, which is what non-idempotent
 * grant/adjust/expire rows want.
 *
 * `usageId` ties a `charge` row to the usage row that caused it, which is how the
 * ledger page shows the model and token counts.
 */
export function insertLedgerSync(db, entry) {
  const createdAt = entry.createdAt || nowIso();
  const balance = entry.balanceAfterNanoUsd != null
    ? nano(entry.balanceAfterNanoUsd)
    : bookBalanceNanoSync(db, entry.userId);
  db.run(
    `INSERT INTO creditLedger(userId, userPlanId, apiKeyId, usageId, requestKey, deltaNanoUsd, balanceAfterNanoUsd, kind, meta, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.userId,
      entry.userPlanId ?? null,
      entry.apiKeyId ?? null,
      entry.usageId == null ? null : Math.round(Number(entry.usageId)) || null,
      entry.requestKey ?? null,
      nano(entry.deltaNanoUsd),
      balance,
      entry.kind,
      entry.meta == null ? null : stringifyJson(entry.meta),
      createdAt,
    ]
  );
}
