import { NextResponse } from "next/server";
import { listCommissions } from "@/lib/db/repos/affiliateRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/affiliates/commissions?affiliateUserId&status — every commission,
 * filterable by affiliate and status (spec "Admin affiliate management").
 */
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  try {
    const { rows, total } = await listCommissions({
      affiliateUserId: params.get("affiliateUserId") || "",
      status: params.get("status") || "",
      limit: Number(params.get("limit")) || 50,
      offset: Number(params.get("offset")) || 0,
    });
    return NextResponse.json(
      {
        total,
        commissions: rows.map((row) => ({
          id: row.id,
          orderId: row.orderId,
          affiliateUserId: row.affiliateUserId,
          affiliateEmail: row.affiliateEmail ?? null,
          affiliateCode: row.affiliateCode ?? null,
          buyerEmail: row.buyerEmail ?? null,
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
    return NextResponse.json({ error: "Không tải được hoa hồng" }, { status: 500, headers: NO_STORE });
  }
}
