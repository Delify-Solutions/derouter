import { NextResponse } from "next/server";
import { listReferrals } from "@/lib/db/repos/affiliateRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/affiliates/referrals?q&affiliateUserId&limit&offset — every referred
 * account with its referrer, paid orders and commission (spec affiliate-program
 * "Admin referral list").
 */
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  try {
    const { rows, total } = await listReferrals({
      q: (params.get("q") || "").slice(0, 100),
      affiliateUserId: params.get("affiliateUserId") || "",
      limit: Number(params.get("limit")) || 50,
      offset: Number(params.get("offset")) || 0,
    });
    return NextResponse.json({ total, referrals: rows }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách giới thiệu" }, { status: 500, headers: NO_STORE });
  }
}
