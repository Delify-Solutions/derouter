// The plan queue: order, admission, two-pass charging, window state.
//
// Each `userPlans` row is its own credit pool with its own expiry and its own
// snapshot of time-window limits. This module answers the three questions the rest
// of the product needs, always in the same way for every surface (admission, the
// customer page, the admin page):
//
//   listQueueSync   — what is in the queue, in order
//   admitSync       — may this request run at all, and if not, why not
//   chargeSync      — who pays for the request that just completed
//
// Order (design D2): explicit priority first (ascending), then no-priority plans by
// ascending expiry, then creation time, then id. Manual order wins; a new plan goes
// last.
//
// Windows (D3) are "first-use fixed": a window of `hours` opens at the first charge
// to that plan, closes `hours` later, and its spend resets to zero. Counters live in
// `userPlanWindows` so admission stays O(plans) indexed reads; rebuildWindowsSync
// can always recompute them from the ledger, which is what the consistency test
// asserts.
//
// SYNCHRONOUS + DRIVER-FREE (D8): every function takes the adapter.
import { insertLedgerSync, getDebtNanoSync, setDebtNanoSync, nano } from "./ledger.js";
import { parseLimits, serializeLimits } from "./limits.js";
import { insertAuditSync } from "./audit.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function nowIso() {
  return new Date().toISOString();
}

function isoOf(ms) {
  return new Date(ms).toISOString();
}

/** Order of the queue (D2). Kept in one SQL fragment so listQueueSync and the
 *  window rebuild cannot drift. */
const QUEUE_ORDER = `
  ORDER BY (up.priority IS NULL) ASC,
           up.priority ASC,
           up.expiresAt ASC,
           up.createdAt ASC,
           up.id ASC`;

function rowToEntry(row, windowsByPlan) {
  const limits = parseLimits(row.limits);
  const stored = windowsByPlan.get(row.id) ?? new Map();
  const windows = {};
  for (const limit of limits) {
    const state = stored.get(limit.hours);
    if (state) windows[limit.hours] = { startedAt: state.startedAt, spentNanoUsd: nano(state.spentNanoUsd) };
  }
  return {
    id: row.id,
    userId: row.userId,
    planId: row.planId ?? null,
    planCode: row.planCode ?? null,
    planName: row.planName ?? null,
    source: row.source ?? null,
    creditTotalNanoUsd: nano(row.creditTotalNanoUsd),
    creditRemainingNanoUsd: nano(row.creditRemainingNanoUsd),
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    priority: row.priority == null ? null : nano(row.priority),
    limits,
    windows,
    createdAt: row.createdAt ?? null,
  };
}

/**
 * Read the queue: active, unexpired purchases in D2 order, with their limits and
 * current window state.
 *
 * Note the status test is only `active`: expiry is compared here as well
 * (`expiresAt > nowIso`) so an unswept expired plan can never be admitted — the
 * janitor's `expired` status is a bookkeeping step, not the gate.
 *
 * @returns {Array<object>} entries per design D9
 */
export function listQueueSync(db, userId, nowIsoArg = null) {
  if (!db) throw new Error("listQueueSync requires the db adapter");
  if (!userId) return [];
  const at = nowIsoArg || nowIso();

  const rows = db.all(
    `SELECT up.*, p.code AS planCode, p.name AS planName
       FROM userPlans up
       LEFT JOIN plans p ON p.id = up.planId
      WHERE up.userId = ? AND up.status = 'active' AND up.expiresAt > ?
      ${QUEUE_ORDER}`,
    [userId, at]
  );
  if (rows.length === 0) return [];

  // One query for every window row of the queue, not one per plan.
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(", ");
  const windowRows = db.all(
    `SELECT userPlanId, hours, startedAt, spentNanoUsd FROM userPlanWindows WHERE userPlanId IN (${placeholders})`,
    ids
  );
  const windowsByPlan = new Map();
  for (const row of windowRows) {
    if (!windowsByPlan.has(row.userPlanId)) windowsByPlan.set(row.userPlanId, new Map());
    windowsByPlan.get(row.userPlanId).set(nano(row.hours), {
      startedAt: row.startedAt,
      spentNanoUsd: nano(row.spentNanoUsd),
    });
  }

  return rows.map((row) => rowToEntry(row, windowsByPlan));
}

/**
 * Pure evaluation of one entry at an instant (design D9). No I/O, so the UI and
 * admission provably agree.
 *
 * @param {object} entry from listQueueSync
 * @param {number} nowMs
 */
export function evaluatePlan(entry, nowMs) {
  const now = Number(nowMs) || 0;
  const windows = [];
  let blocked = false;
  let reopenMs = null;

  for (const limit of entry.limits ?? []) {
    const state = entry.windows?.[limit.hours] ?? null;
    const closedAtMs = state ? new Date(state.startedAt).getTime() + limit.hours * HOUR_MS : null;
    const isOpen = state != null && Number.isFinite(closedAtMs) && now < closedAtMs;
    const spent = isOpen ? nano(state.spentNanoUsd) : 0;
    const full = isOpen && spent >= limit.maxNanoUsd;

    if (full) {
      blocked = true;
      // The plan reopens when its LAST full window closes — every one of them must
      // have room. A 5-hour window that closed while a 168-hour one is still full
      // therefore does not unblock the plan.
      if (reopenMs == null || closedAtMs > reopenMs) reopenMs = closedAtMs;
    }

    windows.push({
      hours: limit.hours,
      maxNanoUsd: limit.maxNanoUsd,
      spentNanoUsd: spent,
      startedAt: isOpen ? state.startedAt : null,
      resetAt: isOpen ? isoOf(closedAtMs) : null,
      open: isOpen,
      full,
    });
  }

  // Room is the tightest window. A closed or unopened window contributes its full
  // maximum (nothing is spent in it yet). No limits = unlimited (`null`).
  let roomNanoUsd = null;
  if (windows.length > 0) {
    roomNanoUsd = Number.POSITIVE_INFINITY;
    for (const w of windows) {
      roomNanoUsd = Math.min(roomNanoUsd, Math.max(0, w.maxNanoUsd - w.spentNanoUsd));
    }
  }

  const expiresMs = new Date(entry.expiresAt).getTime();
  return {
    eligible: nano(entry.creditRemainingNanoUsd) > 0 && Number.isFinite(expiresMs) && expiresMs > now && !blocked,
    blocked,
    reopenAt: reopenMs == null ? null : isoOf(reopenMs),
    roomNanoUsd,
    windows,
  };
}

/**
 * May a request run? (spec plan-queue-billing "Admission")
 *
 *   first eligible plan      → { ok: true, planId }
 *   only window-blocked ones → 429 plan_limit with the EARLIEST reopen and the
 *                              seconds until it
 *   nothing with credit      → 402 insufficient_quota
 */
export function admitSync(db, userId, nowIsoArg = null) {
  const at = nowIsoArg || nowIso();
  const nowMs = new Date(at).getTime();
  const queue = listQueueSync(db, userId, at);

  let earliestReopenMs = null;
  let anyOnlyBlocked = false;

  for (const entry of queue) {
    const state = evaluatePlan(entry, nowMs);
    if (state.eligible) return { ok: true, planId: entry.id };
    // "Only blocked" = has credit and is unexpired, but a window is full.
    if (nano(entry.creditRemainingNanoUsd) > 0 && state.blocked) {
      anyOnlyBlocked = true;
      const reopenMs = state.reopenAt ? new Date(state.reopenAt).getTime() : null;
      if (reopenMs != null && (earliestReopenMs == null || reopenMs < earliestReopenMs)) {
        earliestReopenMs = reopenMs;
      }
    }
  }

  if (anyOnlyBlocked) {
    const resetAt = earliestReopenMs == null ? null : isoOf(earliestReopenMs);
    return {
      ok: false,
      status: 429,
      code: "plan_limit",
      resetAt,
      retryAfterSec: resetAt ? Math.max(1, Math.ceil((earliestReopenMs - nowMs) / 1000)) : 60,
    };
  }

  return { ok: false, status: 402, code: "insufficient_quota" };
}

/**
 * Write one amount against a plan: decrement credit, insert the ledger row, then
 * advance every window of that plan by the same amount (opening windows that are
 * closed or absent). All four writes belong to the caller's transaction — this
 * function never opens one.
 *
 * The entry's `creditRemainingNanoUsd` is updated IN PLACE as well as written to the
 * database. That is not a convenience: `chargeSync` takes from the same plan twice
 * (pass 1 inside a window, pass 2 ignoring it), and a second take computed from the
 * pre-charge balance would overwrite the first with `original − take2` instead of
 * `current − take2`. The plan's credit and the ledger would then disagree — money
 * billed but never removed, or credit fabricated back.
 *
 * @returns {number} the plan's remaining credit AFTER this take
 */
function applyTake(db, { entry, amount, requestKey, usageId, apiKeyId, at, pass }) {
  const left = Math.max(0, nano(entry.creditRemainingNanoUsd) - amount);
  if (left <= 0) {
    db.run(`UPDATE userPlans SET creditRemainingNanoUsd = 0, status = 'exhausted' WHERE id = ?`, [entry.id]);
  } else {
    db.run(`UPDATE userPlans SET creditRemainingNanoUsd = ? WHERE id = ?`, [left, entry.id]);
  }
  // Keep the in-memory entry authoritative for any later take in THIS charge.
  entry.creditRemainingNanoUsd = left;

  insertLedgerSync(db, {
    userId: entry.userId,
    userPlanId: entry.id,
    apiKeyId,
    usageId,
    requestKey,
    deltaNanoUsd: -amount,
    kind: "charge",
    meta: { pass },
    createdAt: at,
  });

  // Window bookkeeping. Pass-2 amounts count too: the spec requires the spend to
  // be recorded so the plan is blocked for the NEXT request (an admitted request
  // is always paid, D4).
  const atMs = new Date(at).getTime();
  for (const limit of entry.limits ?? []) {
    const state = entry.windows?.[limit.hours] ?? null;
    const closedAtMs = state ? new Date(state.startedAt).getTime() + limit.hours * HOUR_MS : null;
    const isOpen = state != null && Number.isFinite(closedAtMs) && atMs < closedAtMs;

    if (isOpen) {
      const spent = nano(state.spentNanoUsd) + amount;
      db.run(
        `UPDATE userPlanWindows SET spentNanoUsd = ?, updatedAt = ? WHERE userPlanId = ? AND hours = ?`,
        [spent, at, entry.id, limit.hours]
      );
      // Keep the in-memory copy in step so a second take against the same plan in
      // this same charge sees the updated spend.
      state.spentNanoUsd = spent;
    } else {
      // Opening a new window: an absent row is inserted, a closed one is reset.
      db.run(
        `INSERT INTO userPlanWindows(userPlanId, hours, startedAt, spentNanoUsd, updatedAt)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(userPlanId, hours) DO UPDATE SET
           startedAt = excluded.startedAt,
           spentNanoUsd = excluded.spentNanoUsd,
           updatedAt = excluded.updatedAt`,
        [entry.id, limit.hours, at, amount, at]
      );
      if (!entry.windows) entry.windows = {};
      entry.windows[limit.hours] = { startedAt: at, spentNanoUsd: amount };
    }
  }
}

/**
 * Charge a completed request (spec plan-queue-billing "Charging a completed
 * request", design D4/D9).
 *
 * Pass 1 walks the queue taking min(left, credit, tightest room) — this is what
 * splits a charge at a window edge. Pass 2 walks it again ignoring windows, so a
 * request that was admitted is always paid. Anything still left becomes debt.
 *
 * Idempotent on `requestKey`: a key that already has a ledger row means this
 * request was billed, and NOTHING is written — that is what stops a retry from
 * double-counting window spend.
 *
 * @returns {{ charged:number, alreadyCharged:boolean, parts:Array, debtNanoUsd:number }}
 */
export function chargeSync(db, {
  userId,
  apiKeyId = null,
  usageId = null,
  requestKey,
  costNanoUsd = 0,
  nowIso: atArg = null,
} = {}) {
  if (!db) throw new Error("chargeSync requires the db adapter");
  if (!userId) throw new Error("chargeSync requires a userId");
  const at = atArg || nowIso();

  if (requestKey) {
    const existing = db.get(`SELECT id FROM creditLedger WHERE requestKey = ?`, [requestKey]);
    if (existing) {
      return { charged: 0, alreadyCharged: true, parts: [], debtNanoUsd: getDebtNanoSync(db, userId) };
    }
  }

  const cost = Math.max(0, nano(costNanoUsd));
  if (cost === 0) {
    return { charged: 0, alreadyCharged: false, parts: [], debtNanoUsd: getDebtNanoSync(db, userId) };
  }

  const nowMs = new Date(at).getTime();
  // Fresh read: the queue is re-evaluated at charge time, never pinned at
  // admission (D4), so concurrent streams are bounded by the plan that can pay.
  const queue = listQueueSync(db, userId, at);

  const parts = [];
  let remaining = cost;
  let ledgerRows = 0;

  const rowKey = () => {
    if (!requestKey) return null;
    return ledgerRows === 0 ? requestKey : `${requestKey}#${ledgerRows + 1}`;
  };

  // ── Pass 1: respect windows ───────────────────────────────────────────────
  for (const entry of queue) {
    if (remaining <= 0) break;
    if (nano(entry.creditRemainingNanoUsd) <= 0) continue;
    const state = evaluatePlan(entry, nowMs);
    const room = state.roomNanoUsd; // null = unlimited
    const capacity = room == null ? remaining : Math.min(remaining, room);
    const take = Math.min(capacity, nano(entry.creditRemainingNanoUsd));
    if (take <= 0) continue;

    applyTake(db, { entry, amount: take, requestKey: rowKey(), usageId, apiKeyId, at, pass: 1 });
    ledgerRows += 1;
    remaining -= take;
    parts.push({ userPlanId: entry.id, amountNanoUsd: take, pass: 1 });
  }

  // ── Pass 2: ignore windows ────────────────────────────────────────────────
  if (remaining > 0) {
    for (const entry of queue) {
      if (remaining <= 0) break;
      // applyTake already wrote the post-pass-1 balance back into the entry, so
      // this is the LIVE remainder. Subtracting pass 1 again here (as an earlier
      // version did) double-counted it — pass 1 was deducted twice from a base
      // that also still included it.
      const available = Math.max(0, nano(entry.creditRemainingNanoUsd));
      if (available <= 0) continue;

      const take = Math.min(available, remaining);
      applyTake(db, { entry, amount: take, requestKey: rowKey(), usageId, apiKeyId, at, pass: 2 });
      ledgerRows += 1;
      remaining -= take;
      parts.push({ userPlanId: entry.id, amountNanoUsd: take, pass: 2 });
    }
  }

  // ── Remainder becomes debt ────────────────────────────────────────────────
  let debtNanoUsd = getDebtNanoSync(db, userId);
  if (remaining > 0) {
    debtNanoUsd = debtNanoSyncAdd(db, userId, remaining);
    insertLedgerSync(db, {
      userId,
      userPlanId: null,
      apiKeyId,
      usageId,
      requestKey: rowKey(),
      deltaNanoUsd: -remaining,
      kind: "charge",
      meta: { overdraft: true },
      createdAt: at,
    });
    remaining = 0;
  }

  return { charged: cost, alreadyCharged: false, parts, debtNanoUsd };
}

function debtNanoSyncAdd(db, userId, amount) {
  const next = getDebtNanoSync(db, userId) + amount;
  setDebtNanoSync(db, userId, next);
  return getDebtNanoSync(db, userId);
}

/**
 * Persist a customer's chosen order (spec "Reordering the queue").
 *
 * The submitted list must be EXACTLY the current queue: a missing or extra id means
 * the page was looking at a stale queue (a plan expired, a grant landed), and
 * applying a stale order silently would move money between pools the customer did
 * not choose. That case is 409 `queue_changed`.
 *
 * @returns {{ok:true}|{ok:false,status:400|409,code:string}}
 */
export function reorderSync(db, userId, orderedIds, { actor = "customer", nowIso: atArg = null } = {}) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return { ok: false, status: 400, code: "invalid_order" };
  }
  if (!orderedIds.every((id) => typeof id === "string" && id.length > 0)) {
    return { ok: false, status: 400, code: "invalid_order" };
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    return { ok: false, status: 400, code: "invalid_order" };
  }

  const at = atArg || nowIso();
  const queue = listQueueSync(db, userId, at);
  const currentIds = queue.map((entry) => entry.id);
  const currentSet = new Set(currentIds);
  const submittedSet = new Set(orderedIds);

  if (currentIds.length !== orderedIds.length) {
    return { ok: false, status: 409, code: "queue_changed" };
  }
  for (const id of orderedIds) if (!currentSet.has(id)) return { ok: false, status: 409, code: "queue_changed" };
  for (const id of currentIds) if (!submittedSet.has(id)) return { ok: false, status: 409, code: "queue_changed" };

  orderedIds.forEach((id, index) => {
    db.run(`UPDATE userPlans SET priority = ? WHERE id = ? AND userId = ?`, [index + 1, id, userId]);
  });

  insertAuditSync(db, {
    userId,
    actor,
    action: "queue_reordered",
    details: { before: currentIds, after: [...orderedIds] },
    now: at,
  });

  return { ok: true };
}

/**
 * The queue as both UIs need it: entries merged with their evaluation plus the
 * one status label the row shows.
 *
 * `statusLabel` is `paying` for the plan admission would pick now, `blocked` for a
 * window-blocked one and `waiting` otherwise. No UI computes eligibility itself —
 * the dashboard and the customer page must never disagree with the request path.
 */
export function queueViewSync(db, userId, nowIsoArg = null) {
  const at = nowIsoArg || nowIso();
  const nowMs = new Date(at).getTime();
  const queue = listQueueSync(db, userId, at);

  let payingId = null;
  for (const entry of queue) {
    if (evaluatePlan(entry, nowMs).eligible) { payingId = entry.id; break; }
  }

  return queue.map((entry) => {
    const state = evaluatePlan(entry, nowMs);
    const statusLabel = entry.id === payingId ? "paying" : state.blocked ? "blocked" : "waiting";
    return { ...entry, ...state, statusLabel };
  });
}

/**
 * Recompute one plan's window state from its ledger rows (design D9).
 *
 * The counters in `userPlanWindows` are what admission reads; this function proves
 * they equal what the ledger says, by replaying the same open/close rule. Used by
 * the consistency test (task 9.6 case 14) and by any future repair tool. Backfill
 * rows are excluded: that pass deliberately never touched windows (D10).
 *
 * @returns {Object<number, {startedAt:string, spentNanoUsd:number}>}
 */
export function rebuildWindowsSync(db, userPlanId, nowIsoArg = null) {
  const at = nowIsoArg || nowIso();
  const nowMs = new Date(at).getTime();

  const plan = db.get(`SELECT limits FROM userPlans WHERE id = ?`, [userPlanId]);
  const limits = parseLimits(plan?.limits);
  if (limits.length === 0) return {};

  const rows = db.all(
    `SELECT deltaNanoUsd, createdAt, meta FROM creditLedger
      WHERE userPlanId = ? AND kind = 'charge'
      ORDER BY createdAt ASC, id ASC`,
    [userPlanId]
  );

  const out = {};
  for (const limit of limits) out[limit.hours] = { startedAt: null, spentNanoUsd: 0 };

  for (const row of rows) {
    let meta = null;
    try { meta = row.meta ? JSON.parse(row.meta) : null; } catch { meta = null; }
    if (meta?.backfill) continue;

    const amount = Math.abs(nano(row.deltaNanoUsd));
    if (amount === 0) continue;
    const atMs = new Date(row.createdAt).getTime();
    if (!Number.isFinite(atMs)) continue;

    for (const limit of limits) {
      const state = out[limit.hours];
      const closedAtMs = state.startedAt ? new Date(state.startedAt).getTime() + limit.hours * HOUR_MS : null;
      const isOpen = state.startedAt != null && atMs < closedAtMs;
      if (isOpen) {
        state.spentNanoUsd += amount;
      } else {
        state.startedAt = row.createdAt;
        state.spentNanoUsd = amount;
      }
    }
  }

  // A window whose close time is already in the past reads as closed: its spend is
  // zero and no window is open until the next charge.
  for (const limit of limits) {
    const state = out[limit.hours];
    if (!state.startedAt) continue;
    const closedAtMs = new Date(state.startedAt).getTime() + limit.hours * HOUR_MS;
    if (nowMs >= closedAtMs) {
      out[limit.hours] = { startedAt: null, spentNanoUsd: 0 };
    }
  }

  return out;
}

/**
 * One-time back-charge of tenant usage rows that were never charged (design D10
 * step 4, spec "One-time back-charge of uncharged usage").
 *
 * For each candidate row, ascending time:
 *   * plans considered = that user's purchases with credit left, started at or
 *     before the usage timestamp, expiring after it, not revoked, in queue order;
 *   * take credit only — windows are NOT touched, because the windows these
 *     requests belonged to are long gone and reconstructing them would block
 *     plans on charges that already happened;
 *   * remainder becomes debt;
 *   * ledger rows are tagged `meta.backfill` with the original usage time so
 *     support can find and, if decided, compensate them.
 *
 * Runs inside the caller's transaction and is idempotent: a row that already has
 * its `usage:<id>` ledger row is skipped.
 *
 * @returns {{ rows:number, chargedNanoUsd:number, debtNanoUsd:number }}
 */
export function runBackfillSync(db, { sinceIso, nowIso: atArg = null } = {}) {
  const at = atArg || nowIso();
  const since = sinceIso || "1970-01-01T00:00:00.000Z";

  // Candidates: customer-key usage, cost > 0, at/after the cut-off, with no charge
  // ledger row yet. The NOT EXISTS is the idempotency guarantee.
  const candidates = db.all(
    `SELECT uh.id, uh.timestamp, uh.costNanoUsd, uh.cost, uh.apiKeyId, ak.userId
       FROM usageHistory uh
       JOIN apiKeys ak ON ak.id = uh.apiKeyId AND ak.userId IS NOT NULL
      WHERE COALESCE(uh.costNanoUsd, 0) > 0
        AND uh.timestamp >= ?
        AND NOT EXISTS (
          SELECT 1 FROM creditLedger cl WHERE cl.requestKey = 'usage:' || uh.id
        )
      ORDER BY uh.timestamp ASC, uh.id ASC`,
    [since]
  );

  let rows = 0;
  let chargedNanoUsd = 0;
  let debtNanoUsd = 0;

  for (const row of candidates) {
    const usageAt = row.timestamp;
    // Plans that existed at the usage instant, in queue order.
    const plans = db.all(
      `SELECT id, userId, creditRemainingNanoUsd, limits
         FROM userPlans
        WHERE userId = ?
          AND creditRemainingNanoUsd > 0
          AND status <> 'revoked'
          AND startsAt <= ?
          AND expiresAt > ?
        ORDER BY (priority IS NULL) ASC, priority ASC, expiresAt ASC, createdAt ASC, id ASC`,
      [row.userId, usageAt, usageAt]
    );

    let remaining = nano(row.costNanoUsd);
    let ledgerRows = 0;
    const rowKey = () => (ledgerRows === 0 ? `usage:${row.id}` : `usage:${row.id}#${ledgerRows + 1}`);
    const meta = { backfill: true, usageTimestamp: usageAt };

    for (const plan of plans) {
      if (remaining <= 0) break;
      const available = nano(plan.creditRemainingNanoUsd);
      if (available <= 0) continue;
      const take = Math.min(available, remaining);
      const left = available - take;
      if (left === 0) {
        db.run(`UPDATE userPlans SET creditRemainingNanoUsd = 0, status = 'exhausted' WHERE id = ?`, [plan.id]);
      } else {
        db.run(`UPDATE userPlans SET creditRemainingNanoUsd = ? WHERE id = ?`, [left, plan.id]);
      }
      insertLedgerSync(db, {
        userId: row.userId,
        userPlanId: plan.id,
        apiKeyId: row.apiKeyId,
        usageId: row.id,
        requestKey: rowKey(),
        deltaNanoUsd: -take,
        kind: "charge",
        meta,
        createdAt: at,
      });
      ledgerRows += 1;
      remaining -= take;
      chargedNanoUsd += take;
    }

    if (remaining > 0) {
      const next = getDebtNanoSync(db, row.userId) + remaining;
      setDebtNanoSync(db, row.userId, next);
      insertLedgerSync(db, {
        userId: row.userId,
        userPlanId: null,
        apiKeyId: row.apiKeyId,
        usageId: row.id,
        requestKey: rowKey(),
        deltaNanoUsd: -remaining,
        kind: "charge",
        meta: { ...meta, overdraft: true },
        createdAt: at,
      });
      debtNanoUsd += remaining;
      remaining = 0;
    }

    rows += 1;
  }

  return { rows, chargedNanoUsd, debtNanoUsd };
}

export { serializeLimits, parseLimits };
