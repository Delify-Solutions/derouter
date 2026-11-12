## MODIFIED Requirements

### Requirement: Customer request rates come from the paying plan and are counted per user
For customer keys, the RPM and TPM limits SHALL be those of the purchase at the head of the user's queue, read live on every request. That is the purchase's own override when set, else the limits of the plan it was bought from (`plans.rpm` / `plans.tpm`, empty = unlimited); see plan-templates "Per-purchase rate override".

The following SHALL have no rate limit applied:
- a purchase with no plan (admin credit, gift credit) and no override;
- a user with no purchase able to pay. That case is then answered by plan admission (402 or 429).

The allowance SHALL be counted per user and per plan. A planless purchase with an override SHALL have its own allowance.

Within an allowance, the limits SHALL be counted across all keys of the same user in the trailing 60 seconds:
- RPM SHALL be the number of recorded requests;
- TPM SHALL be the sum of prompt and completion tokens.

When TPM is exceeded, the request SHALL wait for room up to `TPM_MAX_WAIT_MS` (default 30000), with waiting serialized per user. It SHALL then fail with 429 `rate_limit` if still over.

Admin keys keep per-key counting.

#### Scenario: Two keys share one RPM allowance
- **WHEN** the paying plan allows 10 RPM and the user has made 6 requests with key K1 and 4 with key K2 in the last 60 seconds
- **THEN** the next request with either key is rejected with HTTP 429, error code `rate_limit` and header `Retry-After: 60`

#### Scenario: The head of the queue sets the rate
- **WHEN** a user holds plan A (1 RPM) ahead of plan B (100 RPM) in the queue and has made 1 request in the last minute
- **THEN** the next request is rejected with 429 `rate_limit`, and after the user moves plan B to the head it is accepted

#### Scenario: Editing a plan applies at once
- **WHEN** an admin raises a plan's RPM while customers hold purchases of it without an override
- **THEN** the new value applies to those customers' next request

#### Scenario: Credit without a plan
- **WHEN** a user pays from an admin or gift credit that has no plan and no override, and has made 20 requests in the last minute
- **THEN** the request is not rejected for RPM

#### Scenario: Credit with its own rate
- **WHEN** a user pays from a gift credit whose purchase has RPM 2 and has made 2 requests in the last minute
- **THEN** the next request is rejected with 429 `rate_limit`

#### Scenario: Admin keys unaffected
- **WHEN** two admin keys each made 6 requests in the last minute and each key has RPM 10
- **THEN** neither key is rejected for RPM
