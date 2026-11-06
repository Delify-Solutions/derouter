## MODIFIED Requirements

### Requirement: Matching rules and automatic approval
For a stored incoming transaction, the system SHALL decide in one database transaction, locking the order:
- **matched** — a code was found, the order uses this provider, is `pending` — or `expired` while the transaction's own time is known and no later than the order's `expiresAt`, its voucher (if any) is still active and not held by another order, and reviving it keeps the plan within its monthly purchase limit — the transaction occurred no earlier than 5 minutes before the order was created and no later than its `expiresAt`, and the amount is exactly `payAmount` (VND) or at least `payAmount` (USDT): the order SHALL be approved through the normal grant path (plan queued with its snapshot, debt repaid first), marked `paid` with `paymentTransactionId`, `approvedBy = payment:<provider kind>`, and the transaction marked `matched`;
- otherwise the transaction SHALL be marked `needs_review` with one reason: `no_code`, `order_not_found`, `wrong_provider`, `order_not_pending` (already paid, cancelled or refunded), `order_expired`, `amount_mismatch` (VND not exact) or `underpaid` (USDT below the amount).

The same rules apply to the webhook, the poll and the dry run, whichever of the expiry sweep and the payment's arrival happens first.

An admin notification SHALL be sent for every `matched` and every `needs_review` transaction.

#### Scenario: Exact VietQR payment
- **WHEN** 250,000đ arrives with content containing the code of a pending 250,000đ order
- **THEN** the order is `paid`, the plan is in the customer's queue, and the transaction is `matched`

#### Scenario: Wrong amount
- **WHEN** 200,000đ arrives for a 250,000đ order
- **THEN** the order stays `pending`, the transaction is `needs_review` with reason `amount_mismatch`

#### Scenario: Late payment
- **WHEN** a correct payment that occurred after the order's `expiresAt` arrives
- **THEN** the order stays `expired` and the transaction is `needs_review` with reason `order_expired`

#### Scenario: Paid in time, seen after the sweep
- **WHEN** a customer pays at minute 29 of a 30-minute order and the poll that brings the transfer in runs after the sweep marked the order `expired`
- **THEN** the order is `paid` once, the plan is granted once, and the transaction is `matched`

#### Scenario: The expired order's voucher went to another order
- **WHEN** a payment made inside the window arrives for an `expired` order whose voucher was meanwhile used by another paid order
- **THEN** the order stays `expired` and the transaction is `needs_review` with reason `order_expired`

#### Scenario: Expired order and a payment without a time
- **WHEN** a correct payment with no transaction time arrives for an `expired` order
- **THEN** the transaction is `needs_review` with reason `order_expired`

#### Scenario: Binance overpayment
- **WHEN** 10.5 USDT arrives with the code of a 10 USDT order
- **THEN** the order is approved
