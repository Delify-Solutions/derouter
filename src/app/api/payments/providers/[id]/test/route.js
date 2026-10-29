import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getProviderWithSecrets } from "@/lib/db/repos/paymentProvidersRepo.js";
import { ingestTransactionSync } from "@/lib/payments/reconcile.js";
import { fetchSepayTransactions } from "@/lib/payments/providers/sepay.js";
import { fetchWeb2mTransactions } from "@/lib/payments/providers/web2m.js";
import { fetchBinanceTransactions } from "@/lib/payments/providers/binance.js";
import { fetchAcbTransactions } from "@/lib/payments/providers/acb.js";
import { createAcbTokenStore, acbFingerprintFor } from "@/lib/payments/poller.js";
import { formatVnd, formatUsdt } from "@/lib/payments/amounts.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/payments/providers/[id]/test — "Chạy thử" (design D8).
 *
 * Fetches the provider's recent transactions and reports what reconciliation WOULD
 * decide for each, with `dryRun: true` so nothing is stored and no order changes
 * (spec payment-provider-admin "Dry run"). The dry run goes through the same
 * `ingestTransactionSync`, which is what makes its answer trustworthy.
 */
export async function POST(request, { params }) {
  const { id } = await params;

  let provider;
  try {
    provider = await getProviderWithSecrets(id);
  } catch {
    return NextResponse.json({ error: "Không đọc được nguồn nhận tiền" }, { status: 500, headers: NO_STORE });
  }
  if (!provider) return NextResponse.json({ error: "Không tìm thấy nguồn nhận tiền" }, { status: 404, headers: NO_STORE });

  let fetched;
  try {
    fetched = await runFetch(provider);
  } catch (error) {
    // The message is sanitized by the providers themselves; never echo a URL here.
    return NextResponse.json({ error: error?.message || "Không lấy được giao dịch" }, { status: 400, headers: NO_STORE });
  }

  if (!fetched.ok) {
    // `unavailable` is the documented SePay-without-token case: not an error the
    // admin caused, so it says so instead of implying the account is broken.
    return NextResponse.json(
      { error: fetched.error, unavailable: fetched.unavailable === true },
      { status: 400, headers: NO_STORE }
    );
  }

  let results = [];
  try {
    const db = await getAdapter();
    const settings = await getSettings();
    results = db.transaction(() => fetched.transactions.map((tx) => {
      const outcome = ingestTransactionSync(db, {
        provider,
        tx,
        via: "poll",
        settings,
        dryRun: true,
      });
      // Read the order's plan/customer for a matched preview; a dry run must not
      // need a second round trip from the UI.
      const order = outcome.orderId
        ? db.get(
            `SELECT o.id, COALESCE(u.email, o.emailSnapshot) AS email, p.name AS planName, p.code AS planCode
               FROM orders o
               LEFT JOIN users u ON u.id = o.userId
               LEFT JOIN plans p ON p.id = o.planId
              WHERE o.id = ?`,
            [outcome.orderId]
          )
        : null;
      return {
        externalId: tx.externalId,
        direction: tx.direction,
        amount: tx.amount,
        currency: tx.currency,
        amountText: tx.currency === "VND" ? formatVnd(tx.amount) : `${formatUsdt(tx.amount)} USDT`,
        content: tx.content,
        occurredAt: tx.occurredAt,
        outcome: outcome.outcome,
        reason: outcome.reason ?? null,
        orderId: outcome.orderId ?? null,
        order: order
          ? { id: order.id, email: order.email ?? null, planName: order.planName ?? null, planCode: order.planCode ?? null }
          : null,
      };
    }));
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Không chạy thử được" },
      { status: 500, headers: NO_STORE }
    );
  }

  return NextResponse.json({ results, count: results.length }, { headers: NO_STORE });
}

async function runFetch(provider) {
  const args = { config: provider.config ?? {}, secrets: provider.secrets ?? {} };
  switch (provider.kind) {
    case "sepay":
      // Polling SePay needs an API token; without one the dry run is simply not
      // available (spec payment-provider-admin "Dry run").
      if (!provider.secrets?.apiToken) {
        return { ok: false, unavailable: true, error: "SePay cần API token để chạy thử" };
      }
      return fetchSepayTransactions(args);
    case "web2m":
      return fetchWeb2mTransactions(args);
    case "binance":
      return fetchBinanceTransactions(args);
    case "acb":
      return fetchAcbTransactions({
        ...args,
        tokenStore: createAcbTokenStore(provider.id, { fingerprint: acbFingerprintFor(provider) }),
      });
    default:
      return { ok: false, error: "Loại nguồn nhận tiền không hỗ trợ chạy thử" };
  }
}
