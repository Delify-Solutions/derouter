import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { listCustomerCacheMissRefunds } from "@/lib/db/repos/cacheMissRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/account/cache-refunds
 *
 * The signed-in customer's own cache-miss refunds (auto or admin-approved), newest
 * first (spec cache-miss-refund "Customer visibility"). The reason is always the
 * same fixed generic sentence — never the internal cause.
 */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  try {
    const entries = await listCustomerCacheMissRefunds(session.userId);
    return NextResponse.json({ entries }, { headers: NO_STORE });
  } catch (error) {
    console.error("[account/cache-refunds] failed:", error?.message || error);
    return NextResponse.json({ error: "Không tải được danh sách hoàn tiền" }, { status: 500, headers: NO_STORE });
  }
}
