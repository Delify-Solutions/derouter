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

/**
 * Images on book: the sum of every active image purchase. Independent of the
 * dollar balance — an image plan sells counts, not credit — and the figure an
 * image ledger row snapshots as `balanceAfterImages`.
 */
export function bookBalanceImagesSync(db, userId) {
  const row = db.get(
    `SELECT COALESCE(SUM(imageRemaining), 0) AS images FROM userPlans
      WHERE userId = ? AND status = 'active' AND kind = 'image'`,
    [userId]
  );
  return Math.max(0, Math.round(Number(row?.images) || 0));
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
 * Insert one ledger row. `requestKey` stays NULL unless the caller passes one;
 * SQLite allows many NULLs under a UNIQUE index, which is what non-idempotent
 * grant/adjust/expire rows want.
 *
 * `usageId` ties a `charge` row to the usage row that caused it, which is how the
 * ledger page shows the model and token counts.
 */
export function insertLedgerSync(db, entry) {
  const createdAt = entry.createdAt || nowIso();
  const deltaImages = Math.round(Number(entry.deltaImages) || 0);
  const balance = entry.balanceAfterNanoUsd != null
    ? nano(entry.balanceAfterNanoUsd)
    : bookBalanceNanoSync(db, entry.userId);
  // An image row's snapshot is the IMAGE balance; a credit row leaves it NULL, so
  // the ledger page never shows an image figure on a dollar entry.
  const balanceImages = deltaImages !== 0 || entry.balanceAfterImages != null
    ? (entry.balanceAfterImages != null
        ? Math.max(0, Math.round(Number(entry.balanceAfterImages) || 0))
        : bookBalanceImagesSync(db, entry.userId))
    : null;
  db.run(
    `INSERT INTO creditLedger(userId, userPlanId, apiKeyId, usageId, requestKey, deltaNanoUsd, deltaImages, balanceAfterNanoUsd, balanceAfterImages, kind, meta, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.userId,
      entry.userPlanId ?? null,
      entry.apiKeyId ?? null,
      entry.usageId == null ? null : Math.round(Number(entry.usageId)) || null,
      entry.requestKey ?? null,
      nano(entry.deltaNanoUsd),
      deltaImages,
      balance,
      balanceImages,
      entry.kind,
      entry.meta == null ? null : stringifyJson(entry.meta),
      createdAt,
    ]
  );
}
