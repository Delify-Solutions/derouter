// SePay webhook logic, independent of the Next.js transport (design D7).
//
// The route is a thin adapter over `handleSepayWebhook`: it reads the header and
// the raw text from a Request and returns `{ status, body }` as JSON. Keeping the
// decision here means the four documented answers (401 / 400 / 413 / 200) can be
// exercised with the exact bytes SePay sends, in a plain `node --test` process,
// without a Next.js runtime.
//
// Spec payment-reconciliation "SePay webhook" is the contract:
//   * only `Authorization: Apikey <key>` matching an ACTIVE sepay provider's key;
//   * record and reconcile the transaction, then answer `{success:true}` for every
//     authenticated request — including duplicates and review rows — so SePay does
//     not retry them.
//
// Relative imports only: no Next.js, no `@/` alias.
import { ingestTransactionSync } from "./reconcile.js";
import { normalizeSepayTransaction, verifyWebhookAuth } from "./providers/sepay.js";
import { formatVnd } from "./amounts.js";

export const MAX_BODY_BYTES = 64 * 1024;

/**
 * The active SePay provider whose webhook key verifies `authorization`, or null.
 * Synchronous: the caller passes the provider rows it already has (the route loads
 * them), which keeps this module free of the encrypted-secret repo.
 *
 * @param {string|null|undefined} authorization
 * @param {Array<{id:string, kind:string, name:string, config?:object, secrets?:object}>} providers
 */
export function findProviderForAuth(authorization, providers = []) {
  for (const provider of providers) {
    if (provider?.kind !== "sepay") continue;
    if (verifyWebhookAuth(authorization, provider.secrets?.webhookKey)) return provider;
  }
  return null;
}

/**
 * Handle one delivery.
 *
 * @param {{ headers: { get(name:string): string|null }, text(): Promise<string> }} request
 * @param {{
 *   providers: Array<object>,        // active sepay providers WITH decrypted secrets
 *   db: object,                      // adapter
 *   settings: object,
 *   nowIso?: string,
 *   notify?: (event: object) => void|Promise<void>,   // called after commit
 * }} deps
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleSepayWebhook(request, { providers, db, settings, nowIso = null, notify } = {}) {
  // 1. Authenticate before reading the body: a wrong key learns nothing.
  const authorization = request?.headers?.get?.("authorization") ?? null;
  const provider = findProviderForAuth(authorization, providers);
  if (!provider) return { status: 401, body: { success: false } };

  // 2. Size. The declared length is advisory, so the real check is on the bytes.
  const declared = Number(request?.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { status: 413, body: { success: false } };
  }

  let text;
  try {
    text = await request.text();
  } catch {
    return { status: 400, body: { success: false } };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return { status: 413, body: { success: false } };
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { status: 400, body: { success: false } };
  }
  if (!payload || typeof payload !== "object") return { status: 400, body: { success: false } };

  // 3. Normalize. A body without an id cannot be deduplicated, so it is a bad
  //    request rather than a payment.
  const tx = normalizeSepayTransaction(payload);
  if (!tx) return { status: 400, body: { success: false } };

  // 4. Money that arrived at another account of this provider can never be this
  //    order's payment; the reconciliation engine is told so up front.
  const accountMismatch = provider.config?.accountNumber
    && tx.accountNumber
    && String(provider.config.accountNumber) !== String(tx.accountNumber);

  let outcome;
  try {
    outcome = db.transaction(() => ingestTransactionSync(db, {
      provider,
      tx,
      via: "webhook",
      nowIso,
      settings,
      forceReason: accountMismatch ? "wrong_provider" : null,
    }));
  } catch (error) {
    // Answer 200 anyway: the failure is ours, and letting SePay retry a payment
    // whose ingest threw would produce a retry storm without fixing anything. The
    // error is logged by the route.
    console.error("[payments/sepay/webhook] ingest failed:", error?.message || error);
    return { status: 200, body: { success: true }, ingestFailed: true };
  }

  // 5. Notify after commit, never for a duplicate (design D4 step 6).
  if (outcome && (outcome.outcome === "matched" || outcome.outcome === "needs_review")) {
    try {
      await notify?.({
        outcome: outcome.outcome,
        reason: outcome.reason ?? null,
        provider: { id: provider.id, kind: provider.kind, name: provider.name },
        tx,
        amountText: tx.currency === "VND" ? formatVnd(tx.amount) : `${tx.amount / 1e9} USDT`,
        orderId: outcome.orderId ?? null,
      });
    } catch (error) {
      console.warn("[payments/sepay/webhook] notification skipped:", error?.message || error);
    }
  }

  // 6. Always 200 for an authenticated request, so SePay does not retry.
  return { status: 200, body: { success: true }, outcome: outcome?.outcome ?? null };
}
