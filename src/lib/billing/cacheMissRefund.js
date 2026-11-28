// Daily cache-miss refund sweep (change cache-miss-auto-refund, capability
// cache-miss-refund "Daily capped auto-refund").
//
// Same shape as src/lib/billing/expiry.js: one unref'd interval (daily instead of
// every 5 minutes), a re-entry guard, fail-open everywhere, a globalThis singleton
// so Next.js dev hot reload cannot start a second interval.
//
// Registration: the integrator adds one line to
// src/shared/services/initializeApp.js's runHeavyStartup():
//   import("@/lib/billing/cacheMissRefund.js").then(({ startCacheMissRefundSweeper }) => startCacheMissRefundSweeper())
// Until then detections accumulate as `pending` with no sweep running — safe (spec
// Migration Plan step 3).
//
// ── Why crediting a `refund`-kind ledger row is NOT enough (design decision #4,
//    tasks 3.3/3.4) ──
// `creditLedger` is an append-only RECORD of money movements; it is not itself the
// customer's spendable balance. The number that gates a request
// (`userPlans.creditRemainingNanoUsd`, read by `bookBalanceNanoSync` /
// `getAvailableNanoUsd`) is a column that `chargeSync`/`adjustCreditSync` mutate
// DIRECTLY — it is never derived by summing the ledger. `rebuildWindowsSync` (the
// one function that DOES replay the ledger) only ever reads `kind = 'charge'` rows,
// by design (its own comment: "counters recomputed from the ledger"), so a `refund`
// row would be invisible to it even if it did touch `userPlanWindows`. Posting only
// a ledger row would therefore record that a refund happened while leaving the
// customer unable to actually spend the money back — a `creditRemainingNanoUsd`
// direct update (the same technique `adjustCreditSync` uses for an admin credit
// adjustment) is required, and `refundIntoPlanSync` below does exactly that.
//
// `userPlanWindows` (the per-window RATE counters, e.g. "$50/6h") are deliberately
// NOT touched: they record that a request happened and spent window quota at the
// time it ran, which is still true after a later refund of its price — exactly how
// an `adjust` or `expire` row already behaves (neither nudges a window counter
// either). Reducing them on refund would let a customer effectively spend more than
// a window's limit by refund-and-respend, which is a bigger (and new) risk than the
// window briefly looking "fuller" than the current balance would suggest.
import { getAdapter } from "../db/driver.js";
import { getSettings } from "../db/repos/settingsRepo.js";
import { insertLedgerSync, nano } from "./ledger.js";
import { listQueueSync, evaluatePlan } from "./planQueue.js";
import {
  listPendingDetectionsSync,
  markDetectionRefundedSync,
  getDetectionByIdSync,
  rejectDetectionSync,
} from "../db/repos/cacheMissRepo.js";

function nowIso() {
  return new Date().toISOString();
}

/** "YYYY-MM-DD" of an ISO instant — the calendar day the per-user cap tracks. */
function dayKeyOf(iso) {
  return String(iso).slice(0, 10);
}

/**
 * Sum of what has ALREADY been auto-refunded to this user on the given calendar
 * day (earlier runs of the sweep, same day) — so re-running the sweep within one
 * day shrinks the remaining budget instead of granting a fresh cap each time.
 */
function alreadyAutoRefundedTodaySync(db, userId, atIso) {
  const key = dayKeyOf(atIso);
  const row = db.get(
    `SELECT COALESCE(SUM(refundNanoUsd), 0) AS total FROM cacheMissDetections
      WHERE userId = ? AND status = 'auto_refunded' AND substr(resolvedAt, 1, 10) = ?`,
    [userId, key]
  );
  return nano(row?.total);
}

/**
 * The charge that paid for one request: the creditLedger 'charge' row with the
 * largest magnitude for that usageId (a single request's cost can be split across
 * more than one purchase in rare cases — pass 1 / pass 2 / an image+dollar split;
 * the largest part is treated as "the" payer to reverse into, same simplification
 * design.md's "the same userPlanId the original charge used" assumes a single plan).
 * An overdraft charge (userPlanId NULL) is never picked — there is no plan balance
 * to restore for it.
 */
function findOriginalChargeSync(db, usageHistoryId) {
  const rows = db.all(
    `SELECT userPlanId, deltaNanoUsd FROM creditLedger
      WHERE usageId = ? AND kind = 'charge' AND userPlanId IS NOT NULL
      ORDER BY ABS(deltaNanoUsd) DESC LIMIT 1`,
    [usageHistoryId]
  );
  return rows[0] || null;
}

/** A userPlans row usable as a refund target: open, unexpired, dollar-denominated. */
function loadUsablePlanSync(db, userPlanId, atIso) {
  if (!userPlanId) return null;
  const row = db.get(
    `SELECT id, status, creditRemainingNanoUsd, expiresAt, unlimitedCredit, kind FROM userPlans WHERE id = ?`,
    [userPlanId]
  );
  if (!row) return null;
  if (Number(row.unlimitedCredit) === 1) return null; // nothing to add dollars to
  if ((row.kind || "llm") === "image") return null; // this request's refund is in dollars
  if (row.status !== "active" && row.status !== "exhausted") return null;
  if (!(new Date(row.expiresAt).getTime() > new Date(atIso).getTime())) return null;
  return row;
}

/**
 * The user's current active paying plan (same resolution a NEW request's charge
 * would use), for the fallback when the original plan is gone (design.md Risk #2).
 */
function resolveFallbackPlanSync(db, userId, atIso) {
  const nowMs = new Date(atIso).getTime();
  const queue = listQueueSync(db, userId, atIso);
  for (const entry of queue) {
    if (entry.kind === "image" || entry.unlimitedCredit) continue;
    if (evaluatePlan(entry, nowMs).eligible) return entry.id;
  }
  return null;
}

/**
 * Credit one detection's refund directly into a plan's spendable balance (the
 * "direct nudge" — see the module comment) and record it with a `refund`-kind
 * ledger row. SYNCHRONOUS — run inside the caller's db.transaction.
 *
 * @returns {{ ok: true, userPlanId: string, ledgerId: number, fallback: boolean } | { ok: false, reason: string }}
 */
export function refundIntoPlanSync(db, detection, atIso = null) {
  const at = atIso || nowIso();
  const charge = findOriginalChargeSync(db, detection.usageHistoryId);
  let plan = charge ? loadUsablePlanSync(db, charge.userPlanId, at) : null;
  let fallback = false;

  if (!plan) {
    const fallbackPlanId = resolveFallbackPlanSync(db, detection.userId, at);
    plan = fallbackPlanId ? loadUsablePlanSync(db, fallbackPlanId, at) : null;
    fallback = true;
  }

  if (!plan) return { ok: false, reason: "no_plan_to_credit" };

  const before = nano(plan.creditRemainingNanoUsd);
  const after = before + detection.refundNanoUsd;
  // A refund only ever moves a purchase up, never down, so the only status flip
  // possible is exhausted -> active (same rule adjustCreditSync uses).
  const status = plan.status === "exhausted" && after > 0 ? "active" : plan.status;
  db.run(`UPDATE userPlans SET creditRemainingNanoUsd = ?, status = ? WHERE id = ?`, [after, status, plan.id]);

  const ledgerId = insertLedgerSync(db, {
    userId: detection.userId,
    userPlanId: plan.id,
    apiKeyId: detection.apiKeyId,
    usageId: detection.usageHistoryId,
    // Idempotency against a rerun: a second attempt at the SAME detection collides
    // on this UNIQUE column and throws, which the sweep's per-detection try/catch
    // turns into "skip, keep going" rather than a double credit.
    requestKey: `cache-miss-refund:${detection.id}`,
    deltaNanoUsd: detection.refundNanoUsd,
    kind: "refund",
    meta: {
      reason: "cache_miss",
      detectionId: detection.id,
      ...(fallback ? { fallbackPlan: true } : {}),
    },
    createdAt: at,
  });

  return { ok: true, userPlanId: plan.id, ledgerId, fallback };
}

/**
 * One sweep, synchronous core (tests call this directly against a throwaway DB).
 * Groups pending detections by user, refunds in detection order up to that user's
 * remaining cap for the calendar day (earlier auto-refunds today already counted
 * against it), leaves the rest `pending`. One user's unusual failure (no plan to
 * credit into) is skipped, never aborts the run for other users or other
 * detections of the same user still under budget.
 *
 * @returns {{ usersConsidered: number, refunded: number, refundedNanoUsd: number, skipped: number }}
 */
export function runCacheMissRefundSweepSync(db, { dailyCapNanoUsd, nowIso: atArg = null } = {}) {
  if (!db) throw new Error("runCacheMissRefundSweepSync requires the db adapter");
  const at = atArg || nowIso();
  const cap = Math.max(0, nano(dailyCapNanoUsd));

  const pending = listPendingDetectionsSync(db); // oldest first, every user mixed
  const byUser = new Map();
  for (const detection of pending) {
    if (!byUser.has(detection.userId)) byUser.set(detection.userId, []);
    byUser.get(detection.userId).push(detection);
  }

  let refunded = 0;
  let refundedNanoUsd = 0;
  let skipped = 0;

  for (const [userId, detections] of byUser) {
    let budget = Math.max(0, cap - alreadyAutoRefundedTodaySync(db, userId, at));
    for (const detection of detections) {
      // In detection order, up to the remaining cap: the first one that would
      // overrun it, and everything after it, stay pending for this run (picked up
      // again the next run, or by an admin approval that bypasses the cap).
      if (detection.refundNanoUsd > budget) break;
      try {
        const result = refundIntoPlanSync(db, detection, at);
        if (!result.ok) {
          console.warn(`[cache-miss-refund] skipped ${detection.id}: ${result.reason}`);
          skipped += 1;
          continue;
        }
        markDetectionRefundedSync(db, detection.id, { status: "auto_refunded", ledgerId: result.ledgerId, resolvedAt: at });
        budget -= detection.refundNanoUsd;
        refunded += 1;
        refundedNanoUsd += detection.refundNanoUsd;
      } catch (e) {
        // A UNIQUE(requestKey) collision (already refunded by an earlier run) or any
        // other per-detection failure must never abort the rest of the sweep.
        console.error(`[cache-miss-refund] failed ${detection.id} (swallowed):`, e?.message || e);
        skipped += 1;
      }
    }
  }

  return { usersConsidered: byUser.size, refunded, refundedNanoUsd, skipped };
}

// ── Admin approve / reject (spec cache-miss-refund "Admin review page") ─────

/**
 * Approve a pending detection: posts its ledger row immediately, independent of
 * that user's daily cap for that day (the cap only throttles the AUTOMATIC path).
 */
export async function approveCacheMissDetection(id, { adminNote = null } = {}) {
  const db = await getAdapter();
  return db.transaction(() => {
    const detection = getDetectionByIdSync(db, id);
    if (!detection) return { ok: false, status: 404, error: "not_found" };
    if (detection.status !== "pending") return { ok: false, status: 409, error: "not_pending" };
    const at = nowIso();
    const result = refundIntoPlanSync(db, detection, at);
    if (!result.ok) return { ok: false, status: 409, error: result.reason };
    markDetectionRefundedSync(db, id, { status: "approved", ledgerId: result.ledgerId, resolvedAt: at });
    if (adminNote) db.run(`UPDATE cacheMissDetections SET adminNote = ? WHERE id = ?`, [adminNote, id]);
    return { ok: true, detection: getDetectionByIdSync(db, id) };
  });
}

/** Reject a pending detection: permanent, no ledger row, never revisited by the sweep. */
export async function rejectCacheMissDetection(id, { adminNote = null } = {}) {
  const db = await getAdapter();
  return db.transaction(() => {
    const detection = getDetectionByIdSync(db, id);
    if (!detection) return { ok: false, status: 404, error: "not_found" };
    if (detection.status !== "pending") return { ok: false, status: 409, error: "not_pending" };
    rejectDetectionSync(db, id, { adminNote });
    return { ok: true, detection: getDetectionByIdSync(db, id) };
  });
}

// ── Scheduling (same shape as expiry.js) ─────────────────────────────────────

export const CACHE_MISS_REFUND_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
export const CACHE_MISS_REFUND_INITIAL_DELAY_MS = 60 * 1000;

const g = (globalThis.__cacheMissRefundSweeper ??= {
  started: false,
  interval: null,
  initialTimeout: null,
  tickRunning: false,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
});

function isTruthyEnv(value) {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** One sweep, resolving the adapter and settings, inside one transaction. Never throws. */
export async function runCacheMissRefundSweepTick() {
  if (g.tickRunning) return null;
  g.tickRunning = true;
  try {
    const db = await getAdapter();
    const settings = await getSettings();
    const at = nowIso();
    const result = db.transaction(() =>
      runCacheMissRefundSweepSync(db, { dailyCapNanoUsd: settings.cacheMissRefundDailyCapNanoUsd, nowIso: at })
    );
    g.lastRunAt = at;
    g.lastResult = result;
    g.lastError = null;
    return result;
  } catch (err) {
    g.lastError = err?.message || String(err);
    console.warn("[CacheMissRefundSweeper] sweep failed (swallowed):", g.lastError);
    return null;
  } finally {
    g.tickRunning = false;
  }
}

/**
 * Start the daily interval. Idempotent — returns false when already running.
 * @param {{ intervalMs?: number, initialDelayMs?: number }} [opts]
 * @returns {boolean} true if this call started it
 */
export function startCacheMissRefundSweeper({ intervalMs, initialDelayMs } = {}) {
  if (g.started) return false;
  if (isTruthyEnv(process.env.DISABLE_CACHE_MISS_REFUND_SWEEP)) return false;
  if (process.env.NEXT_PHASE === "phase-production-build") return false;

  g.started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : CACHE_MISS_REFUND_INTERVAL_MS;
  const delay = Number.isFinite(initialDelayMs) && initialDelayMs >= 0
    ? initialDelayMs
    : CACHE_MISS_REFUND_INITIAL_DELAY_MS;

  const safeTick = () => {
    runCacheMissRefundSweepTick().catch((err) => {
      console.warn("[CacheMissRefundSweeper] unhandled tick rejection (swallowed):", err?.message || err);
    });
  };

  g.initialTimeout = setTimeout(safeTick, delay);
  if (g.initialTimeout.unref) g.initialTimeout.unref();

  g.interval = setInterval(safeTick, period);
  if (g.interval.unref) g.interval.unref();

  return true;
}

export function stopCacheMissRefundSweeper() {
  if (g.initialTimeout) {
    clearTimeout(g.initialTimeout);
    g.initialTimeout = null;
  }
  if (g.interval) {
    clearInterval(g.interval);
    g.interval = null;
  }
  g.started = false;
}

/** Observability for an admin page / health check. */
export function getCacheMissRefundSweeperStatus() {
  return {
    started: g.started,
    intervalMs: CACHE_MISS_REFUND_INTERVAL_MS,
    tickRunning: g.tickRunning,
    lastRunAt: g.lastRunAt,
    lastResult: g.lastResult,
    lastError: g.lastError,
  };
}
