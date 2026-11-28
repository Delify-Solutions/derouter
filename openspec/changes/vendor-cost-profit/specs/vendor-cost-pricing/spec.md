## Purpose
Lets the admin record what an upstream provider actually costs per model, separately from the price charged to customers, so that profit and loss can be reported without ever changing a customer's bill.

## ADDED Requirements

### Requirement: Vendor cost configuration per provider and model
The admin SHALL be able to set a vendor cost for a (provider, model) pair from the Providers page, when adding a custom model or editing an existing one. A vendor cost record has the same rate fields as the existing sell-price record (input, output, cached, reasoning, cache_creation), priced per 1M tokens.
- A (provider, model) pair with no vendor cost set SHALL behave as "no vendor cost configured" (see the snapshot requirement below), never as a zero cost.
- Vendor cost is configured per actual upstream (provider, model) pair only. It has no combo-level equivalent: a combo's vendor cost, when needed, is derived from the vendor cost of the upstream model that actually answered.
- Setting, changing or clearing a vendor cost SHALL have no effect on `pricingRepo.resolvePrice`, discounts, or any amount charged to a customer, now or retroactively.

#### Scenario: Set a flat vendor cost
- **WHEN** the admin sets provider `openrouter`, model `glm-5` to a vendor cost of 1.00 USD input / 3.00 USD output per 1M tokens
- **THEN** that rate is stored for that (provider, model) pair and the customer-facing price of `glm-5` is unchanged

#### Scenario: No vendor cost configured
- **WHEN** the admin has never set a vendor cost for provider `zai`, model `glm-5.3:pre`
- **THEN** that pair has no vendor cost record, distinct from a vendor cost of zero

### Requirement: Optional on-peak/off-peak vendor cost schedule
A vendor cost record MAY define on-peak and off-peak rate variants instead of one flat rate. When it does, it also defines a daily off-peak time window (start and end time of day, Asia/Ho_Chi_Minh time); any time outside that window is on-peak. This schedule applies ONLY to the vendor cost side — it SHALL have no effect on what a customer is charged.
- When a record has no peak schedule, its one flat rate applies at every hour.
- An off-peak window that wraps past midnight (start later than end) SHALL be treated as spanning midnight (e.g. 22:00–06:00 means off-peak from 22:00 to 23:59 and from 00:00 to 06:00).
- A time exactly equal to the window's start is off-peak; a time exactly equal to the window's end is on-peak.

#### Scenario: Off-peak request
- **WHEN** a vendor cost record for `openrouter`/`glm-5` has off-peak 00:00–06:00 (Asia/Ho_Chi_Minh) at half the on-peak rate, and a request is logged at 03:00 Asia/Ho_Chi_Minh
- **THEN** the off-peak rate is used to compute that request's vendor cost

#### Scenario: On-peak request
- **WHEN** the same record and a request is logged at 14:00 Asia/Ho_Chi_Minh
- **THEN** the on-peak rate is used

#### Scenario: Window spanning midnight
- **WHEN** a vendor cost record's off-peak window is 22:00–06:00 and a request is logged at 23:30 Asia/Ho_Chi_Minh
- **THEN** the off-peak rate is used

### Requirement: Per-request vendor cost snapshot
When a request is logged, the system SHALL resolve its vendor cost using the request's own timestamp (to pick on-peak vs off-peak, if the matching vendor cost record has a schedule) and store the result once, at that time. This resolved value SHALL NOT change afterwards even if the admin later edits or removes the vendor cost record that produced it.
- When no vendor cost record matches the request's (provider, model) pair at the time it is logged, the stored value SHALL be absent (null), not zero.
- This snapshot SHALL be computed alongside the existing recorded charge and cost, without altering either.

#### Scenario: Snapshot is stable after a later price change
- **WHEN** a request is logged while `openrouter`/`glm-5`'s vendor cost is 1.00 USD input per 1M tokens, and the admin later changes it to 2.00 USD
- **THEN** that request's stored vendor cost still reflects 1.00 USD, unaffected by the later change

#### Scenario: Unpriced pair yields no vendor cost
- **WHEN** a request is logged for a (provider, model) pair with no vendor cost record
- **THEN** the request's stored vendor cost is absent, and it is reported as "no vendor cost data" everywhere it is shown, never as zero

### Requirement: Historical requests have no vendor cost
Requests logged before this capability existed SHALL have no vendor cost, permanently. There SHALL be no backfill or retroactive estimation of vendor cost for them.

#### Scenario: Pre-existing request stays unpriced
- **WHEN** a request was logged before vendor cost pricing was configured for its (provider, model) pair
- **THEN** it permanently has no recorded vendor cost, even after that pair later gets a vendor cost record
