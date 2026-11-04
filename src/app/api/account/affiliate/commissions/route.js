import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { listMyCommissions } from "@/lib/db/repos/affiliateRepo.js";
import { maskEmail } from "@/lib/affiliate/mask.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/account/affiliate/commissions — the affiliate's own commissions.
 *
 * The buyer is a masked email and nothing else: no id, no order, no plan (spec
 * "Customer affiliate page"). The order amount, currency and date are the facts
 * that explain the figure.
 */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  const params = request.nextUrl.searchParams;
  const limit = Number(params.get("limit")) || 20;
  const offset = Number(params.get("offset")) || 0;

  try {
    const { rows, total } = await listMyCommissions(session.userId, { limit, offset });
    return NextResponse.json(
      {
        total,
        commissions: rows.map((row) => ({
          id: row.id,
          buyerEmail: maskEmail(row.buyerEmail),
          currency: row.currency,
          baseAmount: Number(row.baseAmount),
          rateBp: Number(row.rateBp),
          amount: Number(row.amount),
          status: row.status,
          availableAt: row.availableAt,
          releasedAt: row.releasedAt ?? null,
          reversedAt: row.reversedAt ?? null,
          createdAt: row.createdAt,
        })),
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách hoa hồng" }, { status: 500, headers: NO_STORE });
  }
}
