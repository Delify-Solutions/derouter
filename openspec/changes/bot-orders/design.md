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
One period, no voucher, no custom amount: those need the web form (a link is
offered).

### D5. One order per tap sequence
A second tap on the same plan and method reuses the customer's unpaid,
unexpired order. Once the order is written, logging and the admin ping are best
effort (not awaited, never fail the reply); an order fully covered by discounts
is reported as activated.
