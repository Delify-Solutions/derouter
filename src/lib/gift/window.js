// When a gift code is redeemable, in one place.
//
// Two callers need the same rule: `giftRepo.redeemGiftCode` (may this account
// redeem it?) and the affiliate welcome-gift eligibility check (may this code be
// advertised?). Duplicating it would let the advert show a code the redeem refuses.
//
// DRIVER-FREE: relative imports only, no db access.

export function toMillis(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Inside its start/expiry window. NULL on either side means open-ended. */
export function inWindow(row, nowMs) {
  const startsAt = toMillis(row?.startsAt);
  const expiresAt = toMillis(row?.expiresAt);
  if (startsAt !== null && nowMs < startsAt) return false;
  if (expiresAt !== null && nowMs > expiresAt) return false;
  return true;
}

/** Has the code used up its total? Never for an unlimited code (change gift-unlimited). */
export function giftExhausted(row) {
  if (Number(row?.unlimitedRedemptions) === 1) return false;
  return Number(row?.redeemedCount ?? 0) >= Number(row?.maxRedemptions ?? 1);
}

/**
 * Everything that makes a code drivable: active, in window, not exhausted.
 * `notStarted` and `expired` are kept apart for the admin screens.
 */
export function giftStatusOf(row, nowMs = Date.now()) {
  if (!row) return "missing";
  if (Number(row.isActive) !== 1) return "disabled";
  const startsAt = toMillis(row.startsAt);
  const expiresAt = toMillis(row.expiresAt);
  if (startsAt !== null && nowMs < startsAt) return "scheduled";
  if (expiresAt !== null && nowMs > expiresAt) return "expired";
  if (giftExhausted(row)) return "exhausted";
  return "active";
}
