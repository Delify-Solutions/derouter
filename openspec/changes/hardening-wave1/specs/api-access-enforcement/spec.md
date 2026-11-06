## MODIFIED Requirements

### Requirement: Customer request rates come from the paying plan and are counted per user
For customer keys, the RPM and TPM limits SHALL be those of the plan (`plans.rpm` / `plans.tpm`, empty = unlimited) that the purchase at the head of the user's queue was bought from, read live on every request. A purchase with no plan (admin credit, gift credit) and a user with no purchase able to pay SHALL have no rate limit applied; the latter is then answered by plan admission (402 or 429). RPM SHALL be the number of counted requests across all keys of the same user in the trailing 60 seconds, and TPM the sum of prompt and completion tokens of those requests. A counted request is one that was served (status `ok` or `success`) or that its client abandoned after it reached the upstream (status 499); failed upstream attempts (one row per account or combo member tried) and platform denials SHALL NOT count. When TPM is exceeded the request SHALL wait for room up to `TPM_MAX_WAIT_MS` (default 30000) counted from the moment it started waiting, with waiting serialized per user, and SHALL check once more when that budget is spent before failing with 429 `rate_limit`. A request whose client disconnects while it waits, including while queued behind another request, SHALL leave the wait at once, without a denial being recorded. Admin keys keep per-key counting with the same rules.

#### Scenario: Two keys share one RPM allowance
- **WHEN** the paying plan allows 10 RPM and the user has made 6 requests with key K1 and 4 with key K2 in the last 60 seconds
- **THEN** the next request with either key is rejected with HTTP 429, error code `rate_limit` and header `Retry-After: 60`

#### Scenario: The head of the queue sets the rate
- **WHEN** a user holds plan A (1 RPM) ahead of plan B (100 RPM) in the queue and has made 1 request in the last minute
- **THEN** the next request is rejected with 429 `rate_limit`, and after the user moves plan B to the head it is accepted

#### Scenario: Editing a plan applies at once
- **WHEN** an admin raises a plan's RPM while customers hold purchases of it
- **THEN** the new value applies to those customers' next request

#### Scenario: Credit without a plan
- **WHEN** a user pays from an admin or gift credit that has no plan and has made 20 requests in the last minute
- **THEN** the request is not rejected for RPM

#### Scenario: Admin keys unaffected
- **WHEN** two admin keys each made 6 requests in the last minute and each key has RPM 10
- **THEN** neither key is rejected for RPM

#### Scenario: A provider outage does not use the allowance
- **WHEN** the paying plan allows 10 RPM and in the last minute the user had 1 served request, a combo request whose 3 members all failed upstream, and one 429 denial
- **THEN** the user's RPM count is 1

#### Scenario: Connect-and-hang-up is held to the rate
- **WHEN** the paying plan allows 10 RPM and the user's client sent 10 requests in the last minute and hung up on each after it reached the upstream
- **THEN** the next request is rejected with 429 `rate_limit`

#### Scenario: Queued requests share one wait budget
- **WHEN** three requests of one user queue for TPM room that never frees
- **THEN** all three receive 429 `rate_limit` within one `TPM_MAX_WAIT_MS`, not three

#### Scenario: Client leaves while waiting
- **WHEN** a request waits for TPM room and its client disconnects
- **THEN** the wait ends at once and no denial row is recorded

## ADDED Requirements

### Requirement: Encoded request paths are refused
Every request SHALL be refused with HTTP 400, before any access rule is applied, when its path percent-encodes a letter, a digit, `-`, `.`, `_`, `~`, `/` or `\`, or contains a raw `\`. Other encoded characters (spaces, non-ASCII text, `%25`, `:`) SHALL be unaffected.

#### Scenario: Encoded admin API path
- **WHEN** an unauthenticated client requests `/%61pi/settings`
- **THEN** the response is 400 and no route handler runs

#### Scenario: Encoded name in a path
- **WHEN** an admin requests `/api/combos/my%20combo`
- **THEN** the request is handled as before
