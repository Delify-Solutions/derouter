# model-discounts Specification

## Purpose
Defines time-limited discounts on the list price of models: how a rule is stored and validated, which rules apply to a request, how rules stack and are capped, where the discount is applied so that the charge, the usage history and every price a customer sees agree, and how the admin manages rules from the combo, plan and group screens.

## Requirements
### Requirement: A discount rule
A discount rule SHALL have: an id; a scope type (`combo`, `plan` or `group`) and a scope id (the combo NAME, the plan template id, or the group id); an optional list of model names (combo names); a percent stored as an integer number of basis points (1 bp = 0.01%) between 1 and 10000; an optional start and an optional end instant (ISO); an enabled flag; an optional label of at most 80 characters; creation and update times. Each rule is its own row: configuring a second discount never edits or merges the first. The scope of a rule SHALL NOT change after creation. Percent SHALL never be stored or computed as a floating-point number.

An empty or missing model list means "every model of the scope": for a combo-scope rule that is the combo itself (a combo-scope rule SHALL NOT carry a model list); for a plan- or group-scope rule it is every model a request can name. A non-empty list restricts a plan- or group-scope rule to those combos.

#### Scenario: Two discounts on one combo are two rules
- **WHEN** the admin adds 10% (1–7 Nov) and 5% (open ended) to combo `gpt`
- **THEN** two rules exist for `gpt` and each can be edited, disabled or deleted on its own

#### Scenario: Combo rule takes no model list
- **WHEN** a combo-scope rule is submitted with `models: ["gpt"]`
- **THEN** it is refused with a validation error on `models`

### Requirement: Validation
Creating or updating a rule SHALL be refused with HTTP 400 and a list of `{field, message}` errors when: the percent is not a number with at most two decimals between 0.01 and 100 (percent is parsed from text, not multiplied as a float; a comma or dot is accepted as decimal separator); the end is not strictly after the start (equal instants are an empty window); an instant is not a valid date; the scope type is unknown or the combo, plan or group does not exist; any listed model is not an existing combo name; or the label is longer than 80 characters. A refused request SHALL change nothing. The percent MAY be sent as `percent` (text or number) or as integer `percentBp`. Instants are normalised to ISO strings.

#### Scenario: Percent out of range
- **WHEN** a rule is submitted with percent `0`, `100.01` or `1.234`
- **THEN** the response is HTTP 400 with an error on `percent` and no rule is stored

#### Scenario: End before start
- **WHEN** a rule has start 10:00 and end 09:00
- **THEN** the response is HTTP 400 with an error on `endsAt`

#### Scenario: Unknown scope or model
- **WHEN** a rule points at a plan id that does not exist, or lists a model that is not a combo
- **THEN** the response is HTTP 400 with an error on `scopeId` or `models`

### Requirement: When a rule applies
A rule SHALL apply to a request only when it is enabled, its window is open at the request time, and its scope matches:
- `combo`: the requested model is exactly the rule's combo name (a bare combo name; a `provider/model` request never matches a combo rule);
- `group`: the paying customer's group is the rule's group while that group is active (the same live-group rule as key enforcement), and the rule covers the requested model;
- `plan`: the plan template of the purchase that pays first (see "Which plan decides") is the rule's plan, and the rule covers the requested model.

The request time is the time the usage row is recorded. The window is half open: the start instant is INCLUSIVE and the end instant is EXCLUSIVE, the same convention as plan expiry (`expiresAt > now`). A missing start or end leaves that side open. A rule with an unparseable bound never applies. A disabled or expired rule is ignored. Requests made with a key that has no owning customer (admin and local keys) have no group and no paying plan, so only combo-scope rules apply to them.

#### Scenario: Window edges
- **WHEN** a rule runs from 10:00 to 11:00
- **THEN** a request at 09:59:59.999 is not discounted, at 10:00:00.000 it is, at 10:59:59.999 it is, and at 11:00:00.000 it is not

#### Scenario: Expired and disabled rules are ignored
- **WHEN** a combo has a 20% rule that ended an hour ago and a 10% rule that is switched off
- **THEN** a request for that combo is charged the list price

#### Scenario: Scope matching
- **WHEN** group `g1` has a 10% rule for all models and a 5% rule for model `a`, and the customer is in `g1`
- **THEN** a request for `a` gets 15%, a request for `b` gets 10%, and a customer in another group gets 0%

#### Scenario: Combo rules need a bare combo name
- **WHEN** combo `gpt` has a 10% rule and a request names `openai/gpt`
- **THEN** no discount applies

### Requirement: Which plan decides
`chargeSync` may split one request across several purchased plans, and the usage cost is computed before the split, so one request SHALL be discounted by the plan rules of ONE plan: the first plan in the customer's queue that is eligible at the request time (not window-blocked, with credit, unexpired — the plan admission would pick); when no plan is eligible, the first plan with credit left (where the second pass of the charge starts). A purchase without a plan template (a gift or an admin grant) or an empty queue means no plan-scope rule applies. The plan that pays the remainder of a split charge SHALL NOT add its rules.

#### Scenario: Window-blocked plan is skipped
- **WHEN** the queue is plan "lite" (5-hour window full) then plan "pro", and only "pro" has a 20% rule
- **THEN** the request is discounted 20% by the "pro" rule

#### Scenario: Gift purchase has no plan rules
- **WHEN** the only purchase is an admin grant with no plan template
- **THEN** plan-scope rules do not apply, combo- and group-scope rules still do

### Requirement: Additive stacking with a 100% cap
All rules that apply to the same request SHALL be summed, whatever their scope, and the sum SHALL be capped at 100%. The effective price is the list price times (10000 − total basis points) / 10000. A total of 100% means the request is free; the cost is never negative and never above the list cost.

#### Scenario: Stacking
- **WHEN** a request matches a combo rule of 30%, a group rule of 25% and a plan rule of 15.5%
- **THEN** the total discount is 70.5% (7050 bp)

#### Scenario: Cap
- **WHEN** a request matches rules of 60% and 70%
- **THEN** the total discount is 100% and the request costs 0

### Requirement: Where the discount is applied and rounding
The discount SHALL be applied in exactly one place: `saveRequestUsage`, after the list cost has been computed from tokens (or images) and rates and before the usage row, the daily roll-up and the plan-queue charge are written, inside the same transaction. The usage row's cost (`costNanoUsd` and the legacy `cost`), the amount charged against the plan queue (and therefore the ledger and the plan windows), the daily roll-up, key budgets and every report that reads recorded cost SHALL all use the discounted figure. The discount SHALL be applied once, to the request's total list cost, with integer (BigInt) arithmetic, rounded half up to a whole nano-USD: `round(list × (10000 − bp) / 10000)`. A list cost of 0 stays 0. Image requests are discounted like token requests. A discount lookup failure SHALL be logged and the request recorded at list cost; it SHALL NOT discard the usage row.

A discounted request SHALL record in the usage row's meta the list cost (`listCostNanoUsd`), the total percent in basis points (`discountBp`) and the applied rule ids (`discountRuleIds`). A request with no applicable rule SHALL carry none of these fields.

Admission is not a cost estimate: it depends on credit and windows only, so a model that is 100% off is still admitted. Image models still require a list price greater than zero to be served.

#### Scenario: Charge uses the discounted cost
- **WHEN** a 1,000-in / 500-out request has a list cost of $0.002 and a total discount of 50%
- **THEN** the usage row, the ledger charge and the plan's window spend are $0.001, and the meta holds `listCostNanoUsd` $0.002 and `discountBp` 5000

#### Scenario: 100% is free
- **WHEN** the total discount is 100%
- **THEN** the usage row costs 0, no ledger charge row is written, the plan credit is unchanged, and the meta still records the list cost

#### Scenario: Rounding
- **WHEN** a request costs 3 nano-USD at list price with a 50% discount
- **THEN** the discounted cost is 2 nano-USD (1.5 rounds up)

### Requirement: Admin management
The admin console SHALL provide a "Giảm giá" section on the combo screen (per combo), the plan screen (per plan) and the group screen (per group), opened from a button on each item. It SHALL list that scope's rules and let the admin add, edit, switch on/off and delete one. A rule row shows the percent, a status label, the window and (for plan and group scope) the covered models. The status SHALL be one of `Đang chạy` (enabled and open), `Chưa bắt đầu` (enabled, start in the future), `Đã hết hạn` (enabled, end passed) or `Đã tắt` (switched off), always as text with an icon, never by colour alone. The form takes: percent (0.01 to 100 percent, step 0.01), models (all models, or a picked subset — plan and group scope only), start, end and label; field errors from the server are shown next to the field. The list has loading, error and empty states.

When the enabled, unexpired rules of the scope overlap, the screen SHALL show the combined percent in force now (capped at 100%), and a warning when the raw sum exceeds 100% now or when a rule that starts later would push the sum past 100%. The overlap is evaluated per model (rules that cover different models do not add up) and only within the scope shown; rules of other scopes still stack at request time and are not visible there.

The API SHALL be `GET/POST /api/discounts` (list by `scopeType` and `scopeId`, create) and `GET/PATCH/DELETE /api/discounts/[id]`, behind the admin session like every non-public route.

#### Scenario: Overlap warning
- **WHEN** a group has two enabled all-model rules of 60% and 50% open at the same time
- **THEN** the screen shows 100% in force, "cộng 110%, đã giới hạn ở 100%" and a warning

#### Scenario: Different models do not add up
- **WHEN** two rules of 60% cover model `x` and model `y` respectively
- **THEN** no overlap warning is shown

### Requirement: Rules follow their scope
Renaming a combo SHALL move its combo-scope rules to the new name and rewrite the name in plan- and group-scope model lists. Deleting a combo SHALL delete its combo-scope rules and remove its name from model lists; a plan- or group-scope rule whose list becomes empty SHALL be switched off rather than widened to "all models". Deleting a group SHALL delete its rules. Plans are only deactivated, never deleted, so their rules remain.

#### Scenario: Last model of a rule deleted
- **WHEN** a group rule covers only combo `a` and `a` is deleted
- **THEN** the rule is switched off and still lists no models

### Requirement: Customers see the discounted price
Surfaces that show per-model prices SHALL show the lowered price with the list price struck through, the percent taken off and — where the surface can do so without a hydration mismatch — the remaining time or the end date. The list price is always still shown. A model with no applicable rule renders exactly as before.
- The public usage page's "Available Models" table (`/api/usage/key/receipts`) evaluates the rules for the key's owner: their group and the plan that pays first. Each model keeps its list rates and gains `discount` and the lowered `discounted` rates; the remaining time is shown relative to now. The request history shows each discounted request's cost, its list cost struck through and "giảm X%".
- The landing page pricing table evaluates combo rules plus the default customer group's rules for a visitor with no plan; for each plan that has rules of its own it adds that plan's figure, shown when that plan is selected. The end date is shown as an absolute Vietnam-time date. The worked example uses the effective rates.
- The account usage history shows the same discounted cost, struck list cost and "giảm X%".

Displayed discounted rates are the list rates multiplied by (10000 − bp) / 10000 and rounded to six decimals; they are for display only. The amount actually charged follows "Where the discount is applied and rounding", so a displayed rate times the tokens can differ from the charge by at most the final nano-USD rounding and the rounding of the rate itself.

#### Scenario: Discounted model on the usage page
- **WHEN** a combo with input $3 and output $15 per 1M tokens has an active 20% rule ending in 3 days
- **THEN** its row shows input $2.40 with $3 struck through, output $12 with $15 struck through, "Giảm 20%" and "còn 3 ngày"

#### Scenario: Expired rule disappears
- **WHEN** the rule's end time passes
- **THEN** the next page load shows the list price and no discount marker
