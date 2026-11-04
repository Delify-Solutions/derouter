import { NextResponse } from "next/server";
import { listVouchers } from "@/lib/db/repos/affiliateRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/affiliates/vouchers?status=&limit=&offset= — every voucher (admin). */
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  try {
    const { rows, total } = await listVouchers({
      status: params.get("status") || "",
      limit: Number(params.get("limit")) || 50,
      offset: Number(params.get("offset")) || 0,
    });
    return NextResponse.json(
      {
        total,
        vouchers: rows.map((row) => ({
          id: row.id,
          code: row.code,
          currency: row.currency,
          amount: Number(row.amount),
          status: row.status,
          ownerUserId: row.ownerUserId,
          ownerEmail: row.ownerEmail ?? null,
          usedOrderId: row.usedOrderId ?? null,
          usedByEmail: row.usedByEmail ?? null,
          usedAt: row.usedAt ?? null,
          createdAt: row.createdAt,
        })),
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được voucher" }, { status: 500, headers: NO_STORE });
  }
}
