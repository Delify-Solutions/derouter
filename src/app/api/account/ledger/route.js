import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import {
  getAccountLedgerSync,
  getLedgerPlanOptionsSync,
} from "@/lib/db/repos/accountPlansRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/account/ledger?page=1&planId=&kind=
 *
 * One page (25 rows) of the caller's own ledger, newest first, with the model and
 * token counts joined from `usageHistory` through `usageId` (design D18). Scoped to
 * the session's userId — a planId or kind from another account simply matches
 * nothing.
 */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  try {
    const db = await getAdapter();
    const params = request.nextUrl.searchParams;
    const result = getAccountLedgerSync(db, session.userId, {
      pageSize: 25,
      page: Number(params.get("page")) || 1,
      planId: params.get("planId") || null,
      kind: params.get("kind") || null,
    });

    return NextResponse.json(
      { ...result, planOptions: getLedgerPlanOptionsSync(db, session.userId) },
      { headers: NO_STORE }
    );
  } catch (error) {
    console.error("[account/ledger] failed:", error?.message || error);
    return NextResponse.json({ error: "Không tải được sổ cái" }, { status: 500, headers: NO_STORE });
  }
}
