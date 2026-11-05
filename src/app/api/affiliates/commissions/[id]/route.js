import { NextResponse } from "next/server";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { actOnCommission } from "@/lib/db/repos/affiliateRepo.js";
import { validateReason } from "@/lib/billing/adminActions.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const ERRORS = {
  not_found: { status: 404, error: "Không tìm thấy khoản hoa hồng" },
  not_pending: { status: 409, error: "Chỉ duyệt sớm được khoản đang giữ" },
  already_reversed: { status: 409, error: "Khoản này đã bị hủy" },
  affiliate_deleted: { status: 409, error: "CTV đã bị xóa tài khoản, không còn ví để duyệt vào" },
  bad_action: { status: 400, error: "Thao tác không hợp lệ" },
};

/**
 * PATCH /api/affiliates/commissions/[id] — `{ action: "release" | "reverse", reason }`
 * (spec affiliate-program "Admin commission actions"). `release` ends the hold
 * now; `reverse` cancels the commission and needs a reason. Both are audited.
 */
export async function PATCH(request, { params }) {
  const { id } = await params;
  const actor = await getAdminActor(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  const action = body.action;
  if (action !== "release" && action !== "reverse") {
    return NextResponse.json(ERRORS.bad_action, { status: 400, headers: NO_STORE });
  }
  // Same rule as every other audited admin action: 3–500 characters. Optional
  // for an early release, required for a cancel.
  const typed = typeof body.reason === "string" ? body.reason.trim() : "";
  const reason = typed ? validateReason(typed) : null;
  if (typed && !reason) {
    return NextResponse.json({ error: "Lý do phải có từ 3 đến 500 ký tự" }, { status: 400, headers: NO_STORE });
  }
  if (action === "reverse" && !reason) {
    return NextResponse.json({ error: "Cần ghi lý do (3–500 ký tự) khi hủy hoa hồng" }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await actOnCommission(id, action, { actor, reason: reason || null });
    if (result.error) {
      const known = ERRORS[result.error] ?? { status: 400, error: "Không thực hiện được" };
      return NextResponse.json({ error: known.error }, { status: known.status, headers: NO_STORE });
    }
    const row = result.commission;
    return NextResponse.json(
      {
        ok: true,
        commission: row && {
          id: row.id,
          status: row.status,
          releasedAt: row.releasedAt ?? null,
          reversedAt: row.reversedAt ?? null,
        },
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không lưu được thay đổi" }, { status: 500, headers: NO_STORE });
  }
}
