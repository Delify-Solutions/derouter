import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { listUserRedemptions, GIFT_REASON_TEXT } from "@/lib/db/repos/giftRepo.js";
import { getSettings } from "@/lib/localDb";
import { redeemForAccount } from "@/lib/gift/redeemFlow.js";
import { resolveAccountUser } from "@/lib/auth/userSession.js";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";
import { fireAndForget, notifyPlanReceived } from "@/lib/notify/customerTelegram.js";

export const dynamic = "force-dynamic";

// Reasons are collapsed on purpose: a code that exists but belongs to another
// user must be indistinguishable from one that does not exist.
const FAILURE = {
  not_found: { status: 404, error: "This code is not valid." },
  not_active: { status: 404, error: "This code is not valid." },
  exhausted: { status: 404, error: "This code is not valid." },
  already_redeemed: { status: 409, error: "You have already used this code." },
  invalid_plan: { status: 409, error: "This code cannot be applied to your account." },
  // New-user codes (spec gift-codes "New-user codes"). Only `telegram_required`
  // carries a code: it is the one refusal the page offers to fix (link Telegram).
  not_new_user: { status: 409, error: GIFT_REASON_TEXT.not_new_user },
  telegram_required: { status: 403, error: GIFT_REASON_TEXT.telegram_required, code: "telegram_required" },
  telegram_used: { status: 409, error: GIFT_REASON_TEXT.telegram_used },
  // Channel-join codes (change channel-gift).
  channel_required: { status: 403, error: GIFT_REASON_TEXT.channel_required, code: "channel_required" },
  telegram_channel_used: { status: 409, error: GIFT_REASON_TEXT.telegram_channel_used },
};

const CHANNEL_TELEGRAM_REQUIRED = "Cần liên kết Telegram rồi tham gia kênh để nhận mã này.";
const CHANNEL_UNAVAILABLE = "Chưa kiểm tra được kênh Telegram lúc này. Vui lòng thử lại sau ít phút.";
const CHANNEL_TOO_SOON = "Vui lòng đợi vài giây rồi thử lại.";
// The channel check itself failed (redeemFlow): not a refusal of the code.
const CHECK_FAILURE = {
  too_soon: { status: 429, error: CHANNEL_TOO_SOON, code: "too_soon" },
  channel_unavailable: { status: 503, error: CHANNEL_UNAVAILABLE, code: "channel_unavailable" },
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
    const settings = (await getSettings().catch(() => null)) || {};
    const flow = await redeemForAccount(db, { userId: session.userId, code: body.code, settings });
    if (!flow.ok && CHECK_FAILURE[flow.reason]) {
      const failure = CHECK_FAILURE[flow.reason];
      return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
    }

    const giftCode = String(body.code).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32);
    if (!flow.ok) {
      // Refusals are kept too: repeated guessing or welcome-code farming shows up here.
      await recordActivity(request, {
        userId: session.userId,
        action: "gift_refused",
        details: { code: giftCode, reason: flow.reason },
      });
      const mapped = FAILURE[flow.reason] || FAILURE.not_found;
      const channelCode = flow.requirement?.channelJoinOnly === true;
      const error = channelCode && flow.reason === "telegram_required" ? CHANNEL_TELEGRAM_REQUIRED : mapped.error;
      return NextResponse.json(
        { error, ...(mapped.code ? { code: mapped.code } : {}), ...(flow.channelUrl ? { channelUrl: flow.channelUrl } : {}) },
        { status: mapped.status }
      );
    }

    const { result, channelOffer } = flow;
    await recordActivity(request, {
      userId: session.userId,
      action: "gift_redeem",
      details: { code: giftCode, userPlanId: result.userPlan?.id ?? null },
    });
    if (result.userPlan?.id) fireAndForget(notifyPlanReceived(result.userPlan.id, "gift"));

    return NextResponse.json({
      channelOffer,
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
