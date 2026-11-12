## Context

Gift redemption (`redeemGiftCode`) is synchronous and runs in one transaction;
Telegram's Bot API is async. New-user codes already snapshot the Telegram user on
each redemption (`giftRedemptions.telegramUserId`).

## Goals / Non-Goals

**Goals:** channel-join vouchers that cannot be farmed with several accounts;
codes customers can take without typing; a prompt after the welcome code.

**Non-Goals:** taking the voucher back when the customer later leaves the channel;
checking membership periodically.

## Decisions

### D1. Membership is checked before the transaction, re-bound inside it
The redeem route reads the code (`giftRequirementSync`); for a channel-join code
with a linked, not-yet-claimed Telegram user it calls `getChatMember`, then passes
the Telegram user it found in the channel (`channelMemberTelegramUserId`) to
`redeemGiftCode`. Inside the savepoint `channelRefusalSync` requires a link, no
earlier redemption of this code by that Telegram user, and that the verified user
is still the account's link — so relinking between the check and the claim fails.
Telegram errors (bot not admin, chat missing, network) answer 503
`channel_unavailable`; they never count as "not a member".

### D2. One per Telegram user per code
The rule is per code, not across all channel codes, so a later campaign can run a
new channel code. Uniqueness of `users.telegramUserId` plus the redemption snapshot
stop one Telegram user from taking the same code on two accounts.

### D3. Chat id
`telegramChannelChatId` (optional, `@name` or `-100…`) or else the username in the
public channel link. A private invite link has no username and needs the id.

### D4. Listed codes and the welcome offer
`listAvailableGiftsSync` returns active, in-window, not exhausted codes with a
valid grant that the account can still take (per-account limit, new-user rules,
channel claim). The welcome offer looks at every channel-join code (listed first),
so it works even when the admin did not list the code; it is offered only when the
channel link and chat id are set.

### D5. New-user and channel-join are exclusive
One code is one kind; both flags pin `perUserLimit` to 1.

### D6. Only ask Telegram when it can matter
`giftRequirementSync.checkChannel` is true only for a live code (active, in window,
not used up) the account can still take, with a link whose Telegram user has not
claimed it; otherwise the transaction refuses with the right reason and no Bot API
call is made. Checks are spaced 3 s per account in memory (429 "đợi vài giây"),
so a looping customer cannot push the shared bot into Telegram's flood limit.
Channel codes are neither listed nor offered unless a bot token, a chat id and a
channel link are set (`channelCheckConfigured`).

## Risks / Trade-offs

- A redeem attempt of a live channel code costs one Bot API call, at most one per
  account every 3 s.
- A customer may leave the channel after taking the voucher (accepted).
