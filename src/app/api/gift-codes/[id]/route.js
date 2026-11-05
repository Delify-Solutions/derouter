import { getAdminActor } from "@/lib/auth/adminIdentity";
import { NextResponse } from "next/server";
import { getGiftCodeById, updateGiftCode, deleteGiftCode } from "@/lib/db/repos/giftRepo.js";

export const dynamic = "force-dynamic";

// GET /api/gift-codes/:id
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const code = await getGiftCodeById(id);
    if (!code) return NextResponse.json({ error: "Gift code not found" }, { status: 404 });
    return NextResponse.json({ code });
  } catch {
    return NextResponse.json({ error: "Failed to fetch gift code" }, { status: 500 });
  }
}

// PATCH /api/gift-codes/:id — edit any field of a code: the code string, what it
// grants (plan / credit / amount / duration), RPM/TPM, limits, dates, flags, note.
// Applies to later redemptions; earlier ones keep what they received.
export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (body.maxRedemptions !== undefined) {
      const n = Number(body.maxRedemptions);
      if (!Number.isInteger(n) || n < 1) {
        return NextResponse.json({ error: "maxRedemptions must be at least 1" }, { status: 400 });
      }
    }
    if (body.perUserLimit !== undefined) {
      const n = Number(body.perUserLimit);
      if (!Number.isInteger(n) || n < 1) {
        return NextResponse.json({ error: "perUserLimit must be at least 1" }, { status: 400 });
      }
    }
    if (body.expiresAt && Number.isNaN(Date.parse(body.expiresAt))) {
      return NextResponse.json({ error: "expiresAt must be a valid date" }, { status: 400 });
    }
    if (body.startsAt && Number.isNaN(Date.parse(body.startsAt))) {
      return NextResponse.json({ error: "startsAt must be a valid date" }, { status: 400 });
    }

    const code = await updateGiftCode(id, {
      code: body.code,
      planId: body.planId,
      creditNanoUsd: body.creditNanoUsd,
      amountVnd: body.amountVnd,
      durationDays: body.durationDays,
      rpm: body.rpm,
      tpm: body.tpm,
      maxRedemptions: body.maxRedemptions,
      perUserLimit: body.perUserLimit,
      startsAt: body.startsAt,
      expiresAt: body.expiresAt,
      isActive: body.isActive,
      newUserOnly: body.newUserOnly === undefined ? undefined : body.newUserOnly === true,
      channelJoinOnly: body.channelJoinOnly === undefined ? undefined : body.channelJoinOnly === true,
      listed: body.listed === undefined ? undefined : body.listed === true,
      note: body.note,
    });
    if (!code) return NextResponse.json({ error: "Gift code not found" }, { status: 404 });
    return NextResponse.json({ code });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to update gift code" }, { status: 400 });
  }
}

// DELETE /api/gift-codes/:id — a never-redeemed code is removed; a redeemed one is
// hidden and stops working, keeping its redemption history (spec gift-codes).
// Either way the code is unlinked from the referral default gift, CTV overrides
// and the promo popup in the same transaction.
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const actor = await getAdminActor(request);
    const result = await deleteGiftCode(id, { actor });
    if (!result) return NextResponse.json({ error: "Không tìm thấy mã" }, { status: 404 });
    return NextResponse.json({ success: true, deleted: result.deleted, unlinked: result.unlinked });
  } catch {
    return NextResponse.json({ error: "Không xóa được mã" }, { status: 500 });
  }
}
