## Context

The link lives on `users` (`telegramUserId`, `telegramUsername`, `telegramLinkedAt`, `telegramDmBlockedAt`); `unlinkTelegramSync` clears it and drops unused link tokens. New-user gift codes check `giftRedemptions.telegramUserId`, a snapshot taken at redemption.

## Decisions

### D1. Reuse the customer unlink, add audit and activity
`adminUnlinkTelegramSync(db, userId, { actor, reason })` calls `unlinkTelegramSync` in one transaction with an `insertAuditSync` row (`telegram_unlinked`, details: Telegram id and username) and an `insertActivitySync` row (`telegram_unlink`, `by: "admin"`, no IP: the admin's address is not the customer's). Errors: `not_found`, `not_linked` (404, 409). The reason follows `validateReason` (3–500 characters).

### D2. Tell the Telegram user before the link is gone
The route sends a security message (`force: true`, bounded by the notifier's timeout) before the transaction, because afterwards the account no longer knows the chat. A failed send never blocks the unlink.

### D3. List
`listTelegramLinksSync` filters `telegramUserId IS NOT NULL`, orders by `telegramLinkedAt DESC`, searches email, username and id with escaped `LIKE`; a query starting with `@` searches the username only. Pages of 25 in the UI, at most 100 per request.

### D4. Promo audience
`isNewAccountForPromoSync` becomes: no `userPlans` row of any source and no `giftRedemptions` row. `PromoPopupSlot` on public pages reads the customer token's user id and applies the same rule, so landing/docs/register no longer show the promo to an old signed-in account.

## Risks / Trade-offs

- An account that received only a tiny admin credit no longer sees the welcome promo. This is the owner's chosen definition.
