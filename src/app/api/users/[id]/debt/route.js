import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById } from "@/lib/localDb";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { clearDebtSync } from "@/lib/billing/adminActions.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * DELETE /api/users/[id]/debt { reason, expectNanoUsd? } (admin) — write the
 * account's debt off (change debt-clear). One transaction: the debt, its ledger
 * row and the audit entry land together or not at all.
 */
export async function DELETE(request, { params }) {
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  const actor = await getAdminActor(request);
  const db = await getAdapter();
  const result = db.transaction(() =>
    clearDebtSync(db, id, { reason: body?.reason, expectNanoUsd: body?.expectNanoUsd ?? null, actor })
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  return NextResponse.json({ ok: true, clearedNanoUsd: result.clearedNanoUsd }, { headers: NO_STORE });
}
