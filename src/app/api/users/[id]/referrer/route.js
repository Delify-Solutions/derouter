import { NextResponse } from "next/server";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { setUserReferrer } from "@/lib/db/repos/affiliateRepo.js";
import { validateReason } from "@/lib/billing/adminActions.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const ERROR_TEXT = {
  not_found: { status: 404, error: "Không tìm thấy người dùng" },
  self: { status: 400, error: "Không thể đặt tài khoản làm người giới thiệu của chính nó" },
  unknown_referrer: { status: 400, error: "Người giới thiệu không tồn tại" },
};

/**
 * PATCH /api/users/[id]/referrer — set or clear an account's referrer (design D8).
 *
 * `{ referrerUserId: string|null, reason }`. A reason is required: this is the one
 * way to attribute an account that already exists, and the audit log must explain
 * it. It never creates commission retroactively.
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
  if (!Object.prototype.hasOwnProperty.call(body, "referrerUserId")) {
    return NextResponse.json({ error: "Thiếu người giới thiệu" }, { status: 400, headers: NO_STORE });
  }
  if (!validateReason(body.reason)) {
    return NextResponse.json(
      { error: "Lý do phải có từ 3 đến 500 ký tự" },
      { status: 400, headers: NO_STORE }
    );
  }

  const raw = body.referrerUserId;
  const referrerUserId = typeof raw === "string" && raw.trim() ? raw.trim() : null;

  try {
    const result = await setUserReferrer(id, referrerUserId, { actor, reason: body.reason.trim() });
    if (result?.error) {
      const mapped = ERROR_TEXT[result.error] || { status: 400, error: "Không đổi được người giới thiệu" };
      return NextResponse.json({ error: mapped.error }, { status: mapped.status, headers: NO_STORE });
    }
    return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không đổi được người giới thiệu" }, { status: 500, headers: NO_STORE });
  }
}
