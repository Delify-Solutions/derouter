## 1. Buying in the bot

- [x] 1.1 `orders.js`: plan detail with methods, create order, payment reply, status, cancel, /myorders, pay again
- [x] 1.2 Handler wiring (bp, bm, up, us, uc; /myorders, /buy), sendPhoto with text fallback, admin notifier ← (verify: same rules as the web checkout; only the owner sees or cancels an order)
- [x] 1.3 `test/bot-orders.test.js`

## 2. Custom amounts, cancel guard, docs

- [x] 2.1 Custom-amount plans in the bot: quick 1× / 2× (or the minimum), typed amount via forced reply, quote, methods with the amount (D6) ← (verify: purchase check before any amount step; amount parity with the web)
- [x] 2.2 Web `cancelOrder` guarded on `pending` (D7), with a test that forces the read/write gap
- [x] 2.3 Writing to the bot resumes paused notifications (D8)
- [x] 2.4 Customer docs page `content/docs/telegram-bot.md`; docs seed test slug list
