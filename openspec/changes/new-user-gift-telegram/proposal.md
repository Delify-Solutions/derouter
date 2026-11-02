## Why

The owner wants a welcome gift for new customers. Gift codes today are limited per account, and accounts are free to create, so a public welcome code would be farmed with throwaway emails. A Telegram account needs a phone number, which makes it a far costlier identity to repeat. Linking one should be a single tap from the customer's point of view.

## What Changes

- **Telegram linking** for customer accounts through a Telegram **Mini App**. On `/account` (and from the gift page when a code needs it), "Liên kết Telegram" opens `https://t.me/<bot>/<app>?startapp=<one-time token>`. Telegram opens our page `/telegram/link` inside the app, which hands Telegram's signed launch data to the server. The server checks the signature with the bot token and links that Telegram user to the account the token was issued for. There is no chat and no Start button, and no webhook is needed. One Telegram user links to at most one account. The customer can unlink.
- **New-user gift codes**: a gift code can be flagged `newUserOnly`. Typing such a code succeeds only when:
  - the account has never bought a plan (no purchase grant);
  - the account has never received a new-user code;
  - the account has a linked Telegram;
  - that Telegram user has never received a new-user code on any account.

  The Telegram user id is stored on the redemption, so unlinking and relinking elsewhere does not reset it. A new-user code allows one redemption per account.
- The redeem API reports each refusal separately. Only "Telegram not linked" offers the link button. Once linking finishes, the gift page redeems the code by itself.
- An admin who assigns a code straight to accounts bypasses the new-user conditions.
- Admin: a "Mã người mới" option and tag on gift codes, the Telegram user on each redemption, and the bot username and Mini App short name in the Telegram settings.

## Capabilities

### New Capabilities
- `telegram-link`: linking a customer account to a Telegram user through a Mini App.

### Modified Capabilities
- `gift-codes`: new-user codes.

## Impact

- **Database** (`SCHEMA_VERSION` 23 → 24, additive):
  - `users.telegramUserId`, `users.telegramUsername`, `users.telegramLinkedAt`, with a unique index on `telegramUserId`;
  - new table `telegramLinkTokens`;
  - `giftCodes.newUserOnly`;
  - `giftRedemptions.telegramUserId`.
- **Code**:
  - `src/lib/telegram/initData.js` (signature check);
  - `src/lib/db/repos/telegramLinkRepo.js`;
  - `src/lib/db/repos/giftRepo.js`;
  - `src/app/api/account/telegram/**` and `src/app/api/public/telegram/link`;
  - `src/app/telegram/link`;
  - the `/account` and `/account/gift` UI;
  - the admin gift codes page and the settings page;
  - `next.config.mjs` (headers for the Mini App page).
- **Settings**: `telegramBotUsername`, `telegramMiniAppName` (default `link`). The existing `telegramBotToken` signs Mini App data.
- **Operator step**: in BotFather, `/newapp` for the bot with short name `link` and URL `https://<domain>/telegram/link`.
