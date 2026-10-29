// Payment poller: expiry sweep + one fetch per provider per interval (design D6).
//
// Same shape as `src/lib/billing/expiry.js`: one unref'd interval, a re-entry
// guard so a slow tick cannot stack, and fail-open everywhere — a bank outage must
// never kill the interval or crash the server.
//
// Started from `src/shared/services/initializeApp.js`. `DISABLE_PAYMENT_POLLER=1`
// turns it off, and `next build` never starts it (evaluating route modules during a
// build must not open a database or call a bank).
//
// Per-tick contract:
//   1. expire pending gateway orders past their window;
//   2. for every ACTIVE provider that is due, fetch, ingest each transaction, and
//      record `lastPolledAt` + `lastError`.
// Providers run independently and one at a time each: two ticks cannot fetch the
// same provider concurrently, so a slow bank cannot double-store transactions.
// Relative imports throughout (design D2): the engine under src/lib/payments/ is
// loaded by plain `node --test`, where an `@/` alias does not resolve.
import { getAdapter } from "../db/driver.js";
import { getSettings } from "../db/repos/settingsRepo.js";
import { listProvidersWithSecrets, recordPollResult } from "../db/repos/paymentProvidersRepo.js";
import { expireGatewayOrdersSync } from "./checkout.js";
import { formatVnd, formatUsdt } from "./amounts.js";
import { ingestTransactionSync } from "./reconcile.js";
import { fetchSepayTransactions } from "./providers/sepay.js";
import { fetchWeb2mTransactions } from "./providers/web2m.js";
import { fetchBinanceTransactions } from "./providers/binance.js";
import {
  fetchAcbTransactions,
  acbCredentialFingerprint,
  resolveAcbIdentity,
  ACB_DEFAULT_BASE_URL,
} from "./providers/acb.js";
import { makeKv } from "../db/helpers/kvStore.js";
import { encryptSecret, decryptSecret, isEncrypted } from "../crypto/secrets.js";

export const POLLER_INTERVAL_MS = 15 * 1000;
export const POLLER_INITIAL_DELAY_MS = 20 * 1000;
/** Floor for a provider's own interval, and the ACB-specific floor. */
export const MIN_INTERVAL_SECONDS = 15;
export const ACB_MIN_INTERVAL_SECONDS = 30;

const ACB_TOKEN_SCOPE = "payments:acb-token";

const g = (globalThis.__paymentPoller ??= {
  started: false,
  interval: null,
  initialTimeout: null,
  tickRunning: false,
  inFlight: new Set(),
  lastRunAt: null,
  lastResult: null,
  lastError: null,
});

function isTruthyEnv(value) {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * ACB token store backed by the `kv` table (design D1/7.3).
 *
 * The stored value is `encryptSecret(JSON { token, fingerprint, savedAt })`. The
 * fingerprint binds the token to the credentials it was minted for: a changed
 * username, password, device or base URL makes the entry unusable, which is what
 * the "changing credentials invalidates the cached token" requirement needs.
 */
export function createAcbTokenStore(providerId, { fingerprint, kv = null } = {}) {
  const store = kv ?? makeKv(ACB_TOKEN_SCOPE);
  return {
    async get() {
      try {
        const raw = await store.get(providerId, null);
        if (!raw || typeof raw !== "object" || !raw.value) return null;
        const plain = isEncrypted(raw.value) ? decryptSecret(raw.value) : raw.value;
        if (!plain) return null;
        const parsed = JSON.parse(plain);
        if (!parsed || typeof parsed.token !== "string") return null;
        return { token: parsed.token, fingerprint: parsed.fingerprint ?? null, savedAt: parsed.savedAt ?? null };
      } catch {
        // A corrupt or undecryptable entry reads as "no token": the poller logs in
        // again instead of failing the tick.
        return null;
      }
    },
    async set(token) {
      const payload = JSON.stringify({
        token,
        fingerprint: fingerprint ?? null,
        savedAt: new Date().toISOString(),
      });
      await store.set(providerId, { value: encryptSecret(payload) });
    },
    async clear() {
      try {
        await store.remove(providerId);
      } catch {
        // nothing to clear
      }
    },
  };
}

/**
 * The fingerprint a provider's token is bound to. Exported so
 * `paymentProvidersRepo.updateProvider`'s caller can clear the cache on a
 * credential change without recomputing it by hand.
 */
export function acbFingerprintFor(provider, env = process.env) {
  // Identity resolution is the same call the fetcher makes, so a token cached
  // here can never look valid to the fetcher under a different device id.
  const identity = resolveAcbIdentity(provider?.config ?? {}, env);
  return acbCredentialFingerprint({
    username: provider?.secrets?.username ?? "",
    password: provider?.secrets?.password ?? "",
    deviceId: identity.deviceId,
    baseUrl: String(provider?.config?.baseUrl || env?.ACB_BASE_URL || ACB_DEFAULT_BASE_URL).replace(/\/+$/, ""),
  });
}

/** Clear a provider's cached ACB token (called when its credentials change). */
export async function clearAcbToken(providerId) {
  await makeKv(ACB_TOKEN_SCOPE).remove(providerId);
}

function intervalSecondsFor(provider) {
  const configured = Number(provider.pollIntervalSeconds) || 30;
  const floor = provider.kind === "acb" ? ACB_MIN_INTERVAL_SECONDS : MIN_INTERVAL_SECONDS;
  return Math.max(configured, floor);
}

function isDue(provider, nowMs) {
  if (!provider.lastPolledAt) return true;
  const last = Date.parse(provider.lastPolledAt);
  if (!Number.isFinite(last)) return true;
  return last + intervalSecondsFor(provider) * 1000 <= nowMs;
}

/** Which fetcher handles a kind, and whether it is pollable at all. */
function fetcherFor(provider) {
  switch (provider.kind) {
    case "sepay":
      // SePay pushes webhooks; polling is a backstop and needs an API token.
      if (!provider.secrets?.apiToken) return null;
      return (args) => fetchSepayTransactions({ ...args });
    case "web2m":
      return (args) => fetchWeb2mTransactions({ ...args });
    case "binance":
      return (args) => fetchBinanceTransactions({ ...args });
    case "acb":
      return (args) => fetchAcbTransactions({ ...args });
    default:
      return null;
  }
}

/**
 * Announce one outcome (spec payment-reconciliation: "An admin notification SHALL
 * be sent for every matched and every needs_review transaction"). Imported
 * dynamically and fully wrapped: the money is already recorded.
 */
async function sendNotification({ outcome, provider, tx, orderId }) {
  try {
    const mod = await import("@/lib/notify/telegram");
    const amountText = tx.currency === "VND"
      ? `${formatVnd(tx.amount)}`
      : `${formatUsdt(tx.amount)} USDT`;

    if (outcome.outcome === "matched") {
      const db = await getAdapter();
      const row = orderId
        ? db.get(
            `SELECT COALESCE(u.email, o.emailSnapshot) AS email, p.name AS planName
               FROM orders o
               LEFT JOIN users u ON u.id = o.userId
               LEFT JOIN plans p ON p.id = o.planId
              WHERE o.id = ?`,
            [orderId]
          )
        : null;
      if (typeof mod?.notifyPaymentMatched === "function") {
        await mod.notifyPaymentMatched({
          email: row?.email ?? null,
          planName: row?.planName ?? null,
          amountText,
          providerName: provider.name,
          orderId,
        });
      }
      return;
    }
    if (typeof mod?.notifyPaymentNeedsReview === "function") {
      await mod.notifyPaymentNeedsReview({
        amountText,
        content: tx.content,
        reason: outcome.reason,
        providerName: provider.name,
      });
    }
  } catch (error) {
    console.warn("[PaymentPoller] notification skipped:", error?.message || error);
  }
}

/**
 * One tick. Never throws. Exported for tests and for a manual trigger.
 *
 * @param {{ now?: () => number, fetchImpl?: Function }} [options]
 */
export async function runPaymentPollerTick({ now = () => Date.now(), fetchImpl } = {}) {
  if (g.tickRunning) return null;
  g.tickRunning = true;
  const nowMs = now();
  const at = new Date(nowMs).toISOString();
  const result = { at, expired: 0, polled: [], errors: [] };

  try {
    const db = await getAdapter();
    const settings = await getSettings();

    // 1. Expiry first: an order past its window must stop being payable before a
    //    late payment can be matched against it as if it were still live.
    try {
      const expiredIds = db.transaction(() => expireGatewayOrdersSync(db, at));
      result.expired = expiredIds.length;
    } catch (error) {
      result.errors.push(`expiry: ${error?.message || error}`);
    }

    // 2. Providers.
    const providers = await listProvidersWithSecrets({ activeOnly: true });
    for (const provider of providers) {
      if (!isDue(provider, nowMs)) continue;
      if (g.inFlight.has(provider.id)) continue;

      const fetcher = fetcherFor(provider);
      if (!fetcher) {
        // A SePay provider without an API token is webhook-only by design; it is
        // neither an error nor a poll.
        await recordPollResult(provider.id, { at, error: null });
        continue;
      }

      g.inFlight.add(provider.id);
      try {
        const args = {
          config: provider.config ?? {},
          secrets: provider.secrets ?? {},
          fetchImpl,
          now,
        };
        if (provider.kind === "acb") {
          args.tokenStore = createAcbTokenStore(provider.id, { fingerprint: acbFingerprintFor(provider) });
        }

        const fetched = await fetcher(args);
        if (!fetched.ok) {
          await recordPollResult(provider.id, { at, error: fetched.error });
          result.errors.push(`${provider.kind}/${provider.id}: ${fetched.error}`);
          continue;
        }

        let matched = 0;
        let review = 0;
        let duplicates = 0;
        // Notifications are collected and sent AFTER the loop, outside the write
        // transactions (design D4 step 6): a Telegram call must never hold a
        // SQLite write lock or turn a stored payment into a failed one.
        const pendingNotifications = [];
        for (const tx of fetched.transactions) {
          try {
            // One transaction per write transaction: SQLite serializes writers, and
            // a single poisoned row must not roll back the approvals around it.
            const outcome = db.transaction(() => ingestTransactionSync(db, {
              provider,
              tx,
              via: "poll",
              nowIso: at,
              settings,
            }));
            if (outcome.outcome === "matched") {
              matched += 1;
              pendingNotifications.push({ outcome, provider, tx, orderId: outcome.orderId });
            } else if (outcome.outcome === "needs_review") {
              review += 1;
              pendingNotifications.push({ outcome, provider, tx, orderId: outcome.orderId });
            } else if (outcome.outcome === "duplicate") duplicates += 1;
          } catch (error) {
            result.errors.push(`${provider.kind}/${provider.id}: ${error?.message || error}`);
          }
        }

        await recordPollResult(provider.id, { at, error: null });
        for (const entry of pendingNotifications) {
          await sendNotification(entry).catch(() => {});
        }
        result.polled.push({
          providerId: provider.id,
          kind: provider.kind,
          fetched: fetched.transactions.length,
          matched,
          review,
          duplicates,
        });
      } catch (error) {
        await recordPollResult(provider.id, { at, error: error?.message || String(error) });
        result.errors.push(`${provider.kind}/${provider.id}: ${error?.message || error}`);
      } finally {
        g.inFlight.delete(provider.id);
      }
    }

    g.lastRunAt = at;
    g.lastResult = result;
    g.lastError = null;
    return result;
  } catch (error) {
    g.lastRunAt = at;
    g.lastError = error?.message || String(error);
    console.warn("[PaymentPoller] tick failed (swallowed):", g.lastError);
    return null;
  } finally {
    g.tickRunning = false;
  }
}

/**
 * Start the interval. Idempotent — returns false when already running.
 * @param {{ intervalMs?: number, initialDelayMs?: number, fetchImpl?: Function }} [options]
 */
export function startPaymentPoller({ intervalMs, initialDelayMs, fetchImpl } = {}) {
  if (g.started) return false;
  if (isTruthyEnv(process.env.DISABLE_PAYMENT_POLLER)) return false;
  if (process.env.NEXT_PHASE === "phase-production-build") return false;

  g.started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : POLLER_INTERVAL_MS;
  const delay = Number.isFinite(initialDelayMs) && initialDelayMs >= 0 ? initialDelayMs : POLLER_INITIAL_DELAY_MS;

  const safeTick = () => {
    runPaymentPollerTick({ fetchImpl }).catch((error) => {
      console.warn("[PaymentPoller] unhandled tick rejection (swallowed):", error?.message || error);
    });
  };

  g.initialTimeout = setTimeout(safeTick, delay);
  if (g.initialTimeout.unref) g.initialTimeout.unref();

  g.interval = setInterval(safeTick, period);
  if (g.interval.unref) g.interval.unref();

  return true;
}

export function stopPaymentPoller() {
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
export function getPaymentPollerStatus() {
  return {
    started: g.started,
    intervalMs: POLLER_INTERVAL_MS,
    tickRunning: g.tickRunning,
    inFlight: Array.from(g.inFlight),
    lastRunAt: g.lastRunAt,
    lastResult: g.lastResult,
    lastError: g.lastError,
  };
}
