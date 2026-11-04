import { NextResponse } from "next/server";
import { listWithdrawals } from "@/lib/db/repos/affiliateRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/affiliates/withdrawals?status — every request, newest first. */
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  try {
    const { rows, total, pendingCount } = await listWithdrawals({
      status: params.get("status") || "",
      limit: Number(params.get("limit")) || 50,
      offset: Number(params.get("offset")) || 0,
    });
    return NextResponse.json(
      {
        total,
        pendingCount,
        withdrawals: rows.map((row) => ({
          id: row.id,
          userId: row.userId,
          email: row.email ?? null,
          displayName: row.displayName ?? null,
          currency: row.currency,
          amount: Number(row.amount),
          destination: row.destination,
          status: row.status,
          txRef: row.txRef ?? null,
          adminNote: row.adminNote ?? null,
          decidedBy: row.decidedBy ?? null,
          decidedAt: row.decidedAt ?? null,
          createdAt: row.createdAt,
        })),
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được lệnh rút" }, { status: 500, headers: NO_STORE });
  }
}
