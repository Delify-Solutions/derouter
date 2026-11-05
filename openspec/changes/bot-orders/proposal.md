## Why

The owner wants customers to buy plans directly in the Telegram bot.

## What Changes

- `/plans` lists plans with a "Mua" button; a plan shows the payment methods it
  offers (VietQR, Binance USDT, manual when allowed) for one period.
- Choosing a method creates the order through the same checkout code as the web
  and replies with the payment details: the VietQR image with bank, account,
  amount and transfer content (or Binance Pay ID, amount and note), expiry, and
  buttons to check payment, cancel, or open the order on the web. The admin is
  told about the new order as for web orders.
- `/myorders` lists recent orders; pending ones can be paid again or cancelled.
- Custom-amount plans: quick 1× / 2× the plan's price, or a typed amount (a
  forced reply to the bot's prompt), quoted before choosing a method.
- Multi-period terms and vouchers stay on the web.
- The web's own cancel is guarded on `pending` too.
- A linked customer writing to the bot resumes notifications paused after
  Telegram refused a message.
- Customer docs page "Bot Telegram".

## Capabilities

### Modified Capabilities
- `telegram-bot` (change telegram-bot-commands): buying plans.

## Impact

- `src/lib/telegram/bot/orders.js` (new), `handler.js`, `customer.js`,
  `src/lib/telegram/botApi.js` (sendPhoto), webhook route (admin notifier),
  `src/lib/db/repos/billingRepo.js` (`cancelOrder` guard),
  `content/docs/telegram-bot.md`; tests `test/bot-orders.test.js`,
  `test/telegram-bot.test.js`, `test/docs-seed.test.js`.
