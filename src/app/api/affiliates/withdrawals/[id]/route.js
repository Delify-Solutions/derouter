import { NextResponse } from "next/server";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { decideWithdrawal } from "@/lib/db/repos/affiliateRepo.js";
import { WalletError } from "@/lib/affiliate/wallet.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * PATCH /api/affiliates/withdrawals/[id] — `{ action: 'paid'|'rejected', txRef?, reason? }`.
 *
 * A decided withdrawal cannot be decided again: the status guard inside the
 * transaction returns no row and this answers 409, leaving the balance untouched
 * (spec "Admin decides withdrawals").
 */
export async function PATCH(request, { params }) {
  const { id } = await params;
  const actor = await getAdminActor(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  const action = body?.action === "paid" || body?.action === "rejected" ? body.action : "";
  if (!action) {
    return NextResponse.json({ error: "Hành động không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  try {
    const row = await decideWithdrawal(
      id,
      { action, txRef: body?.txRef, reason: body?.reason },
      { actor }
    );
    if (!row) {
      return NextResponse.json(
        { error: "Lệnh rút này đã được xử lý" },
        { status: 409, headers: NO_STORE }
      );
    }
    return NextResponse.json(
      { ok: true, withdrawal: { id: row.id, status: row.status, txRef: row.txRef ?? null } },
      { headers: NO_STORE }
    );
  } catch (error) {
    if (error instanceof WalletError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: "Không xử lý được lệnh rút" }, { status: 500, headers: NO_STORE });
  }
}
