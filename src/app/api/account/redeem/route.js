import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import {
  redeemGiftCode, listUserRedemptions, GIFT_REASON_TEXT, giftRequirementSync, listAvailableGiftsSync,
} from "@/lib/db/repos/giftRepo.js";
import { getSettings } from "@/lib/localDb";
import { channelUrlOf } from "@/lib/telegram/channel.js";
import {
  botTokenOf, channelChatIdOf, channelCheckConfigured, checkChannelMember, reserveMembershipCheck,
} from "@/lib/telegram/channelMember.js";
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

/**
 * Channel-join code: ask Telegram whether the account's Telegram user is in the
 * channel. Runs before the transaction (it is async); the transaction re-checks
 * that the link did not change meanwhile.
 * @returns {Promise<{ verified: string|null } | { response: NextResponse }>}
 */
async function verifyChannelMembership(userId, requirement, settings) {
  // Dead code, no link, already taken: the transaction refuses with the right reason.
  if (!requirement.checkChannel) return { verified: null };
  if (!reserveMembershipCheck(userId)) {
    return { response: NextResponse.json({ error: CHANNEL_TOO_SOON, code: "too_soon" }, { status: 429 }) };
  }
  const telegramUserId = requirement.telegramUserId;
  const checked = await checkChannelMember(botTokenOf(settings), channelChatIdOf(settings), telegramUserId);
  if (!checked.ok) {
    return { response: NextResponse.json({ error: CHANNEL_UNAVAILABLE, code: "channel_unavailable" }, { status: 503 }) };
  }
  return { verified: checked.member ? telegramUserId : null };
}

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
    const requirement = giftRequirementSync(db, { userId: session.userId, code: body.code });
    let settings = null;
    const loadSettings = async () => {
      if (!settings) settings = (await getSettings().catch(() => null)) || {};
      return settings;
    };
    let channelMemberTelegramUserId = null;
    if (requirement?.channelJoinOnly) {
      const checked = await verifyChannelMembership(session.userId, requirement, await loadSettings());
      if (checked.response) return checked.response;
      channelMemberTelegramUserId = checked.verified;
    }

    // One transaction: the redemption row, the counter bump and the grant commit together.
    const result = db.transaction(() =>
      redeemGiftCode(db, { userId: session.userId, code: body.code, channelMemberTelegramUserId })
    );

    const giftCode = String(body.code).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32);
    if (!result?.ok) {
      // Refusals are kept too: repeated guessing or welcome-code farming shows up here.
      await recordActivity(request, {
        userId: session.userId,
        action: "gift_refused",
        details: { code: giftCode, reason: result?.reason || "not_found" },
      });
      const mapped = FAILURE[result?.reason] || FAILURE.not_found;
      const channelCode = requirement?.channelJoinOnly === true;
      const error = channelCode && result?.reason === "telegram_required" ? CHANNEL_TELEGRAM_REQUIRED : mapped.error;
      const channelUrl = result?.reason === "channel_required" ? channelUrlOf(await loadSettings()) : "";
      return NextResponse.json(
        { error, ...(mapped.code ? { code: mapped.code } : {}), ...(channelUrl ? { channelUrl } : {}) },
        { status: mapped.status }
      );
    }

    await recordActivity(request, {
      userId: session.userId,
      action: "gift_redeem",
      details: { code: giftCode, userPlanId: result.userPlan?.id ?? null },
    });
    if (result.userPlan?.id) fireAndForget(notifyPlanReceived(result.userPlan.id, "gift"));

    // A welcome code just taken: point the new customer at the channel-join
    // voucher they can still take (change channel-gift).
    let channelOffer = null;
    if (requirement?.newUserOnly) {
      const channelUrl = channelUrlOf(await loadSettings());
      const offer = channelUrl && channelCheckConfigured(settings)
        ? listAvailableGiftsSync(db, session.userId, { listedOnly: false, channelOnly: true })[0]
        : null;
      if (offer) {
        channelOffer = {
          code: offer.code,
          creditNanoUsd: offer.grant.creditNanoUsd,
          unlimitedCredit: offer.grant.unlimitedCredit,
          planName: offer.grant.planName,
          channelUrl,
        };
      }
    }

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
