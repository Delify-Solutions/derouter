## Why

The owner wants to grow the Telegram channel: any customer who links Telegram and
joins the channel gets a $10 credit voucher, once per Telegram user, whether the
account is new or not. Customers should also see the codes they can take without
being sent one, and a new customer who just took the welcome code should be told
about the channel voucher right away.

## What Changes

- New gift-code kind **channel-join** (`giftCodes.channelJoinOnly`): redeemable by
  any account with a linked Telegram user who is a member of the admin's channel;
  one per Telegram user per code; one per account; never also a new-user code.
  Membership is checked with Bot API `getChatMember` (the bot must be a channel
  admin). An admin assignment skips the check.
- New flag **listed** (`giftCodes.listed`): the code appears under "Mã có thể sử
  dụng" on `/account/gift` with a "Nhận" button, only for accounts that can still
  take it. A code that only lacks a Telegram link shows the link prompt.
- After a welcome (new-user) code is taken, the redeem response carries a
  `channelOffer` and the gift page opens a modal: join the channel, then take the
  voucher.
- Admin: toggles in the gift-code form, badges in the list; on the Telegram page an
  optional channel chat id (for a private channel) and a "Kiểm tra bot" check.
- Schema v34.

## Capabilities

### New Capabilities

### Modified Capabilities
- `gift-codes`: channel-join codes, listed codes, the welcome-code channel offer.

## Impact

- `src/lib/db/schema.js`, `src/lib/db/repos/giftRepo.js`, `src/lib/telegram/channelMember.js`
- `src/app/api/account/redeem`, `src/app/api/account/gifts/available`, `src/app/api/telegram-channel/check`,
  `src/app/api/gift-codes`, `src/app/api/settings`
- `src/app/account/gift/components/*`, admin gift-code form/list, `TelegramChannelCard`
- `test/channel-gift.test.js`
