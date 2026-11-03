## MODIFIED Requirements

### Requirement: Plan definition
A plan SHALL have the following fields:
- `code`: 2–32 characters of a–z, 0–9, `_` or `-`, starting with a letter or digit; unique.
- `name`: required.
- `description`.
- `price`: integer nano-USD ≥ 0.
- `credit`: integer nano-USD > 0, usable on every model the buyer's group allows. Alternatively `unlimitedCredit`, which stores 0 and removes the ceiling (see plan-queue-billing "Unlimited-credit plans").
- `durationDays`: integer ≥ 1.
- `limits`: 0 to 5 entries.
- An optional custom-amount top-up: `allowCustomAmount` with `customMinVnd` / `customMaxVnd` (see payment-checkout "Custom-amount top-up").
- `productLine`: `api` (default) or `business`.
- `maxBots`: integer 0–1,000. Required and ≥ 1 when `productLine` is `business`; stored as NULL for `api`.
- `maxKbBytes`: integer bytes, 1 MB–10 GB. Required when `productLine` is `business`; stored as NULL for `api`.
- The existing fields, with their current meaning:
  - `isActive`;
  - `isPurchasable`;
  - `allowedGroupIds`;
  - `purchaseLimitPerMonth`: gifts included (see plan-terms "Gifts count toward the monthly purchase limit");
  - `termOptions` (see plan-terms);
  - `isFeatured`;
  - `sortOrder`.

`POST /api/plans` and `PATCH /api/plans/[id]` SHALL accept and return `limits`, `productLine`, `maxBots` and `maxKbBytes`. Each SHALL respond 400 with a Vietnamese message for an invalid product line, or for a business plan missing `maxBots` or `maxKbBytes`.

Existing plans SHALL read as `productLine = api`.

#### Scenario: Go plan
- **WHEN** an admin creates code `go`, price $10, credit $250, 30 days, limits `[{hours: 5, max: $20}, {hours: 168, max: $80}]`
- **THEN** the plan is stored, and `GET /api/plans` returns it with those values and `productLine: "api"`

#### Scenario: Business plan without bot limit
- **WHEN** an admin creates a plan with `productLine: "business"` and no `maxBots`
- **THEN** the response is 400, and no plan is stored

## ADDED Requirements

### Requirement: Product line in the admin plan form
The admin plan form SHALL have a "Dòng sản phẩm" selector with the choices "API" and "AI doanh nghiệp".

When "AI doanh nghiệp" is selected, the form SHALL show these inputs, with inline validation:
- "Số bot tối đa";
- "Dung lượng tài liệu (MB)", which the form converts to bytes.

The plan list SHALL show each plan's product line as a text badge.

#### Scenario: Business fields appear
- **WHEN** the admin selects "AI doanh nghiệp" in the plan form
- **THEN** the bot and document-size inputs appear and are required
