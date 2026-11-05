import { NextResponse } from "next/server";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { getAdapter } from "@/lib/db/driver.js";
import { getAffiliateDetail, updateAffiliate } from "@/lib/db/repos/affiliateRepo.js";
import { validateOverride } from "@/lib/affiliate/settings.js";
import { eligibleReferralGiftSync } from "@/lib/affiliate/gift.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/affiliates/[userId] — one affiliate, its terms, wallet and recent rows. */
export async function GET(request, { params }) {
  const { userId } = await params;
  try {
    const detail = await getAffiliateDetail(userId);
    if (!detail) {
      return NextResponse.json({ error: "Không tìm thấy CTV" }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(detail, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không tải được CTV" }, { status: 500, headers: NO_STORE });
  }
}

const STATUSES = new Set(["active", "blocked"]);

/**
 * PATCH /api/affiliates/[userId] — per-affiliate overrides, block switch, note,
 * and `invited` (boolean) for invite-only mode.
 *
 * `rateBp` / `maxOrders` / `giftCodeId` accept `null` (or "") to CLEAR the
 * override and fall back to the program default (spec "Effective terms per
 * affiliate"). The rate keeps the defaults' range, and only a new-user gift code
 * may be selected. Every write is audited on the affiliate's account.
 */
export async function PATCH(request, { params }) {
  const { userId } = await params;
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

  const detail = await getAffiliateDetail(userId);
  if (!detail) {
    return NextResponse.json({ error: "Không tìm thấy CTV" }, { status: 404, headers: NO_STORE });
  }

  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const patch = {};

  for (const key of ["rateBp", "maxOrders", "buyerBonusBp", "buyerBonusMaxOrders"]) {
    if (!has(key)) continue;
    const checked = validateOverride(key, body[key]);
    if (checked.error) return NextResponse.json({ error: checked.error }, { status: 400, headers: NO_STORE });
    patch[key] = checked.value;
  }

  if (has("giftCodeId")) {
    const raw = body.giftCodeId;
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id) {
      patch.giftCodeId = null;
    } else if (id === detail.affiliate.giftCodeId) {
      // Unchanged: an override that has since run out or expired must not block
      // an unrelated edit (blocking a fraudulent CTV, say). It simply stops being
      // advertised until the admin picks another code.
    } else {
      const db = await getAdapter();
      const gift = eligibleReferralGiftSync(db, id);
      // An exhausted or expired code cannot be advertised, so it cannot be chosen
      // either; the message names the actual requirement.
      const row = db.get(`SELECT newUserOnly, isActive FROM giftCodes WHERE id = ?`, [id]);
      if (!row || Number(row.newUserOnly) !== 1) {
        return NextResponse.json(
          { error: "Chỉ chọn được mã người mới (bắt buộc liên kết Telegram)" },
          { status: 400, headers: NO_STORE }
        );
      }
      if (!gift) {
        return NextResponse.json(
          { error: "Mã này đang tắt, hết hạn hoặc đã dùng hết" },
          { status: 400, headers: NO_STORE }
        );
      }
      patch.giftCodeId = id;
    }
  }

  if (has("status")) {
    const status = typeof body.status === "string" ? body.status.trim() : "";
    if (!STATUSES.has(status)) {
      return NextResponse.json({ error: "Trạng thái không hợp lệ" }, { status: 400, headers: NO_STORE });
    }
    patch.status = status;
  }

  if (has("invited")) {
    if (typeof body.invited !== "boolean") {
      return NextResponse.json({ error: "invited phải là true hoặc false" }, { status: 400, headers: NO_STORE });
    }
    patch.invited = body.invited;
  }

  if (has("adminNote")) {
    const note = typeof body.adminNote === "string" ? body.adminNote.trim() : "";
    if (note.length > 1000) {
      return NextResponse.json({ error: "Ghi chú tối đa 1000 ký tự" }, { status: 400, headers: NO_STORE });
    }
    patch.adminNote = note || null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Không có thay đổi nào" }, { status: 400, headers: NO_STORE });
  }

  try {
    const updated = await updateAffiliate(userId, patch, {
      actor,
      reason: typeof body.reason === "string" ? body.reason.trim() || null : null,
    });
    return NextResponse.json({ ok: true, affiliate: updated }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không lưu được thay đổi" }, { status: 500, headers: NO_STORE });
  }
}
