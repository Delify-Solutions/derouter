# payment-checkout Specification

## Purpose
Defines how a customer pays for one plan directly: the order created for a chosen payment method, the unique code and exact amount to pay, the order page that guides the payment and reacts when it arrives, and how unpaid orders are cancelled or expire.
## Requirements
### Requirement: Creating a gateway order
`POST /api/account/orders` with `{ planId, method }`, where `method` is `vietqr`, `binance` or `manual`, SHALL create a pending order only if the method is offered for that plan (spec `plan-dual-pricing`) and the existing purchase blockers allow it; otherwise it SHALL answer HTTP 400 with the reason. For `vietqr` and `binance` the order SHALL store, at creation: a payment code, `payCurrency` (`VND` or `USDT`), `payAmount` (đồng for VND; nano-USDT for USDT, equal to the plan's USD price), the receiving provider (the active provider of that kind with the lowest sort order), and `expiresAt` = now + the setting `paymentOrderTtlMinutes` (default 30). Plan credit, duration and limits are snapshotted as for any order. The response SHALL contain the order id and the URL `/account/orders/<id>`.

#### Scenario: VietQR order
- **WHEN** a customer orders "Go" (250,000đ) with method `vietqr`
- **THEN** the order is pending with currency VND, amount 250000, a payment code, a provider and an expiry 30 minutes ahead

#### Scenario: Method not offered
- **WHEN** a customer requests method `binance` for a plan with USD price 0
- **THEN** the response is HTTP 400 and no order is created

### Requirement: Payment code
A payment code SHALL be the setting `paymentCodePrefix` (default `DR`, 2–6 uppercase letters) followed by 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, unique across all orders. It SHALL contain only letters and digits so banks do not alter it.

#### Scenario: Code shape
- **WHEN** an order is created with the default prefix
- **THEN** its code matches `^DR[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$` and no other order has the same code

### Requirement: Pending order limit
A customer SHALL NOT hold more than 5 pending gateway orders at once; a sixth SHALL be refused with HTTP 429 and the message "Bạn đang có quá nhiều đơn chưa thanh toán — thanh toán hoặc huỷ bớt đơn cũ".

#### Scenario: Sixth pending order
- **WHEN** a customer with 5 pending gateway orders creates another
- **THEN** the response is HTTP 429 and no order is created

### Requirement: Order page
`/account/orders/[id]` SHALL be visible only to the order's owner (others get a not-found state) and SHALL show the plan, the amount with its currency, the payment code, and:
- for `vietqr`: a VietQR image encoding the receiving account, the amount and the code as transfer content, plus copyable bank name, account number, account holder, amount and content, and the instruction "Nhập đúng nội dung chuyển khoản, nếu sai hệ thống không tự kích hoạt được";
- for `binance`: the admin's QR image when configured, the copyable Binance Pay UID / account name, the USDT amount and the code, and the instruction "Ghi mã vào ô Note khi chuyển Binance Pay".

While the order is pending it SHALL show a countdown to `expiresAt` and refresh its status from `GET /api/account/orders/[id]` every 5 seconds; when the order becomes `paid` it SHALL show "Thanh toán thành công — gói đã vào hàng đợi" with a link to `/account/plans`; when it becomes `expired` or `cancelled` it SHALL say so and offer "Tạo đơn mới".

#### Scenario: Paid while watching
- **WHEN** the customer keeps the order page open and the payment is matched
- **THEN** within 5 seconds the page shows the success message and the plan is in the queue

#### Scenario: Someone else's order
- **WHEN** a customer opens another customer's order id
- **THEN** the page shows the not-found state and no payment details

### Requirement: Cancel and expiry
The owner SHALL be able to cancel a pending order (existing endpoint). A periodic job (at least every minute) SHALL set every pending gateway order whose `expiresAt` has passed to `expired`. Orders with status `cancelled` or `expired` SHALL NOT count toward `purchaseLimitPerMonth` or the pending-order limit. The order status list SHALL be `pending`, `paid`, `cancelled`, `expired`, `refunded`.

#### Scenario: Expiry
- **WHEN** a VietQR order is still pending 31 minutes after creation
- **THEN** its status is `expired` and it no longer counts toward the monthly purchase limit

