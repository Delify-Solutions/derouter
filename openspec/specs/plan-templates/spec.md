# plan-templates Specification

## Purpose
Lets the admin define the plans that are sold — price, total credit usable on any model, duration and per-window spending limits — and see how each plan performs, without silently rewriting what existing buyers already hold.
## Requirements
### Requirement: Plan definition
A plan SHALL have: `code` (2–32 characters of a–z, 0–9, `_` or `-`, starting with a letter or digit, unique), `name` (required), `description`, `price` (integer nano-USD ≥ 0), `credit` (integer nano-USD > 0, usable on every model the buyer's group allows), `durationDays` (integer ≥ 1), `limits` (0 to 5 entries), and the existing `isActive`, `isPurchasable`, `allowedGroupIds`, `purchaseLimitPerMonth`, `isFeatured` and `sortOrder` with their current meaning. `POST /api/plans` and `PATCH /api/plans/[id]` SHALL accept and return `limits`.

#### Scenario: Go plan
- **WHEN** an admin creates code `go`, price $10, credit $250, 30 days, limits `[{hours: 5, max: $20}, {hours: 168, max: $80}]`
- **THEN** the plan is stored and `GET /api/plans` returns it with those values

### Requirement: Limit validation
Each limit SHALL have an integer `hours` between 1 and `durationDays × 24` and a maximum greater than zero and strictly less than the plan's credit. Two limits SHALL NOT share the same `hours`. For any two limits with `hours` a < b, the maximum of a SHALL NOT exceed the maximum of b. A plan SHALL have at most 5 limits. A violation SHALL be rejected with HTTP 400 and a Vietnamese message naming the offending limit; nothing is saved.

#### Scenario: Shorter window with a larger maximum
- **WHEN** an admin saves limits `[{5h, $50}, {168h, $40}]`
- **THEN** the response is HTTP 400 naming the 5-hour limit

#### Scenario: Maximum not below credit
- **WHEN** a plan with $250 credit gets a limit `{24h, $250}`
- **THEN** the response is HTTP 400

### Requirement: Orders snapshot limits
Creating an order SHALL store the plan's price, credit, duration and limits at that moment, and approving it SHALL grant exactly that snapshot. An order created before this change (no stored limits) SHALL be granted with the plan's limits at approval time.

#### Scenario: Limits changed while an order is pending
- **WHEN** a customer orders "Go" with `{5h, $20}`, the admin then changes it to `{5h, $10}` and approves the order
- **THEN** the granted plan carries `{5h, $20}`

### Requirement: Applying new limits to active purchases is explicit
Editing a plan SHALL affect only later orders and grants. When `PATCH /api/plans/[id]` changes `limits` and includes `applyToActive: true`, every purchased plan of that plan with status `active` SHALL receive the new limits (credit and expiry unchanged), window state for removed window lengths SHALL be deleted while state for kept lengths SHALL keep its spent amount, each affected user SHALL get an audit entry `plan_limits_changed` with actor = the admin and reason "Áp dụng hạn mức mới của gói <code>", and the response SHALL include `affectedCount`.

#### Scenario: Apply to 3 active purchases
- **WHEN** an admin saves new limits for "Go" with `applyToActive: true` while 3 purchases are active and 2 are expired
- **THEN** the 3 active purchases carry the new limits, the 2 expired ones are unchanged and `affectedCount` is 3

### Requirement: Plan statistics
`GET /api/plans` SHALL return for every plan: `activeCount` (its purchases with status `active`), `activeUsers` (distinct users holding such a purchase), `revenueNanoUsd` (sum of order amounts with status `paid`; `refunded` and other statuses excluded) and `consumedNanoUsd` (sum of amounts charged to its purchases). The admin plans page SHALL show these four figures per plan.

#### Scenario: Refunded order excluded
- **WHEN** a plan has 2 paid orders of $10 and 1 refunded order of $10
- **THEN** `revenueNanoUsd` equals $20

### Requirement: Admin plan form
The plan form SHALL replace the per-model limit block with a limits editor: rows of window length (presets `5 giờ` = 5, `1 ngày` = 24, `1 tuần` = 168, or a custom number of hours) and a USD maximum, with add/remove controls and inline validation messages from the limit validation rule. It SHALL show a live preview sentence, for example "Khách trả $10 → nhận $250 dùng chung mọi model trong 30 ngày; tối đa $20 mỗi 5 giờ, $80 mỗi 1 tuần". When editing a plan whose limits changed, it SHALL offer the checkbox "Áp dụng hạn mức mới cho N gói đang chạy" with N = the plan's `activeCount`.

#### Scenario: Preview reflects the form
- **WHEN** the admin enters price 10, credit 250, 30 days and one limit `5 giờ / 20`
- **THEN** the preview reads "Khách trả $10 → nhận $250 dùng chung mọi model trong 30 ngày; tối đa $20 mỗi 5 giờ"

### Requirement: Per-model ceilings no longer exist
The system SHALL NOT store or enforce per-model monthly ceilings. `/api/plans/[id]/model-limits` and `/api/account/quota` SHALL respond 404, the page `/account/quota` SHALL redirect permanently to `/account/plans`, and no response SHALL carry `x-plan-model-limit`, `x-plan-model-remaining`, `x-plan-window`, `x-plan-window-limit`, `x-plan-window-remaining` or `x-plan-window-reset` headers.

#### Scenario: Old quota page
- **WHEN** a customer opens `/account/quota`
- **THEN** the browser is redirected to `/account/plans`

