# public-landing Specification

## Purpose
Defines the public sales page: it presents the active plans truthfully from plan data, lists the models a newly registered customer can actually call with their token prices, explains how the shared credit is consumed, and routes a visitor to buy the plan they picked.
## Requirements
### Requirement: Plan cards come from plan data
The landing page SHALL render one card per active plan in plan sort order, showing: name, description, price, "Nhận $<credit> dùng chung mọi model", "Dùng <N> ngày", one line per limit "Tối đa $<max> mỗi <window label>", a featured badge when the plan is featured, and an inert "Chưa mở bán" control when the plan is not purchasable. Window labels SHALL be `5 giờ` for 5, `1 ngày` for 24, `1 tuần` for 168 and `<N> giờ` otherwise. No text on the page SHALL describe per-model limits.

#### Scenario: Go card
- **WHEN** plan "Go" is active with price $10, credit $250, 30 days and limits 5h/$20 and 168h/$80
- **THEN** its card shows "$10", "Nhận $250 dùng chung mọi model", "Dùng 30 ngày", "Tối đa $20 mỗi 5 giờ" and "Tối đa $80 mỗi 1 tuần"

### Requirement: Sellable models and pricing explanation
The model list SHALL contain exactly the configured combos (the names a customer sends as `model`, as listed by the public `/v1/models`) that the default customer group allows — every chat combo when the group has no allow-list — and SHALL NOT list raw provider models. Each entry SHALL show input, output and cached-input price per 1M tokens: the combo's own price when the admin set one, otherwise the price of the combo's first model, from the router's pricing. The pricing section SHALL state that credit is deducted at these token prices so more expensive models use credit faster, and SHALL show one worked example computed from a listed model's prices for 20,000 input and 2,000 output tokens.

#### Scenario: Model outside the default group hidden
- **WHEN** the default group allows `model-a` and `model-b` only
- **THEN** the landing model list shows exactly `model-a` and `model-b`

#### Scenario: Only configured combos are listed
- **WHEN** the router has 600 provider models but the admin configured two combos
- **THEN** the landing model list and the price table show exactly those two combos

#### Scenario: Combo price
- **WHEN** a combo has its own price set
- **THEN** the table shows that price; without one it shows the price of the combo's first model

### Requirement: Plan selection entry flow
The "Chọn <plan name>" control SHALL link a visitor without a customer session to `/register?next=/account/plans?plan=<code>` and a signed-in customer to `/account/plans?plan=<code>`.

#### Scenario: Signed-out visitor picks Go
- **WHEN** a signed-out visitor clicks "Chọn Go", registers, verifies and logs in
- **THEN** they land on `/account/plans?plan=go` with the Go card highlighted

### Requirement: Default copy and FAQ match the shared-credit model
The default landing copy (hero, plans, pricing, get-started, FAQ) SHALL describe one shared credit per purchase, per-plan window limits and the plan queue. The FAQ SHALL answer: what happens when I buy several plans; what a 5-hour limit is; what happens to remaining credit at expiry; which models I can use; what happens when a plan is temporarily blocked. Copy saved by the admin SHALL continue to override the defaults.

#### Scenario: Fresh install copy
- **WHEN** no landing copy has been saved by the admin
- **THEN** the page contains the five FAQ questions and no mention of per-model limits

