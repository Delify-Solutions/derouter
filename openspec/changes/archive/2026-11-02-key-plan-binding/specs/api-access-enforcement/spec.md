## RENAMED Requirements
- FROM: `### Requirement: Customer request rates come from the paying plan and are counted per user`
- TO: `### Requirement: Customer request rates come from the paying plan and are counted per user and plan`

## MODIFIED Requirements

### Requirement: Customer request rates come from the paying plan and are counted per user and plan
For customer keys, the RPM and TPM limits SHALL be those of the plan (`plans.rpm` / `plans.tpm`, empty = unlimited) that pays for the request — the key's pinned plan, else the plan of the purchase at the head of the user's queue — read live on every request. A purchase with no plan (admin credit, gift credit) and a user with no purchase able to pay SHALL have no rate limit applied; the latter is then answered by plan admission (402 or 429). The allowance SHALL be counted per user and plan: RPM is the number of recorded requests, and TPM the sum of prompt and completion tokens, in the trailing 60 seconds across all keys of that user that were counted against that plan (`plans.id`, so several purchases of one plan share it). When TPM is exceeded the request SHALL wait for room up to `TPM_MAX_WAIT_MS` (default 30000) with waiting serialized per user and plan, then fail with 429 `rate_limit` if still over. Admin keys keep per-key counting.

#### Scenario: Two keys share one RPM allowance
- **WHEN** the paying plan allows 10 RPM and the user has made 6 requests with key K1 and 4 with key K2, both paid by that plan, in the last 60 seconds
- **THEN** the next request with either key is rejected with HTTP 429, error code `rate_limit` and header `Retry-After: 60`

#### Scenario: Another plan has its own allowance
- **WHEN** a user holds plans A and B (1 RPM each), key KA is pinned to A and KB to B, and KA has made 1 request in the last minute
- **THEN** the next request with KA is rejected with 429 `rate_limit` and the next request with KB is accepted

#### Scenario: Buying a plan twice does not double its rate
- **WHEN** a user holds two purchases of a 2 RPM plan and has made 2 requests in the last minute
- **THEN** the next request is rejected with 429 `rate_limit`

#### Scenario: The head of the queue sets the rate
- **WHEN** a user holds plan A (1 RPM) ahead of plan B (100 RPM) in the queue and has made 1 request paid by A in the last minute
- **THEN** the next request of an unpinned key is rejected with 429 `rate_limit`, and after the user moves plan B to the head it is accepted

#### Scenario: Editing a plan applies at once
- **WHEN** an admin raises a plan's RPM while customers hold purchases of it
- **THEN** the new value applies to those customers' next request

#### Scenario: Credit without a plan
- **WHEN** a user pays from an admin or gift credit that has no plan and has made 20 requests in the last minute
- **THEN** the request is not rejected for RPM

#### Scenario: Another user's usage does not count
- **WHEN** two users hold the same 1 RPM plan and one of them has made a request in the last minute
- **THEN** the other user's next request is accepted

#### Scenario: Admin keys unaffected
- **WHEN** two admin keys each made 6 requests in the last minute and each key has RPM 10
- **THEN** neither key is rejected for RPM

## ADDED Requirements

### Requirement: Customer keys may be pinned to one plan
A customer key SHALL carry an optional plan (`apiKeys.planId`, a `plans.id`). A key without one ("all plans") SHALL be admitted and charged by the whole queue as before. A pinned key SHALL be admitted and charged only by purchases of that plan, in their normal queue order, and SHALL NOT fall back to another plan: when no purchase of that plan can pay, the request SHALL be rejected with 402 `insufficient_quota` and a message naming the plan, or with 429 `plan_limit` when every purchase of the plan with credit is window-blocked. A charge for a pinned key that the plan cannot cover in full SHALL become debt, not be taken from another plan. The pin applies from the key's next request. Admin keys cannot be pinned.

#### Scenario: Pinned key uses its own plan
- **WHEN** a user holds plan A ahead of plan B in the queue and sends a request with a key pinned to B
- **THEN** the request is paid from B

#### Scenario: Pinned key does not fall back
- **WHEN** a user holds only plan A and sends a request with a key pinned to plan B
- **THEN** the response is HTTP 402 with code `insufficient_quota` and a message naming plan B, while an unpinned key of the same user is still served by A

#### Scenario: Shortfall does not spill
- **WHEN** a request on a key pinned to B costs $3 and B has $1 left while A has $100
- **THEN** B pays $1, $2 becomes debt, and A's credit is unchanged

#### Scenario: Lapsed plan
- **WHEN** the only purchase of a key's pinned plan has expired
- **THEN** the key answers 402 `insufficient_quota` until the plan is renewed or the key is moved to another plan
