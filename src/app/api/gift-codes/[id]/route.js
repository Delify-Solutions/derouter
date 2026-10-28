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

// PATCH /api/gift-codes/:id — flip active, extend expiry, change limits or note.
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
      planId: body.planId,
      creditNanoUsd: body.creditNanoUsd,
      durationDays: body.durationDays,
      maxRedemptions: body.maxRedemptions,
      perUserLimit: body.perUserLimit,
      startsAt: body.startsAt,
      expiresAt: body.expiresAt,
      isActive: body.isActive,
      note: body.note,
    });
    if (!code) return NextResponse.json({ error: "Gift code not found" }, { status: 404 });
    return NextResponse.json({ code });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to update gift code" }, { status: 400 });
  }
}

// DELETE /api/gift-codes/:id — soft delete (isActive = 0); history is kept.
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const ok = await deleteGiftCode(id);
    if (!ok) return NextResponse.json({ error: "Gift code not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to disable gift code" }, { status: 500 });
  }
}
