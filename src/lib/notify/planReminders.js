// Periodic Telegram reminders (spec telegram-notify): a plan about to expire
// (3 days, then 24 hours before) and credit running low (under 10% left).
//
// One row in telegramNotices per reminder sent, so a reminder goes out once.
// Same scheduler shape as src/lib/billing/expiry.js: unref'd interval, re-entry
// guard, fail-open. Relative imports only: tests import this module directly.

import { getAdapter } from "../db/driver.js";
import { messages, notifyCustomer } from "./customerTelegram.js";

export const REMINDER_INTERVAL_MS = 10 * 60 * 1000;
export const REMINDER_INITIAL_DELAY_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Credit is "low" when less than this fraction of the account's current credit is left. */
export const LOW_CREDIT_FRACTION = 0.1;

// Outcomes after which the reminder counts as handled. A transient failure
// (network, flood limit, bot not configured) leaves it for the next tick; any
// other Telegram error would fail the same way again, so it is not retried.
const SETTLED = new Set(["opted_out", "blocked", "not_linked", "inactive", "telegram_error"]);

/**
 * Reminders due at `nowMs`, not yet sent. Only linked, reachable accounts.
 * @returns {Array<{ kind: string, refId: string, userId: string, build: Function }>}
 */
export function findDueRemindersSync(db, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  const in3d = new Date(nowMs + 3 * DAY_MS).toISOString();
  const due = [];

  // Expiry: a running plan ending within 3 days, unless another plan of the
  // account runs past it (a queued renewal or a longer plan keeps service going).
  const expiring = db.all(
    `SELECT up.id, up.userId, up.startsAt, up.expiresAt, p.name AS planName
       FROM userPlans up
       JOIN users u ON u.id = up.userId
       LEFT JOIN plans p ON p.id = up.planId
      WHERE u.telegramUserId IS NOT NULL AND u.telegramDmBlockedAt IS NULL AND u.status = 'active'
        AND up.status = 'active' AND up.startsAt <= ? AND up.expiresAt > ? AND up.expiresAt <= ?
        AND NOT EXISTS (
          SELECT 1 FROM userPlans other
           WHERE other.userId = up.userId AND other.id <> up.id
             AND other.status = 'active' AND other.expiresAt > up.expiresAt
        )`,
    [now, now, in3d]
  );
  for (const plan of expiring) {
    const msLeft = new Date(plan.expiresAt).getTime() - nowMs;
    const kind = msLeft <= DAY_MS ? "expire_1d" : "expire_3d";
    // A plan no longer than the window (a 2-day gift, a 1-day grant) would be
    // "about to expire" the moment it lands: only warn when it outlived the window.
    const lengthMs = new Date(plan.expiresAt).getTime() - new Date(plan.startsAt).getTime();
    if (lengthMs <= (kind === "expire_1d" ? DAY_MS : 3 * DAY_MS)) continue;
    due.push({
      kind,
      // Keyed on the end date too: an admin extension earns a fresh reminder.
      refId: `${plan.id}:${plan.expiresAt}`,
      userId: plan.userId,
      build: messages.planExpiring({
        planName: plan.planName,
        expiresAt: plan.expiresAt,
        daysLeft: kind === "expire_1d" ? 1 : Math.ceil(msLeft / DAY_MS),
      }),
    });
  }

  // Credit: across the account's running plans, since usage drains them in
  // queue order — one empty plan with a full one behind it is not "low".
  const current = db.all(
    `SELECT up.id, up.userId, up.creditTotalNanoUsd, up.creditRemainingNanoUsd, up.unlimitedCredit,
            up.status, up.startsAt, up.createdAt, p.name AS planName
       FROM userPlans up
       JOIN users u ON u.id = up.userId
       LEFT JOIN plans p ON p.id = up.planId
      WHERE u.telegramUserId IS NOT NULL AND u.telegramDmBlockedAt IS NULL AND u.status = 'active'
        AND up.status IN ('active', 'exhausted') AND up.startsAt <= ? AND up.expiresAt > ?
      ORDER BY up.userId, up.startsAt`,
    [now, now]
  );
  const byUser = new Map();
  for (const row of current) {
    if (!byUser.has(row.userId)) byUser.set(row.userId, []);
    byUser.get(row.userId).push(row);
  }
  for (const [userId, plans] of byUser) {
    if (plans.some((plan) => plan.unlimitedCredit && plan.status === "active")) continue;
    const total = plans.reduce((sum, plan) => sum + (Number(plan.creditTotalNanoUsd) || 0), 0);
    const remaining = plans
      .filter((plan) => plan.status === "active")
      .reduce((sum, plan) => sum + (Number(plan.creditRemainingNanoUsd) || 0), 0);
    if (total <= 0 || remaining >= total * LOW_CREDIT_FRACTION) continue;
    // Keyed on the newest plan: buying more starts a fresh allowance to warn
    // about, while an old plan expiring out of the set does not repeat the warning.
    const newest = plans.reduce((a, b) => (String(b.createdAt || b.startsAt) > String(a.createdAt || a.startsAt) ? b : a));
    const refId = `${userId}:${newest.id}`;
    due.push({
      kind: "credit_low",
      refId,
      userId,
      build: messages.creditLow({
        planName: plans[plans.length - 1].planName,
        remainingNanoUsd: remaining,
        totalNanoUsd: total,
      }),
    });
  }

  if (!due.length) return due;
  return due.filter(
    (item) => !db.get(`SELECT 1 AS x FROM telegramNotices WHERE kind = ? AND refId = ?`, [item.kind, item.refId])
  );
}

function recordNoticeSync(db, item, nowIso) {
  db.run(
    `INSERT OR IGNORE INTO telegramNotices(userId, kind, refId, createdAt) VALUES(?, ?, ?, ?)`,
    [item.userId, item.kind, item.refId, nowIso]
  );
  // The 1-day reminder supersedes the 3-day one: never send it afterwards.
  if (item.kind === "expire_1d") {
    db.run(
      `INSERT OR IGNORE INTO telegramNotices(userId, kind, refId, createdAt) VALUES(?, 'expire_3d', ?, ?)`,
      [item.userId, item.refId, nowIso]
    );
  }
}

const g = (globalThis.__telegramReminders ??= {
  started: false,
  interval: null,
  initialTimeout: null,
  tickRunning: false,
  lastRunAt: null,
  lastError: null,
});

/** One pass. Never throws. Returns how many reminders were sent. */
export async function runReminderTick(nowMs = Date.now()) {
  if (g.tickRunning) return null;
  g.tickRunning = true;
  let sent = 0;
  try {
    const db = await getAdapter();
    for (const item of findDueRemindersSync(db, nowMs)) {
      const result = await notifyCustomer(item.userId, "expiry", item.build);
      if (result.ok) sent += 1;
      if (result.ok || SETTLED.has(result.reason)) recordNoticeSync(db, item, new Date().toISOString());
      if (result.reason === "not_configured") break;
      if (result.reason === "rate_limited") break; // resume next tick
    }
    g.lastRunAt = new Date(nowMs).toISOString();
    g.lastError = null;
    return sent;
  } catch (error) {
    g.lastError = error?.message || String(error);
    console.warn("[TelegramReminders] tick failed (swallowed):", g.lastError);
    return null;
  } finally {
    g.tickRunning = false;
  }
}

function isTruthyEnv(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Start the interval. Idempotent; skipped during `next build`. */
export function startTelegramReminders() {
  if (g.started) return false;
  if (isTruthyEnv(process.env.DISABLE_TELEGRAM_REMINDERS)) return false;
  if (process.env.NEXT_PHASE === "phase-production-build") return false;
  g.started = true;
  const safeTick = () => {
    runReminderTick().catch(() => {});
  };
  g.initialTimeout = setTimeout(safeTick, REMINDER_INITIAL_DELAY_MS);
  g.initialTimeout.unref?.();
  g.interval = setInterval(safeTick, REMINDER_INTERVAL_MS);
  g.interval.unref?.();
  return true;
}
