## MODIFIED Requirements

### Requirement: Plan definition
A plan SHALL have: `code` (2–32 characters of a–z, 0–9, `_` or `-`, starting with a letter or digit, unique), `name` (required), `description`, `price` (integer nano-USD ≥ 0), `kind` (`llm`, the default, or `image`), `durationDays` (integer ≥ 1), `limits` (0 to 5 entries), an optional custom-amount top-up (`allowCustomAmount` with `customMinVnd` / `customMaxVnd`, see payment-checkout "Custom-amount top-up"; `llm` plans only), and the existing `isActive`, `isPurchasable`, `allowedGroupIds`, `purchaseLimitPerMonth` (gifts included, see plan-terms "Gifts count toward the monthly purchase limit"), `termOptions` (see plan-terms) and `highlighted`. A `kind = 'llm'` plan SHALL carry `credit` (integer nano-USD > 0, usable on every model the buyer's group allows — or `unlimitedCredit`, which stores 0 and removes the ceiling, see plan-queue-billing "Unlimited-credit plans"). A `kind = 'image'` plan SHALL instead carry `imageCount` (integer > 0, see image-plans "An image plan is a fixed count for a fixed term") and SHALL store `creditNanoUsd = 0`, `unlimitedCredit = false` and `allowCustomAmount = false`. A plan SHALL have exactly one kind and one balance.

#### Scenario: Go plan
- **WHEN** an admin creates code `go`, price $10, credit $250, 30 days, limits `[{hours: 5, max: $20}, {hours: 168, max: $80}]`
- **THEN** the plan is stored and `GET /api/plans` returns it with those values and `kind = "llm"`

#### Scenario: Image plan
- **WHEN** an admin creates code `img100`, `kind = "image"`, price 250.000đ, `imageCount = 100`, 30 days, limits `[{hours: 5, maxImages: 20}]`
- **THEN** the plan is stored with `kind = "image"`, `imageCount = 100` and `creditNanoUsd = 0`

### Requirement: Limit validation
Each limit SHALL have an integer `hours` between 1 and `durationDays × 24` and a maximum greater than zero and strictly less than the plan's balance in the plan's own unit — the plan's credit for an `llm` plan, `maxImages` and the plan's `imageCount` for an `image` plan (an unlimited-credit plan has no credit to compare with, so only the other rules apply). Two limits SHALL NOT share the same `hours`. For any two limits with `hours` a < b, the maximum of a SHALL NOT exceed the maximum of b. A plan SHALL have at most 5 limits. A violation SHALL be rejected with HTTP 400 and a Vietnamese message naming the offending limit; nothing is saved.

#### Scenario: Shorter window with a larger maximum
- **WHEN** an admin saves limits `[{5h, $50}, {168h, $40}]`
- **THEN** the response is HTTP 400 naming the 5-hour limit

#### Scenario: Maximum not below credit
- **WHEN** a plan with $250 credit gets a limit `{24h, $250}`
- **THEN** the response is HTTP 400

#### Scenario: Image limit counted in images
- **WHEN** an image plan with 100 images gets a limit `{5h, maxImages: 100}`
- **THEN** the response is HTTP 400, because a ceiling that never binds is not a limit

### Requirement: Orders snapshot limits
Creating an order SHALL store the plan's price, `kind`, `imageCount`, credit, duration and limits at that moment, and approving it SHALL grant exactly that snapshot. An order created before this change (no stored limits) SHALL be granted with the plan's limits at approval time.

#### Scenario: Limits changed while an order is pending
- **WHEN** a customer orders "Go" with `{5h, $20}`, the admin then changes it to `{5h, $10}` and approves the order
- **THEN** the granted plan carries `{5h, $20}`

#### Scenario: Kind changed while an image order is pending
- **WHEN** a customer orders 100 images, the admin then switches that plan to a credit plan and approves the order
- **THEN** the granted purchase still holds 100 images and no credit
