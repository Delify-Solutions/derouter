# payment-reconciliation Specification

## Purpose
Defines how money arriving at a receiving account (SePay, web2m, ACB or Binance Pay) is recorded exactly once, tied to the right order through its payment code, and either activates the plan automatically or is kept for the admin to resolve — never silently dropped and never credited twice.
## Requirements
### Requirement: Every incoming transaction is recorded once
Each transaction received from a provider — by webhook or polling — SHALL be normalized to: provider, external id, direction, amount in minor units (đồng for VND, nano-USDT for USDT), currency, content/note, occurrence time and the raw payload. Outgoing transactions SHALL be ignored and not stored. An incoming transaction whose (provider, external id) was already stored SHALL change nothing.

#### Scenario: Webhook retried
- **WHEN** SePay delivers the same transaction id twice
- **THEN** one transaction row exists and the order was approved at most once

### Requirement: Payment code extraction
The system SHALL search the content/note, upper-cased, for the order payment code pattern (configured prefix + 8 code characters), first in the text as received and then in the text with every non-alphanumeric character removed, and SHALL use the first candidate that equals an existing order's payment code.

#### Scenario: Bank adds its own text
- **WHEN** the content is `MBVCB.1234567.DR8K3Q7MZP.CT tu 0123 toi 9876`
- **THEN** the code `DR8K3Q7MZP` is extracted

#### Scenario: Customer inserts spaces
- **WHEN** the content is `dr8k 3q7m zp thanh toan`
- **THEN** the code `DR8K3Q7MZP` is extracted

### Requirement: Matching rules and automatic approval
For a stored incoming transaction, the system SHALL decide in one database transaction, locking the order:
- **matched** — a code was found, the order uses this provider, is `pending`, the transaction occurred no earlier than 5 minutes before the order was created and no later than its `expiresAt`, and the amount is exactly `payAmount` (VND) or at least `payAmount` (USDT): the order SHALL be approved through the normal grant path (plan queued with its snapshot, debt repaid first), marked `paid` with `paymentTransactionId`, `approvedBy = payment:<provider kind>`, and the transaction marked `matched`;
- otherwise the transaction SHALL be marked `needs_review` with one reason: `no_code`, `order_not_found`, `wrong_provider`, `order_not_pending` (already paid, cancelled or refunded), `order_expired`, `amount_mismatch` (VND not exact) or `underpaid` (USDT below the amount).

An admin notification SHALL be sent for every `matched` and every `needs_review` transaction.

#### Scenario: Exact VietQR payment
- **WHEN** 250,000đ arrives with content containing the code of a pending 250,000đ order
- **THEN** the order is `paid`, the plan is in the customer's queue, and the transaction is `matched`

#### Scenario: Wrong amount
- **WHEN** 200,000đ arrives for a 250,000đ order
- **THEN** the order stays `pending`, the transaction is `needs_review` with reason `amount_mismatch`

#### Scenario: Late payment
- **WHEN** a correct payment arrives after the order expired
- **THEN** the order stays `expired` and the transaction is `needs_review` with reason `order_expired`

#### Scenario: Binance overpayment
- **WHEN** 10.5 USDT arrives with the code of a 10 USDT order
- **THEN** the order is approved

### Requirement: SePay webhook
`POST /api/payments/sepay/webhook` SHALL be reachable without a session. It SHALL accept only requests whose `Authorization` header is `Apikey <key>` equal (constant-time comparison) to the webhook key of an active `sepay` provider, else answer 401. It SHALL record and reconcile the transaction (id, `transferType`, `transferAmount`, `content`, `transactionDate`, `accountNumber`) for that provider and answer HTTP 200 `{ "success": true }` for every authenticated request, including duplicates and transactions needing review, so SePay does not retry them.

#### Scenario: Wrong key
- **WHEN** a request carries `Authorization: Apikey wrong`
- **THEN** the response is HTTP 401 and nothing is stored

### Requirement: Polling providers
A background poller SHALL fetch recent transactions for every active provider configured for polling (`web2m`, `acb`, `binance`, and `sepay` when an API token is set) no more often than its poll interval (default 30 seconds, minimum 15), with a 15-second request timeout, one fetch per provider at a time, and record the last poll time and last error on the provider. Binance requests SHALL be signed with HMAC-SHA256 over the query string using the provider's secret. Request URLs or headers containing secrets SHALL NOT be written to logs or stored errors.

#### Scenario: Provider down
- **WHEN** the web2m API times out
- **THEN** the provider shows the error and the time, other providers keep polling, and no secret appears in the error text

### Requirement: ACB account polling
For an `acb` provider the system SHALL read the account's incoming transactions through the ACB mobile-app API:
- it SHALL log in with the stored internet-banking username and password only when no cached token exists, and SHALL reuse the cached token on later polls;
- when ACB answers that the token is expired or unauthorized, it SHALL log in again once and retry once in the same poll; a second refusal SHALL be recorded as the provider's last error;
- it SHALL read the transaction history of the configured account number for the last 30 days (at most 100 rows); when the history service is refused or returns no rows, it SHALL read the notifications feed instead and keep only notifications mentioning the account number, deriving direction from the `(VND) +`/`(VND) -` marker and the amount from the notification;
- the transfer memo SHALL be the text after `transaction:` when present, and amounts SHALL always be positive with direction carried separately;
- a changed username, password or device identity SHALL invalidate the cached token.

#### Scenario: Token reused between polls
- **WHEN** an ACB provider polled successfully a minute ago and polls again
- **THEN** no login request is sent

#### Scenario: Expired token
- **WHEN** ACB refuses the cached token
- **THEN** the provider logs in once, retries, and the poll succeeds without an error being recorded

#### Scenario: History blocked
- **WHEN** the history call answers "You cannot consume this service"
- **THEN** transactions are taken from the notifications feed and a `(VND) + 250,000` notification for the account becomes an incoming 250000đ transaction

### Requirement: Admin resolution of transactions
For a `needs_review` transaction the admin SHALL be able to:
- "Gán vào đơn" — choose a pending or expired order; the order SHALL be approved through the normal grant path regardless of the amount difference, and the transaction becomes `matched` with `resolvedBy` and the reason;
- "Đánh dấu đã xử lý" — mark it `resolved` (for example refunded outside the system).

Both actions SHALL require a reason of 3–500 characters and SHALL write an audit entry on the order owner's audit log when an order is involved. A `matched` or `resolved` transaction SHALL NOT be resolved again, and an order that is already `paid` SHALL NOT be approved again.

#### Scenario: Assign a late payment
- **WHEN** the admin assigns an `order_expired` transaction to its order with reason "Khách chuyển muộn 3 phút"
- **THEN** the order becomes `paid`, the plan is queued, and the transaction shows the admin and the reason

