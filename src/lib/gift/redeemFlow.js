// One redemption flow for every place a customer redeems a code (change
// telegram-bot-commands): the web gift page and the Telegram bot. The channel
// membership check (async, Telegram) runs before the transaction and its result
// is re-bound inside it (change channel-gift D1); a welcome code returns the
// channel-join voucher to offer next.
//
// Relative imports only: tests import this module directly.
import { redeemGiftCode, giftRequirementSync, listAvailableGiftsSync } from "../db/repos/giftRepo.js";
import { channelUrlOf } from "../telegram/channel.js";
import {
  botTokenOf, channelChatIdOf, channelCheckConfigured, checkChannelMember, reserveMembershipCheck,
} from "../telegram/channelMember.js";

/**
 * @returns {Promise<
 *   { ok: true, result: object, requirement: object|null, channelOffer: object|null }
 *   | { ok: false, reason: string, requirement: object|null, channelUrl: string }>}
 *   reason: a redeemGiftCode reason, or "too_soon" / "channel_unavailable" from the
 *   channel check.
 */
export async function redeemForAccount(db, {
  userId, code, settings = {}, checkMember = checkChannelMember, reserve = reserveMembershipCheck,
} = {}) {
  const requirement = giftRequirementSync(db, { userId, code });
  let channelMemberTelegramUserId = null;
  // Dead code, no link, already taken: the transaction refuses with the right reason.
  if (requirement?.channelJoinOnly && requirement.checkChannel) {
    if (!reserve(userId)) return { ok: false, reason: "too_soon", requirement, channelUrl: "" };
    const checked = await checkMember(botTokenOf(settings), channelChatIdOf(settings), requirement.telegramUserId);
    if (!checked.ok) return { ok: false, reason: "channel_unavailable", requirement, channelUrl: "" };
    channelMemberTelegramUserId = checked.member ? requirement.telegramUserId : null;
  }

  // One transaction: the redemption row, the counter bump and the grant commit together.
  const result = db.transaction(() =>
    redeemGiftCode(db, { userId, code, channelMemberTelegramUserId })
  );
  if (!result?.ok) {
    const reason = result?.reason || "not_found";
    return { ok: false, reason, requirement, channelUrl: reason === "channel_required" ? channelUrlOf(settings) : "" };
  }

  // A welcome code just taken: the channel-join voucher this account can still take.
  let channelOffer = null;
  if (requirement?.newUserOnly) {
    const channelUrl = channelUrlOf(settings);
    const offer = channelUrl && channelCheckConfigured(settings)
      ? listAvailableGiftsSync(db, userId, { listedOnly: false, channelOnly: true })[0]
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
  return { ok: true, result, requirement, channelOffer };
}
