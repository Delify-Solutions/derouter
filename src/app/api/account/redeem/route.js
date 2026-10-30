import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { redeemGiftCode, listUserRedemptions } from "@/lib/db/repos/giftRepo.js";
import { resolveAccountUser } from "@/lib/auth/userSession.js";

export const dynamic = "force-dynamic";

// Reasons are collapsed on purpose: a code that exists but belongs to another
// user must be indistinguishable from one that does not exist.
const FAILURE = {
  not_found: { status: 404, error: "This code is not valid." },
  not_active: { status: 404, error: "This code is not valid." },
  exhausted: { status: 404, error: "This code is not valid." },
  already_redeemed: { status: 409, error: "You have already used this code." },
  invalid_plan: { status: 409, error: "This code cannot be applied to your account." },
};

async function requireSession(request) {
  // resolveAccountUser checks the session row too, so a revoked token cannot redeem.
  const session = await resolveAccountUser(request);
  if (!session?.userId) return null;
  return session;
}

// GET /api/account/redeem — the code history for the signed-in user.
export async function GET(request) {
  try {
    const session = await requireSession(request);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const redemptions = await listUserRedemptions(session.userId);
    return NextResponse.json({ redemptions });
  } catch {
    return NextResponse.json({ error: "Failed to fetch redemptions" }, { status: 500 });
  }
}

// POST /api/account/redeem { code }
export async function POST(request) {
  try {
    const session = await requireSession(request);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body?.code || typeof body.code !== "string") {
      return NextResponse.json({ error: "Enter a code." }, { status: 400 });
    }

    const db = await getAdapter();
    // One transaction: the redemption row, the counter bump and the grant commit together.
    const result = db.transaction(() =>
      redeemGiftCode(db, { userId: session.userId, code: body.code })
    );

    if (!result?.ok) {
      const mapped = FAILURE[result?.reason] || FAILURE.not_found;
      return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    }

    return NextResponse.json({
      ok: true,
      creditAppliedNanoUsd: result.userPlan?.creditTotalNanoUsd ?? 0,
      unlimitedCredit: result.userPlan?.unlimitedCredit === 1,
      // A grant repays what the account owes first; the remainder becomes plan
      // credit. Both numbers are returned so the result panel never overstates.
      appliedToOverdraftNanoUsd: result.appliedToOverdraftNanoUsd ?? 0,
      planName: result.planName ?? null,
      expiresAt: result.userPlan?.expiresAt ?? null,
    });
  } catch {
    return NextResponse.json({ error: "Failed to redeem code" }, { status: 500 });
  }
}
