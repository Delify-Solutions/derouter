## MODIFIED Requirements

### Requirement: Plan definition
A plan SHALL have: `code` (2–32 characters of a–z, 0–9, `_` or `-`, starting with a letter or digit, unique), `name` (required), `description`, `price` (integer nano-USD ≥ 0), `kind` (`llm`, the default, or `image`), `durationDays` (integer ≥ 1), `limits` (0 to 5 entries), an optional `allowedModels` list, an optional custom-amount top-up (`allowCustomAmount` with `customMinVnd` / `customMaxVnd`, see payment-checkout "Custom-amount top-up"; `llm` plans only), and the existing `isActive`, `isPurchasable`, `allowedGroupIds`, `purchaseLimitPerMonth` (gifts included, see plan-terms "Gifts count toward the monthly purchase limit"), `termOptions` (see plan-terms) and `highlighted`. A `kind = 'llm'` plan SHALL carry `credit` (integer nano-USD > 0, usable on every model the buyer's group allows and this plan's `allowedModels` permits); a `kind = 'image'` plan SHALL carry `imageCount` (integer > 0) instead of credit.

`allowedModels` SHALL be `null` (meaning "no restriction — whatever the buyer's group allows", the value every plan created before this change has) or a non-empty array of combo names. An empty array SHALL be rejected with HTTP 400 rather than coerced to `null`, because "no model at all" is never what an admin means and would look like a plan that silently grants nothing. An entry that names no existing combo SHALL be refused, so a typo cannot be saved as a plan that grants nothing.

A plan's list SHALL only ever **narrow** the account's access: the group allow-list of the buyer is enforced first and independently, so a plan naming a model the buyer's group denies grants nothing.

#### Scenario: Go plan
- **WHEN** an admin creates code `go`, price $10, credit $250, 30 days, limits `[{hours: 5, max: $20}, {hours: 168, max: $80}]`
- **THEN** the plan is stored and `GET /api/plans` returns it with those values, `kind = "llm"` and `allowedModels = null`

#### Scenario: Image plan
- **WHEN** an admin creates code `img100`, `kind = "image"`, price 250.000đ, `imageCount = 100`, 30 days, limits `[{hours: 5, maxImages: 20}]`
- **THEN** the plan is stored with `kind = "image"`, `imageCount = 100` and `creditNanoUsd = 0`

#### Scenario: A plan restricted to two combos
- **WHEN** an admin saves `allowedModels: ["claude-sonnet", "gpt-5"]` on a plan
- **THEN** the plan stores exactly those two names and `GET /api/plans` returns them

#### Scenario: Empty list refused
- **WHEN** an admin saves `allowedModels: []`
- **THEN** the response is HTTP 400 and the plan keeps its previous list

#### Scenario: Unknown combo refused
- **WHEN** an admin saves `allowedModels: ["claude-sonet"]` and no combo has that exact name
- **THEN** the response is HTTP 400 naming the unknown entry, and nothing is written

### Requirement: Orders snapshot limits
An order SHALL snapshot the plan's limits, `kind`, `imageCount` and `allowedModels` at creation. Approving it SHALL grant a purchase carrying those snapshots, so editing the plan afterwards cannot change what an already-paid order grants.

#### Scenario: Limits frozen at order time
- **WHEN** an order is created for a plan with a 5-hour $20 limit and the admin raises that limit to $50 before the order is approved
- **THEN** the granted purchase keeps the $20 limit

#### Scenario: Models frozen at order time
- **WHEN** an order is created for a plan allowing `claude-sonnet` and the admin then adds `gpt-5` to the plan
- **THEN** the granted purchase still allows only `claude-sonnet`

### Requirement: Applying new limits to active purchases is explicit
`PATCH /api/plans/[id]` SHALL change only future orders and grants unless the request carries `applyToActive: true`, in which case it SHALL also rewrite the same field on every `active` purchase of that plan, writing one audit entry per affected purchase. This applies to `limits` and `allowedModels` alike.

Removing a model from a plan with `applyToActive: true` SHALL be allowed but SHALL be reported: the response SHALL carry `affectedCount`, and the admin form SHALL state, before saving, how many live purchases lose access.

#### Scenario: Editing without applyToActive
- **WHEN** an admin adds a model to a plan that 30 customers hold, without ticking "áp dụng cho gói đang chạy"
- **THEN** only orders created afterwards grant that model and no existing purchase changes

#### Scenario: Pushing a removal down
- **WHEN** an admin removes `gpt-5` from a plan with `applyToActive: true` and 3 live purchases of it allow `gpt-5`
- **THEN** `affectedCount` is 3, those purchases stop allowing `gpt-5` on their next request, and 3 audit entries record the change
