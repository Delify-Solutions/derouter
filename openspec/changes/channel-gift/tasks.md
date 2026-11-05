## 1. Data and rules

- [x] 1.1 Schema v34: `giftCodes.channelJoinOnly`, `giftCodes.listed`
- [x] 1.2 giftRepo: create/update flags, exclusivity, perUserLimit pin
- [x] 1.3 `channelRefusalSync`, `channelClaimedSync`, `giftRequirementSync`; `redeemGiftCode` takes `channelMemberTelegramUserId`
- [x] 1.4 `listAvailableGiftsSync` ← (verify: only codes the account can still take; channel claim per Telegram user)

## 2. Telegram

- [x] 2.1 `channelMember.js`: chat id resolution, `checkChannelMember`, `checkBotCanReadChannel`
- [x] 2.2 Settings `telegramChannelChatId` validation; admin check route
- [x] 2.3 Redeem route: membership check before the transaction, 503 on Telegram failure, `channelOffer` after a welcome code ← (verify: no path redeems a channel code without a verified member of the same Telegram user)

## 3. UI

- [x] 3.1 Admin gift form toggles and list badges; Telegram page chat id + "Kiểm tra bot"
- [x] 3.2 `/account/gift`: "Mã có thể sử dụng", channel-required hint in the typed form, welcome offer modal

## 4. Checks

- [x] 4.1 `test/channel-gift.test.js`; npm test, lint, build; live run
