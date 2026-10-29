import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { listProvidersWithSecrets } from "@/lib/db/repos/paymentProvidersRepo.js";
import { handleSepayWebhook } from "@/lib/payments/webhook.js";

export const dynamic = "force-dynamic";

// The one unauthenticated endpoint in the change (design D7). It authenticates
// itself with the provider's webhook key, so the path is on PUBLIC_API_PATHS.
//
// Every decision lives in `src/lib/payments/webhook.js` — this file only supplies
// the adapter, the provider rows with decrypted secrets and the notifier, which is
// what lets the same bytes be replayed in a plain `node --test` process.
//
// The answer is `{ success: true }` for every authenticated request, including
// duplicates and needs-review rows: SePay retries anything else, and a retry loop
// on a wrong-amount transfer would page the admin forever.
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request) {
  let db;
  let providers;
  let settings;
  try {
    db = await getAdapter();
    // Only active SePay providers: an account the operator turned off must stop
    // accepting webhooks immediately.
    providers = await listProvidersWithSecrets({ kind: "sepay", activeOnly: true });
    settings = await getSettings();
  } catch (error) {
    console.error("[payments/sepay/webhook] setup failed:", error?.message || error);
    return NextResponse.json({ success: false }, { status: 500, headers: NO_STORE });
  }

  const result = await handleSepayWebhook(request, {
    providers,
    db,
    settings,
    notify: sendNotification,
  });

  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}

/**
 * Announce the outcome. Imported dynamically and fully wrapped: the transaction is
 * already committed, so a missing bot token or a Telegram outage must never turn a
 * received payment into an error response.
 */
async function sendNotification({ outcome, reason, provider, tx, amountText, orderId }) {
  const mod = await import("@/lib/notify/telegram");

  if (outcome === "matched") {
    const db = await getAdapter();
    // Read the customer/plan for the message. If the order vanished between the
    // commit and here, the payment is still approved; only the detail is missing.
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
      reason,
      providerName: provider.name,
    });
  }
}
