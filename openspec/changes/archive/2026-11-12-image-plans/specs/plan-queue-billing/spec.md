## MODIFIED Requirements

### Requirement: Each grant creates an independent purchased plan
Every grant — approving an order, redeeming a plan gift code, redeeming a credit gift code, an admin "grant plan" and an admin "grant credit" — SHALL create one purchased plan holding: `kind`, total `credit` and total `imageCount` for its kind, the remaining balance in that same unit, start time, expiry (start + duration days), source (`purchase`, `gift` or `admin`; legacy rows may carry `refund`), status `active`, no priority, and a snapshot of time-window limits. Plan-based grants SHALL snapshot the limits from the order (approval) or from the plan at grant time (gift, admin). Credit-only gifts and admin credit grants SHALL be `kind = 'llm'` with no limits; an image purchase SHALL hold `imageTotal = imageRemaining = the purchased count` and `creditTotalNanoUsd = creditRemainingNanoUsd = 0`. Credit SHALL first repay any existing debt and only the rest SHALL become the plan's credit (existing rule); an image grant repays no debt. All money is integer nano-USD; all image balances are integers.

#### Scenario: Gift plan snapshots limits
- **WHEN** a user redeems a gift code for plan "Go" whose limits are `[{5h, $20}, {168h, $80}]`
- **THEN** the new purchased plan carries exactly those two limits

#### Scenario: Later plan edit does not change a purchase
- **WHEN** the admin changes "Go" to `[{5h, $10}]` after the user bought it
- **THEN** the user's purchased plan still carries `[{5h, $20}, {168h, $80}]`

#### Scenario: Credit gift has no limits
- **WHEN** a user redeems a credit gift code worth $5 for 30 days
- **THEN** the new purchased plan has $5 credit, a 30-day expiry and no limits

#### Scenario: Image gift
- **WHEN** a user redeems a gift code for an image plan of 100 images
- **THEN** the new purchased plan has 100 images, 0 credit and the plan's limits snapshot

### Requirement: Time-window limits
A limit SHALL be a window length in whole hours plus a maximum for that window, expressed in the unit the purchase sells: a nano-USD maximum (`maxNanoUsd`) for a credit purchase, an image maximum (`maxImages`) for an image purchase. Each limit of each purchased plan SHALL have its own window state:
- the window opens at the first charge to that plan when no window of that length is open, and closes at open time + length;
- while open, its spent amount is the sum of all amounts charged to that plan since it opened, in the purchase's own unit;
- after it closes, its spent amount counts as zero until the next charge opens a new window.

A plan SHALL be window-blocked while any open window's spent amount is greater than or equal to its maximum. A window-blocked plan SHALL reopen at the latest closing time among its full windows. A limit of the other unit SHALL NOT be compared: an image limit never blocks a dollar charge and a dollar limit never blocks an image charge.

#### Scenario: Window opens on first charge
- **WHEN** a plan with limit `{5h, $20}` is charged for the first time at 10:00
- **THEN** its 5-hour window is open from 10:00 to 15:00

#### Scenario: Window resets after its length
- **WHEN** that plan spent $20 by 11:00 and the next request arrives at 15:01
- **THEN** the plan is eligible again and the 15:01 charge opens a new window ending at 20:01

#### Scenario: Windows are independent
- **WHEN** a plan has limits `{5h, $20}` and `{168h, $80}`, its 168-hour window holds $80 spent and its 5-hour window has closed
- **THEN** the plan stays window-blocked until the 168-hour window closes

#### Scenario: Image window counted in images
- **WHEN** an image plan with limit `{5h, maxImages: 20}` has generated 20 images since 10:00
- **THEN** the plan is window-blocked until 15:00, its 5-hour window shows 20 of 20 images, and its dollar spend stays 0

### Requirement: Admission
Before forwarding a request made with a customer key (after the access checks of `api-access-enforcement`), the system SHALL filter the queue by the request's kind (`image-plans` "The queue admits by kind") and then look for the first eligible plan: one whose own balance is greater than zero (`imageRemaining` for `kind = 'image'`, `creditRemainingNanoUsd` for `kind = 'llm'`), whose `startsAt` is not later than now, whose expiry is later than now, and which is not window-blocked.
- If such a plan exists, the request SHALL proceed on it.
- Otherwise, if at least one candidate plan is funded and unexpired and only window-blocked, the system SHALL respond HTTP 429 with error code `plan_limit`, a `Retry-After` header equal to the whole seconds (rounded up) until the earliest reopen time among those plans, `resetAt` set to that time in ISO-8601 UTC inside the error object, and a Vietnamese message stating the relative wait (for example "Các gói đang chạm hạn mức, mở lại sau 1 giờ 12 phút").
- Otherwise the system SHALL respond HTTP 402 with error code `insufficient_quota` and the message "Hết quota — mua gói hoặc nhập mã quà tặng tại /account/plans".

Admin keys and keyless local requests SHALL bypass admission.

#### Scenario: First plan blocked, second eligible
- **WHEN** plan 1 is window-blocked and plan 2 has credit
- **THEN** the request proceeds

#### Scenario: Every plan blocked
- **WHEN** plan 1 reopens at 15:30, plan 2 reopens at 14:10 and it is 13:00
- **THEN** the response is HTTP 429 `plan_limit` with `Retry-After: 4200` and `resetAt` equal to 14:10

#### Scenario: Nothing left
- **WHEN** the user has no queued plan with credit
- **THEN** the response is HTTP 402 `insufficient_quota`

#### Scenario: Image purchase cannot pay a text request
- **WHEN** the user's only funded plan is an image purchase and the request is a chat completion
- **THEN** the response is HTTP 402 `insufficient_quota`

### Requirement: Charging a completed request
When a request made with a customer key completes with a cost C greater than zero (computed from the router's token pricing, as today) and a number of generated images I (0 for any non-image request), the system SHALL, in the same database transaction that records the usage row:
0. **Images** — for each `kind = 'image'` purchase in queue order that is eligible, take up to `min(I left, images remaining, room in its image windows)` images and record one ledger row of kind `charge` carrying `deltaImages = −taken` and `deltaNanoUsd = 0`; the taken images are paid for, so their share of C (`floor(C × taken / I)`) SHALL be dropped from C before the money passes;
1. **Pass 1** — walk the queue as it is at charge time; for each `kind = 'llm'` plan with remaining credit and an expiry later than now, take `min(C left, remaining credit, room)` where room is the smallest `maximum − spent` over the plan's open windows, a closed or unopened window counting with its full maximum (no limits = unlimited room);
2. **Pass 2** — take whatever is left of C from `kind = 'llm'` plans in queue order that still have remaining credit and an unexpired expiry, ignoring windows;
3. record anything still left as debt, as today.

Each amount taken SHALL produce one ledger row of kind `charge` carrying the plan, the API key, the usage row and the amount, and SHALL be added to that plan's window spent amounts — opening windows where needed — including amounts taken in pass 2. A plan whose remaining balance reaches zero SHALL become `exhausted`. A cost of zero and no images SHALL write nothing. Charging SHALL be idempotent per request: a request already charged SHALL produce no new ledger rows and no change to any window.

#### Scenario: Split at the window edge
- **WHEN** plan 1 (limit `{5h, $20}`, $19.50 spent in its open window) and plan 2 are queued and a request costs $1
- **THEN** $0.50 is charged to plan 1 and $0.50 to plan 2 as two ledger rows, and plan 1 is window-blocked

#### Scenario: Single plan absorbs the overflow
- **WHEN** the user's only plan has $19.50 spent of a $20 window and $100 credit, and a request costs $1
- **THEN** $1 is charged to that plan, its window shows $20.50 spent and the plan is window-blocked until the window closes

#### Scenario: Debt when credit runs out mid-request
- **WHEN** the only plan has $0.30 credit and a request costs $1
- **THEN** $0.30 is charged to the plan, the plan becomes `exhausted` and $0.70 is recorded as debt

#### Scenario: Retried request
- **WHEN** the same completed request is recorded twice
- **THEN** exactly one set of ledger rows exists and window spent amounts increased once

#### Scenario: Image request paid by images
- **WHEN** an image purchase holds 5 images and a request returns 2 images priced at $0.08 total
- **THEN** one `charge` row records `−2` images and 0 nano-USD, 3 images remain, and no debt is recorded

#### Scenario: Images covered, money split
- **WHEN** an image purchase holds 1 image, a credit plan holds $10, and a request returns 2 images priced at $0.10
- **THEN** the image purchase is exhausted on 1 image, $0.05 is charged to the credit plan and no debt is recorded

### Requirement: Refunding an order takes its credit back
Refunding a paid order SHALL set the order to `refunded` and, for every `active` plan that order produced, set the plan to `refunded`, set its remaining balance to zero (credit, or images for an image purchase), delete its window state and record one ledger row of kind `revoke` with the negative forfeited amount in the plan's own unit; it SHALL NOT grant any plan or credit. Credit already spent SHALL stay spent, and images already generated SHALL stay paid for. Refunding an already refunded order SHALL be a no-op, and an order that granted nothing SHALL only change status. A one-time start-up repair SHALL apply the same closing to plans of orders that were refunded before this rule (including the old compensation plans with source `refund`).

#### Scenario: Refund with partly spent credit
- **WHEN** an order granted $25, $5 has been spent, and the order is refunded
- **THEN** the plan becomes `refunded` with $0 remaining, a `revoke` row of -$20 exists, and no new plan is created

#### Scenario: Refund of an image order
- **WHEN** an order granted 100 images, 30 were generated, and the order is refunded
- **THEN** the purchase becomes `refunded` with 0 images, a `revoke` row of −70 images exists, and no credit is granted
