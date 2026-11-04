import { NextResponse } from "next/server";
import { listAffiliates } from "@/lib/db/repos/affiliateRepo.js";

// Admin surface: not in PUBLIC_API_PATHS, so dashboardGuard requires the admin JWT
// and a customer session gets 401/403 (spec "Every admin API under /api/affiliates
// SHALL require an admin session").
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/affiliates?q&status&limit&offset — affiliates with their aggregates. */
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  try {
    const { rows, total } = await listAffiliates({
      q: params.get("q") || "",
      status: params.get("status") || "",
      limit: Number(params.get("limit")) || 50,
      offset: Number(params.get("offset")) || 0,
    });
    return NextResponse.json(
      {
        total,
        affiliates: rows.map((row) => ({
          userId: row.userId,
          code: row.code,
          email: row.email,
          displayName: row.displayName ?? null,
          status: row.status,
          clickCount: Number(row.clickCount ?? 0),
          signups: Number(row.signupCount ?? 0),
          payingReferrals: Number(row.payingCount ?? 0),
          rateBp: row.rateBp,
          maxOrders: row.maxOrders,
          giftCodeId: row.giftCodeId ?? null,
          effective: row.effective,
          earned: { VND: Number(row.earnedVnd) || 0, USD: Number(row.earnedUsdNano) || 0 },
          wallet: row.wallet,
          sharedIp: row.sharedIp === true,
          adminNote: row.adminNote ?? null,
          createdAt: row.createdAt ?? null,
        })),
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách CTV" }, { status: 500, headers: NO_STORE });
  }
}
