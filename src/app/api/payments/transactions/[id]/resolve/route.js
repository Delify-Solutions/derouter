import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { resolveTransactionSync } from "@/lib/payments/reconcile.js";
import { getTransaction } from "@/lib/db/repos/paymentTransactionsRepo.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/payments/transactions/[id]/resolve — `{ action, orderId?, reason }`
 * (design D8, spec payment-reconciliation "Admin resolution of transactions").
 *
 * The actor comes from `getAdminActor` so the audit entry names the specific admin
 * behind the shared dashboard password, and the reason is required and bounded.
 */
export async function POST(request, { params }) {
  const { id } = await params;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  const action = body?.action;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  const orderId = typeof body?.orderId === "string" && body.orderId.trim() ? body.orderId.trim() : null;

  try {
    const actor = await getAdminActor(request);
    const db = await getAdapter();

    const result = db.transaction(() => resolveTransactionSync(db, {
      transactionId: id,
      action,
      orderId,
      reason,
      actor,
    }));

    if (!result.ok) {
      const status = result.code === "not_found" ? 404 : result.code === "already" ? 409 : 400;
      return NextResponse.json({ error: result.error, code: result.code }, { status, headers: NO_STORE });
    }

    const transaction = await getTransaction(id);
    return NextResponse.json({ success: true, transaction, order: result.order ?? null }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Không xử lý được giao dịch" },
      { status: 500, headers: NO_STORE }
    );
  }
}
