## Decisions

### D1. Same checkout as the web
`planPurchaseBlocker` (who may buy), `offeredMethodsSync` (methods),
`createGatewayOrderSync` / `createOrder` (the order), `buildPaymentBlock` (exact
details). Paying is detected by the existing gateway pollers/webhooks, and
`notifyOrderApproved` tells the linked customer. Re-checked when the order is
created, so a stale button cannot buy what the web would refuse.

### D2. QR as a photo, text as the fallback
The VietQR URL (or the Binance QR image) is sent with `sendPhoto` and the details
as its caption; if Telegram cannot fetch the image, or the caption is too long,
the details go as text.

### D3. Cancelling
Owner only, guarded by `fromStatus: "pending"`, so a payment that landed first
wins; logged as `order_cancel` with `via: "telegram_bot"`.

### D4. Scope
One period, no voucher: those need the web form (a link is offered).

### D5. One order per tap sequence
A second tap on the same plan and method reuses the customer's unpaid,
unexpired order. Once the order is written, logging and the admin ping are best
effort (not awaited, never fail the reply); an order fully covered by discounts
is reported as activated.

### D6. Custom-amount plans
After "Mua", the bot offers 1× and 2× the plan's VND price (kept inside the
plan's bounds) and "Nhập số tiền", which sends a forced-reply prompt ending in
"Mã gói: <planId>". The customer's reply to that bot message carries the plan, so
no conversation state is kept. The marker is the prompt's last line, so a plan name containing the same words cannot mislead the match. Amounts accept 500000, 500.000, 500k, 1.5tr.
`quoteTopup` validates and prices them, the quote (amount → credit) is shown, and
the method buttons carry the amount (`bm:<plan>:<method>:<amount>`, ≤ 64 bytes).
The order is created with `amountVnd` like the web; reuse of an unpaid order
also matches its credit, so another amount is another order.

### D7. Web cancel guarded
`cancelOrder` updates only `WHERE status = 'pending'` and reports `not_pending`
when nothing changed.

### D8. Writing to the bot resumes notifications
`telegramDmBlockedAt` (set when Telegram refused a message) is also cleared when
the linked customer sends the bot any update: a user who blocked the bot cannot
write to it, so a message proves the chat works again. This adds a fourth way to
clear the mark to telegram-notify's delivered message, new link and unlink.
