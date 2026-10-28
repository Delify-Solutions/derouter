import { NextResponse } from "next/server";
import { listGiftCodes, createGiftCode, listGiftPlans } from "@/lib/db/repos/giftRepo.js";

export const dynamic = "force-dynamic";

// GET /api/gift-codes — list codes plus the plans the picker may offer.
export async function GET() {
  try {
    const [codes, plans] = await Promise.all([listGiftCodes(), listGiftPlans()]);
    return NextResponse.json({ codes, plans });
  } catch (error) {
    console.log("Error listing gift codes:", error);
    return NextResponse.json({ error: "Failed to fetch gift codes" }, { status: 500 });
  }
}

// POST /api/gift-codes — mint a code.
export async function POST(request) {
  try {
    const body = await request.json();

    const maxRedemptions = Number(body.maxRedemptions ?? 1);
    if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) {
      return NextResponse.json({ error: "maxRedemptions must be at least 1" }, { status: 400 });
    }
    const perUserLimit = Number(body.perUserLimit ?? 1);
    if (!Number.isInteger(perUserLimit) || perUserLimit < 1) {
      return NextResponse.json({ error: "perUserLimit must be at least 1" }, { status: 400 });
    }

    const planId = body.planId || null;
    const creditNanoUsd = body.creditNanoUsd != null && body.creditNanoUsd !== ""
      ? Number(body.creditNanoUsd)
      : null;
    if (Boolean(planId) === Boolean(creditNanoUsd)) {
      return NextResponse.json(
        { error: "Provide exactly one of planId or creditNanoUsd" },
        { status: 400 }
      );
    }

    let durationDays = null;
    if (creditNanoUsd != null) {
      if (!Number.isInteger(creditNanoUsd) || creditNanoUsd <= 0) {
        return NextResponse.json({ error: "creditNanoUsd must be a positive integer" }, { status: 400 });
      }
      durationDays = Number(body.durationDays);
      if (!Number.isInteger(durationDays) || durationDays < 1) {
        return NextResponse.json(
          { error: "durationDays must be at least 1 when granting credit" },
          { status: 400 }
        );
      }
    }

    if (body.expiresAt && Number.isNaN(Date.parse(body.expiresAt))) {
      return NextResponse.json({ error: "expiresAt must be a valid date" }, { status: 400 });
    }
    if (body.startsAt && Number.isNaN(Date.parse(body.startsAt))) {
      return NextResponse.json({ error: "startsAt must be a valid date" }, { status: 400 });
    }

    const code = await createGiftCode({
      code: body.code || undefined,
      grantKind: planId ? "plan" : "credit",
      planId,
      creditNanoUsd,
      durationDays,
      maxRedemptions,
      perUserLimit,
      startsAt: body.startsAt || null,
      expiresAt: body.expiresAt || null,
      note: body.note || null,
      createdBy: body.createdBy || "admin",
    });

    return NextResponse.json({ code }, { status: 201 });
  } catch (error) {
    console.log("Error creating gift code:", error);
    return NextResponse.json({ error: error.message || "Failed to create gift code" }, { status: 400 });
  }
}
