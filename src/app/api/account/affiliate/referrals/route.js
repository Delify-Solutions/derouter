import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { listMyReferrals } from "@/lib/db/repos/affiliateRepo.js";
import { maskEmail } from "@/lib/affiliate/mask.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/account/affiliate/referrals — who this affiliate brought in (spec
 * "Customer affiliate page"): masked email, signup date, earned per currency.
 */
export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  const params = request.nextUrl.searchParams;
  const limit = Number(params.get("limit")) || 20;
  const offset = Number(params.get("offset")) || 0;

  try {
    const { rows, total } = await listMyReferrals(session.userId, { limit, offset });
    return NextResponse.json(
      {
        total,
        referrals: rows.map((row) => ({
          email: maskEmail(row.email),
          signedUpAt: row.signedUpAt,
          earned: {
            VND: Number(row.earnedVnd) || 0,
            USD: Number(row.earnedUsdNano) || 0,
          },
        })),
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách người được giới thiệu" }, { status: 500, headers: NO_STORE });
  }
}
