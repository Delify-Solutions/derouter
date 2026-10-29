# plan-queue-billing Specification

## Purpose
Defines how a customer's purchased plans form a queue, which plan pays for each request, how per-plan time-window limits block and reopen a plan, and how credit is granted, charged, expired, carried as debt and back-charged — so that "pay $10, get $250 usable on any model, drained one plan at a time in the order I choose" holds exactly.
## Requirements
### Requirement: Each grant creates an independent purchased plan
Every grant — approving an order, redeeming a plan gift code, redeeming a credit gift code, an admin "grant plan" and an admin "grant credit" — SHALL create one purchased plan holding: total credit, remaining credit, start time, expiry (start + duration days), source (`purchase`, `gift` or `admin`; legacy rows may carry `refund`), status `active`, no priority, and a snapshot of time-window limits. Plan-based grants SHALL snapshot the limits from the order (approval) or from the plan at grant time (gift, admin). Credit-only grants SHALL have no limits. Credit SHALL first repay any existing debt and only the rest SHALL become the plan's credit (existing rule). All money is integer nano-USD.

#### Scenario: Gift plan snapshots limits
- **WHEN** a user redeems a gift code for plan "Go" whose limits are `[{5h, $20}, {168h, $80}]`
- **THEN** the new purchased plan carries exactly those two limits

#### Scenario: Later plan edit does not change a purchase
- **WHEN** the admin changes "Go" to `[{5h, $10}]` after the user bought it
- **THEN** the user's purchased plan still carries `[{5h, $20}, {168h, $80}]`

#### Scenario: Credit gift has no limits
- **WHEN** a user redeems a credit gift code worth $5 for 30 days
- **THEN** the new purchased plan has $5 credit, a 30-day expiry and no limits

### Requirement: Queue order
A user's queue SHALL consist of the purchased plans with status `active` and expiry later than now. They SHALL be ordered: plans with a priority first, by ascending priority; then plans without a priority by ascending expiry; ties by ascending creation time, then by id.

#### Scenario: Default order is earliest expiry first
- **WHEN** a user holds plan A expiring on 10 Nov and plan B expiring on 20 Nov and never reordered
- **THEN** the queue is A, B

#### Scenario: Manual order wins and new plans go last
- **WHEN** the user reorders to B, A and later receives plan C expiring on 5 Nov
- **THEN** the queue is B, A, C

### Requirement: Reordering the queue
A reorder request SHALL carry the complete list of the queue's plan ids in the desired order. If the submitted ids are exactly the current queue, the system SHALL store priorities 1..n in that order and record an audit entry `queue_reordered` with the actor. If the set differs (missing, extra, expired or exhausted id), it SHALL respond HTTP 409 with error code `queue_changed` and change nothing. An empty list or duplicate ids SHALL be rejected with HTTP 400.

#### Scenario: Stale reorder refused
- **WHEN** a plan in the customer's queue expires between page load and pressing "Lưu thứ tự"
- **THEN** the response is HTTP 409 `queue_changed` and no priority changes

### Requirement: Time-window limits
A limit SHALL be a window length in whole hours plus a maximum amount for that window. Each limit of each purchased plan SHALL have its own window state:
- the window opens at the first charge to that plan when no window of that length is open, and closes at open time + length;
- while open, its spent amount is the sum of all amounts charged to that plan since it opened;
- after it closes, its spent amount counts as zero until the next charge opens a new window.

A plan SHALL be window-blocked while any open window's spent amount is greater than or equal to its maximum. A window-blocked plan SHALL reopen at the latest closing time among its full windows.

#### Scenario: Window opens on first charge
- **WHEN** a plan with limit `{5h, $20}` is charged for the first time at 10:00
- **THEN** its 5-hour window is open from 10:00 to 15:00

#### Scenario: Window resets after its length
- **WHEN** that plan spent $20 by 11:00 and the next request arrives at 15:01
- **THEN** the plan is eligible again and the 15:01 charge opens a new window ending at 20:01

#### Scenario: Windows are independent
- **WHEN** a plan has limits `{5h, $20}` and `{168h, $80}`, its 168-hour window holds $80 spent and its 5-hour window has closed
- **THEN** the plan stays window-blocked until the 168-hour window closes

### Requirement: Admission
Before forwarding a request made with a customer key (after the access checks of `api-access-enforcement`), the system SHALL look for the first plan in the queue that has remaining credit greater than zero, an expiry later than now and is not window-blocked.
- If such a plan exists, the request SHALL proceed.
- Otherwise, if at least one queued plan has remaining credit and is only window-blocked, the system SHALL respond HTTP 429 with error code `plan_limit`, a `Retry-After` header equal to the whole seconds (rounded up) until the earliest reopen time among those plans, `resetAt` set to that time in ISO-8601 UTC inside the error object, and a Vietnamese message stating the relative wait (for example "Các gói đang chạm hạn mức, mở lại sau 1 giờ 12 phút").
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

### Requirement: Charging a completed request
When a request made with a customer key completes with a cost C greater than zero (computed from the router's token pricing, as today), the system SHALL, in the same database transaction that records the usage row:
1. **Pass 1** — walk the queue as it is at charge time; for each plan with remaining credit and an expiry later than now, take `min(C left, remaining credit, room)` where room is the smallest `maximum − spent` over the plan's open windows, a closed or unopened window counting with its full maximum (no limits = unlimited room);
2. **Pass 2** — take whatever is left of C from plans in queue order that still have remaining credit and an unexpired expiry, ignoring windows;
3. record anything still left as debt, as today.

Each amount taken SHALL produce one ledger row of kind `charge` carrying the plan, the API key, the usage row and the amount, and SHALL be added to that plan's window spent amounts — opening windows where needed — including amounts taken in pass 2. A plan whose remaining credit reaches zero SHALL become `exhausted`. A cost of zero SHALL write nothing. Charging SHALL be idempotent per request: a request already charged SHALL produce no new ledger rows and no change to any window.

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

### Requirement: Refunding an order takes its credit back
Refunding a paid order SHALL set the order to `refunded` and, for every `active` plan that order produced, set the plan to `refunded`, set its remaining credit to zero, delete its window state and record one ledger row of kind `revoke` with the negative forfeited amount; it SHALL NOT grant any plan or credit. Credit already spent SHALL stay spent. Refunding an already refunded order SHALL be a no-op, and an order that granted nothing SHALL only change status. A one-time start-up repair SHALL apply the same closing to plans of orders that were refunded before this rule (including the old compensation plans with source `refund`).

#### Scenario: Refund with partly spent credit
- **WHEN** an order granted $25, $5 has been spent, and the order is refunded
- **THEN** the plan becomes `refunded` with $0 remaining, a `revoke` row of -$20 exists, and no new plan is created

### Requirement: Image generation is priced per image
A completed `POST /v1/images/generations` SHALL be recorded as a usage row and charged exactly like any other request, at `image` USD per generated image (a price field on per-model pricing and on combo pricing, resolved with the same combo-first order as token prices) times the number of images returned (at least 1). A customer key SHALL be refused with HTTP 403 before any upstream call when the resolved model has no positive image price; admin and local keys are not billed and SHALL NOT be refused. A custom OpenAI-compatible provider node SHALL be usable for image generation at `<baseUrl>/images/generations` with the request body forwarded as sent except for `model`, so model-specific fields (`condition_images`, `seed`, `num_inference_steps`, ...) reach the upstream; built-in provider adapters keep their field whitelists.

#### Scenario: Two images at $0.04
- **WHEN** a customer key generates 2 images on a model priced at $0.04 per image
- **THEN** one `charge` of $0.08 is written against their plan queue

#### Scenario: Unpriced image model
- **WHEN** a customer key calls an image model with no image price
- **THEN** the call is refused with 403 and nothing is charged or forwarded

### Requirement: Expiry
A plan whose expiry has passed SHALL never be selected by admission or charged, even before the periodic sweep runs. The sweep, running at least every 5 minutes, SHALL mark such plans `expired`, set their remaining credit to zero, record a ledger row of kind `expire` with the forfeited amount, and delete window state belonging to plans that are no longer `active`.

#### Scenario: Unswept expired plan
- **WHEN** plan A expired one minute ago, has not been swept, and plan B has credit
- **THEN** a new request is charged to plan B and plan A's credit is unchanged until the sweep

### Requirement: Debt
Debt SHALL be repaid first by any later grant. While debt exists, available credit SHALL be reported as the sum of the queue's remaining credit minus the debt, floored at zero.

#### Scenario: Grant repays debt
- **WHEN** a user with $0.70 debt is granted a $250 plan
- **THEN** the debt becomes zero and the new plan has $249.30 credit

### Requirement: One-time back-charge of uncharged usage
On the first start after this change, the system SHALL charge, in ascending timestamp order, every usage row that belongs to a customer key, has a cost greater than zero, has a timestamp at or after `2026-10-28T19:22:58Z`, and has no `charge` ledger row. Each row SHALL only be charged to purchased plans whose start is at or before the usage timestamp and whose expiry is after it, in queue order, ignoring window limits; any remainder SHALL become debt. These ledger rows SHALL be marked as back-charges with the usage timestamp. Window state SHALL NOT change. The back-charge SHALL run exactly once; running the start-up again SHALL change nothing.

#### Scenario: Plan bought later does not pay for earlier usage
- **WHEN** an uncharged $2 usage row is dated 29 Oct 08:00, plan A started 29 Oct 01:00 with $1 left and plan B started 29 Oct 09:00
- **THEN** $1 is charged to plan A, $1 becomes debt, and plan B is untouched

#### Scenario: Old rows ignored
- **WHEN** an uncharged usage row is dated 27 Oct
- **THEN** it is not charged

