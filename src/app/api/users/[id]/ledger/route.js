import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById } from "@/lib/localDb";
import { getAccountLedgerSync, getLedgerPlanOptionsSync } from "@/lib/db/repos/accountPlansRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/users/[id]/ledger?page&planId&kind — the customer's ledger, admin side. */
export async function GET(request, { params }) {
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  const db = await getAdapter();
  const query = request.nextUrl.searchParams;
  const result = getAccountLedgerSync(db, id, {
    page: Number(query.get("page")) || 1,
    pageSize: 25,
    planId: query.get("planId") || null,
    kind: query.get("kind") || null,
  });

  return NextResponse.json(
    { ...result, planOptions: getLedgerPlanOptionsSync(db, id) },
    { headers: NO_STORE }
  );
}
