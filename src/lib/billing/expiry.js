// Billing janitor — expires stale plans and forfeits their remaining credit.
//
// Same shape as src/sse/services/backgroundTokenRefresh.js: one unref'd interval,
// a re-entry guard so a slow sweep cannot stack ticks, and fail-open everywhere
// (a DB hiccup must never kill the interval or crash the server).
//
// Registration: the integrator adds one line to
// src/shared/services/initializeApp.js's runHeavyStartup():
//   import("@/lib/billing/expiry.js").then(({ startBillingJanitor }) => startBillingJanitor())
// Until then nothing sweeps, and `getAvailableNanoUsd` still refuses expired
// credit (it filters on expiresAt), so an unswept plan cannot be spent.

import { runExpirySweep } from "@/lib/db/repos/billingRepo.js";

export const BILLING_JANITOR_INTERVAL_MS = 5 * 60 * 1000;
export const BILLING_JANITOR_INITIAL_DELAY_MS = 30 * 1000;

// Module-level state survives only until the module is re-evaluated; Next.js dev
// hot reload can therefore start a second interval. globalThis is the stable
// home, matching the pattern used by the DB driver.
const g = (globalThis.__billingJanitor ??= {
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

/** One sweep. Never throws. Exported for tests and for a manual trigger. */
export async function runBillingJanitorTick() {
  if (g.tickRunning) return null;
  g.tickRunning = true;
  try {
    const now = new Date().toISOString();
    const result = await runExpirySweep(now);
    g.lastRunAt = now;
    g.lastResult = result;
    g.lastError = null;
    if (result.expired > 0) {
      console.log(
        `[BillingJanitor] expired ${result.expired} plan(s), forfeited ${result.forfeitedNanoUsd} nanoUSD`
      );
    }
    return result;
  } catch (err) {
    g.lastError = err?.message || String(err);
    console.warn("[BillingJanitor] sweep failed (swallowed):", g.lastError);
    return null;
  } finally {
    g.tickRunning = false;
  }
}

/**
 * Start the interval. Idempotent — returns false when already running.
 * @param {{ intervalMs?: number, initialDelayMs?: number }} [opts]
 * @returns {boolean} true if this call started it
 */
export function startBillingJanitor({ intervalMs, initialDelayMs } = {}) {
  if (g.started) return false;
  if (isTruthyEnv(process.env.DISABLE_BILLING_JANITOR)) return false;
  // `next build` evaluates route modules to collect their config. Starting a
  // sweeper there would open a database in the build environment for no reason,
  // so the phase check is explicit rather than relying on the unref.
  if (process.env.NEXT_PHASE === "phase-production-build") return false;

  g.started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : BILLING_JANITOR_INTERVAL_MS;
  const delay = Number.isFinite(initialDelayMs) && initialDelayMs >= 0
    ? initialDelayMs
    : BILLING_JANITOR_INITIAL_DELAY_MS;

  const safeTick = () => {
    runBillingJanitorTick().catch((err) => {
      console.warn("[BillingJanitor] unhandled tick rejection (swallowed):", err?.message || err);
    });
  };

  g.initialTimeout = setTimeout(safeTick, delay);
  if (g.initialTimeout.unref) g.initialTimeout.unref();

  g.interval = setInterval(safeTick, period);
  if (g.interval.unref) g.interval.unref();

  return true;
}

export function stopBillingJanitor() {
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
export function getBillingJanitorStatus() {
  return {
    started: g.started,
    intervalMs: BILLING_JANITOR_INTERVAL_MS,
    tickRunning: g.tickRunning,
    lastRunAt: g.lastRunAt,
    lastResult: g.lastResult,
    lastError: g.lastError,
  };
}
