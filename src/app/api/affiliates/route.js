import { NextResponse } from "next/server";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { inviteAffiliate, listAffiliates } from "@/lib/db/repos/affiliateRepo.js";

// Admin surface: not in PUBLIC_API_PATHS, so dashboardGuard requires the admin JWT
// and a customer session gets 401/403 (spec "Every admin API under /api/affiliates
// SHALL require an admin session").
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/affiliates?q&status&invited&limit&offset — affiliates with their aggregates. */
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  try {
    const { rows, total } = await listAffiliates({
      q: params.get("q") || "",
      status: params.get("status") || "",
      invited: params.get("invited") || "",
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
          invitedAt: row.invitedAt ?? null,
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

/**
 * POST /api/affiliates — `{ user, reason? }`: add an account (user id or email)
 * as an invited affiliate (spec affiliate-program "Affiliate access mode").
 * Creates its code when missing; audited as `affiliate_invited`.
 */
export async function POST(request) {
  const actor = await getAdminActor(request);
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  const who = typeof body?.user === "string" ? body.user.trim() : "";
  if (!who || who.length > 320) {
    return NextResponse.json({ error: "Nhập email hoặc ID tài khoản" }, { status: 400, headers: NO_STORE });
  }
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) || null : null;
  try {
    const result = await inviteAffiliate(who, { actor, reason });
    if (result.error) {
      return NextResponse.json({ error: "Không tìm thấy tài khoản" }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(
      {
        ok: true,
        alreadyInvited: result.alreadyInvited,
        affiliate: { userId: result.user.id, email: result.user.email, code: result.affiliate.code },
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không thêm được CTV" }, { status: 500, headers: NO_STORE });
  }
}
